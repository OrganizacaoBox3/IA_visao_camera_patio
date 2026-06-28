# Diagnóstico de Performance — MVP Visão Computacional

> Análise técnica baseada na leitura do código-fonte real (`src/`). Foco: causas de
> **lentidão** e **travamentos** do dashboard que processa N câmeras.
> Data: 2026-06-28. Referências no formato `arquivo:linha`.

---

## 1. Resumo executivo — top 5 causas por impacto

| # | Causa | Onde | Impacto |
|---|---|---|---|
| 1 | **N loops `requestAnimationFrame` independentes (1 por câmera/tile), rodando a ~60 fps mesmo com frames chegando a 15 fps** — cada tile recalcula motion (`getImageData` + `new Float32Array`) e redesenha o canvas inteiro a cada tick, multiplicado pelo número de câmeras. | `CameraWorkspace.tsx:190-288`, `FadigaView.tsx:92-136`, `DashboardPage.tsx:94-99,126-128` | **Crítico** — escala linear (ou pior) com nº de câmeras; principal fonte de travamento. |
| 2 | **Trabalho redundante por frame: sem detecção de "frame novo"** no `CameraWorkspace`. O mesmo `ImageBitmap` (15 fps) é reprocessado ~4× (motion, luma, draw) porque o loop roda no refresh do display. Aloca `new Float32Array(pw*ph)` + `getImageData` a cada tick → pressão de GC e leitura GPU→CPU síncrona. | `CameraWorkspace.tsx:214-216,270` | **Crítico** — ~75% do trabalho de main thread é desperdiçado. |
| 3 | **Inferência pesada na MAIN THREAD nos modos Fadiga e Objetos.** Fadiga roda MediaPipe Face + Hand + coco-ssd **todos na main thread**, com modelos **por instância** (N zonas = N conjuntos de modelos). Objetos usa coco-ssd "andaime" na main thread. | `fadiga.ts:138,154,176`, `models.ts:13-31`, `detector.ts:93` | **Crítico** — bloqueia a main thread por dezenas/centenas de ms; trava a UI. |
| 4 | **Tiling 2×2 + carga dupla de modelos coco.** Câmera aberta dispara 4 inferências (4 tiles × `getImageData` + `postMessage`) por ciclo de 350 ms; o worker é singleton e **serializa** todas as câmeras (fila). Além disso `ensureDetectClient` carrega **dois** modelos coco (worker `mobilenet_v2` + main thread `lite_mobilenet_v2`). | `detect.ts:107-119,31-33`, `model.ts:8`, `config.ts:13,22-23` | **Alto** — 4× custo de inferência na câmera aberta + memória dobrada. |
| 5 | **OWL-ViT (zero-shot transformers.js) é extremamente caro** e o frame de captura (1280 px JPEG q0.82 @15 fps) é maior que o necessário para inferência (que reamostra para 240/512/640). | `owlvitWorker.ts:29-37`, `config.ts:96-99,147-149` | **Alto** — picos de latência no modo Objetos; banda/decodificação acima do necessário. |

**As 3 correções de maior ganho / menor esforço** (detalhe na seção 4):
A) gate de "frame novo" + reuso do buffer de luma no loop do `CameraWorkspace`;
B) acoplar o loop à taxa real de frame (parar o redesenho/motion quando o `ImageBitmap` não mudou) em vez de 60 fps;
C) eliminar a carga dupla de coco e tirar a inferência coco-ssd da main thread no Fadiga/Objetos.

---

## 2. Análise detalhada por área

### 2.1. Arquitetura de loop (orquestração / RAF)

O `DashboardPage` renderiza **um componente por câmera** (`renderTile`, `DashboardPage.tsx:94-99`,
grid em `:126-128`). Cada `CameraWorkspace`/`FadigaView` instala seu **próprio** loop
`requestAnimationFrame` (`CameraWorkspace.tsx:190-288`, `FadigaView.tsx:92-136`). Não há um
scheduler central. Consequências:

- Com N câmeras há **N loops a ~60 fps** disputando a main thread, cada um fazendo
  `getFrame()` → motion → `drawScene`. Mesmo tiles "parados" pagam o custo.
- Os frames chegam a **15 fps** (`config.ts:148`) e são decodificados para `ImageBitmap`
  (`DashboardPage.tsx:53`), mas o loop **não verifica se o frame mudou** — reprocessa o mesmo
  bitmap ~4×.
- A câmera aberta em tela cheia continua com **todos os outros tiles ativos** ao fundo
  (apenas o tile da câmera aberta é substituído por placeholder, `DashboardPage.tsx:95`).

### 2.2. Captura / conversão de frames

- **Nó de câmera** (`CameraPage.tsx:63-78`): `drawImage` + `toBlob("image/jpeg", q)` num
  canvas oculto, em `setInterval(1000/fps)`. Tem **anti-backlog** (`encoding`, `:62,65`) — bom.
  Porém envia **1280 px** (`config.ts:147`), enquanto a detecção reamostra para 240/512/640 px;
  os 1280 px só servem para exibição. JPEG binário (não base64) — bom (`:71-74`).
- **Dashboard** (`DashboardPage.tsx:49-57`): decodifica com `createImageBitmap` **fora da main
  thread**, guarda só o último frame e fecha o bitmap antigo com `.close()` (`:54`) — bom. Há
  "uma decodificação por vez" (`:51`). Não há vazamento aparente de `ImageBitmap`.

### 2.3. Inferência / modelo (coco-ssd, tiling, NMS, worker)

- **Worker coco-ssd** (`detectWorker.ts`): roda fora da main thread (bom). Mas é **singleton
  compartilhado por todas as câmeras** (`detect.ts:14-35`) — serializa a fila; com muitas
  câmeras a latência por câmera cresce (cada `CameraWorkspace` pode ter 1 detect em voo via
  `detectingRef`, `CameraWorkspace.tsx:220`).
- **Tiling 2×2** na câmera aberta (`detect.ts:107-119`, `config.ts:23`): 4 blocos →
  4× `rasterize` (`getImageData` síncrono na main thread, `detect.ts:85-95`) + 4 mensagens +
  4 inferências por ciclo de 350 ms. Custo alto e a rasterização ainda é trabalho de main thread.
- **Carga dupla de modelo** (`detect.ts:31-33`): inicializa o worker com `mobilenet_v2`
  **e** aquece o fallback main-thread `loadDetector()` (`lite_mobilenet_v2`, `model.ts:8`).
  São dois modelos coco na memória; divergência de `base` documentada em
  `docs-regenerada/02-...md:409`.
- **NMS** (`detect.ts:70-81`): O(n²) por classe, mas n é pequeno (≤ `maxBoxes=40`) — custo
  desprezível.

### 2.4. Workers vs main thread

| Carga | Onde roda | Observação |
|---|---|---|
| coco-ssd (Atividade) | **worker** `detectWorker.ts` | OK, mas singleton serializado |
| OWL-ViT (Objetos) | **worker** `owlvitWorker.ts` | OK, porém modelo pesadíssimo |
| coco-ssd "andaime" (Objetos) | **MAIN THREAD** `detector.ts:93` | bloqueia main thread |
| ZXing (Leitura) | **worker** `zxingWorker.ts` | OK (ou BarcodeDetector nativo async) |
| MediaPipe Face/Hand (Fadiga) | **MAIN THREAD** `fadiga.ts:138,154` | wasm chamado de forma síncrona na main thread |
| coco-ssd celular (Fadiga) | **MAIN THREAD** `fadiga.ts:176` | `this.obj.detect(...)` na main thread |

O modo **Fadiga** é o pior caso: três modelos na main thread, **por instância** (`models.ts:2-3`
explica que `runningMode VIDEO` impede compartilhar). N operadores/zonas multiplicam memória e
contenção da main thread.

### 2.5. Render / canvas

- `drawScene` (`CameraWorkspace.tsx:290-369`) executa **a cada tick de rAF** (~60 fps): limpa,
  `drawImage` do frame inteiro + desenha tracks + zonas + máscaras + labels. Não é gated por
  "frame novo" nem pela taxa real. Em tela cheia o canvas é `viewport × devicePixelRatio`
  (`:291-293`) → em telas hi-DPI o custo de fill/stroke cresce muito.
- `drawFadigaScene` idem a cada tick (`FadigaView.tsx:108`).
- O canvas 2D usa `getContext("2d")` repetido por frame (`:294`) — barato, mas
  `getImageData`/`new Float32Array` no motion (`CameraWorkspace.tsx:214-216`) são caros e por frame.

### 2.6. Transmissão socket + JPEG

- Por câmera: ~15 JPEGs/s a 1280 px q0.82. Banda e custo de `createImageBitmap` no dashboard
  escalam com N câmeras. O perfil de **leitura** sobe ainda mais (até 1920 px,
  `config.ts:77-81`). Como a detecção reamostra, a resolução alta só beneficia a tela.

### 2.7. React re-renders

- Cada `CameraWorkspace` faz `setPanel(new Map(...))` + `setPerf` + `setPresence` a cada
  200 ms (full) / 500 ms (tile) (`CameraWorkspace.tsx:276-283`). Isso re-renderiza a subárvore
  do drawer (lista de zonas, legendas) — moderado, mas multiplicado por N tiles. O
  `new Map(...)` força nova referência sempre.
- `FadigaView` re-renderiza a cada 140/350 ms com ~13 `setState` (`FadigaView.tsx:124-131`).
- `DashboardPage` re-renderiza ao receber `cameras`/`cfgs`; `getterFor` é memoizado por
  `gettersRef` (`:70-77`) — bom (não recria props a cada render).

### 2.8. Memória / vazamentos

- **GC churn**: `new Float32Array(pw*ph)` + `getImageData` a cada frame no motion
  (`CameraWorkspace.tsx:215-216`) e no Leitura (`leitura.ts:57`). Em N câmeras × 60 fps isso é
  alocação intensa → pausas de GC (micro-travamentos).
- **ImageBitmap**: liberado corretamente (`DashboardPage.tsx:54,45`).
- **Modelos**: Fadiga fecha Face/Hand no `dispose` (`fadiga.ts:230-235`) — bom; mas duas
  instâncias coco coexistem por causa da carga dupla (2.3).
- **Canvases reutilizados** (`scratch`, `rasterCanvas`, `proc`, `motion`, crops) — bom, sem
  vazamento.
- **Tensores tfjs**: `model.detect` gerencia tensores internamente; não há `tf.tidy` manual
  exposto, mas o coco-ssd já libera — risco baixo desde que não se troque de backend.

---

## 3. Problemas detalhados (evidência → causa → correção)

### P1 — Loop a 60 fps reprocessa frames de 15 fps (sem gate de frame novo)
- **Evidência**: `CameraWorkspace.tsx:194` (`requestAnimationFrame(loop)`), motion/luma em
  `:214-216`, draw em `:274` — nenhum compara o `ImageBitmap` atual com o anterior.
- **Por quê**: o loop roda no refresh do monitor (~60 fps), mas o frame só muda a 15 fps. ~3 de
  cada 4 iterações fazem motion + luma + redraw **sobre o mesmo pixel** → desperdício e GC.
- **Correção**: guardar `lastFrameElRef`/`lastFrameTsRef`; se `f.el === lastFrameEl` (ou `f.ts`
  igual), **pular** motion/detecção/draw nesse tick (continuar agendando o rAF). O `FadigaProcessor`
  já tem esse padrão (`newFrame` via `lastEl`, `fadiga.ts:124-125`) — replicar no `CameraWorkspace`.
  Idealmente expor `ts` no `FrameSource`/getter (`DashboardPage.tsx:73`) para comparação barata.
- **Esforço**: baixo. **Ganho**: alto (~60-75% menos trabalho de main thread por câmera).

### P2 — Alocação de `Float32Array` + `getImageData` por frame no motion
- **Evidência**: `CameraWorkspace.tsx:214` (`getImageData`), `:215` (`new Float32Array(pw*ph)`),
  `:270` (`prevLumaRef = luma`). Idêntico em `leitura.ts:57`.
- **Por quê**: leitura GPU→CPU síncrona + alocação grande a cada frame → pressão de GC e stalls.
- **Correção**: alocar **dois buffers de luma reutilizáveis** (atual/anterior) e fazer swap em
  vez de `new`; só recriar ao mudar `pw/ph`. Combinar com P1 para só ler quando o frame muda.
- **Esforço**: baixo. **Ganho**: médio-alto (elimina GC churn do caminho quente).

### P3 — Inferência coco-ssd na MAIN THREAD no Fadiga e Objetos
- **Evidência**: `fadiga.ts:176` (`this.obj.detect(...)`), `detector.ts:93`
  (`model.detect(...)` andaime), ambos via `loadDetector()` (`model.ts:7`) que roda na main thread.
- **Por quê**: `model.detect` é síncrono-pesado na main thread (dezenas/centenas de ms) → trava
  desenho e interação enquanto infere.
- **Correção**: reaproveitar o **worker** `detectWorker.ts` (já existente) para o coco do Fadiga
  (celular) e para o andaime do Objetos, em vez de `loadDetector` na main thread. Alternativa de
  curtíssimo prazo: aumentar `fadiga.objectIntervalMs` (220→500+) e `objects` andaime menos
  frequente para reduzir a frequência de bloqueio.
- **Esforço**: médio (rotear pelo worker) / baixo (só afrouxar cadência). **Ganho**: alto.

### P4 — Modelos MediaPipe Face/Hand na main thread, por instância
- **Evidência**: `fadiga.ts:138,154` (`detectForVideo` na main thread), `models.ts:13-31`
  (criados por instância; `numHands:2`, `numFaces:1`).
- **Por quê**: MediaPipe Tasks (wasm) executa na thread que chama; cada zona/câmera de fadiga
  carrega e roda seu próprio par de modelos → memória e contenção multiplicadas.
- **Correção**: (a) limitar nº de câmeras/zonas de fadiga simultâneas; (b) considerar delegate
  **GPU** no `createFromOptions` (`baseOptions.delegate: "GPU"`) se suportado; (c) afrouxar
  `faceIntervalMs`/`handIntervalMs` (`config.ts:108-109`); (d) avaliar mover MediaPipe para um
  worker (OffscreenCanvas) — maior esforço.
- **Esforço**: médio/alto. **Ganho**: alto no modo Fadiga.

### P5 — Carga dupla de modelos coco-ssd
- **Evidência**: `detect.ts:31` (worker `mobilenet_v2`) + `:33` (`loadDetector()` main thread
  `lite_mobilenet_v2`, `model.ts:8`).
- **Por quê**: dois modelos coco residentes em memória (e dois downloads) sem necessidade no
  caminho feliz (worker funcionando).
- **Correção**: só aquecer o fallback main-thread **após** o worker falhar (`workerFailed`), não
  proativamente. Unificar `base` para evitar dois pesos baixados.
- **Esforço**: baixo. **Ganho**: médio (memória + tempo de carga inicial).

### P6 — Tiling 2×2 ligado por padrão na câmera aberta
- **Evidência**: `config.ts:23` (`cols:2,rows:2`), `detect.ts:107-119`, gatilho em
  `CameraWorkspace.tsx:219,222` (`mode === "full"`).
- **Por quê**: 4 rasterizações (`getImageData` main thread) + 4 inferências por ciclo de 350 ms.
- **Correção**: tornar o tiling **opcional/condicional** (ligar só quando houver objetos
  pequenos/cena densa, ou via toggle). Para a maioria das cenas, `1×1` reduz o custo de detecção
  em ~4×. Alternativa: subir `objectIntervalMs` quando tiling ligado.
- **Esforço**: baixo. **Ganho**: alto na câmera aberta.

### P7 — `drawScene` redesenha tudo a ~60 fps
- **Evidência**: `CameraWorkspace.tsx:274` chamado todo tick; canvas a `vp×dpr` (`:291-293`).
- **Por quê**: fill/stroke/`drawImage` de tela cheia em hi-DPI a 60 fps × N câmeras.
- **Correção**: redesenhar só quando o frame mudar (P1) ou no máximo na taxa de frame; limitar
  `dpr` efetivo (ex.: `Math.min(dpr, 1.5)`) para o canvas de overlay.
- **Esforço**: baixo. **Ganho**: médio.

### P8 — OWL-ViT muito caro (modo Objetos)
- **Evidência**: `owlvitWorker.ts:29-37` (`pipeline("zero-shot-object-detection")`, `topk:50`),
  `config.ts:96-99` (`procWidth:640`, `detectIntervalMs:700`).
- **Por quê**: transformer zero-shot em wasm é ordens de magnitude mais lento que coco-ssd;
  picos de latência e fila no worker.
- **Correção**: reduzir `procWidth` (640→480/384), aumentar `detectIntervalMs` quando em tile,
  reduzir `topk`, e usar WebGPU/wasm-SIMD com threads no transformers.js se disponível
  (`env.backends.onnx.wasm.numThreads`). Considerar coco-ssd como primário quando as classes
  forem cobertas por COCO.
- **Esforço**: baixo (parâmetros) / médio (backend). **Ganho**: alto no modo Objetos.

### P9 — Frame de captura maior que o necessário
- **Evidência**: `config.ts:147-149` (1280 px, 15 fps, q0.82); detecção reamostra para 240
  (`config.ts:7`), 512 (`:22`), 640 (`:98`).
- **Por quê**: banda + `toBlob` (nó) + `createImageBitmap` (dashboard) pagam por pixels que só
  servem para exibição.
- **Correção**: reduzir `frameWidth` (ex.: 960) e/ou `frameFps` (ex.: 10-12) para câmeras de
  atividade; manter alta resolução só no modo leitura. Avaliar `q` 0.7-0.75.
- **Esforço**: baixo. **Ganho**: médio (banda, decodificação, escala com N).

### P10 — `setState` em rajada por tile (re-render)
- **Evidência**: `CameraWorkspace.tsx:276-283` (`setPanel(new Map)`, `setPerf`, `setPresence`),
  `FadigaView.tsx:124-131` (~13 setState).
- **Por quê**: cada tile re-renderiza sua subárvore 2-5×/s; multiplicado por N.
- **Correção**: agrupar em um único objeto de estado por tile; aumentar o intervalo de UI no
  modo tile (`:276` já usa 500 ms — pode subir para 750-1000 ms); evitar recriar `Map` quando
  nada mudou (comparar tamanho/refs).
- **Esforço**: baixo. **Ganho**: baixo-médio.

---

## 4. Tabela priorizada (quick wins primeiro)

| Prioridade | Ação | Arquivo(s) | Esforço | Ganho | Tipo |
|---|---|---|---|---|---|
| 1 | Gate de "frame novo" (pular motion/detect/draw se `ImageBitmap` não mudou) | `CameraWorkspace.tsx:194,214,274`; getter em `DashboardPage.tsx:73` | Baixo | Alto | Quick win |
| 2 | Reusar buffers de luma (swap em vez de `new Float32Array`/`getImageData` por frame) | `CameraWorkspace.tsx:215`, `leitura.ts:57` | Baixo | Médio-Alto | Quick win |
| 3 | Não aquecer o coco main-thread proativamente (só no fallback) | `detect.ts:33` | Baixo | Médio | Quick win |
| 4 | Tiling opcional/condicional (default 1×1) ou cadência maior quando ligado | `config.ts:23`, `detect.ts:107` | Baixo | Alto | Quick win |
| 5 | Reduzir captura: `frameWidth` 1280→960, `frameFps` 15→12, `q` 0.82→0.75 (atividade) | `config.ts:147-149` | Baixo | Médio | Quick win |
| 6 | Afrouxar cadências de inferência (objetos andaime, fadiga `objectIntervalMs`) | `config.ts:99,110` | Baixo | Médio | Quick win |
| 7 | Cap de `devicePixelRatio` no overlay + draw só na taxa de frame | `CameraWorkspace.tsx:291-293,274` | Baixo | Médio | Quick win |
| 8 | OWL-ViT: `procWidth`↓, `topk`↓, threads wasm/WebGPU | `config.ts:98`, `owlvitWorker.ts:33` | Baixo-Médio | Alto | Médio |
| 9 | Mover coco-ssd do Fadiga (celular) e do andaime Objetos para o worker | `fadiga.ts:176`, `detector.ts:93` | Médio | Alto | Médio |
| 10 | Agrupar `setState` por tile + intervalo de UI maior | `CameraWorkspace.tsx:276`, `FadigaView.tsx:124` | Baixo | Baixo-Médio | Quick win |
| 11 | Scheduler central de processamento (1 loop, round-robin entre câmeras) em vez de N rAF | `DashboardPage.tsx`, `CameraWorkspace.tsx:190` | Alto | Alto | Estrutural |
| 12 | MediaPipe (Fadiga) em worker/OffscreenCanvas + delegate GPU; limitar nº simultâneo | `models.ts:15-30`, `fadiga.ts` | Alto | Alto | Estrutural |
| 13 | `requestVideoFrameCallback` / acoplar processamento à chegada de frame (push) em vez de rAF | `DashboardPage.tsx:39`, loops | Médio | Médio-Alto | Estrutural |

---

## 5. Métricas para instrumentar e validar

Já existe `FrameMeter` (`telemetry.ts`) medindo FPS e latência média (usado em `FadigaView`).
Recomenda-se expandir e expor no dashboard:

1. **FPS de processamento por câmera** — `meterRef.current.fps` já calculado
   (`CameraWorkspace.tsx:279`); exibir por tile e um agregado. Meta: estável ≥ taxa de frame
   (12-15), sem quedas bruscas.
2. **Taxa de frames "úteis" vs "repetidos"** — após o gate P1, contar quantos ticks de rAF
   tiveram frame novo. Deve cair para ~taxa de captura (valida P1).
3. **Latência de inferência por modelo** — já há `detectMs` (Objetos `objetos.ts:67`),
   `decodeMs` (Leitura), `faceMs/handMs/objMs` (Fadiga `fadiga.ts`). Empilhar em `FrameMeter`
   e expor p50/p95. Vigiar coco main-thread (P3/P4).
4. **Tempo de main thread bloqueado** — usar `PerformanceObserver` com `longtask`
   (entradas > 50 ms) para quantificar travamentos; correlacionar com inferência main-thread.
5. **Heap JS** — `performance.memory.usedJSHeapSize` (Chromium) amostrado a cada ~5 s; vigiar
   crescimento monotônico (vazamento de `ImageBitmap`/tensores) e amplitude do serrilhado de GC
   (valida P2).
6. **Profundidade de fila do worker** — contar `pending.size` em `detect.ts:18` e
   `detector.ts:25`; fila crescente indica saturação (valida P6/P8 e o gargalo do singleton).
7. **Tamanho/cadência do JPEG** — logar bytes por frame e fps efetivo no nó
   (`CameraPage.tsx:74`) e no dashboard; valida P9 (banda) e o anti-backlog.
8. **Tempo de `createImageBitmap`** — medir em `drainDecode` (`DashboardPage.tsx:53`) para
   confirmar que a decodificação não é gargalo após reduzir resolução.

**Como validar**: medir baseline (FPS, p95 de inferência, longtasks/min, heap) com 1, 4 e 8
câmebras nos modos atividade/objetos/fadiga; aplicar os quick wins 1-7; re-medir. Espera-se
queda forte em longtasks/min e em alocação/GC, e FPS estável próximo da taxa de captura.
