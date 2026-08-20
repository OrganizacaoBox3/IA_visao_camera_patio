# Ponte DVR — nginx do relay (B-3)

Front autenticado que publica a web do DVR **por subdomínio**, sempre atrás do login do portal.
Toda request passa por `auth_request → /_dvr_auth` no control-plane do visão (C-be-6); só `200`
libera o proxy. Config: [`dvr.conf`](./dvr.conf). Desenho completo:
`../../../box3-mobile/planejamento/ponte-dvr/de-risking/relay-proxy.md` e `contratos.md §5`.

> **Estado:** B-3 feito (config + validada com `nginx -t`). A **VPS** e a **emissão do cert** são
> ação de infra do dono (não provisionadas por aqui). `dvr.conf` é revisável e materializado no deploy.

## Como o acesso casa Host ↔ DVR ↔ técnico
1. Técnico loga no portal (`coletor.box3.software`) → recebe o **cookie de sessão** no domínio pai
   `.box3.software` (C-be-7). Por ser domínio pai, o subdomínio `*.dvr.box3.software` também o recebe.
2. Técnico abre `https://cliente-x-abc123.dvr.box3.software` (nova aba). O nginx dispara
   `auth_request` para `/_dvr_auth` repassando **Cookie** + **X-Original-Host** (= o subdomínio).
3. O control-plane, no `/_dvr_auth`: valida o técnico pelo **cookie**, acha o **DVR pelo Host**
   (sessão ativa via `stores.sessoes.ativaPorHost`), checa **canAccess** do técnico no cliente,
   **renova** `ultima_atividade` e **audita**. Responde `200` (libera) ou `401`/`403`.
4. Em `200`, o control-plane devolve o header **`X-Dvr-Upstream: 127.0.0.1:<remotePort>`** — o nginx
   captura com `auth_request_set` e faz `proxy_pass` para essa porta de loopback (o túnel `frps`).

## Upstream dinâmico — mecanismo escolhido (e a alternativa)
**Escolhido: `auth_request_set $dvr_upstream $upstream_http_x_dvr_upstream` + `proxy_pass http://$dvr_upstream`.**
A subrequisição de auth **já** consulta a sessão ativa (o mapa de rota `rotasAtivas()` — `host_publico →
remote_port → dvr`) para autorizar; devolver o alvo no header `X-Dvr-Upstream` aproveita essa mesma
consulta. Vantagens:
- **Fonte única de verdade:** a rota é a própria linha de sessão ativa no control-plane. Encerrar/timeout
  já a remove (some do `rotasAtivas`), então o `/_dvr_auth` passa a responder `401` e o proxy cai junto —
  sem nada para sincronizar.
- **Sem map file, sem `nginx -s reload`, sem sync entre máquinas** (o control-plane roda noutra máquina
  que não a VPS do relay). Resolvido **por request**.
- IP **literal** (`127.0.0.1:<porta>`) → **não exige `resolver`** no nginx (o resolver só seria preciso
  se a variável fosse um nome DNS a resolver).

**Alternativa (map file):** o control-plane regenera um arquivo `map $host $dvr_upstream { ... }`
(uma linha por sessão ativa) e recarrega o nginx (`nginx -s reload`) a cada abrir/encerrar. Rejeitada
aqui porque exige **entregar o arquivo à VPS do relay e recarregar** (cross-machine, mais partes móveis)
e duplica a verdade que o `/_dvr_auth` já tem. Fica documentada como plano B se um dia o `/_dvr_auth`
sair do caminho de dados.

## TLS wildcard `*.dvr.box3.software` (DNS-01) — documentado, não emitido aqui
Um DVR novo sobe sessão **na hora** → não dá para emitir cert host-a-host on-demand. Usamos **wildcard**,
que o Let's Encrypt só emite via **desafio DNS-01** (HTTP-01 não emite `*`).
- **DNS:** um registro **wildcard** `*.dvr.box3.software → IP da VPS` (+ o apex `dvr.box3.software`).
- **Emissão:** `certbot` com plugin de DNS (ex. `certbot-dns-cloudflare`/`route53`) **ou** `acme.sh`,
  com deploy-hook que roda `nginx -s reload`. O token de API do DNS vem do secret manager — **nunca no git**.
- Caminhos usados no `dvr.conf`: `/etc/letsencrypt/live/dvr.box3.software/{fullchain,privkey}.pem`.

## Config a materializar no deploy (sem segredo no git)
- **Host do control-plane** em dois pontos do `dvr.conf`: o `proxy_pass` de `location = /_dvr_auth`
  e o `return 302` do `@login`. Trocar `coletor.box3.software` pelo host real do portal do visão.
- **Cookie de sessão (C-be-7):** o control-plane deve rodar com `CP_COOKIE_DOMAIN=.box3.software`
  (default) para o cookie valer no subdomínio do relay. Ver `control-plane/cookie.js`.
- **Cert wildcard** nos caminhos acima.

## sub_filter — armadilhas do relay-proxy.md §6 (WebSocket hardcoded)
A UI de DVR crava **host/porta absolutos** e portas de **WebSocket fixas de firmware** (Hikvision
**7681** plano / **7682** TLS). Sem reescrita, o live view não conecta pelo proxy. O `dvr.conf`:
- desliga gzip (`proxy_set_header Accept-Encoding ""`) p/ o nginx conseguir ler/reescrever o corpo (#8);
- `sub_filter` reescreve `ws://$host:7681`/`wss://$host:7682` → `wss://$host` (via 443) e `http://` →
  `https://` (mixed-content, #5);
- **proxia o WebSocket** (`Upgrade`/`Connection` via `map $http_upgrade`).

**Limite honesto (documentar ao cliente):**
- O **IP interno** do DVR (ex. `192.168.1.108`) também pode vir hardcoded, mas é **por DVR** — não dá
  match estático. O control-plane conhece `dvr.ip` (do registro) e pode devolvê-lo num header
  (`X-Dvr-Lan-Ip`) para `auth_request_set` + `sub_filter` com variável no match. Ligar quando o parque exigir.
- **Live view por ActiveX** (firmware antigo) **não roda em navegador** — fora de escopo (web-only v1).

## Login-plugin do frps (B-2, relacionado)
O `frps.toml` aponta o server-plugin para o **shim de loopback** (`relay/frp-login-shim.mjs`,
`127.0.0.1:9001`), que repassa ao control-plane (`POST /api/dvr/frp-login`) **injetando** o header
`x-frp-plugin-token` (o frp não adiciona headers custom). Direto ao control-plane também é possível
quando a trava de token não for necessária. Ver `../frps.toml` e `../README.md`.

## Validar a sintaxe (sem VPS)
`nginx -t` num container, com um cert de teste nos caminhos esperados:
```sh
# gere um cert self-signed de teste em ./certs/{fullchain,privkey}.pem, depois:
docker run --rm \
  -v "$PWD/dvr.conf:/etc/nginx/conf.d/dvr.conf:ro" \
  -v "$PWD/certs/fullchain.pem:/etc/letsencrypt/live/dvr.box3.software/fullchain.pem:ro" \
  -v "$PWD/certs/privkey.pem:/etc/letsencrypt/live/dvr.box3.software/privkey.pem:ro" \
  nginx:alpine nginx -t
# => "syntax is ok" / "test is successful"  (validado nesta onda)
```
