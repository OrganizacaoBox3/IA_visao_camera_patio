# Ponte DVR — Relay (frp server) · skeleton

Servidor de túnel reverso (`frps`) da Ponte DVR. O coletor (app `app-ponte-dvr`) sobe um `frpc`
que expõe **só a porta web do DVR** para uma porta de **loopback** nesta VPS; o técnico alcança
essa porta **sempre atrás de login** (nginx `auth_request` → control-plane do visão). Desenho
completo: `../../box3-mobile/planejamento/ponte-dvr/de-risking/relay-proxy.md`.

> **Estado:** SKELETON (tarefa B-1). Só `frps.toml` (túnel + loopback + menor privilégio). O
> login-plugin (B-2/C-be-4) e o nginx de front com `auth_request`/`sub_filter` (B-3) são das
> próximas ondas.

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

## Próximas ondas
- **B-2 / C-be-4:** login-plugin do `frps` valida a `site_key` do coletor contra o control-plane
  do visão (Opção A, contratos §8). Placeholder comentado no fim do `frps.toml`.
- **B-3:** nginx (subdomínio por DVR, TLS wildcard DNS-01, `auth_request` → `/_dvr_auth`,
  `sub_filter` p/ host/porta de WebSocket hardcoded do DVR).
