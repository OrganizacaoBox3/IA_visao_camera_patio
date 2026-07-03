# 07 — Deploy, Infraestrutura e Testes (E2E)

> Documento de referência técnica do **MVP Visão de Pátio** (`visao_computacional_mvp`).
> Cobre execução local, arquitetura de deploy em produção (nginx + systemd + DigitalOcean),
> variáveis de ambiente, a suíte de testes E2E com Playwright e ponteiros para os manuais de
> operação de câmeras/leitores.
>
> Baseado exclusivamente no código real do repositório. Pontos incertos estão marcados como
> **(a confirmar)**.

---

## 1. Visão geral da arquitetura

O projeto tem **dois processos** (mais um **worker process** de análise dentro do hub):

1. **Frontend SPA (React + Vite)** — é **espelho** da análise do hub (exibe vídeo + overlays
   servidos via `analysis-tracks`) e roda no navegador apenas os **modos especializados**
   (Fadiga/MediaPipe, Leitura/ZXing, Objetos/OWL-ViT). Em produção é servido como estático
   (`dist/`) pelo nginx. **Mudança da ADR-009:** a análise de indicadores (pessoas/atividade/
   fluxo) **saiu do navegador** e passou para o hub.
2. **Hub Node (`server/index.js`)** — servidor socket.io que relaia frames câmera → dashboard,
   expõe a API HTTP (`/api/`) de login/gestão/status e **agora roda o motor de análise
   D-FINE-S** num worker process dedicado (`server/analysis/`, ADR-009), 24/7 e independente de
   espectador. Consome os frames que já transitam pelo relé; não persiste vídeo. Persiste
   histórico/usuários/config em PostgreSQL quando configurado, com **fallback JSON**
   (`server/data-hist.json`). **Implicação de deploy:** o hub passa a ter **custo de CPU
   proporcional às câmeras** (~7 câmeras/core no modelo S; ~17 no N — `ANALYSIS_MODEL`).

Fluxo em produção (resumo de `docs/deploy-digitalocean.md`):

```
Navegador (dashboard + /camera)
        │  HTTPS / wss (mesma origem)
        ▼
   nginx :443 (TLS)
   ├─ /socket.io/*  → proxy → hub Node 127.0.0.1:8091  (upgrade WebSocket)
   ├─ /api/*        → proxy → hub Node 127.0.0.1:8091
   └─ /*            → /var/www/visao-patio/dist  (SPA estática)
        ▲
   systemd: visao-hub (node server/index.js), HOST=127.0.0.1 PORT=8091 (loopback)
```

Decisões-chave (de `docs/deploy-digitalocean.md:28`):

- **HTTPS é obrigatório** — `getUserMedia` (acesso à câmera) só funciona em *secure context*.
- **wss na mesma origem** — página `https://` não abre `ws://` (mixed-content). O front usa
  `location.origin` em produção (`src/config.ts:143`) e o nginx faz o proxy de `/socket.io`.
- **A porta do hub nunca é exposta** à internet — fica só no loopback; o nginx é o único que a alcança.
- **A análise de indicadores roda no HUB** (motor D-FINE-S em worker process, ADR-009), não mais
  no navegador. O hub continua no loopback pela rede, mas **não é mais "leve"**: além da banda do
  relé, consome CPU proporcional às câmeras — dimensione o servidor pela contagem de câmeras.

---

## 2. Como rodar localmente

Pré-requisito: **Node >= 20** (`package.json:14-16`).

### 2.1 Scripts disponíveis (`package.json:6-13`)

| Script | Comando | O que faz |
|--------|---------|-----------|
| `npm run dev` | `vite --host` | Sobe o **frontend** em modo dev com HMR. `--host` expõe na LAN (celular acessa o IP do laptop). |
| `npm run build` | `tsc && vite build` | Checagem de tipos + build de produção → gera `dist/`. |
| `npm run preview` | `vite preview` | Serve o `dist/` localmente para validar o build. |
| `npm run hub` | `node server/index.js` | Sobe o **hub** de câmeras (socket.io + API). |
| `npm run start` | `node server/index.js` | Idêntico a `hub` (alias de produção). |
| `npm run e2e` | `playwright test` | Roda a suíte de testes E2E (ver seção 6). |
| `npm run verify` | `lint && typecheck && build && test` | Gate local (ESLint + `tsc --noEmit` + Vite build + Vitest). Vermelho não entra. |
| `npm run eval` | `node eval/gate.mjs` | **Sensor de regressão de acurácia** do motor de análise (roda o worker de produção sobre o fixture COCO commitado e compara com `eval/thresholds.json`). **NÃO** entra no `verify` — é gate manual/CI opcional, rode antes de trocar modelo/threshold. |

### 2.2 Sessão de desenvolvimento típica

Em dois terminais:

```powershell
# Terminal 1 — hub (socket.io). Default: HOST=0.0.0.0, PORT=4000.
npm run hub

# Terminal 2 — frontend (Vite dev server, default :5173)
npm run dev
```

- **Resolução do endpoint do hub no front** (`src/config.ts:140-144`):
  1. `VITE_HUB_URL` (build-time) — força um endpoint explícito.
  2. Em produção (não-DEV): **mesma origem** (`location.origin`) → wss no mesmo domínio.
  3. Em dev: `http://<location.hostname>:4000` — permite o celular apontar para o IP do laptop.
- **Porta do hub em dev = 4000** (`server/index.js:15`), `HOST=0.0.0.0` (`server/index.js:18`)
  para o celular alcançar o laptop. Em produção o systemd fixa `127.0.0.1:8091`.
- **Headers de segurança em dev/preview** vêm do `vite.config.ts` (CSP, Permissions-Policy,
  X-Content-Type-Options). Em produção, esses headers são responsabilidade do nginx (seção 4).

### 2.3 Nó de câmera

A tela de câmera é uma rota da própria SPA: `/camera` (opcionalmente
`/camera?key=<token>&name=<nome>`). Em dev, abra `http://<ip-do-laptop>:5173/camera` no celular.
O dashboard lista os nós conectados.

---

## 3. Variáveis de ambiente

### 3.1 Frontend (build-time, prefixo `VITE_`)

Arquivo de referência: `.env.production.example`.

| Variável | Obrigatória? | Descrição |
|----------|--------------|-----------|
| `VITE_HUB_URL` | **Não** (opcional) | Força o endpoint do hub. Na maioria dos casos **não** precisa: em produção o front usa a **mesma origem** (`wss://seu-dominio/socket.io`) via reverse proxy. Só defina se o hub estiver em outro host/domínio (ex.: hub dedicado). |

> **Nota de discrepância (a confirmar):** o comentário em `.env.production.example` menciona
> reverse proxy do **Caddy**, e `src/config.ts:137` também cita "Caddy/nginx". Já o deploy real
> documentado (`docs/deploy-digitalocean.md`) e os arquivos em `deploy/` usam **nginx**. O Caddy
> parece ser de uma versão anterior; o stack atual é nginx.

Para usar: copie `.env.production.example` → `.env.production` e ajuste se necessário.

### 3.2 Hub Node (runtime) — todas as envs detectadas no código

Levantadas via `process.env.*` em `server/`:

| Variável | Onde é lida | Default | Função |
|----------|-------------|---------|--------|
| `PORT` | `server/index.js:15` | `4000` | Porta do hub. Produção: `8091`. |
| `HOST` | `server/index.js:18` | `0.0.0.0` | Interface de escuta. Produção: `127.0.0.1` (loopback). |
| `NODE_ENV` | (systemd) | — | `production` em produção. |
| `AUTH_SECRET` | `server/users.js:10` | — | **Assina os tokens de sessão.** Defina um valor forte e único em produção. |
| `AUTH_TTL_MS` | `server/users.js:11` | — | Tempo de vida do token de sessão. |
| `SUPERADMIN_USER` | `server/users.js:68` | — | Cria o superadmin no 1º boot (se `users.json` vazio). |
| `SUPERADMIN_PASSWORD` | `server/users.js:68` | — | Senha do superadmin inicial — troque depois. |
| `CAMERA_TOKEN` | `server/index.js:84,153` | — | (opcional) Token de dispositivo p/ nós `/camera` autenticarem sem login humano. |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `server/db.js:22-25,12` | — | Conexão PostgreSQL (histórico + usuários + destinatários + config). Schema aplicado no boot (`server/schema.sql`). |
| `DATABASE_URL` | `server/db.js:15,19,20` | — | Alternativa ao conjunto `PG*` (connection string única). |
| `VISAO_DB` | `server/db.js:12` | — | Nome de banco alternativo (a confirmar — fallback de `PGDATABASE`). |
| `RTSP_SOURCES` | `server/rtsp.js:23` | — | Fontes RTSP via env (`Label=rtsp://...;Outra=rtsp://...`). |
| `RTSP_FPS` | `server/rtsp.js:98` | `8` | FPS de ingestão RTSP. |
| `RTSP_WIDTH` | `server/rtsp.js:99` | `480` (a confirmar) | Largura do frame RTSP. |
| `RTSP_QUALITY` | `server/rtsp.js:100` | `7` | Qualidade JPEG (menor = melhor). |
| `ANALYSIS_ENABLED` | `server/analysis/` | *(liga se o modelo já existe)* | Motor D-FINE no hub. `1` liga e **baixa o modelo no boot** se ausente; `0` desliga. Rode o 1º boot com `1`. |
| `ANALYSIS_MODEL` | `server/analysis/` | `s` (`n\|s\|m`) | Modelo/custo: **N** ~17 cam/core (menos recall), **S** ~7 cam/core (produção), **M** ~4 cam/core. Drop-in — só troca o `.onnx`. |
| `ANALYSIS_FPS` | `server/analysis/` | `1` | Taxa de análise por câmera (1–2 fps), 24/7. |
| `ANALYSIS_MODEL_PATH` | `server/analysis/` | — | Fixa um `.onnx` explícito (ignora `ANALYSIS_MODEL` e o fallback) — usado sem internet e pelo `eval/`. |
| `WHATSAPP_ENABLED` | `server/whatsapp.js:12` | — | `1` liga o WhatsApp (Baileys, não-oficial). Pareie por QR no painel. |
| `ALERT_WEBHOOK_URL` | `server/alerts.js:7` | — | Andon: repassa alertas críticos a Slack/Teams/Discord/Zapier/n8n. Sem ela, o andon fica off. |
| `ALERT_DEDUP_MS` | `server/alerts.js:8`, `server/dispatch.js:10` | — | Janela anti-repetição de alertas (ms). |

> **Discrepância (a confirmar):** `docs/deploy-digitalocean.md:157` menciona `PANEL_PASSWORD`
> como variável de senha do painel. Essa variável **não** aparece no código atual do `server/`
> — a autenticação evoluiu para `AUTH_SECRET` + usuários (`server/users.js`) + `SUPERADMIN_*`.
> O texto do manual de deploy parece desatualizado nesse ponto.

> **Envs adicionais do motor** (defaults e detalhe em `server/analysis/README.md`):
> `ANALYSIS_HIGH_SCORE` (0.35), `ANALYSIS_SCORE_MIN` (0.25), `ANALYSIS_AGG_MS` (3000),
> `ANALYSIS_INTRA_THREADS` (2), `ANALYSIS_NMS_IOU` (0.6). E `DATA_HIST_RETENTION_DAYS` (30 —
> poda do fallback JSON, `server/pgstore.js:21`). Status ao vivo: `GET /api/analysis/status`
> (autenticado) expõe `worker.ready/pid`, modelo, e `fps/queue` por câmera.

**Deps de RUNTIME do hub (novas — ADR-009).** O hub deixou de rodar só com `socket.io`. Em
`package.json > dependencies` agora entram, para runtime do servidor: **`onnxruntime-node`** e
**`sharp`** (motor D-FINE — **binários NATIVOS**, instalar no SO do servidor Linux; **nunca**
subir o `node_modules/` do Windows), **`pg`** (Postgres) e **`pino`** (logs). O
`npm install --omit=dev` cobre todas (estão em `dependencies`, não em `devDependencies`).

**Modelo ONNX (não versionado — `server/models/`, `.gitignore:49-51`).** Não vem no upload:
com `ANALYSIS_ENABLED=1` o hub **baixa o `.onnx` no 1º boot** (onnx-community, Apache-2.0),
verificando tamanho + **sha256** (escrita atômica). Default `s` = `dfine_s_obj2coco.onnx`
(~40 MB). Sem internet de saída no servidor: copie o `.onnx` para `server/models/` antes do boot
ou aponte `ANALYSIS_MODEL_PATH`. Falha de download do S/M cai para o **N** com aviso; sem modelo
algum, o motor desliga e o hub segue relaiando normal.

### 3.3 Onde definir em produção

As envs do hub são definidas no **systemd unit** (`deploy/visao-hub.service:21-48`). Várias já
vêm preenchidas como exemplo (incluindo um `PGPASSWORD` e `PGHOST` reais no arquivo —
**recomenda-se rotacionar/segregar essas credenciais**, a confirmar se são de produção).

---

## 4. Infraestrutura de produção

### 4.1 nginx — reverse proxy + estático (`deploy/nginx-visao.conf`)

Cenário: VPS **compartilhada** onde 80/443 já são de um nginx existente. O arquivo adiciona
**apenas um server block** (subdomínio). Responsabilidades:

1. **Serve a SPA estática** de `/var/www/visao-patio/dist` com fallback SPA
   (`try_files $uri $uri/ /index.html` — `deploy/nginx-visao.conf:82-83`).
2. **Proxy `/socket.io/` → `127.0.0.1:8091`** com upgrade de WebSocket
   (`deploy/nginx-visao.conf:51-62`): `proxy_read_timeout 600s` (conexões wss longas) e
   `proxy_buffering off`.
3. **Proxy `/api/` → `127.0.0.1:8091`** (login/gestão — `deploy/nginx-visao.conf:65-71`).
4. **Headers de segurança** (`deploy/nginx-visao.conf:43-47`) que espelham o `vite.config.ts`:
   CSP, Permissions-Policy (`camera=(self)`), X-Content-Type-Options, Referrer-Policy e HSTS.
   Todos com `always` para valer inclusive em respostas de erro.
5. **Cache longo** para `/assets/` (1 ano, `immutable`) — re-aplica os headers de segurança
   porque `add_header` num `location` **substitui** (não herda) os do server
   (`deploy/nginx-visao.conf:75-79`).

Pontos de atenção embutidos no arquivo:

- **`map $http_upgrade $connection_upgrade`** (`deploy/nginx-visao.conf:22-25`): se o
  `nginx.conf` global já define esse `map` (comum), **remova** essas 4 linhas para não duplicar
  (duplicar quebra `nginx -t`).
- **TLS** (`deploy/nginx-visao.conf:28-35`): use o certbot já presente
  (`certbot --nginx -d visao.seudominio.com`) — ele preenche `ssl_certificate`/`listen 443 ssl`.
- **`auth_basic` opcional** (`deploy/nginx-visao.conf:85-88`, comentado): camada extra de senha
  HTTP por cima do login da app.

### 4.2 systemd — serviço do hub (`deploy/visao-hub.service`)

| Campo | Valor | Observação |
|-------|-------|------------|
| `Type` | `simple` | `deploy/visao-hub.service:12` |
| `User` | `visao` | Usuário sem privilégios (`:14`). |
| `WorkingDirectory` | `/var/www/visao-patio` | `:15` |
| `ExecStart` | `/usr/bin/node server/index.js` | `:16` |
| `Restart` | `always`, `RestartSec=3` | Reinício automático (`:17-18`). |
| Envs | `HOST=127.0.0.1`, `PORT=8091`, `NODE_ENV=production`, `AUTH_SECRET`, `PG*`, … | `:21-48` |
| Hardening | `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full` | `:50-52` |
| `WantedBy` | `multi-user.target` | `:55` |

O hub liga **apenas ao loopback na 8091** — só o nginx (mesma máquina) o alcança.

### 4.3 DigitalOcean — resumo do roteiro (`docs/deploy-digitalocean.md`)

O manual completo descreve uma VPS compartilhada com portas já ocupadas; a **8091** foi
escolhida por estar livre. Etapas resumidas:

0. **Arquitetura** — nginx existente na 443; hub Node na 8091 loopback.
1. **Pré-requisitos** — subdomínio (registro A), SSH com sudo, nginx + certbot já presentes.
2. **Preparar pasta/usuário** — instalar Node 20 (NodeSource), `adduser --system visao`,
   `mkdir /var/www/visao-patio`. (ffmpeg só se for ingerir RTSP.)
3. **Build local + upload** — `npm install && npm run build` na máquina dev; `scp` de
   `dist server deploy package.json package-lock.json` (**nunca** o `node_modules/` do Windows);
   no servidor `npm install --omit=dev` (deps de runtime do hub — inclui os binários nativos
   `onnxruntime-node`/`sharp`, além de `pg`/`pino`) e `chown -R visao:visao`.
4. **Subir o hub** — copiar o `.service`, `daemon-reload`, `enable --now visao-hub`.
5. **Configurar nginx** — copiar o `.conf`, ajustar `server_name`, emitir TLS com certbot,
   `nginx -t && systemctl reload nginx`.
6. **Validação** — checklist (TLS, "conectado" no rodapé, `/camera` no celular, zonas, 8091
   inacessível de fora, sem erros de CSP/mixed-content).
7. **Segurança/operação** — login no hub; **histórico persistido no hub** (Postgres com fallback
   JSON `server/data-hist.json`, centralizado — não mais IndexedDB por navegador); andon via
   webhook; modelos do navegador vêm de CDNs (internet na 1ª carga) **e o hub baixa o ONNX do
   D-FINE no 1º boot** (internet de saída OU upload manual + `ANALYSIS_MODEL_PATH`); banda escala
   com câmeras × espectadores e **CPU do hub escala com câmeras** (motor de análise).
8. **(Opcional) RTSP** — ffmpeg + `server/rtsp.sources.json` ou `RTSP_SOURCES`.

---

## 5. .gitignore — o que não é versionado (`.gitignore`)

- **Logs** (`*.log`).
- **Artefatos** (`node_modules`, `dist`, `dist-ssr`, `*.local`).
- **Editor** (`.vscode/*` exceto `extensions.json`, `.idea`, `.DS_Store`).
- **Mídia de demo pesada** (`public/demo/*.mp4`, `*.webm`).
- **`server/rtsp.sources.json`** — fontes RTSP reais, **podem conter credenciais** (`:20`).
- **Estado de runtime do hub** — `server/cameras.json`, `server/alarms.json`, `server/camcfg.json`,
  `server/alarm-shelves.json`, `server/users.json`, `server/wa-auth/`, `deploy/visao-hub.service`.
- **Histórico em fallback JSON** — `server/data-hist.json` (+ `.tmp`) — só indicadores agregados (`:46-47`).
- **Modelo ONNX do motor de análise** — `server/models/` (baixado no boot com verificação de sha,
  ~15–79 MB conforme N/S/M — ver `server/analysis/README.md`) (`:49-51`).
- **Bancada de acurácia** — `eval/data/`, `eval/last-results.json`, `eval/model-comparison.json`
  (dados pesados COCO + resultados de execução; o `eval/fixture/` commitável ~5 MB fica versionado).

Implicação prática: credenciais de câmeras RTSP ficam fora do repositório (configuradas no
servidor). O build (`dist/`) e o **modelo ONNX** também não são versionados — gerados/baixados no
deploy. O histórico agora vive no servidor (Postgres ou `data-hist.json`), não mais no navegador.

---

## 6. Testes E2E (Playwright)

### 6.1 Configuração (`playwright.config.ts`)

| Item | Valor | Ref |
|------|-------|-----|
| `testDir` | `./e2e` | `:7` |
| `timeout` | 90 s por teste; `expect` 20 s | `:8-9` |
| `workers` / `retries` | `1` / `0` | `:10-11` |
| `globalSetup` / `globalTeardown` | `./e2e/global-setup.ts` / `./e2e/global-teardown.ts` | `:13-14` |
| `baseURL` | `http://127.0.0.1:5180` | `:16` |
| `launchOptions.args` | `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream` | `:17` |
| `trace` | `retain-on-failure` | `:18` |
| `projects` | `chromium` (Desktop Chrome) | `:20` |
| `webServer` | `npm run dev -- --port 5180 --host 127.0.0.1 --strictPort`, env `VITE_HUB_URL=http://127.0.0.1:4100` | `:21-27` |

A orquestração (comentário em `playwright.config.ts:2-5`):
- **hub isolado na 4100** subido pelo `global-setup` (sem Postgres, bootstrap admin);
- **Vite dev na 5180** apontando para esse hub via `VITE_HUB_URL`;
- **Chromium com webcam FAKE** para o nó de câmera funcionar headless.

### 6.2 Setup global (`e2e/global-setup.ts`)

Sobe um **hub isolado** para não tocar o estado de dev:

1. Cria um tempdir (`mkdtempSync`) e copia apenas `*.js` e `*.sql` de `server/` para lá
   (`:23-25`) — `users.json`/`wa-auth` ficam só no tempdir.
2. Monta o env do hub (`:27-33`): `PORT=4100`, `HOST=127.0.0.1`, `CAMERA_TOKEN=e2e-cam`,
   `AUTH_SECRET=e2e-secret`, `SUPERADMIN_USER=admin`, `SUPERADMIN_PASSWORD=admin@box3`,
   `NODE_PATH` → `node_modules` do projeto.
3. **Remove** as envs de Postgres/WhatsApp (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
   `PGDATABASE`, `DATABASE_URL`, `WHATSAPP_ENABLED`) — `:34` → o hub roda **sem PG** e faz
   bootstrap do admin local.
4. `spawn` do `node index.js` no tempdir; grava o PID em `visao-e2e-hub.pid` no tmp (`:36-37`).
5. **Aguarda** o hub responder em `/socket.io/?EIO=4&transport=polling` por até 30 s
   (`waitFor`, `:13-20,39`); aceita `r.ok` ou status 400. Se não subir, mata o processo e falha.

### 6.3 Teardown global (`e2e/global-teardown.ts`)

Lê o PID do arquivo em tmp, mata o processo (`process.kill`) e remove o pidfile (`:7-12`).
Tolerante a "já morreu" / ausência do pidfile.

### 6.4 O que é testado (`e2e/app.spec.ts`)

Helpers:
- **`login(page)`** (`:4-10`): login real — preenche `#login-user`/`#login-pass` com
  `admin`/`admin@box3`, clica "Entrar" e espera o heading "Central de câmeras". Valida o fluxo
  real: `POST /api/login` → token → socket autenticado.
- **`connectCamera(context, dashboard)`** (`:13-18`): abre `/camera?key=e2e-cam&name=E2E-CAM`
  (webcam fake) e espera o nó "E2E-CAM" aparecer no dashboard (timeout 30 s).

Casos:

| Teste | O que verifica | Ref |
|-------|----------------|-----|
| **login + navegação das telas principais** | Login e navegação: Relatório ("Relatório Operacional"), Usuários (`/usuarios`), Meu perfil (`/perfil`). | `:20-28` |
| **regressão: Select abre e seleciona DENTRO do modal de config da zona** | Abre câmera fake → "Configurar zona" → Dialog. Bug original: o dropdown do Select abria **atrás** do overlay. Garante que a opção "Leitura" fica visível e clicável, e que o valor muda. | `:30-49` |
| **regressão: Select funciona no modal '⚙ Câmeras' do dashboard** | Mesma regressão do Select, mas no modal "Câmeras" do dashboard: seleciona "Operador (fadiga)" no campo "Tipo da câmera". | `:51-65` |

> Os dois últimos são **testes de regressão** de um bug de z-index/overlay do Radix Select
> dentro de Dialogs.

### 6.5 Como rodar

```powershell
npm run e2e
```

O Playwright sobe sozinho o hub isolado (4100) e o Vite dev (5180). Pré-requisitos: deps
instaladas (`npm install`) e o browser do Playwright disponível
(`npx playwright install chromium` se necessário — **a confirmar** se já está instalado no ambiente).

---

## 7. Passo-a-passo de deploy (resumido, executável)

> Baseado em `docs/deploy-digitalocean.md` + arquivos em `deploy/`.

**Na máquina dev (Windows/PowerShell):**

```powershell
npm install
npm run build      # gera dist/ (tsc + vite)
scp -r dist server deploy package.json package-lock.json usuario@IP_DA_VPS:/tmp/visao-up/
```

**No servidor (Linux):**

```bash
# 1. Posicionar e instalar deps de runtime do hub
sudo cp -r /tmp/visao-up/* /var/www/visao-patio/
cd /var/www/visao-patio
sudo npm install --omit=dev
sudo chown -R visao:visao /var/www/visao-patio

# 2. Hub via systemd (8091, loopback)
sudo cp deploy/visao-hub.service /etc/systemd/system/visao-hub.service
sudo nano /etc/systemd/system/visao-hub.service   # ajustar AUTH_SECRET, PG*, etc.
sudo systemctl daemon-reload
sudo systemctl enable --now visao-hub
systemctl status visao-hub --no-pager

# 3. nginx (server block novo)
sudo cp deploy/nginx-visao.conf /etc/nginx/conf.d/visao.conf
sudo nano /etc/nginx/conf.d/visao.conf            # trocar server_name
sudo certbot --nginx -d visao.seudominio.com      # TLS
sudo nginx -t && sudo systemctl reload nginx
```

**Atualizações futuras:**
- Só frontend: refazer `npm run build` local, subir o novo `dist/`, `systemctl reload nginx`.
- `server/` mudou: `systemctl restart visao-hub`.

---

## 8. Troubleshooting

### Deploy / infra

| Sintoma | Causa provável / ação |
|---------|------------------------|
| `nginx -t` falha com erro de `map` duplicado | O `nginx.conf` global já define `map $http_upgrade $connection_upgrade`. Remova as 4 linhas do `map` em `deploy/nginx-visao.conf:22-25`. |
| Rodapé do app não mostra "conectado" | Proxy `/socket.io/` ou upgrade de WebSocket falhando. Confira `deploy/nginx-visao.conf:51-62`, se o hub está `active (running)` (`systemctl status visao-hub`) e os logs (`journalctl -u visao-hub -f`). |
| Erro de **mixed-content** no console | Front tentando `ws://` numa página `https://`. Em produção deve usar mesma origem (`location.origin`, `src/config.ts:143`). Não defina `VITE_HUB_URL=ws://...` inseguro. |
| Câmera (`getUserMedia`) não abre | Falta **secure context**: precisa de HTTPS válido (cadeado). Em LAN dev, use o IP via `--host` e aceite a permissão de câmera. |
| Erros de **CSP** no console | CSP do nginx (`deploy/nginx-visao.conf:43`) ou do `vite.config.ts:8` bloqueando um domínio. Modelos vêm de CDNs (jsDelivr, HuggingFace, storage.googleapis, kaggle, tfhub) — devem estar no `connect-src`/`script-src`. |
| Headers de segurança ausentes em `/assets/` | `add_header` num `location` **substitui** os do server; estão re-declarados em `deploy/nginx-visao.conf:75-79`. |
| 8091 acessível de fora | Erro grave de exposição. O hub deve ouvir só em `127.0.0.1` (`deploy/visao-hub.service:21`). Verifique com `nc -z IP_DA_VPS 8091` (deve falhar). |
| Hub não conecta ao Postgres | Confira `PG*`/`DATABASE_URL` no `.service` (`server/db.js:12-25`). Banco precisa existir (`CREATE DATABASE visao_computacional`) — schema (`server/schema.sql`) é aplicado no boot. |
| Login não funciona após deploy | `AUTH_SECRET` não definido/alterado (`server/users.js:10`) ou `SUPERADMIN_*` ausente no 1º boot (`server/users.js:68`). Atenção: `PANEL_PASSWORD` citada no manual antigo **não** é usada (a confirmar). |

### Testes E2E

| Sintoma | Causa provável / ação |
|---------|------------------------|
| `[e2e] hub não respondeu na 4100` | Hub isolado não subiu em 30 s (`e2e/global-setup.ts:39-40`). Verifique se `server/` está intacto e se há porta 4100 livre. |
| Porta 5180 ocupada | `--strictPort` faz o Vite falhar se a 5180 estiver em uso (`playwright.config.ts:22`). Libere a porta. |
| Câmera fake não aparece no dashboard | Faltam as flags de webcam fake do Chromium (`playwright.config.ts:17`) ou `CAMERA_TOKEN` divergente (setup usa `e2e-cam`, e o teste abre `/camera?key=e2e-cam`). |
| Browser do Playwright ausente | `npx playwright install chromium`. |
| Processo hub órfão após falha | O teardown mata pelo PID em `visao-e2e-hub.pid` (`e2e/global-teardown.ts`); se sobrar, mate manualmente o `node` na 4100. |

---

## 9. Manuais de operação (câmeras e leitores) — referência

Guias práticos existentes em `docs/manuais/` (apenas leitura; índice em
`docs/manuais/README.md`). Resumo:

### 9.1 Câmeras IP / RTSP (geral) — `docs/manuais/manual-camera-rtsp.md`

- O sistema precisa da **URL RTSP completa** (`rtsp://USUARIO:SENHA@IP:PORTA/CAMINHO`), não só o IP.
- Reunir antes: IP (mesma LAN/VPN), usuário/senha, porta (padrão **554**), caminho do stream
  (varia por fabricante), RTSP habilitado na câmera e **ffmpeg** no host do hub.
- Padrões por fabricante: Hikvision (`/Streaming/Channels/101`), Dahua/Intelbras
  (`/cam/realmonitor?channel=1&subtype=0`), Axis (`/axis-media/media.amp`). Use o **substream**
  para análise (leve).
- Teste a URL **antes** com VLC, `ffmpeg -frames:v 1` ou `ffplay`.
- Conectar: editar `server/rtsp.sources.json` (gitignored) ou usar `RTSP_SOURCES`. Ajustes:
  `RTSP_FPS`, `RTSP_WIDTH`, `RTSP_QUALITY`.
- Sem câmera física? Simule um RTSP local com **mediamtx** + ffmpeg.
- Tabela de problemas comuns (401, timeout, sem imagem, travando, ffmpeg ausente).

### 9.2 Intelbras (RTSP) — `docs/manuais/manual-intelbras-rtsp.md`

- Intelbras = plataforma **Dahua**: `rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=CANAL&subtype=TIPO`.
- `CANAL=1` para câmera IP direta; nº do canal num NVR/DVR. `subtype=0` principal, **`subtype=1`
  substream (recomendado)**.
- ✅ Linhas **VIP** e gravadores **NVD/MHDX/NVR/DVR** têm RTSP/ONVIF. ⚠️ Linha **Mibo**
  (doméstica) geralmente **não** expõe RTSP.
- Exemplos prontos + passo a passo + tabela de problemas.

### 9.3 Leitores industriais (Sick / Cognex) — `docs/manuais/manual-leitores-industriais.md`

- Cognex (DataMan/In-Sight) e Sick (Lector/InspectorP) são **leitores de código/visão
  industrial**, **não** câmeras CCTV — geralmente **não expõem RTSP**.
- Entregam o **resultado da leitura** (string + status + timestamp) via TCP/IP, EtherNet/IP,
  PROFINET, OPC UA, MQTT, REST.
- Dois caminhos de integração: **A)** como vídeo, só se houver MJPEG por HTTP (ffmpeg lê MJPEG);
  **B) recomendado** — como **evento/indicador** (throughput, tempo sem leitura → "estação
  parada", taxa NOK), via conector no hub.
- **Status: conceitual** — ainda **não há conector de leitor implementado** no hub.

---

## 10. Apêndice — mapa de arquivos relevantes

| Arquivo | Papel |
|---------|-------|
| `package.json:6-13` | Scripts dev/build/preview/hub/start/e2e. |
| `vite.config.ts` | Headers de segurança de dev/preview (CSP etc.). |
| `playwright.config.ts` | Config E2E (webServer, fake webcam, setup/teardown). |
| `e2e/global-setup.ts` | Sobe hub isolado na 4100 sem PG. |
| `e2e/global-teardown.ts` | Mata o hub isolado pelo PID. |
| `e2e/app.spec.ts` | Casos E2E (login, navegação, regressões de Select). |
| `deploy/nginx-visao.conf` | Server block nginx (estático + proxy socket.io/api + segurança). |
| `deploy/visao-hub.service` | Unit systemd do hub (8091 loopback, envs, hardening). |
| `.env.production.example` | Modelo de env do front (`VITE_HUB_URL` opcional). |
| `.gitignore` | Exclusões (artefatos, mídia pesada, credenciais RTSP). |
| `server/index.js:15-18` | Defaults `PORT=4000` / `HOST=0.0.0.0`. |
| `src/config.ts:140-144` | Resolução do endpoint do hub no front. |
| `docs/deploy-digitalocean.md` | Roteiro de deploy na VPS (fonte primária). |
| `docs/manuais/*` | Manuais de câmeras RTSP / Intelbras / leitores industriais. |
