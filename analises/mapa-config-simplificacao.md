# Mapa de configuração & proposta de simplificação

> **Mandato:** mapear TODO o fluxo de config/variáveis do MVP e propor uma simplificação guiada por um
> princípio de produto: **"o sistema entrega SEMPRE a melhor versão como base — o cliente não liga flag
> pra ter o bom."** Guia: manifesto `../agentes/` (KISS, YAGNI, uma responsabilidade, honestidade;
> _menos é mais_).
>
> **Escopo:** este documento é **mapa + proposta**. Nenhum código foi alterado. Evidência em
> `arquivo:linha`. Data: 2026-07-05.

---

## 0. Resumo executivo

O MVP tem **~70 variáveis de ambiente do servidor + 4 do front + 6 campos por câmera + ~1 dezena de
blocos de constantes de tuning**. A grande maioria já tem **default sensato** e está bem categorizada.
O problema **não** é a quantidade de _knobs_ — é que **algumas das MELHORES capacidades do produto estão
atrás de opt-in** (flags que o cliente precisa descobrir e ligar para ter o "bom"):

- vídeo fluido (WebRTC/go2rtc) exige `GO2RTC_ENABLED=1` **+** um binário provisionado à mão (`GO2RTC_BIN`);
- webcam sem "câmera lenta ao minimizar" exige `VITE_WEBCAM_WHIP=1` **em build-time**;
- cada câmera nasce em `transport:"mjpeg"` — o operador tem de trocar câmera-a-câmera para WebRTC;
- o motor de análise (o coração do produto) só **baixa o modelo no boot** se `ANALYSIS_ENABLED=1`;
- a auto-máscara (defesa contra falso-positivo de objeto fixo) fica `off` — nem o modo seguro (`suggest`).

**Contagem por categoria (env do servidor + front + camcfg):**

| Categoria                       | Qtd | Observação                                                          |
| ------------------------------- | --- | ------------------------------------------------------------------ |
| **(D)** Deployment-necessário   | ~19 | portas, PG, hub URL, RTSP sources, ffmpeg, webhook — legítimo, fica |
| **(Q)** Toggle de QUALIDADE     | ~9  | **o alvo**: o melhor deve ser default/automático, não opt-in       |
| **(T)** Tuning avançado         | ~40 | default sensato; esconder do usuário comum (já está — são só env)   |
| **(S)** Segredo                 | ~5  | AUTH_SECRET, PGPASSWORD, SUPERADMIN_PASSWORD, CAMERA_TOKEN, DB URL  |

O **caminho-feliz alvo** é **ZERO flags de qualidade**: sobe o hub, aponta as câmeras, e recebe a melhor
versão (WebRTC quando o gateway sobe, D-FINE-S no motor, auto-máscara em modo `suggest`) — com _fallback
automático_ (não opt-out manual) sempre que o "melhor" não puder subir.

---

## 1. Inventário — Env do SERVIDOR (`server/`)

Legenda categoria: **(D)** deployment · **(Q)** qualidade (alvo) · **(T)** tuning · **(S)** segredo.

### 1.1 Rede / processo — todas (D)

| Var          | Arquivo:linha       | Default      | Controla                                  | Cat |
| ------------ | ------------------- | ------------ | ----------------------------------------- | --- |
| `PORT`       | `index.js:31`       | `4000`       | porta HTTP/Socket.IO do hub               | D   |
| `HOST`       | `index.js:34`       | `0.0.0.0`    | interface de bind                         | D   |
| `RTSP_SOURCES` | `rtsp.js:126`     | (vazio)      | fontes RTSP legadas `label=url;…`         | D   |
| `FFMPEG_PATH` | `rtsp.js:29`       | auto-descoberto | override do ffmpeg (senão varre scoop/LOCALAPPDATA/USERPROFILE — `rtsp.js:33-51`) | D   |

### 1.2 Postgres / persistência

| Var                        | Arquivo:linha    | Default | Controla                          | Cat |
| -------------------------- | ---------------- | ------- | --------------------------------- | --- |
| `DATABASE_URL`             | `db.js:21`       | —       | connection string única           | D/S |
| `PGHOST` `PGPORT` `PGUSER` | `db.js:24-26`    | :5432   | conexão discreta                  | D   |
| `PGDATABASE`/`VISAO_DB`    | `db.js:12`       | —       | nome do banco                     | D   |
| `PGPASSWORD`               | `db.js:27`       | —       | senha do banco                    | **S** |
| `DATA_HIST_RETENTION_DAYS` | `pgstore.js:21`  | `30`    | retenção de histórico (dias)      | T   |

> **Nota:** sem `DATABASE_URL`/`PGHOST+PGDATABASE`, `db.configured()` é `false` e todo o sistema cai para
> **fallback JSON** automaticamente (`db.js:16`). Bom padrão — persistência já é "melhor versão automática".

### 1.3 Auth / RBAC

| Var                  | Arquivo:linha   | Default                | Controla                     | Cat   |
| -------------------- | --------------- | ---------------------- | ---------------------------- | ----- |
| `AUTH_SECRET`        | `users.js:17`   | `dev-inseguro-troque…` | assina o token HMAC          | **S** |
| `AUTH_TTL_MS`        | `users.js:18`   | 7 dias                 | validade do token            | T     |
| `SUPERADMIN_USER`    | `users.js:107`  | `admin`                | login do superadmin semente  | D     |
| `SUPERADMIN_PASSWORD`| `users.js:108`  | `admin@box3`           | senha do superadmin semente  | **S** |
| `CAMERA_TOKEN`       | `index.js:159`, `routes/cameras.js:12` | (vazio) | token que nós-câmera apresentam | D/S |

### 1.4 go2rtc (gateway de vídeo WebRTC) — **núcleo do alvo (Q)**

| Var                        | Arquivo:linha   | Default | Controla                                      | Cat |
| -------------------------- | --------------- | ------- | --------------------------------------------- | --- |
| **`GO2RTC_ENABLED`**       | `go2rtc.js:27`  | **off** | liga o supervisor do sidecar                  | **Q** |
| **`GO2RTC_BIN`**           | `go2rtc.js:28`  | (vazio) | caminho do binário go2rtc (ENABLER manual)    | **Q**/D |
| `GO2RTC_API_PORT`          | `go2rtc.js:30`  | `1984`  | porta HTTP/API/WS (proxy `/go2rtc/`)          | D   |
| `GO2RTC_RTSP_PORT`         | `go2rtc.js:31`  | `8554`  | porta RTSP interna                            | D   |
| `GO2RTC_WEBRTC_PORT`       | `go2rtc.js:32`  | `8555`  | porta WebRTC (ICE)                            | D   |
| `GO2RTC_WEBRTC_CANDIDATES` | `go2rtc.js:34`  | (vazio) | candidatos ICE p/ acesso **fora da LAN**      | D   |
| `GO2RTC_YAML`              | `go2rtc.js:40`  | ao lado do BIN | caminho do YAML gerado                  | D   |
| `GO2RTC_LOG_LEVEL`         | `go2rtc.js:103` | `info`  | verbosidade                                   | T   |
| `GO2RTC_RESTART_BASE_MS` / `_MAX_MS` / `_SYNC_DEBOUNCE_MS` | `go2rtc.js:44-46` | 2000/30000/800 | backoff/debounce do supervisor | T |

### 1.5 RTSP (ingest ffmpeg → JPEG) — tuning (T) exceto sources

| Var                  | Arquivo:linha  | Default | Controla                            | Cat |
| -------------------- | -------------- | ------- | ----------------------------------- | --- |
| `RTSP_FPS`           | `rtsp.js:109`  | `10`    | fps de captura (câmera sobrescreve) | T   |
| `RTSP_WIDTH`         | `rtsp.js:110`  | `720`   | largura do frame                    | T   |
| `RTSP_QUALITY`       | `rtsp.js:111`  | `4`     | `-q:v` (menor=melhor)               | T   |
| `RTSP_RECONNECT_BASE_MS`/`_MAX_MS`/`_MAX_RETRIES`/`_STALE_MS`/`_STATUS_MS` | `rtsp.js:80-84` | 2000/30000/0/15000/5000 | reconexão/watchdog | T |

### 1.6 Motor de análise (D-FINE) — **alvo (Q) misturado com tuning (T)**

| Var                         | Arquivo:linha        | Default | Controla                                          | Cat |
| --------------------------- | -------------------- | ------- | ------------------------------------------------- | --- |
| **`ANALYSIS_ENABLED`**      | `engine.js:888`      | (auto)  | `0`=off; `1`=liga **e baixa o modelo no boot**; ausente=roda **só se o modelo já existe** | **Q** |
| **`ANALYSIS_MODEL`**        | `engine.js:116`      | `s`     | `n`\|`s`\|`m` — tamanho/recall do modelo           | **Q** |
| **`ANALYSIS_AUTOMASK`**     | `automask.js`        | **suggest** | `off`\|`suggest`\|`hide` — defesa a FP de objeto fixo (Onda 1: default→suggest) | **Q**/T |
| `ANALYSIS_SOURCE`           | `engine.js:173`      | (relay-less) | `go2rtc`=puxa todas as streams do gateway     | Q/T |
| `ANALYSIS_GO2RTC_PULL`      | `engine.js:174`      | on      | opt-out do pull mesmo com go2rtc ligado           | T   |
| `ANALYSIS_MODEL_PATH`       | `engine.js:115`, `worker.js:53` | catálogo | fixa o `.onnx` (usado pelo `eval/`)     | T/D |
| `ANALYSIS_FPS` / `_FPS_LINE`| `engine.js:121,128`  | 1 / 2   | cadência de inferência (geral / câmera com linha) | T   |
| `ANALYSIS_HIGH_SCORE`       | `engine.js:132`      | 0.35    | limiar de nascimento de track                     | T   |
| `ANALYSIS_AGG_MS`           | `engine.js:133`      | 3000    | janela de agregação de atividade                  | T   |
| `ANALYSIS_AUTOMASK_JITTER` | `automask.js` | 0.02 | limiar de jitter (o único knob que muda por câmera) | T |
| ~~`AUTOMASK_COLS/ROWS/WIN_MS/PRESENT/MIN_ROUNDS`~~ | — | 24/18/600k/0.97/120 | **viraram CONSTANTES** (refactor F3: enxugado 7→2 envs) | — |
| `ANALYSIS_GO2RTC_TIMEOUT_MS`/`_STREAMS_MS` | `engine.js:178-179` | 2000/4000 | timeouts do pull go2rtc            | T   |
| `ANALYSIS_SCORE_MIN`        | `worker.js:55`       | 0.25    | corte bruto do worker                             | T   |
| `ANALYSIS_NMS_IOU`          | `worker.js:56`       | 0.6     | NMS do worker                                     | T   |
| `ANALYSIS_INTRA_THREADS`    | `worker.js:57`       | 2       | threads intra-op do ONNX Runtime                  | T   |

> **Precedente-chave (o ENABLER que já existe):** o motor **baixa o modelo `.onnx` no boot com verificação
> sha256, escrita atômica e fallback automático S→N** — `engine.js:213-272` (`ensureModel`/`downloadModel`,
> catálogo `MODELS` em `engine.js:91-113`). Ou seja: **o produto já sabe auto-provisionar um artefato binário
> grande, com integridade, sem o cliente baixar nada.** Este é exatamente o padrão que falta ao go2rtc.

### 1.7 Alarme / notificações / andon

| Var                  | Arquivo:linha       | Default | Controla                          | Cat |
| -------------------- | ------------------- | ------- | --------------------------------- | --- |
| **`WHATSAPP_ENABLED`** | `whatsapp.js:12`  | off     | canal WhatsApp (Baileys) + QR     | Q/D |
| `ALERT_WEBHOOK_URL`  | `alerts.js:7`       | (vazio) | webhook de andon/externo          | D   |
| `ALERT_DEDUP_MS`     | `dispatch.js:10`, `alerts.js:8` | 60000 | dedup de alerta            | T   |
| `ALARM_POLICY_ENABLED` | `alarm/config.js:33` | **on** | política ISA-18 (já default on)  | T   |
| `ALARM_DEDUP_MS`/`FLOOD_*`/`SHELVE_*`/`RATE_*`/`FLAP_*` | `alarm/config.js:34-59` | vários | tuning da política de alarme | T |
| `ALARM_EVENTS_RETENTION`/`_DAYS` | `events.js:36-37` | 1000/0 | retenção de eventos       | T   |
| `ALARM_LOG_LEVEL`    | `events.js:33`, `alarm/config.js:31` | info | verbosidade           | T   |
| `ALARM_SHELVES_FILE` | `alarm/config.js:46`| (path)  | arquivo de shelve                 | D   |

### 1.8 Shedding / webcam (T)

| Var                  | Arquivo:linha   | Default | Controla                       | Cat |
| -------------------- | --------------- | ------- | ------------------------------ | --- |
| `SHED_IDLE_MS`/`_SWEEP_MS`/`_WEBCAM_FPS` | `index.js:190-192` | 60000/5000/2 | shedding de câmera ociosa | T |
| `WEBCAM_DEFAULT_FPS` | `index.js:195`  | 12      | fps default da webcam          | T   |

---

## 2. Inventário — Env do FRONT (Vite, build-time)

| Var                 | Arquivo:linha     | Default            | Controla                                        | Cat |
| ------------------- | ----------------- | ------------------ | ----------------------------------------------- | --- |
| `VITE_HUB_URL`      | `config.ts:223`   | mesma origem / :4000 dev | endpoint do hub Socket.IO                  | D   |
| `VITE_GO2RTC_BASE`  | `config.ts:248`   | `/go2rtc`          | base do gateway (proxy same-origin)             | D/T |
| **`VITE_WEBCAM_WHIP`** | `config.ts:259`| **off**            | webcam publica por WebRTC/WHIP (mata "câmera lenta ao minimizar") | **Q** |
| `VITE_DEMO_MODE`    | `config.ts:94`    | off                | "Limite curto (10s)" default ligado (só demo)   | Q(demo) |

> **`VITE_WEBCAM_WHIP` é build-time** — trocar exige **rebuild**. É a pior forma de flag de qualidade: nem
> o operador nem o admin conseguem ligar em runtime. Consumido em `routes/CameraPage.tsx:10,102`.

---

## 3. Inventário — Config POR CÂMERA (camcfg)

`CameraCfg` em `src/cameraConfig.ts:14-28`; saneamento em `server/camcfg.js:116-131` (`cleanCamConfig`).
Persistido no backend (Postgres/`camcfg.json`) com cache local — fonte de verdade compartilhada.

| Campo            | Default    | O que faz                                                        | Cat |
| ---------------- | ---------- | ---------------------------------------------------------------- | --- |
| `modo`           | `atividade`| pipeline: atividade/leitura/objetos/fadiga (escolha do operador) | legit |
| `pontoLeitura`   | `Ponto 1`  | rótulo do ponto de leitura de código                             | legit |
| `capture`        | `alta`     | preset de captura media/alta/maxima (default já é o bom p/ leitura) | Q-ish |
| `selectedClasses`| todas      | classes de objeto a contar (modo objetos)                        | legit |
| **`longRange`**  | **false**  | perfil panorâmica: tiling 2×2 + tile maior + limiares baixos     | **Q** |
| **`transport`**  | **`mjpeg`**| vídeo no painel: `mjpeg` (relé atual) \| `webrtc` (fluido via go2rtc) | **Q** |

UI: `src/routes/cameras/CameraSettingsSection.tsx:78-142` (seletor MJPEG×WebRTC por câmera);
`DashboardPage.tsx:755` (`transportOf`).

---

## 4. Inventário — Constantes de APP_CONFIG (`src/config.ts`)

**Todas são tuning (T) baked em build-time.** Não são flags de usuário — são o "manual de calibração" do
detector. Já vivem num único arquivo, comentadas com o _porquê_ de cada número. **Não são o alvo** (não há
opt-in de qualidade escondido aqui — o "bom" já é o default). Blocos:

- `detection.*` (`config.ts:4-47`) — movimento (procWidth 240, ratios), ocupação (coco/tiling 2×2), e o
  sub-bloco `longRange` (grade 4×4, tile 640) que o campo `camcfg.longRange` ativa.
- `people.*` (`50-77`) — thresholds de contagem + ByteTrack-lite (iou 0.25, counterMaxDist 0.35, histerese).
- `zones` / `demo` / `overlay` / `dashboard` (`79-116`) — limites de ociosidade, preset de overlay, feeds/página (6).
- `reading.*` (`134-172`) — captura de alta-res, formatos de barras, detecção de passagem.
- `objects` / `fadiga` (`175-212`) — OWL-ViT e MediaPipe (URLs de CDN externas — ver risco §7).
- `net.*` (`215-238`) — frameWidth 1280, fps 12, jpeg 0.85 (perfil de exibição).
- `go2rtc` / `webcam.whip` (`246-263`) — leem os VITE flags acima.
- `MODE_PRESETS` (`304-350`) — modo = preset completo (camadas + confiança + KPIs).

> Um único ponto de atenção de honestidade: `fadiga.mediapipeWasmUrl`/`faceModelAssetUrl`/`handModelAssetUrl`
> (`config.ts:185-189`) e `objects.model` (Xenova/HF, `config.ts:176`) **dependem de CDN externo em runtime** —
> quebram **offline**. É um acoplamento de qualidade escondido (não é flag, mas é "o bom depende da internet").

---

## 5. PROPOSTA — "sempre a melhor versão" (o coração)

Princípio de execução: **para cada (Q), o melhor vira DEFAULT/automático; o fallback é AUTOMÁTICO (não
opt-out manual); a flag antiga vira, no máximo, um _escape hatch_ raro.** Cada proposta nomeia o **ENABLER**
(o que precisa existir para o default-best subir sem flag).

### 5.1 go2rtc como **componente GERENCIADO** (não binário à mão)

- **Hoje:** vídeo fluido exige `GO2RTC_ENABLED=1` **+** `GO2RTC_BIN=/caminho/para/binário` provisionado
  manualmente. Sem os dois, o módulo é inerte (`go2rtc.js:59-65`, `init` loga "desligado").
- **Alvo:** go2rtc **liga sozinho** se conseguir um binário — igual ao modelo `.onnx`.
- **ENABLER:** replicar `ensureModel`/`downloadModel` (`engine.js:229-272`) para o binário go2rtc: catálogo
  `{ url, sha256, bytes }` por plataforma (win/linux x64/arm64), download no boot com verificação + escrita
  atômica em `server/bin/go2rtc[.exe]`. `binExists()` passa a apontar para esse caminho gerenciado quando
  `GO2RTC_BIN` não é dado. **O precedente já está no mesmo repo** — é copiar o padrão.
- **Escape hatch:** `GO2RTC_BIN` continua existindo para quem quer um binário próprio/air-gapped;
  `GO2RTC_ENABLED=0` para desligar de vez (raro).
- **Fallback automático:** se o download/porta/spawn falhar, `enabled()` fica `false` e o front **já** cai
  para MJPEG por câmera — sem intervenção (ver 5.2).

### 5.2 WebRTC como transporte **default**, MJPEG como fallback automático

- **Hoje:** cada câmera nasce `transport:"mjpeg"` (`cameraConfig.ts:36`, `camcfg.js:124`); o operador troca
  câmera-a-câmera para WebRTC. O "melhor" é opt-in manual e por-câmera.
- **Alvo:** o dashboard **prefere WebRTC automaticamente** quando o gateway está no ar e conhece a stream;
  cai para MJPEG **por câmera** quando não está (go2rtc off, stream ainda não montada, browser sem WebRTC).
- **ENABLER:** trocar a semântica de `transportOf()` (`DashboardPage.tsx:755`) de "lê o campo" para
  "**resolve o melhor disponível**": `webrtc` se `go2rtc.enabled() && stream conhecida`, senão `mjpeg`. O
  campo `camcfg.transport` deixa de ser "liga/desliga" e vira **override opcional** (`auto`|`mjpeg`|`webrtc`,
  default `auto`). Precisa de um sinal do hub "quais streams o go2rtc tem" — **já existe** o refresh de
  `/api/streams` no motor (`engine.js:199-205`, `go2rtcStreams`); expor isso ao front via um campo de status.
- **Escape hatch:** override por câmera para forçar MJPEG (ex.: câmera problemática no WebRTC).

### 5.3 Webcam WHIP **sempre** (sem VITE flag, com fallback)

- **Hoje:** `VITE_WEBCAM_WHIP=1` **em build-time** liga a publicação WebRTC do nó `/camera`
  (`config.ts:259`, `CameraPage.tsx:10,102`); default o nó fica no loop JPEG→socket.
- **Alvo:** o nó **tenta WHIP primeiro**; se a negociação WebRTC falhar (sem go2rtc, browser velho, rede),
  **cai sozinho** para o caminho JPEG→socket atual (que segue vivo como registro/controle — já é o design).
- **ENABLER:** trocar o `if (WHIP_ENABLED)` estático (`CameraPage.tsx:102`) por um _probe_ em runtime:
  tenta `publishWebcamWhip`; no `onState('failed')`/timeout, mantém o loop JPEG. Remove a dependência de
  build-time (o pior tipo de flag). A base same-origin `/go2rtc` já funciona sem VITE (`config.ts:248`).
- **Escape hatch:** nenhum necessário no caminho comum; um override de runtime só se aparecer um browser que
  precise ser forçado a MJPEG.

### 5.4 Motor de análise **sempre ligado** com auto-download (sem `ANALYSIS_ENABLED=1` p/ 1º boot)

- **Hoje:** semântica confusa (`engine.js:886-901`): ausente → roda **só se o `.onnx` já existe**; para
  **baixar no 1º boot** exige `ANALYSIS_ENABLED=1`. Cliente novo sem o arquivo → motor **desligado** com uma
  mensagem pedindo a flag. O coração do produto exige opt-in na estreia.
- **Alvo:** default = **liga e baixa o modelo no boot** (o download já é seguro: sha256 + atômico + fallback
  S→N). `ANALYSIS_ENABLED=0` continua desligando (escape hatch p/ nó sem CPU/somente-vídeo).
- **ENABLER:** inverter o default de `allowDownload` — `ensureModel(want !== "0")` em vez de
  `ensureModel(want === "1")` (`engine.js:893`). Uma linha. Risco: primeira subida baixa ~40 MB (S) — mitigar
  com log claro de progresso (já loga) e permitir o `0` para quem não quer.
- **Custo de CPU (S vs N) — auto-dimensionar em vez de flag:** hoje `ANALYSIS_MODEL=n|s|m` é escolha manual.
  Proposta: **default S** (melhor recall — é o coração da contagem), com **auto-rebaixamento para N** quando o
  `cpuPct` amostrado do worker (`engine.js:207-209`) fica saturado por uma janela — mesma filosofia do fallback
  S→N que já existe para _download_ (`engine.js:256-259`), estendida para _pressão de CPU em runtime_. O cliente
  nunca escolhe o modelo; o hub dimensiona. `ANALYSIS_MODEL` fica como escape hatch p/ fixar.

### 5.5 Auto-máscara em `suggest` como **base segura** (não `off`)

- **Hoje:** `ANALYSIS_AUTOMASK` default `off` (`engine.js:155-161`) — a defesa contra o falso-positivo nº1
  (objeto fixo lido como pessoa, 47-86% dos FP por `acuracia-modelos.md`) fica inerte até alguém ligar.
- **Alvo:** default **`suggest`** — aprende e **expõe/loga** a sugestão, **sem suprimir** (transparência sem
  risco; é o próprio caminho "RECOMENDADO" descrito no comentário do código). `hide` (suprimir) continua opt-in
  consciente; `off` continua disponível.
- **ENABLER:** trocar o default de `AUTOMASK_RAW` vazio → `"suggest"` (`engine.js:155-160`). O gate já é
  conservador (presença ≥97%, jitter baixíssimo, janela ≥10 min). Zero risco de esconder pessoa em `suggest`.
- **Honestidade/LGPD:** `suggest` não altera dado nem persiste imagem — só metadado de célula do grid. Alinhado
  ao invariante.

### 5.6 `ANALYSIS_SOURCE=go2rtc` — pull automático, sem flag

- **Hoje:** `ANALYSIS_SOURCE=go2rtc` força puxar todas as streams; ausente = "relay-less" (só quem não manda
  relé) — `engine.js:173`. Com WebRTC default (5.2), câmeras WHIP não mandam relé JPEG e **precisam** do pull.
- **Alvo:** o modo "relay-less" **já é o comportamento certo** (puxa exatamente quem não tem relé). Manter como
  default; **remover a necessidade de `ANALYSIS_SOURCE`** no caminho comum — o motor detecta ausência de relé e
  puxa (`PULL_STALE_MS`, `engine.js:175-177`). `ANALYSIS_SOURCE=go2rtc` vira escape hatch p/ forçar tudo.
- **ENABLER:** nenhum código novo — só **não depender** da flag; o pull relay-less já cobre o caso WHIP.

### 5.7 `longRange` por câmera — manter opt-in (é escolha de cena, não "qualidade universal")

- **Análise honesta:** `longRange` **não** é "o melhor sempre". Ele quadruplica o custo (tiling 4×4) e só
  ajuda em cena panorâmica/alta (`config.ts:26-41`). Ligar por default **piora** CPU em câmera comum sem ganho.
  **Fica como opt-in por câmera** — é configuração de _cena_, legítima (como `modo`). **Não é alvo.**

### 5.8 Canais de notificação (`WHATSAPP_ENABLED`, `ALERT_WEBHOOK_URL`) — ficam como (D)

- **Análise honesta:** WhatsApp exige pareamento/credencial (QR), webhook exige uma URL de destino. **Não há
  "melhor versão automática"** sem um destino configurado. São **deployment** legítimo, não qualidade
  escondida. Manter opt-in. (Só vale garantir que a UI de onboarding os apresente — fora do escopo deste mapa.)

---

## 6. Tabela ANTES → DEPOIS (flags de QUALIDADE que o cliente toca)

| Capacidade "melhor versão"        | HOJE (o cliente liga…)                          | DEPOIS (default automático)                        | Enabler                                   |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| Vídeo fluido (WebRTC)             | `GO2RTC_ENABLED=1` **+** `GO2RTC_BIN=…`         | auto-provisiona binário (sha256, como o `.onnx`)   | download gerenciado do binário            |
| Transporte por câmera             | trocar `transport→webrtc` câmera-a-câmera       | `auto`: WebRTC se disponível, senão MJPEG          | `transportOf()` resolve o melhor + status de streams |
| Webcam sem "câmera lenta"         | `VITE_WEBCAM_WHIP=1` (**rebuild!**)             | tenta WHIP, cai p/ JPEG sozinho                    | probe de runtime no `/camera`             |
| Motor de análise (1º boot)        | `ANALYSIS_ENABLED=1` p/ baixar o modelo         | liga+baixa por default (`=0` desliga)              | inverter default do `allowDownload`       |
| Modelo N/S/M                      | `ANALYSIS_MODEL=s` (e escolher se CPU aperta)   | S default, auto-rebaixa p/ N sob pressão de CPU    | usar `cpuPct` já amostrado                 |
| Defesa a FP de objeto fixo        | `ANALYSIS_AUTOMASK=suggest`                     | `suggest` por default (seguro, só loga)            | trocar default vazio→`suggest`            |
| Pull de câmera WHIP p/ análise    | `ANALYSIS_SOURCE=go2rtc`                        | relay-less já puxa quem não tem relé               | nenhum (já existe)                        |
| **Flags de qualidade no caminho-feliz** | **≥ 5–7** (2 build-time / provisionamento manual) | **0**                                    | —                                         |

**Deployment (D) e segredos (S) permanecem** — mas esses são o mínimo honesto de qualquer deploy (porta, PG,
segredo, URL das câmeras). O caminho-feliz de **qualidade** vai a **ZERO flags**.

---

## 7. Contradições, riscos e limites (honestidade técnica)

- **LGPD:** todas as propostas preservam o invariante (ADR-002). go2rtc gerenciado **não** adiciona `record:`
  (`go2rtc.js:85-86`); auto-máscara `suggest` só grava metadado de célula; WHIP relaya, não persiste. **OK.**
- **CPU (S vs N):** ligar motor + S por default aumenta CPU no 1º deploy. Mitigação **é** a proposta (auto-N sob
  pressão), mas exige implementar a lógica de rebaixamento por `cpuPct` sustentado — **não trivial**, precisa de
  histerese p/ não oscilar N↔S. É a peça de maior risco; entregar em onda própria com medição.
- **Safari/WebRTC:** WebRTC no Safari tem arestas (codecs, autoplay). O fallback automático a MJPEG (5.2/5.3)
  **é** a defesa — por isso "fallback automático, não opt-out manual" é inegociável na proposta.
- **Offline / air-gap:** auto-download (modelo e binário go2rtc) **exige internet no 1º boot**. Para deploy
  air-gapped, os escape hatches `GO2RTC_BIN` e `ANALYSIS_MODEL_PATH` continuam existindo — e um _bundle_ opcional
  (binário+modelo já no disco) faz o auto-download virar no-op. **CDN do MediaPipe/OWL-ViT** (`config.ts:185-189,
  176`) segue sendo um acoplamento externo em runtime — candidato a hospedagem própria/`transformers.js` local
  numa onda futura (fora do escopo de "flags", mas é qualidade dependente de rede).
- **Reversibilidade:** cada troca de default é 1 flag que **inverte** (não remove) — rollback trivial mantendo o
  escape hatch. Alinhado a "entregas pequenas e reversíveis".

---

## 8. Plano de execução (ondas pequenas, reversíveis)

Cada onda é independente, tem escape hatch e é revertível por 1 flag. Ordem por _risco crescente_.

1. **Onda 1 — defaults de baixo risco (1 linha cada):**
   - `ANALYSIS_AUTOMASK` default → `suggest` (`engine.js:155`).
   - `ANALYSIS_ENABLED` ausente → baixa o modelo (`engine.js:893`, `want !== "0"`).
   - _Validação:_ boot limpo sem env baixa o modelo, sobe motor, loga `auto-máscara=suggest`. `=0` ainda desliga.

2. **Onda 2 — transporte `auto` (front, sem tocar go2rtc ainda):**
   - `camcfg.transport` aceita `auto` (default); `transportOf()` resolve melhor-disponível; hub expõe status
     "streams go2rtc conhecidas". Com go2rtc ainda off, tudo resolve MJPEG → **zero regressão**.
   - _Validação:_ e2e — câmera nova renderiza (MJPEG hoje); com go2rtc no ar, vira WebRTC sozinha.

3. **Onda 3 — go2rtc gerenciado (auto-provisão do binário):**
   - Catálogo por-plataforma + `ensureGo2rtcBin()` espelhando `ensureModel`. `GO2RTC_ENABLED` passa a default-on
     quando o binário sobe; `GO2RTC_BIN`/`=0` viram escape hatch.
   - _Validação:_ boot sem `GO2RTC_BIN` baixa o binário (sha256), sobe o sidecar, câmera RTSP vira WebRTC via
     Onda 2. Falha de download → `enabled()=false` → MJPEG (fallback automático).

4. **Onda 4 — webcam WHIP com probe de runtime:**
   - Remove `VITE_WEBCAM_WHIP` do caminho; `/camera` tenta WHIP e cai p/ JPEG no `failed`/timeout.
   - _Validação:_ nó publica por WebRTC quando go2rtc no ar; mata a rede WebRTC → nó volta a JPEG sem recarregar.

5. **Onda 5 — auto-dimensionamento S↔N por CPU (maior risco, medição obrigatória):**
   - Rebaixa S→N quando `cpuPct` sustentado > teto (histerese); volta quando alivia. `ANALYSIS_MODEL` fixa (escape).
   - _Validação:_ carga sintética de N câmeras mostra o rebaixamento e a estabilidade (sem oscilação N↔S).

> **DoD por onda:** funciona no fluxo real (não só caso feliz); fallback exercido; `npm run verify` verde;
> escape hatch documentado; sem segredo/PII; ADR curto se a decisão de default for não-óbvia (ex.: Onda 5).

---

## 9. Achados-chave (para relatar)

- **Inventário:** ~19 (D) · ~9 (Q, alvo) · ~40 (T) · ~5 (S) no env do servidor+front+camcfg. `APP_CONFIG` é 100%
  tuning já-bom (não é o alvo).
- **O produto já sabe auto-provisionar binário grande com integridade** (`ensureModel`/`downloadModel`,
  `engine.js:213-272`) — o padrão-ouro que falta ao go2rtc.
- **A pior flag é `VITE_WEBCAM_WHIP`** (build-time — exige rebuild p/ ligar qualidade). Depois, o par
  `GO2RTC_ENABLED + GO2RTC_BIN` (provisionamento manual) e `ANALYSIS_ENABLED=1` (coração do produto atrás de opt-in).
- **Caminho-feliz alvo = 0 flags de qualidade**, com fallback SEMPRE automático (nunca opt-out manual). Deploy e
  segredos permanecem — são o mínimo honesto.
