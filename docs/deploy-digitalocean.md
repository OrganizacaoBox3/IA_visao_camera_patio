# Deploy na DigitalOcean — Visão de Pátio

Roteiro passo-a-passo para rodar o `visao_computacional_mvp` na sua melhor versão na VPS
da DigitalOcean. **Cenário real desta VPS:** ela é compartilhada — as portas **80/443 já
são do nginx existente** e há vários serviços rodando. Então **não** subimos um web server
próprio na 443; em vez disso adicionamos **um server block** ao nginx que já está lá.

- Web server público: **nginx existente** (TLS na 443).
- Hub de câmeras (Node/socket.io): porta interna **8091**, só no loopback.

---

## 0. Arquitetura

```
                          ┌──────────────────── VPS compartilhada ─────────────────────┐
  Navegador (operador)    │                                                              │
  câmera + dashboard      │   nginx :443 (TLS já existente)                              │
        │  HTTPS/wss       │    ├─ /socket.io/*  → proxy → hub Node 127.0.0.1:8091        │
        └──────────────────┼──► └─ /*            → /var/www/visao-patio/dist (estático)   │
                          │                          ▲                                   │
  Celular = nó de câmera   │            systemd: visao-hub (node server/index.js)         │
        │  HTTPS/wss       │            HOST=127.0.0.1  PORT=8091  (não exposto)          │
        └──────────────────┘                                                              │
                          └──────────────────────────────────────────────────────────────┘
```

Decisões que sustentam este deploy:

- **HTTPS é obrigatório** — `getUserMedia` (acesso à câmera) só funciona em *secure context*.
- **wss mesma origem** — página `https://` não abre `ws://` (mixed-content). O `config.ts` em
  produção usa `location.origin`; o nginx faz proxy de `/socket.io` para o hub local. A porta
  8091 **nunca** é exposta à internet.
- **O processamento de visão roda no NAVEGADOR**, não no servidor. O hub só relaia frames
  (banda). Por isso ele é leve e fica no loopback; o nginx é quem serve o estático (rápido).
- **Portas já ocupadas nesta VPS** (não reutilizar): 22, 80, 443, 1880, 3000, 3050, 3306,
  5050, 5432-5433, 6000-6002, 6379-6380, 7171, 8000-8001, 8080, 8090, 8181, 8777, 9000-9003,
  9191, 9866, 9876, 9988, 27017, 33060, 55432. **Escolhida para o hub: 8091** (livre).

---

## 1. Pré-requisitos

- Subdomínio apontando para o IP da VPS, ex. `visao.seudominio.com` (registro **A**).
- Acesso SSH com sudo. nginx e certbot já presentes (típico nesta VPS).

---

## 2. Preparar a pasta e o usuário do hub

```bash
ssh usuario@IP_DA_VPS

# Node 20 — confirme; se faltar, instale via NodeSource:
node -v || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs)

# (Opcional) ffmpeg — só se for ingerir câmeras IP/RTSP:
# sudo apt install -y ffmpeg

# Usuário sem privilégios p/ o hub + pasta da app
sudo adduser --system --group --no-create-home visao
sudo mkdir -p /var/www/visao-patio
```

> **Não mexa no firewall/nginx das outras apps.** Não vamos abrir nenhuma porta nova: a 8091
> fica no loopback e o tráfego público entra pela 443 que já está liberada.

---

## 3. Build local e upload

Build é feito **na sua máquina** (Windows); só o resultado sobe.

Na pasta do projeto (`visao_computacional_mvp`):

```powershell
npm install
npm run build      # gera dist/  (tsc + vite)
```

Suba `dist/`, `server/`, `package.json`, `package-lock.json` e a pasta `deploy/`:

```powershell
scp -r dist server deploy package.json package-lock.json usuario@IP_DA_VPS:/tmp/visao-up/
```

No servidor, posicione os arquivos e instale só as deps de produção do hub:

```bash
sudo cp -r /tmp/visao-up/* /var/www/visao-patio/
cd /var/www/visao-patio
sudo npm install --omit=dev          # o hub só precisa de socket.io
sudo chown -R visao:visao /var/www/visao-patio
```

> `--omit=dev`: React/Vite/TF.js são deps de *build*, já compiladas dentro de `dist/`. O hub
> (`server/index.js`) em runtime só usa `socket.io`.

---

## 4. Subir o hub com systemd (porta 8091, loopback)

```bash
sudo cp /var/www/visao-patio/deploy/visao-hub.service /etc/systemd/system/visao-hub.service
sudo systemctl daemon-reload
sudo systemctl enable --now visao-hub
systemctl status visao-hub --no-pager       # "active (running)"
journalctl -u visao-hub -n 20 --no-pager    # "ouvindo em http://127.0.0.1:8091"
```

O unit (`deploy/visao-hub.service`) já fixa `HOST=127.0.0.1`, `PORT=8091`, `Restart=always`
e roda como o usuário `visao`.

---

## 5. Configurar o nginx (server block novo)

```bash
sudo cp /var/www/visao-patio/deploy/nginx-visao.conf /etc/nginx/conf.d/visao.conf
sudo nano /etc/nginx/conf.d/visao.conf    # troque visao.seudominio.com
```

Emita o certificado reaproveitando o certbot já instalado (preenche o SSL no server block):

```bash
sudo certbot --nginx -d visao.seudominio.com
sudo nginx -t && sudo systemctl reload nginx
```

O `deploy/nginx-visao.conf` já faz: serve `dist/` (SPA com fallback p/ `index.html`), proxy
`/socket.io/ → 127.0.0.1:8091` com upgrade de WebSocket, e os headers de CSP/Permissions-Policy.

> **Atenção a um conflito comum:** se o `nginx.conf` global já define
> `map $http_upgrade $connection_upgrade`, remova as 4 linhas do `map` no topo do arquivo
> (duplicar dá erro no `nginx -t`). O comentário no arquivo marca exatamente onde.

---

## 6. Validação (checklist)

Abra `https://visao.seudominio.com`:

- [ ] Cadeado válido (TLS ok).
- [ ] Dashboard carrega; rodapé mostra **"conectado"** (socket.io via wss).
- [ ] Abra `/camera` no **celular** (mesma URL pública), permita a câmera → o nó aparece no
      dashboard e o feed renderiza.
- [ ] Desenhe uma zona (atividade/leitura/objetos) e confirme detecção.
- [ ] `curl -sS http://127.0.0.1:8091/socket.io/?EIO=4` responde **no servidor**, mas a 8091
      **não** é alcançável de fora (`nc -z IP_DA_VPS 8091` deve falhar).
- [ ] DevTools → Console sem erros de CSP nem de mixed-content.

---

## 7. Segurança e operação

- **Acesso restrito (task #25 — feito).** O app tem login por senha compartilhada, validada
  **no hub** (rejeita dashboard E câmeras sem o token correto). Defina `PANEL_PASSWORD` no
  systemd (`deploy/visao-hub.service`, bloco comentado) e `restart` o hub. A senha nunca vai no
  bundle — só trafega no handshake por wss/TLS. Reforço opcional: `auth_basic` no nginx por cima
  (esconde até a tela de login). Obs.: o token fica em `localStorage` (texto) no cliente.
- **Histórico é por navegador (IndexedDB).** Cada operador vê o histórico da própria máquina;
  não há agregação central (futuro: persistir indicadores no servidor).
- **Andon (saída de alerta).** Defina `ALERT_WEBHOOK_URL` no systemd (`deploy/visao-hub.service`)
  para repassar alertas críticos a Slack/Teams/Discord/Zapier/n8n ou endpoint próprio. O hub aplica
  dedup (`ALERT_DEDUP_MS`). A URL fica só no servidor — nunca no bundle. Sem a env, o andon fica off.
- **Modelos de visão vêm de CDNs** (jsDelivr, HuggingFace, storage.googleapis.com). O navegador
  do operador precisa de internet na 1ª carga (depois ficam em cache). Operação 100% offline é
  a task #48 (auto-hospedar os modelos atrás do próprio nginx).
- **Banda escala com câmeras × espectadores** — cada frame passa câmera → hub → cada dashboard.
- **Atualizar a app:** refaça `npm run build` local, suba o novo `dist/` e
  `sudo systemctl reload nginx` (estático). O hub só reinicia se `server/` mudar:
  `sudo systemctl restart visao-hub`.

---

## 8. (Opcional) Câmeras IP / RTSP

Para ingerir câmeras IP no servidor (em vez de nós de navegador), o hub usa **ffmpeg** (passo 2).
Configure as fontes por env no systemd (`deploy/visao-hub.service`, bloco comentado) **ou** crie
`server/rtsp.sources.json`:

```json
[{ "label": "Doca 1", "url": "rtsp://user:senha@10.0.0.5:554/stream" }]
```

Depois `sudo systemctl restart visao-hub`. As câmeras RTSP aparecem no dashboard como qualquer
outra. Para baixa latência em produção séria, considere WebRTC (go2rtc/mediamtx) no futuro.
