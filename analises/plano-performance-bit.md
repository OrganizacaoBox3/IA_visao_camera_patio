# Plano "escova-bit" — processamento de câmera + dashboard rápidos/responsivos

> 2ª rodada de performance (após P0/P1/P2 de `plano-performance-imagem.md`). Três análises
> paralelas com evidência `arquivo:linha` (captura→hub, hub→dashboard, loop de visão/IA).
> Regra: dentro da arquitetura atual (MJPEG/socket.io) — WebRTC continua fora (overengineering).
> Validação headless = verify+e2e; ganho real medido em runtime (FPS/CPU antes×depois).

## O que a análise CONFIRMOU que já está bom (não tocar)
Binário sem base64 · perMessageDeflate desligado · decode "latest-wins" só de feeds ativos ·
gate de frame novo no CameraWorkspace · canvas do tile no tamanho de exibição ·
willReadFrequently + ping-pong de buffers de luma em todos os readbacks · scheduler com
coalescência/prioridade · ZXing/OWL-ViT em workers com transferables · warmup do coco ·
telemetria via refs (sem re-render) · cine-loop só na aberta · CSS estático nos tiles.

## ONDA 1 — Quick wins (esforço baixo, ganho imediato; paralelizável)

| # | O quê | Evidência | Ganho |
|---|---|---|---|
| 1.1 | `.volatile.emit` no frame RTSP (hoje enfileira em dashboard lento; webcam já tem) | `rtsp.js:216` vs `index.js:150` | Alto sob carga |
| 1.2 | `socket.volatile.emit` no nó de câmera (reconnect despeja ~70MB de frames velhos do sendBuffer) | `CameraPage.tsx:113` | Alto (rede real) |
| 1.3 | MediaPipe `delegate: "GPU"` (hoje CPU/WASM **síncrono na main** a cada 66/90ms) | `fadiga/models.ts:17-32`, `fadiga.ts:281-317` | **Alto** (jank fadiga) |
| 1.4 | FadigaView: gate de "frame novo" (hoje redesenha a 60Hz p/ vídeo de 12fps) | `FadigaView.tsx:161-176` (padrão certo: `CameraWorkspace.tsx:646`) | Alto p/ tile fadiga |
| 1.5 | FadigaView: rebaixar cadência face/mãos na GRADE (hoje full 66/90ms mesmo em tile; zonas já rebaixam a 4s — usar ~500ms–1s p/ fadiga) | `FadigaView.tsx:172`, `config.ts:168-170` | Alto (grade) |
| 1.6 | `React.memo(CameraTile)` + callbacks estáveis (`onOpen`/`handleAlert`) — hoje todo `camera-status` (5s/câmera) re-renderiza a árvore inteira ×6 tiles | `CameraTile.tsx:60`, `DashboardPage.tsx:215-217,548,700` | Médio (UI "pastosa") |
| 1.7 | Fix corrida/vazamento no drainDecode (decode em voo ao paginar reatribui bitmap órfão; podar framesRef de câmeras removidas) | `DashboardPage.tsx:184-196,421-441` | Memória |
| 1.8 | ffmpeg low-latency: `-fflags nobuffer -flags low_delay -probesize 500000 -analyzeduration 0 -nostats -loglevel error` (e logar stderr real) | `rtsp.js:175-185,203-205` | Médio (latência −0,5–2s) |
| 1.9 | Worker de detecção: postar `tf.getBackend()` no ready + alerta se `cpu` (fallback silencioso hoje é invisível) | `detectWorker.ts:39-49` | Seguro (evita modo catastrófico) |
| 1.10 | Tick de UI: comparar antes de setar (`setPanel/setPerf/setPresence` criam objetos novos a cada 200/500ms → re-render de ~800 linhas de JSX sem mudança) | `CameraWorkspace.tsx:889-914` | Baixo-médio |

## ONDA 2 — Estruturais (esforço médio, mudam a ordem de escala)

| # | O quê | Evidência | Ganho |
|---|---|---|---|
| 2.1 | **Assinatura por câmera (rooms)**: dashboard emite `watch/unwatch {ids}` quando a página muda (efeito já existe em `DashboardPage.tsx:421-441`); hub emite frame p/ `cam:<id>`; fallback = comportamento atual (contrato ADITIVO). **Bônus shed:** sala vazia → pausar/derrubar fps do ffmpeg e mandar `capture` fps-baixo ao nó (hoje ffmpeg re-encoda 24/7 sem audiência) | `index.js:149-162`, `rtsp.js:206-217` | **Alto** — O(N total)→O(página): 20 câmeras ≈ 240 ev/s e ~30MB/s → só a página |
| 2.2 | **Decode com resize p/ tiles**: `createImageBitmap(blob,{resizeWidth:640})` quando o feed está só em tile (72 decodes/s de 1280×720≈3,7MB RGBA p/ exibir ~400px). **Exceções obrigatórias:** câmera com zona de leitura (ZXing precisa de pixels) ou perfil longRange (tiling 4×4 precisa do nativo) | `DashboardPage.tsx:184` | Alto (CPU decode, memória, GPU) |
| 2.3 | **Coco do celular (fadiga) via worker existente** — hoje roda na main a cada 500ms E carrega um 2º modelo (`lite_mobilenet_v2`) duplicado | `fadiga.ts:358-359,165`, `model.ts:8` | Alto (jank + memória GPU) |
| 2.4 | **Long-range: 1 tile = 1 tarefa do scheduler + tile rotation na grade** (hoje `Promise.all` de 16 tiles = UMA tarefa que monopoliza o worker ~0,5–1,3s e faz a câmera ABERTA esperar; rotação: K de 16 tiles por rodada, fundindo no NMS) | `detect.ts:206-212`, `scheduler.ts:21,59` | Alto c/ LR ligado |
| 2.5 | **Luma long-range 1× por câmera** (hoje cada zona re-rasteriza o frame inteiro 480px/frame; caminho default já compartilha certo) | `atividade.ts:192-220` vs `CameraWorkspace.tsx:663-685` | Médio (LR + N zonas) |

## ONDA 3 — Só se as medições pedirem
- **3.1** `rasterize` sem readback na main: `createImageBitmap(f.el, sx,sy,sw,sh,{resize*})` por tile + transferir ImageBitmap ao worker (`fromPixels` aceita) — zero `getImageData` no caminho do coco (`detect.ts:145-168`).
- **3.2** Nó: `requestVideoFrameCallback` c/ gate de fps no lugar de `setInterval` (evita re-encodar frame repetido em cena escura/estática); `alpha:false` no context.
- **3.3** `alpha:false` (+`desynchronized`) nos canvases de palco + fillRect no letterbox (`CameraWorkspace.tsx:932`, `fadiga/draw.ts:55`, `camera/draw.ts:190`).
- **3.4** Motion a cada 2º frame na grade (~6fps; alarme confirma em 900ms — folga) (`CameraWorkspace.tsx:663-685`).

## Descartado por honestidade (custo > ganho)
Parser MJPEG (Buffer.concat) · micro-alocações no relé · consolidar N loops rAF em 1 ·
batch de tiles no tfjs (exige forkear coco-ssd) · OffscreenCanvas/worker p/ encode do nó ·
WebRTC/WebCodecs (fica como evolução de arquitetura, fora deste plano).

## Execução e validação
- Paralelizar por propriedade de arquivo: Onda 1 em 4 frentes (rtsp.js+CameraPage · fadiga/models+FadigaView · DashboardPage+CameraTile · CameraWorkspace+detectWorker). Onda 2 idem, com mini-spec p/ 2.1 (contrato aditivo `watch/unwatch`).
- Cada onda: `npm run verify` + e2e 8/8 + commit por frente lógica.
- **Medição de runtime (usuário):** FPS de exibição, CPU (Task Manager/DevTools), latência frame→tela, antes×depois com as mesmas câmeras. Sem evidência não há pronto.
