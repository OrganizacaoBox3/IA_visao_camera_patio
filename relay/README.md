# Ponte DVR — Relay (frp server) · skeleton

Servidor de túnel reverso (`frps`) da Ponte DVR. O coletor (app `app-ponte-dvr`) sobe um `frpc`
que expõe **só a porta web do DVR** para uma porta de **loopback** nesta VPS; o técnico alcança
essa porta **sempre atrás de login** (nginx `auth_request` → control-plane do visão). Desenho
completo: `../../box3-mobile/planejamento/ponte-dvr/de-risking/relay-proxy.md`.

> **Estado:** B-1 + **B-2** (login-plugin ligado) + **B-3** (nginx de front) feitos. Falta a **VPS**
> (infra do dono) e a **emissão do cert wildcard** (DNS-01). Peças:
> - `frps.toml` — túnel + loopback + menor privilégio + **server-plugin de login** ligado (B-2).
> - `frp-login-shim.mjs` — shim de loopback que repassa o login-plugin ao control-plane e injeta o
>   `x-frp-plugin-token` (o frp não adiciona headers custom).
> - `nginx/` — site do front: subdomínio por DVR, TLS wildcard (DNS-01), `auth_request → /_dvr_auth`,
>   `sub_filter` do WebSocket hardcoded, **upstream dinâmico** por `auth_request_set`. Ver `nginx/README.md`.

## Regra-mãe (contratos §2 / spec)
- O `frps`/porta bruta **nunca** exposto publicamente. As portas de túnel nascem em
  `127.0.0.1` (`proxyBindAddr`); a internet só fala com o nginx (443), que exige login.
- **Menor privilégio:** `maxPortsPerClient = 1` → um coletor expõe **um** host:porta (o DVR dele).
- **Sem segredo no repo** (invariante 6): `{{FRP_TOKEN}}`/`{{FRP_DASH_*}}` vêm de env/secret
  manager na VPS, injetados no `frps.toml` no deploy (nunca commitados).

## Deploy (a VPS é ação de infra do dono — não é provisionada por aqui)
VPS **dedicada e isolada** do control-plane. Firewall: só **443** (nginx, onda B-3) e **7000**
(frps) públicos; dashboard do frps só em loopback; SSH por chave.

1. Instalar `frp` (>= 0.52) na VPS.
2. Materializar `/etc/frp/frps.toml` a partir deste arquivo, substituindo os `{{PLACEHOLDERS}}`
   pelos segredos do secret manager (ex.: `envsubst < frps.toml > /etc/frp/frps.toml`).
3. Subir como serviço: `frps -c /etc/frp/frps.toml` (systemd unit recomendado).
4. Conferir o dashboard em `http://127.0.0.1:7500` (só via SSH tunnel — nunca público).

Smoke local (sem VPS): `frps -c relay/frps.toml` deve subir, escutar em `:7000` e o dashboard
em `127.0.0.1:7500` (com os placeholders trocados por valores de teste).

## Login-plugin (B-2)
O `frps.toml` liga o server-plugin (`ops = ["Login","NewProxy"]`) apontando para o **shim de
loopback** (`frp-login-shim.mjs`, `127.0.0.1:9001`), que repassa a chamada ao control-plane
(`POST /api/dvr/frp-login`) **injetando** `x-frp-plugin-token` — necessário porque o frp **não**
adiciona headers custom ao plugin. A decisão (accept/reject da `site_key`) é 100% do control-plane
(C-be-4). `addr` alternativo (direto ao control-plane) documentado no `frps.toml`. Subir o shim:
```sh
CP_URL=https://coletor.box3.software CP_FRP_PLUGIN_TOKEN=... node relay/frp-login-shim.mjs
```

## nginx de front (B-3)
Em `nginx/` — subdomínio por DVR, TLS wildcard (DNS-01), `auth_request → /_dvr_auth`, `sub_filter`
do WebSocket hardcoded e **upstream dinâmico** alimentado pelo `/_dvr_auth`. Validado com `nginx -t`.
Ver [`nginx/README.md`](./nginx/README.md).

## Falta (infra do dono / hardware)
- **VPS dedicada** (frps + shim + nginx + hardening) e a **emissão do cert wildcard** (DNS-01).
- Homologação com **DVR real** (WS 7681/7682, live view) — spike de hardware (F5).
