# Conectividade Multi-câmera (RTSP + Navegador) — Avaliação Arquitetural

> Avaliação técnica baseada **exclusivamente no código atual** do MVP
> (`server/`, `src/`). Objetivo de negócio: conectar **diversas câmeras
> simultaneamente** — incluindo streams RTSP públicos/de demonstração e câmeras
> IP reais do CD — para demonstrar aplicações práticas de visão computacional.
>
> Trechos referenciados no formato `arquivo:linha`. Pontos não comprováveis
> pelo código estão marcados como **(a confirmar)**.
>
> Arquivos lidos: `server/rtsp.js`, `server/rtsp.sources.example.json`,
> `server/index.js`, `src/routes/CameraPage.tsx`, `src/routes/DashboardPage.tsx`,
> `src/camera/acquire.ts`, `src/cameraConfig.ts`, `src/config.ts`,
> `src/CameraWorkspace.tsx` (trechos do laço de detecção), `.gitignore`, e a
> documentação `docs-regenerada/02` e `docs-regenerada/06`.

---

## 1. Como funciona hoje a conexão de câmeras

Há **dois tipos de fonte** que convergem para o **mesmo contrato** de frame
(`evento socket "frame"` com JPEG binário). A central (`DashboardPage`) não
distingue a origem: trata câmera de navegador e câmera RTSP exatamente igual.

### 1.1. Câmera de navegador (webcam-node)

- `src/routes/CameraPage.tsx` adquire a webcam via `acquireCameraStream()`
  (`src/camera/acquire.ts:31`) — contexto seguro (HTTPS/localhost), escada de
  constraints `1280→960→qualquer` e mapeamento de erros tipado.
- Conecta ao hub com `role: "camera"`, `id`, `label` (`CameraPage.tsx:53`) e um
  token (`?key=<CAMERA_TOKEN>` de enrolamento, ou a sessão de um usuário logado;
  `CameraPage.tsx:8-12`).
- Em `setInterval` na cadência `1000/frameFps` (`CameraPage.tsx:77`): desenha o
  `<video>` num canvas, `toBlob(JPEG)` e `socket.emit("frame", {buf,w,h,ts})`
  (`CameraPage.tsx:63-76`). Anti-backlog: descarta frame se o encode anterior
  não terminou (flag `encoding`, `CameraPage.tsx:62,65`).
- A central pode **elevar o perfil de captura** por câmera via evento `capture`
  (`CameraPage.tsx:81`), p.ex. modo leitura = alta resolução.
- Defaults: `frameWidth=1280`, `frameFps=15`, `jpegQuality=0.82`
  (`src/config.ts:147-149`).

### 1.2. Câmera IP / RTSP (RTSP-server, via ffmpeg no hub)

- O navegador **não reproduz RTSP**. O hub roda `ffmpeg` por fonte
  (`server/rtsp.js:56-63`):
  `ffmpeg -rtsp_transport tcp -i <url> -an -vf fps=N,scale=W:-2 -f mjpeg -q:v Q pipe:1`.
- O stdout (MJPEG) é varrido por `drainFrames()` procurando marcadores
  `SOI/EOI` (`FFD8…FFD9`) e cada JPEG completo é emitido como
  `io.to("dashboards").emit("frame", { id, buf, ts })` (`server/rtsp.js:72-78`)
  — **mesmo evento** das webcams.
- Cada fonte vira uma câmera `rtsp-<n>` com `kind: "rtsp"` no mapa `cameras`
  (`server/rtsp.js:48-52`).
- Defaults de captura RTSP: `RTSP_FPS=8`, `RTSP_WIDTH=480`, `RTSP_QUALITY=7`
  (`server/rtsp.js:97-101`) — bem mais conservadores que a webcam.
- Resiliência: se `ffmpeg` falta no PATH (`ENOENT`) a fonte é removida e o resto
  segue (`server/rtsp.js:65-69`); se o stream cai, **reconecta em 3 s**
  (`server/rtsp.js:79-84`).

### 1.3. O hub como relé puro (`server/index.js`)

- Hub Socket.IO que **não processa nem armazena vídeo**: só registra câmeras
  conectadas e repassa frames (`server/index.js:1-2`).
- Sockets `role:"camera"` entram no mapa `cameras` + `socketById`; relé de frames
  é **VOLATILE** (`socket.on("frame") → io.to("dashboards").volatile.emit`,
  `server/index.js:181-183`): se um dashboard está lento, o frame é **descartado**
  em vez de enfileirar.
- Sockets `role:"dashboard"` entram na sala `"dashboards"` e recebem a lista de
  câmeras + todos os frames (`server/index.js:191-195`).
- A central direciona perfil de captura por câmera com `set-capture`
  (`server/index.js:199-203`) → reenvia `capture` ao socket da câmera-alvo.
- Auth: todo socket precisa de token de sessão válido; câmeras aceitam também
  `CAMERA_TOKEN` (`server/index.js:150-158`). `maxHttpBufferSize: 8e6`
  (`server/index.js:146`).

### 1.4. Consumo na central (`src/routes/DashboardPage.tsx`)

- Um único socket `role:"dashboard"` recebe **todos os frames de todas as
  câmeras** (`DashboardPage.tsx:39-44`).
- Por câmera mantém só o **último** frame (`FrameEntry`), decodifica para
  `ImageBitmap` fora da main thread (`createImageBitmap` em `drainDecode`,
  `DashboardPage.tsx:49-57`), descartando atrasados.
- Renderiza uma **grade fixa** de tiles: `colsFor(n)` = 1/2/3/4 colunas conforme
  o nº de câmeras (`DashboardPage.tsx:16,126`). **Todas** as câmeras conectadas
  viram tile; não há paginação nem seleção de quais exibir.
- Cada tile é um `CameraWorkspace` (ou `FadigaView`) com seu próprio laço
  `requestAnimationFrame` chamando `detectFrame(...)`
  (`src/CameraWorkspace.tsx:194,219-222`). A inferência (coco-ssd) roda num
  **único Web Worker compartilhado** (`ensureDetectClient`, `detect.ts`),
  portanto as inferências de todas as câmeras são **serializadas** nesse worker.
- Cadência adaptativa: câmera aberta (`full`) usa `objectIntervalMs=350`;
  tiles usam `objectIntervalMsTile=1200` (`config.ts:15-16`,
  `CameraWorkspace.tsx:219`).

### 1.5. Diagrama do fluxo atual

```
  ┌────────────────────────┐                       ┌──────────────────────────┐
  │ WEBCAM-NODE            │                        │ CÂMERA IP / RTSP         │
  │ CameraPage.tsx         │                        │ (DVR/NVR/stream público) │
  │ getUserMedia → canvas  │                        └─────────────┬────────────┘
  │ toBlob(JPEG)           │                              RTSP/tcp │
  └───────────┬────────────┘                                      ▼
              │ socket "frame" {buf,w,h,ts}        ┌────────────────────────────┐
              │ role=camera                        │ server/rtsp.js (no HUB)    │
              │                                    │ ffmpeg → MJPEG → drainFrames│
              │                                    └─────────────┬──────────────┘
              │                                  io.emit("frame",{id,buf,ts})
              ▼                                                   ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │ HUB Socket.IO  (server/index.js) — RELÉ PURO                        │
        │ cameras{} · socketById{} · sala "dashboards" · VOLATILE emit        │
        │ NÃO processa, NÃO grava vídeo. set-capture → câmera-alvo            │
        └───────────────────────────────┬───────────────────────────────────┘
                                         │ broadcast a TODOS os dashboards
                                         ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │ CENTRAL  DashboardPage.tsx                                          │
        │ 1 socket recebe TODOS os frames → createImageBitmap (último/câmera) │
        │ grade fixa colsFor(n) · 1 tile por câmera                           │
        │   cada tile: CameraWorkspace (rAF) → detectFrame()                  │
        │            ╲___ todos compartilham 1 Web Worker coco-ssd ___╱       │
        └───────────────────────────────────────────────────────────────────┘
```

---

## 2. Limitações atuais para escala multi-câmera

### 2.1. CPU do ffmpeg por stream (hub)
- `startOne()` cria **um processo `ffmpeg` por fonte RTSP**
  (`server/rtsp.js:47-89`), cada um decodificando H.264/H.265 + reescalando +
  recodificando MJPEG. O custo cresce **linearmente** com o nº de câmeras IP e
  concentra-se **numa única máquina** (o hub). Não há pool, limite de processos,
  nem distribuição entre hosts.
- Decode + reencode JPEG é desperdício comparado a repassar o stream nativo
  (o próprio cabeçalho sugere WebRTC/go2rtc/mediamtx para produção,
  `server/rtsp.js:5`).

### 2.2. Banda de socket (hub → central)
- O hub faz **fan-out**: cada frame de cada câmera é replicado para **cada**
  dashboard conectado (`io.to("dashboards").emit`). Banda ≈
  `nº_câmeras × fps × tamanho_jpeg × nº_dashboards`.
- VOLATILE (`server/index.js:182`) protege contra acúmulo de latência (descarta
  em vez de enfileirar), mas **não reduz** a banda nominal nem o custo de
  serialização no hub.
- Webcams default em `1280px @ 15fps q0.82` (`config.ts:147-149`) são pesadas;
  RTSP default em `480px @ 8fps` é mais leve. Misturar muitas webcams em alta
  satura rápido. `maxHttpBufferSize: 8e6` (`index.js:146`) limita o **tamanho de
  mensagem**, não o agregado.

### 2.3. Decodificação no cliente (central)
- A central decodifica **JPEG → ImageBitmap para todas as câmeras** num único
  navegador (`drainDecode`, `DashboardPage.tsx:49-57`). Com muitas câmeras, o
  `createImageBitmap` (mesmo assíncrono) e o desenho em N tiles disputam main
  thread/GPU.
- Toda câmera conectada vira tile ativo — não há "processar só as N visíveis".

### 2.4. Inferência por feed (central)
- **Gargalo central de escala.** Cada `CameraWorkspace` roda seu rAF e chama
  `detectFrame()`, mas há **um único worker coco-ssd compartilhado**; as
  inferências de todas as câmeras competem e são serializadas. A guarda
  `detectingRef` é **por componente** (`CameraWorkspace.tsx:220`), não global —
  N tiles podem disparar pedidos que enfileiram no worker.
- Com `objectIntervalMsTile=1200ms`, o worker precisa atender N câmeras dentro
  dessa janela; acima de um certo N a detecção atrasa em todas. O número
  sustentável **(a confirmar)** depende de GPU/CPU da máquina da central.
- Modos `leitura` (BarcodeDetector/ZXing) e `fadiga` (MediaPipe) têm pipelines
  próprios, **também na central**, somando carga.

### 2.5. Limites de conexões / topologia
- Tudo passa por **um hub** e **uma central** (browser). Não há sharding,
  múltiplos workers de ingestão, nem balanceamento. **(a confirmar)** se há
  intenção de múltiplas centrais — hoje cada dashboard recebe tudo.
- `CAMERA_TOKEN` é **um único token compartilhado** para todas as câmeras
  (`index.js:153`) — sem identidade/credencial por dispositivo.

### 2.6. Reconexão / health-check
- RTSP: reconexão simples a cada 3 s em `close` (`rtsp.js:79-84`), **sem
  backoff exponencial, sem teto de tentativas, sem health-check** de stream
  congelado (um ffmpeg que entrega frames corrompidos/estagnados não é
  detectado).
- Não há **status por câmera** exposto à UI (online/offline/erro/última-frame).
  A central só sabe "a câmera está no mapa". Não há métrica de fps real,
  latência, nem alerta de câmera caída.
- Webcam-node: o socket reconecta (padrão socket.io), mas não há monitor de
  saúde do feed.

### 2.7. Gestão de fontes (config estática)
- Fontes RTSP são **estáticas**: lidas só no boot de `loadSources()`
  (`rtsp.js:91-103`) a partir de `server/rtsp.sources.json` **ou** env
  `RTSP_SOURCES`. **Não há CRUD em runtime**: adicionar/remover câmera exige
  editar o arquivo e **reiniciar o hub**.
- Sem banco de câmeras: nenhuma tabela/persistência de fontes (diferente de
  users/recipients/settings, que têm Postgres). `cameraConfig`/zonas vivem em
  `localStorage` do browser por `cameraId` (`cameraConfig.ts:14`,
  docs-regenerada/02 §5-6) — **não compartilhado** entre operadores nem servidor.
- IDs RTSP são posicionais (`rtsp-1`, `rtsp-2`…): reordenar o JSON troca a
  identidade da câmera e desassocia zonas/config salvas no `localStorage`.

---

## 3. O que é necessário para conectar a "diversas câmeras" de forma robusta

### 3.1. Cadastro dinâmico de fontes (CRUD na UI + persistência)
- Criar **tabela `cameras`** no Postgres (`{ id, label, kind, url(cifrada),
  enabled, profile, grupo, criadoEm }`) seguindo o padrão de `recipients`/`users`
  (`server/recipients.js`).
- Endpoints `GET/POST/PATCH/DELETE /api/cameras` (superadmin), espelhando
  `/api/recipients` (`index.js:88-97`).
- Refatorar `startRtspIngestion` para **start/stop por fonte em runtime**
  (hoje só roda no boot, `index.js:220-221`): `addSource(id)`, `removeSource(id)`,
  `restartSource(id)` controlando o ciclo de vida do `ffmpeg`.
- UI de gestão de câmeras (estender o modal "⚙ Câmeras" de
  `DashboardPage.tsx:141-151`, hoje só escolhe tipo área/fadiga) para incluir
  adicionar/editar/remover fonte RTSP com label e URL.
- **IDs estáveis** (UUID por fonte) para não quebrar zonas/config ao reordenar.
- Persistir `cameraConfig`/zonas no servidor (não só `localStorage`) para que
  qualquer operador veja a mesma configuração **(a confirmar prioridade)**.

### 3.2. Seleção de quais feeds processar
- Separar **exibir** de **inferir**: hoje todo tile roda detecção. Permitir:
  - processar inferência só na câmera **aberta/full** e/ou nas **visíveis**;
  - "pausar análise" por câmera (apenas preview);
  - grupos/tabs (ex.: Docas, Expedição) carregando subconjuntos.
- Necessário um **scheduler global de inferência** (substituir o `detectingRef`
  por-componente, `CameraWorkspace.tsx:220`) que faça round-robin entre câmeras
  ativas respeitando um orçamento de FPS de inferência total.

### 3.3. Distribuição de carga de inferência
- Curto prazo: **um worker já serializa**; tornar o agendamento global e
  priorizar a câmera aberta.
- Médio prazo: **pool de workers** (N workers coco-ssd) com fila de tarefas, ou
  mover inferência pesada para **serviço no servidor/edge** (Python/ONNX/YOLO),
  desacoplando da máquina da central. Avaliar **inferência por amostragem**
  (1 a cada k frames) e por classe.
- **(a confirmar)** capacidade-alvo: quantas câmeras simultâneas e a que FPS de
  inferência o negócio exige.

### 3.4. Qualidade / FPS por câmera
- A base já existe: `set-capture` (`index.js:199-203`) + evento `capture`
  (`CameraPage.tsx:81`) e presets `media/alta/maxima` (`config.ts:77-81`) — mas
  **só para webcams**. Para RTSP, `fps/width/quality` são **globais por env**
  (`rtsp.js:97-101`); falta **perfil por fonte RTSP** (reiniciar o ffmpeg da
  fonte com novos args quando o perfil muda).
- Política de "tile = baixa qualidade/fps, aberta = alta" no próprio ingestor
  para poupar banda e ffmpeg.

### 3.5. Layout de grade na central
- `colsFor(n)` satura em 4 colunas e coloca **todas** as câmeras na tela
  (`DashboardPage.tsx:16,126`). Para "diversas câmeras" adicionar:
  **paginação** (ex.: 3×3 por página), **grupos/abas**, busca/filtro, e
  indicador de **status por tile** (online/fps/última-frame/erro).
- Mosaico só renderiza/processa a página visível.

---

## 4. Integração de streams públicos / demo (passo-a-passo)

> O artefato `analises/cameras-fontes-publicas-demo.md` **ainda não existe**
> (a pasta `analises/` estava vazia na elaboração desta avaliação). Quando for
> criado, deve listar URLs RTSP públicas/demo testadas e curadas; **referencie-o
> aqui** como fonte das URLs.

Enquanto não há cadastro dinâmico (seção 3.1), o caminho atual é **arquivo +
restart**:

1. **Instalar o ffmpeg** e garantir que está no `PATH` (sem ele a ingestão RTSP
   não sobe — `rtsp.js:65-69`). Validar com `ffmpeg -version`.
2. **Criar `server/rtsp.sources.json`** copiando o modelo
   `server/rtsp.sources.example.json`. (O arquivo real **já está no
   `.gitignore`** — `server/rtsp.sources.json` — porque pode conter
   credenciais; ver também docs-regenerada/06 §10.2.) Formato:
   ```json
   [
     { "label": "Demo - Praça (público)", "url": "rtsp://.../stream" },
     { "label": "Doca - Carga (CD)",      "url": "rtsp://usuario:senha@10.0.0.51:554/cam/realmonitor?channel=1&subtype=0" }
   ]
   ```
   - Para câmeras Hikvision o caminho típico é `/Streaming/Channels/101`; para
     Dahua/Intelbras, `/cam/realmonitor?channel=1&subtype=0` (ver
     `rtsp.sources.example.json`). **subtype/substream** (ex.: `subtype=1`) puxa
     resolução menor — bom para tiles e para poupar ffmpeg.
   - Credenciais vão embutidas (`usuario:senha@host`); os logs mascaram via
     `redact()` (`rtsp.js:33,88`).
3. **Alternativa sem arquivo** (rápida p/ demo): env
   `RTSP_SOURCES="Demo=rtsp://...;Doca=rtsp://usuario:senha@10.0.0.51:554/..."`
   (`rtsp.js:23-29`). Útil para testar streams públicos sem tocar no repositório.
4. **Ajustar qualidade/fps globais** (opcional) via env antes de subir:
   `RTSP_FPS`, `RTSP_WIDTH`, `RTSP_QUALITY` (`rtsp.js:97-101`). Para validar URL
   nova, comece leve (ex.: `RTSP_WIDTH=480 RTSP_FPS=5`).
5. **Reiniciar o hub** (a leitura das fontes só ocorre no boot,
   `index.js:220-221`). No log devem aparecer linhas
   `[rtsp+] <label> (rtsp-N) ← <url redigida>` (`rtsp.js:88`).
6. **Validar a URL isoladamente** (antes ou em caso de falha), reproduzindo o
   que o código faz:
   ```bash
   ffmpeg -rtsp_transport tcp -i "rtsp://..." -an -vf "fps=8,scale=480:-2" -f mjpeg -q:v 7 -t 5 out_%03d.jpg
   ```
   Se gerar JPEGs, a fonte é compatível com o ingestor. Se falhar, testar sem
   `-rtsp_transport tcp` (algumas câmeras só fazem UDP) **(a confirmar — o código
   hoje força TCP, `rtsp.js:59`)**.
7. **Conferir na central**: a câmera aparece na lista (`cameras`) e no grid; o
   tile deve mostrar frames. Sem frames, mas câmera listada ⇒ ffmpeg conecta mas
   não entrega MJPEG (codec/credencial/caminho errado) — checar log do hub.

> Observação p/ streams **públicos**: muitos demos são RTSP sobre UDP ou
> HTTP/HLS, não RTSP/TCP. Os que não forem RTSP precisarão de outra estratégia
> (ex.: ffmpeg lendo HLS/HTTP como input — `-i http://.../playlist.m3u8`), o que
> hoje **não está parametrizado** (o input é montado como `-rtsp_transport tcp
> -i <url>`, `rtsp.js:58-60`). **(a confirmar)** se basta remover a flag para
> URLs não-RTSP.

---

## 5. Roadmap priorizado

Esforço em escala relativa: **P**=pequeno (≤1 dia), **M**=médio (2-5 dias),
**G**=grande (1-2+ semanas). São estimativas de ordem de grandeza **(a confirmar)**.

### Curto prazo (habilita a demo "diversas câmeras")

| # | Item | Esforço | Risco | Observações |
|---|------|---------|-------|-------------|
| 1 | Curar e validar **URLs públicas/demo** + criar `analises/cameras-fontes-publicas-demo.md` | P | Baixo | Muitos streams públicos caem/mudam; testar item 4 acima |
| 2 | Suportar **input não-RTSP** no ingestor (HLS/HTTP) tornando os args do ffmpeg condicionais ao esquema da URL | P-M | Médio | Streams demo raramente são RTSP/TCP puro |
| 3 | **Status por câmera na UI** (online/offline, fps real, última-frame, erro) | M | Baixo | Hub já tem os eventos; expor `cameras` enriquecido |
| 4 | **Agendador global de inferência** (substituir `detectingRef` por-componente; priorizar câmera aberta; orçamento de FPS) | M | Médio | Maior alavanca de escala com baixo custo |
| 5 | **Paginação/grupos** no grid + processar só visíveis | M | Baixo | Evita travar com N câmeras |
| 6 | **Reconexão com backoff + health-check** de stream congelado no ingestor RTSP | P-M | Médio | Hoje só retry fixo 3 s |

### Médio prazo (robustez e escala real)

| # | Item | Esforço | Risco | Observações |
|---|------|---------|-------|-------------|
| 7 | **CRUD dinâmico de câmeras** (tabela Postgres + `/api/cameras` + start/stop ffmpeg em runtime + UI) | G | Médio | Elimina o "editar JSON e reiniciar"; usar IDs estáveis |
| 8 | **Perfil de qualidade/fps por fonte RTSP** (reiniciar ffmpeg da fonte ao mudar perfil; tile vs aberta) | M | Baixo | Estende `set-capture` ao RTSP |
| 9 | **Persistir zonas/cameraConfig no servidor** (sair do `localStorage`) | M | Médio | Config compartilhada entre operadores/dispositivos |
| 10 | **Pool de workers** de inferência ou **inferência no servidor/edge** (ONNX/YOLO) | G | Alto | Desacopla escala da máquina da central |
| 11 | **Credencial/identidade por dispositivo** (substituir `CAMERA_TOKEN` único) | M | Médio | Segurança ao crescer o parque |
| 12 | **Caminho de produção de baixa latência** WebRTC (go2rtc/mediamtx) substituindo MJPEG | G | Alto | Já indicado no código (`rtsp.js:5`); reduz CPU/banda |

### Riscos transversais
- **Concentração num único hub e numa única central (browser)** é o teto de
  escala — itens 4, 10 e 12 endereçam isso.
- **Streams públicos instáveis** podem comprometer a demo: tratar como
  "best-effort" e ter fallback (clipe local — note que `public/demo/*.mp4` já
  está no `.gitignore`, **(a confirmar)** se há reprodução de arquivo local hoje;
  não há código para isso nos arquivos lidos).
- **Segurança/LGPD**: URLs RTSP com credenciais e `rtsp.sources.json` são
  sensíveis (já ignorados no Git); ao mover para Postgres, **cifrar a URL** e
  controlar acesso (docs-regenerada/06 §10).

---

## 6. Síntese

- **Hoje**: webcam-node e RTSP convergem para o mesmo evento `frame`; o hub é um
  relé puro e **toda a inteligência (decode + inferência) está concentrada numa
  central de navegador**, com **um único worker coco-ssd** servindo todas as
  câmeras.
- **Principais gargalos de escala**: (1) inferência serializada num worker único
  com guarda por-componente; (2) `ffmpeg` por stream concentrado no hub; (3)
  fan-out/banda + decode de todos os feeds na central; (4) fontes RTSP estáticas
  (editar JSON + reiniciar), sem CRUD, sem status/health-check por câmera.
- **Próximo passo recomendado**: implementar um **agendador global de inferência**
  (priorizando a câmera aberta) + **paginação/seleção de feeds** e **status por
  câmera** — maior ganho de escala com menor esforço — em paralelo à curadoria
  das URLs demo. O **CRUD dinâmico de câmeras** vem logo em seguida para tornar a
  conexão de "diversas câmeras" operável sem reiniciar o hub.
