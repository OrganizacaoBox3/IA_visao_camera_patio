# Ponte DVR — Relay CO-RESIDENTE no servidor do hub (`cam.box3.software`)

> Opção (a): o relay (frps + shim + nginx do DVR) roda no **mesmo servidor** que já serve o hub
> (`cam.box3.software`, systemd `visao-hub`). Reusa o nginx e o tooling de cert que já existem lá.
> Nada disso sai por agente/CI: o usuário de deploy tem **sudo restrito** (só `visao-hub`/`box3-backoffice`),
> e instalar frp/nginx-site/cert exige **root**. Este runbook é pra ser executado por quem tem root.
>
> Artefatos deste diretório: `frps.toml` (túnel + login-plugin), `frp-login-shim.mjs` (injeta o token),
> `nginx/dvr.conf` (front `*.dvr.box3.software` → `/_dvr_auth` no hub), `systemd/*.service`.

## 0. Pré-flight — o `libfrpc.so` já está no app
O APK do TC22 já embute `libfrpc.so` (frp **v0.61.1**, arm64). Use **frps da mesma linha 0.61.x** no
servidor (compatibilidade cliente↔servidor). O app dial `serverAddr:7000` com TLS forçado + token.

## 1. DNS (VOCÊ cria, no provedor de DNS) — 2 registros → IP do servidor do hub
- `relay.box3.software`      A → `<IP do servidor>`   (o frpc do app disca aqui: `relay.box3.software:7000`)
- `*.dvr.box3.software`      A → `<IP do servidor>`   (subdomínio por DVR servido pelo nginx)

## 2. Cert wildcard `*.dvr.box3.software` (root) — Let's Encrypt DNS-01 (wildcard não faz HTTP-01)
```sh
# Ex. com o plugin de DNS do seu provedor; ou --manual --preferred-challenges dns.
sudo certbot certonly --preferred-challenges dns -d '*.dvr.box3.software'
# Deve gerar /etc/letsencrypt/live/dvr.box3.software/{fullchain,privkey}.pem
```

## 3. Instalar o frp (root)
```sh
FRP_VER=0.61.1
curl -fsSL -o /tmp/frp.tgz "https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz"
tar -xzf /tmp/frp.tgz -C /tmp
sudo install -m 0755 /tmp/frp_${FRP_VER}_linux_amd64/frps /usr/local/bin/frps
```

## 4. Segredos (root) — gere UMA vez; os PARES têm que bater (hub ↔ frps ↔ shim)
```sh
FRP_TOKEN=$(openssl rand -base64 32)          # auth.token do frps  ==  CP_RELAY_TOKEN do hub
FRP_PLUGIN_TOKEN=$(openssl rand -base64 32)    # trava do shim       ==  CP_FRP_PLUGIN_TOKEN do hub
FRP_DASH_USER=admin; FRP_DASH_PASS=$(openssl rand -base64 24)   # dashboard do frps (só loopback)
```

## 5. `frps.toml` (root) — materialize trocando os `{{PLACEHOLDERS}}`
```sh
sudo mkdir -p /etc/frp
sudo env FRP_TOKEN="$FRP_TOKEN" FRP_DASH_USER="$FRP_DASH_USER" FRP_DASH_PASS="$FRP_DASH_PASS" \
  sh -c 'sed -e "s#{{FRP_TOKEN}}#$FRP_TOKEN#" -e "s#{{FRP_DASH_USER}}#$FRP_DASH_USER#" \
             -e "s#{{FRP_DASH_PASS}}#$FRP_DASH_PASS#" relay/frps.toml > /etc/frp/frps.toml'
sudo chmod 600 /etc/frp/frps.toml
```

## 6. Shim do login-plugin (root) — coloca o código + env + serviço
```sh
sudo mkdir -p /opt/ponte-dvr-relay
sudo cp relay/frp-login-shim.mjs /opt/ponte-dvr-relay/
# env do shim (chmod 600). CP_URL aponta pro hub (público é robusto; loopback tb serve se souber a porta).
printf 'CP_URL=https://cam.box3.software\nCP_FRP_PLUGIN_TOKEN=%s\n' "$FRP_PLUGIN_TOKEN" | sudo tee /etc/frp/shim.env >/dev/null
sudo chmod 600 /etc/frp/shim.env
sudo cp relay/systemd/frp-login-shim.service /etc/systemd/system/
sudo cp relay/systemd/frps.service          /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frp-login-shim.service frps.service
```

## 7. nginx do DVR (root) — adiciona o site (o cert do passo 2 já existe)
```sh
sudo cp relay/nginx/dvr.conf /etc/nginx/sites-available/ponte-dvr.conf
sudo ln -sf /etc/nginx/sites-available/ponte-dvr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx     # NÃO tocar nos outros sites (cam.box3.software intacto)
```

## 8. Env do HUB (root) — o hub precisa emitir o MESMO token/host que o frps espera
No serviço do hub (`systemctl edit visao-hub` → `[Service]` Environment, ou o EnvironmentFile dele):
```
CP_RELAY_ADDR=relay.box3.software     # onde o app disca (casa com o DNS do passo 1)
CP_RELAY_PORT=7000
CP_RELAY_TOKEN=<mesmo FRP_TOKEN do passo 4>
CP_FRP_PLUGIN_TOKEN=<mesmo FRP_PLUGIN_TOKEN do passo 4>
CP_DVR_HOST_SUFFIX=dvr.box3.software
```
Depois: `sudo systemctl restart visao-hub`.

## 9. Firewall (root)
```sh
sudo ufw allow 7000/tcp   # frps (443 já está aberto pro nginx). Dashboard 7500 fica SÓ loopback.
```

## 10. Smoke + reconectar
- `sudo systemctl status frps frp-login-shim` → ambos `active`.
- Dashboard do frps (só via SSH tunnel): `ssh -L 7500:127.0.0.1:7500 <server>` → `http://127.0.0.1:7500`.
- No app (TC22): reabra a sessão do DVR (o `frpc` vai discar `relay.box3.software:7000`, o frps chama o
  shim → hub `frp-login` autoriza → túnel sobe em `127.0.0.1:<20000-20099>`).
- No painel `cam.box3.software/dvrs` → **Abrir DVR** → o nginx resolve o upstream pelo `/_dvr_auth` e serve
  a web do DVR. (Login do técnico: o hub seta o cookie `cp_session` em `.box3.software` — já implementado.)

## Pares de segredo que TÊM que bater (a causa nº1 de "não conecta")
| valor            | frps (`/etc/frp/frps.toml`) | shim (`/etc/frp/shim.env`) | hub (`visao-hub` env) |
|------------------|-----------------------------|----------------------------|-----------------------|
| token do túnel   | `auth.token` = FRP_TOKEN    | —                          | `CP_RELAY_TOKEN`      |
| token do plugin  | —                           | `CP_FRP_PLUGIN_TOKEN`      | `CP_FRP_PLUGIN_TOKEN` |
| host do relay    | (escuta :7000)              | —                          | `CP_RELAY_ADDR` = `relay.box3.software` |

## Hardening pendente (F5, anotado)
- nginx: **remover `cp_session` do Cookie** antes de proxyar pro upstream do DVR (não vazar o token de
  sessão pro firmware) — sem apagar os cookies do próprio DVR. Ver nota em `nginx/dvr.conf`.
- Status "Acesso ativo" reflete a sessão no hub, não um túnel verificado; ligar o report de liveness
  do frps→hub é um endurecimento futuro.
