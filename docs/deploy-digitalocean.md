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
- **A análise de indicadores roda NO HUB** (motor **D-FINE-S** em worker process,
  `server/analysis/`, 24/7 sem espectador — ADR-009). O navegador é **espelho** (vídeo +
  overlays servidos) e roda só os **modos especializados** (fadiga/leitura/objetos). O hub
  continua relaiando frames (banda) e fica no loopback atrás do nginx (que serve o estático),
  **mas a CPU do hub NÃO é mais desprezível**: ele consome CPU proporcional ao nº de câmeras
  (~**7 câmeras/core** no modelo S default; ~**17/core** no N — `ANALYSIS_MODEL=n|s|m`).
  Dimensione o droplet pela contagem de câmeras, não só pela banda.
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

> **NUNCA suba o `node_modules/` do Windows.** O hub agora depende de binários **nativos**
> (`onnxruntime-node`, `sharp`) que precisam ser compilados/baixados **para o SO do servidor
> (Linux)**. Suba só o `package.json`/`package-lock.json` e rode o `npm install` NO servidor.

No servidor, posicione os arquivos e instale só as deps de produção do hub:

```bash
sudo cp -r /tmp/visao-up/* /var/www/visao-patio/
cd /var/www/visao-patio
sudo npm install --omit=dev          # instala as deps de RUNTIME do hub (nativas incluídas)
sudo chown -R visao:visao /var/www/visao-patio
```

> `--omit=dev`: React/Vite/TF.js são deps de *build*, já compiladas dentro de `dist/`. Mas o hub
> em runtime **não é mais só `socket.io`**: precisa de `onnxruntime-node` + `sharp` (o motor de
> análise D-FINE — binários nativos Linux), `pg` (Postgres) e `pino` (logs). Todas estão em
> `dependencies`, então o `--omit=dev` as cobre. Requisito: **toolchain de build presente no
> servidor** (`build-essential`/`python3` — normalmente já há prebuilts para Linux x64, mas
> tenha-os caso o `npm install` precise compilar).

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

### 4.1 Motor de análise (D-FINE) — modelo e envs

O hub agora sobe um **worker process de análise** (`server/analysis/`). Ele precisa de um modelo
ONNX (`server/models/`, **gitignored**) — que **não vem no upload**:

- **1º boot COM internet de saída:** com `ANALYSIS_ENABLED=1`, o hub **baixa o `.onnx` no boot**
  (onnx-community, Apache-2.0), verificando **tamanho + sha256** (escrita atômica). Default `s` =
  `dfine_s_obj2coco.onnx` (~**40 MB**). Depois do 1º download o default liga sozinho.
- **Sem internet de saída no servidor:** copie o `.onnx` do modelo escolhido para
  `server/models/` **antes** do boot (ex.: `scp`), ou aponte `ANALYSIS_MODEL_PATH=<arquivo.onnx>`.
  O boot valida o sha e segue; sem modelo e sem rede, o motor desliga (o hub segue normal).
- **Fallback:** se o download do S/M falhar (e `ANALYSIS_MODEL_PATH` não estiver fixado), o motor
  **cai para o N** com aviso. Fixe `ANALYSIS_MODEL=n` para evitar esse caminho.

Envs do motor (defina no systemd `deploy/visao-hub.service`; ver `server/analysis/README.md`):

| Env | Default | Função |
|-----|---------|--------|
| `ANALYSIS_ENABLED` | *(liga se o modelo já existe)* | `1` liga e **baixa** o modelo no boot; `0` desliga. Rode o 1º boot com `1`. |
| `ANALYSIS_MODEL` | `s` (`n\|s\|m`) | Modelo/custo: **N** ~17 cam/core (menos recall), **S** ~7 cam/core (produção), **M** ~4 cam/core. |
| `ANALYSIS_FPS` | `1` | Taxa de análise por câmera (1–2 fps). |
| `ANALYSIS_MODEL_PATH` | — | Fixa um `.onnx` explícito (ignora `ANALYSIS_MODEL` e o fallback — útil sem internet). |

Verifique o motor pós-boot: `GET /api/analysis/status` (autenticado) mostra
`{ enabled, model, targetFps, worker:{ready,pid,...}, perCamera:{ [id]: {fps, queue, ...} } }`.

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
- [ ] Motor de análise vivo: `GET /api/analysis/status` (autenticado) mostra `worker.ready:true`
      e o modelo esperado — **sem** abrir nenhum dashboard (a análise roda no hub, 24/7).
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
- **Histórico é persistido no HUB** (centralizado — não é mais por navegador). Vai para o
  **Postgres** quando configurado (`PG*`/`DATABASE_URL`; `server/schema.sql` idempotente, aplicado
  no boot) e cai para **fallback JSON** (`server/data-hist.json`, gitignored, escrita atômica) sem
  Postgres ou se o PG falhar. Só indicadores agregados/metadados — nunca imagens (LGPD/ADR-002).
- **Andon (saída de alerta).** Defina `ALERT_WEBHOOK_URL` no systemd (`deploy/visao-hub.service`)
  para repassar alertas críticos a Slack/Teams/Discord/Zapier/n8n ou endpoint próprio. O hub aplica
  dedup (`ALERT_DEDUP_MS`). A URL fica só no servidor — nunca no bundle. Sem a env, o andon fica off.
- **Modelos de visão — dois lugares agora.** (1) Os **modos do navegador** (fadiga/leitura/objetos)
  vêm de CDNs (jsDelivr, HuggingFace, storage.googleapis.com): o navegador do operador precisa de
  internet na 1ª carga (depois ficam em cache). (2) O **motor do hub** baixa o ONNX do D-FINE no 1º
  boot (`server/models/`, ~40 MB no S, sha conferido — ver §4.1): o **servidor** precisa de internet
  de saída no 1º boot **ou** o `.onnx` subido manualmente + `ANALYSIS_MODEL_PATH`. Operação 100%
  offline do navegador é a task #48 (auto-hospedar os modelos do cliente atrás do próprio nginx).
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
