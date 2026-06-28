# Modos de Operação / Processadores

> Documento gerado a partir da leitura do código-fonte (`src/`). Descreve os quatro modos de
> operação do MVP de visão computacional — **Atividade**, **Fadiga**, **Leitura** e **Objetos** —
> e como cada um se encaixa no contrato comum de processadores, no núcleo de visão e na UI.
>
> Referências de código usam o formato `caminho:linha`.

---

## 1. Visão geral e a espinha dorsal (`types.ts`)

Cada modo de operação é implementado como um **processador de zona**: uma classe de domínio puro
(sem React/IO) que recebe o contexto de um frame + a configuração da zona e devolve estado +
efeitos. A view (`CameraWorkspace.tsx`, `FadigaView.tsx`) cuida da apresentação (timeline, toast,
beep, gravação, desenho).

O contrato transversal vive em `src/processors/types.ts`:

- `ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga"` — identifica o modo de uma zona
  (`src/processors/types.ts:6`).
- `Severity = "info" | "warn" | "high"` — severidade de eventos para a timeline
  (`src/processors/types.ts:7`).
- `ZoneBase = NormRect & { id; label; modo }` — geometria normalizada (0..1) + identidade + modo
  (`src/processors/types.ts:10`). A configuração específica de cada modo fica na `cfg` da zona.
- `Disposable { dispose(): void }` — todo processador é descartável; ao remover a zona, libera
  modelos/recursos (`src/processors/types.ts:13`).

O tipo `NormRect` e `FrameSource` (a fonte de frame compartilhada entre views e processadores) ficam
em `src/frame.ts`:

```ts
type FrameSource = { el: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap; w: number; h: number };
type NormRect    = { x: number; y: number; w: number; h: number };
```

Princípio de design (visível nos comentários do código): **ISP/SRP/DRY** — cada modo define seu
próprio `Ctx` (contexto de entrada) e `Result` (saída) concretos; `types.ts` carrega só o que é
transversal e o ciclo de vida.

### Padrão comum dos quatro processadores

Todos seguem a mesma forma:

| Processador | Arquivo | Entrada `process(...)` | Saída |
|---|---|---|---|
| `AtividadeProcessor` | `src/processors/atividade.ts:55` | `(zone, ctx)` | `AtividadeResult` |
| `FadigaProcessor` | `src/processors/fadiga.ts:46` | `(ctx)` | `FadigaResult` |
| `LeituraProcessor` | `src/processors/leitura.ts:26` | `(zone, ctx)` | `LeituraResult` |
| `ObjetosProcessor` | `src/processors/objetos.ts:39` | `(setores, classes, ctx)` | `ObjetosResult` |

Características compartilhadas:

- **Uma instância por zona** mantém o runtime/estado (EMA, janelas temporais, contadores).
- **Inferência throttled e assíncrona**: detecções pesadas (coco-ssd, OWL-ViT, ZXing) rodam em
  workers/Promises e não bloqueiam o loop de render.
- **Recorders**: acumulam amostras (tipicamente 1/s) e emitem em lote (a cada 3–5 s) para o store de
  relatórios.
- **Efeitos como dados**: o processador nunca toca em DOM/áudio; devolve `events`, `alerts`, `beep`,
  `sample` e a view decide o que fazer.

### Integração com o núcleo de visão e a UI

O orquestrador é o loop de `requestAnimationFrame` em `src/CameraWorkspace.tsx:190`. Para cada zona,
ele:

1. Obtém o frame via `getFrame()` (`src/CameraWorkspace.tsx:198`) — um `FrameSource`.
2. Calcula **uma vez por frame** os dados de nível de frame compartilhados (luminância para motion +
   detecção coco-ssd) quando há zona de atividade (`src/CameraWorkspace.tsx:207-227`).
3. Instancia o processador certo conforme `z.modo` (`src/CameraWorkspace.tsx:142`):
   ```ts
   const proc = z.modo === "leitura" ? new LeituraProcessor()
              : z.modo === "objetos" ? new ObjetosProcessor()
              : z.modo === "fadiga"  ? new FadigaProcessor()
              :                        new AtividadeProcessor(performance.now());
   ```
4. Chama `proc.process(...)` e roteia a saída: timeline (`pushTimeline`), alertas
   (`onAlertRef`), gravação (`recordReads`, `recordObjectSamples`, etc.) e o painel
   (`resultsRef`/`setPanel`) (`src/CameraWorkspace.tsx:235-283`).

O modo **Fadiga** também tem uma view dedicada de câmera única (`src/FadigaView.tsx`) que usa o
mesmo `FadigaProcessor` (`src/FadigaView.tsx:35`,`:104`).

---

## 2. Modo ATIVIDADE — ocupação / ociosidade / fluxo por zona

Arquivo: `src/processors/atividade.ts`.

### O que faz

Mede ocupação, ociosidade e fluxo de uma área (zona retangular, opcionalmente com máscara de área
irregular). Classifica a zona numa máquina de estados e dispara alertas de inatividade.

### Modelo / algoritmo

Combina dois sinais:

1. **Movimento por diferença de luminância** (independente de classe): conta pixels cuja luminância
   mudou acima de `motionPixelDelta` entre o frame atual e o anterior, dentro da ROI da zona
   (`src/processors/atividade.ts:66-76`). Suavizado por EMA (`motionEMA`,
   `src/processors/atividade.ts:77`).
2. **Ocupação por objetos**: consome a detecção coco-ssd feita no nível do frame; considera ocupada
   se houver um objeto de `occupancyClasses` cujo centro caia na zona
   (`src/processors/atividade.ts:80-87`).

### Estados (`ZoneState`)

`ATIVA | LENTA | OCIOSA | VAZIA | ALERTA` (`src/processors/atividade.ts:10`), com cores em
`STATE_COLOR` (`:18`). A decisão do alvo de estado está em `src/processors/atividade.ts:96-101`:

- `idleMs > idleLimit` → `ALERTA`
- `slow` → `LENTA`
- `idleMs < activeHoldMs` → `ATIVA`
- `occupied` → `OCIOSA`
- caso contrário → `VAZIA`

Há **anti-flicker**: transições (exceto entrar em ALERTA) só confirmam após `stateConfirmationMs`
(`src/processors/atividade.ts:103-104`).

### Parâmetros / thresholds (de `APP_CONFIG.detection` e `APP_CONFIG.zones`)

| Parâmetro | Valor | Papel | Ref |
|---|---|---|---|
| `procWidth` | 240 | largura do canvas de motion | `src/config.ts:7` |
| `motionPixelDelta` | 22 | delta de luminância p/ "pixel mudou" | `src/config.ts:8` |
| `motionActiveRatio` | 0.012 | fração alterada p/ ATIVA | `src/config.ts:9` |
| `motionSlowRatio` | 0.004 | fração p/ LENTA (gargalo) | `src/config.ts:10` |
| `signalSmoothingAlpha` | 0.4 | EMA do movimento | `src/config.ts:11` |
| `objectScoreThreshold` | 0.5 | confiança mínima p/ ocupação | `src/config.ts:16` |
| `occupancyClasses` | person, truck, car, bus, motorcycle, bicycle | classes que contam | `src/config.ts:19` |
| `activeHoldMs` | 1200 | mantém ATIVA após movimento | `src/config.ts:28` |
| `stateConfirmationMs` | 900 | confirma transição | `src/config.ts:29` |
| `defaultIdleAlertMs` | 15 min | limite de ociosidade (default) | `src/config.ts:43` |
| `demoIdleAlertMs` | 10 s | limite curto p/ demo | `src/config.ts:44` |
| `alertBeepCooldownMs` | 4000 | cooldown do beep | `src/config.ts:50` |

A **sensibilidade** (1..10) por zona ajusta os limiares de movimento:
`sensitivityFactor(s) = 2^((5 - s)/4)` — 5 ≈ 1.0; maior = detecta movimento mais sutil
(`src/processors/atividade.ts:26`).

### Entradas / saídas

- Entrada: `AtividadeZone` (geometria + `idleAlertMs`, `sensitivity`, `atividade`, `contains?`)
  e `AtividadeCtx` (`src/processors/atividade.ts:29-35`) — contém `luma`/`prev` (motion), `dets`
  (coco-ssd), `tracks` (pessoas rastreadas), e flags `sampleFlow`/`recEmit`.
- Saída: `AtividadeResult` (`src/processors/atividade.ts:37-43`): `view` (estado p/ UI),
  `sample` (histórico), `event` (timeline), `alert` (ao entrar em ALERTA) e `beep`.

### Fluxo interno

Movimento → EMA → ocupação → estado-alvo → confirmação anti-flicker → eventos/alerta/beep →
contagem de pessoas na zona → acumulação de histórico (idle/active frames) → cálculo de `flowLevel`
(Alto/Médio/Baixo) (`src/processors/atividade.ts:61-140`).

### Integração

`CameraWorkspace.tsx` monta o `AtividadeCtx` com dados de nível de frame
(`src/CameraWorkspace.tsx:238`), chama `process`, e roteia: `r.event` → timeline, `r.alert` → toast
+ `recordAlert`, `r.sample` → `recordSamples` (`src/CameraWorkspace.tsx:240-244`). Os `tracks` de
pessoas são mantidos por `updateTracks` na própria view (`src/CameraWorkspace.tsx:226`). É o **único
modo** que usa os sinais de nível de frame (luma + coco-ssd) computados em
`src/CameraWorkspace.tsx:207-227`. `dispose()` é no-op (sem recursos externos —
`src/processors/atividade.ts:143`).

---

## 3. Modo FADIGA — operador (landmarks faciais, gestos, celular)

Arquivos: `src/processors/fadiga.ts`, `src/fadiga/landmarks.ts`, `src/fadiga/models.ts`,
`src/fadiga/calibration.ts`, `src/fadiga/draw.ts`. Portado de `sensor_fadiga_mvp`.

### O que faz

Monitora um operador (uma câmera/ROI por operador) detectando **fadiga** (olhos fechados, bocejo),
**uso de celular** e **gestos manuais**, com um motor de risco que emite alertas.

### Modelos / algoritmos

Três pipelines, com modelos próprios da instância:

1. **MediaPipe FaceLandmarker** (`src/fadiga/models.ts:13`) — `runningMode: VIDEO`, `numFaces: 1`.
   Modelo `face_landmarker.task` (float16) do Google Storage (`src/config.ts:106`). Produz landmarks
   faciais usados para **EAR** (Eye Aspect Ratio) e **MAR** (Mouth Aspect Ratio).
2. **MediaPipe HandLandmarker** (`src/fadiga/models.ts:24`) — `numHands: 2`. Para inferir gestos
   (`MAO_ABERTA`, `PUNHO_FECHADO`, `JOINHA`).
3. **coco-ssd** (`src/vision/model.ts`, via `loadDetector`) — detecta `cell phone` para o sinal de
   celular, com **score adaptativo** por contexto.

O `FilesetResolver` (wasm MediaPipe) é compartilhado; os landmarkers são criados **por instância**
pois `runningMode VIDEO` mantém estado de timestamp interno (`src/fadiga/models.ts:1-11`).

#### EAR / MAR (`src/fadiga/landmarks.ts`)

- `calcEar` (`:33`): média do EAR dos dois olhos. EAR = `(|p2-p6| + |p3-p5|) / (2·|p1-p4|)` sobre os
  índices `eyeIndices` (`src/config.ts:127`).
- `calcMar` (`:39`): `|aberturaVertical| / |larguraBoca|` sobre `mouthIndices` (`src/config.ts:128`).
- Gestos: `inferManualSignal` (`:59`) classifica a mão pelos dedos estendidos + polegar
  (`fingerExtended`/`thumbExtended`).
- Geometria de apoio para o score adaptativo de celular: `normalizedLandmarksRect` (`:83`),
  `earZones` (regiões perto das orelhas, `:89`), `rectIntersectionArea`/`rectIou` (`:72`,`:77`).

### Score adaptativo de celular

Em `src/processors/fadiga.ts:176-195`: das detecções coco-ssd de `cell phone` com score bruto
≥ `phoneMinRawScore`, aplica boosts se a caixa do telefone intersecta zonas próximas à orelha
(`phoneAdaptiveBoostEar`) ou às mãos (`phoneAdaptiveBoostHand`); aceita se `adj ≥ phoneScore`
(calibrável) **ou** `raw ≥ phoneScoreThreshold`. Mantém a detecção por `phoneRetainMs` (anti-flicker).

### Motor de risco (`updateRisk`, `src/processors/fadiga.ts:81-116`)

Usa janelas temporais de confirmação:

- `eyesConfirmed`: EAR < `earClosed` por ≥ `fatigueMs`.
- `yawnConfirmed`: MAR ≥ `marYawn` por ≥ `yawnConfirmationMs` (incrementa contador de bocejo).
- `phoneConfirmed`: celular presente por ≥ `phoneConfirmationMs`.
- `fatigue = eyesConfirmed || yawnConfirmed`.

Estado de risco (`RiskState`): `fatigue && phone → ALERTA_DUPLO`; `fatigue → ALERTA_FADIGA`;
`phone → ALERTA_CELULAR`; senão `OK`. Há histerese: saída de alerta só após `recoveryGraceMs`;
troca entre alertas só após `minAlertStateHoldMs` (`src/processors/fadiga.ts:101-103`).

### Parâmetros / thresholds (de `APP_CONFIG.fadiga`, `src/config.ts:104-130`)

| Parâmetro | Valor | Papel |
|---|---|---|
| `faceIntervalMs` / `handIntervalMs` / `objectIntervalMs` | 66 / 90 / 220 | cadência de cada pipeline |
| `phoneClassName` | "cell phone" | classe coco-ssd |
| `phoneScoreThreshold` | 0.55 | aceita por score bruto |
| `phoneMinRawScore` | 0.28 | filtro bruto mínimo |
| `phoneAdaptiveBoostEar` / `...Hand` | 0.22 / 0.18 | boosts contextuais |
| `phoneAdjustedScoreThreshold` | 0.52 | limiar do score ajustado (calibrável) |
| `phoneRetainMs` | 420 | retenção anti-flicker |
| `eyesClosedEarThreshold` | 0.21 | EAR de olho fechado (calibrável) |
| `yawnMarThreshold` | 0.075 | MAR de bocejo (calibrável) |
| `fatigueConfirmationMs` | 1500 | tempo p/ confirmar fadiga (calibrável) |
| `phoneConfirmationMs` / `yawnConfirmationMs` | 1000 / 900 | confirmação |
| `recoveryGraceMs` | 600 | tolerância p/ sair de alerta |
| `signalSmoothingAlpha` | 0.35 | EMA de EAR/MAR |
| `minAlertStateHoldMs` | 900 | hold entre alertas |
| `handGestureConfirmationMs` | 700 | confirmação de gesto |
| `eyeIndices` / `mouthIndices` | índices MediaPipe | EAR/MAR/desenho |

### Calibração (`src/fadiga/calibration.ts`)

Quatro limiares são **calibráveis na UI** e persistidos em `localStorage`
(chave `vp-fadiga-thresholds`): `earClosed`, `marYawn`, `phoneScore`, `fatigueMs`
(`FadigaThresholds`, `src/processors/fadiga.ts:23`). `FADIGA_THRESHOLD_FIELDS`
(`src/fadiga/calibration.ts:17`) define faixas/labels/dicas dos sliders. O default vem de
`APP_CONFIG.fadiga`. Em runtime, `FadigaProcessor.setThresholds(partial)` mescla os valores
(`src/processors/fadiga.ts:72`). `CameraWorkspace` aplica a calibração global ao criar a zona
(`src/CameraWorkspace.tsx:143`).

### Flags (toggles do operador)

`FadigaFlags { face, hands, phone, risk }` (`src/processors/fadiga.ts:20`) liga/desliga cada
pipeline. Desligar um pipeline zera o estado derivado (`src/processors/fadiga.ts:129-131`); `risk`
desligado força risco `OK` (`src/processors/fadiga.ts:201`).

### Entradas / saídas

- Entrada: `process({ frame: FrameSource; now; flags?; srcEl? })` (`src/processors/fadiga.ts:120`).
  `srcEl` dá identidade estável de frame quando o frame é um canvas de recorte (zona) — o `newFrame`
  evita reprocessar o mesmo frame (`src/processors/fadiga.ts:118-125`).
- Saída: `FadigaResult` (`src/processors/fadiga.ts:35-44`): `snapshot` (UI), `scene` (desenho),
  `events`, `alertRisk`, `sample` (recorder 1s/5s) e telemetria de latência por modelo
  (`faceMs`/`handMs`/`objMs`).

### Recorder

Amostra o estado de risco 1×/s e emite acumulado a cada 5 s (`src/processors/fadiga.ts:204-215`),
incluindo soma de EAR para média.

### Desenho (`src/fadiga/draw.ts`)

`drawFadigaScene` (`:32`) desenha o feed (sem espelhar — o nó envia o frame cru, então mapeia x
direto) com: moldura colorida por risco, pontos dos olhos/boca, bbox do rosto, bbox do celular com
score, e bbox/landmarks das mãos com o gesto. Usa `contentRect` para letterbox.

### Integração

- Câmera única dedicada: `FadigaView.tsx` cria o processador (`src/FadigaView.tsx:35`), chama
  `process` (`:104`) e desenha (`:108`).
- Como zona: `CameraWorkspace.tsx` recorta a ROI da zona (`cropFor`, cap ~480 px) e roda o pipeline
  nela (1 operador/zona) (`src/CameraWorkspace.tsx:261`); roteia `events` → timeline + recorder,
  `alertRisk` → toast, e snapshot/scene → painel (`src/CameraWorkspace.tsx:262-266`).
- `dispose()` fecha Face/Hand landmarkers e solta o detector (`src/processors/fadiga.ts:230-235`).

---

## 4. Modo LEITURA — códigos de barras na esteira

Arquivos: `src/processors/leitura.ts`, `src/reading/decoder.ts`, `src/reading/zxingWorker.ts`,
`src/reading/cluster.ts`.

### O que faz

Lê códigos de barras/QR numa faixa (ROI) da esteira, deduplica leituras, detecta **passagens**
físicas de caixa (por movimento) e calcula throughput e taxa de leitura.

### Modelo / algoritmo de decodificação (`src/reading/decoder.ts`)

Dois backends, com seleção automática (`DecoderKind`):

1. **BarcodeDetector nativo** (Chrome/Edge) — assíncrono, sem bloquear a main thread; preferido
   quando disponível (`src/reading/decoder.ts:23-37`). Filtra os formatos por
   `getSupportedFormats`.
2. **Fallback ZXing em Web Worker** (lazy) — `src/reading/zxingWorker.ts`. A lib pesada fica no
   chunk do worker, fora do bundle principal. Recebe pixels RGBA (transferable), computa luminância
   e decodifica com `MultiFormatReader` + `HybridBinarizer`, com `TRY_HARDER`
   (`src/reading/zxingWorker.ts:17-29`).

Formatos suportados: `EAN_13/8, CODE_128/39, ITF, QR_CODE, DATA_MATRIX, UPC_A/E`
(`src/reading/zxingWorker.ts:8-11`; espelhados em `APP_CONFIG.reading.formats`, `src/config.ts:69`).

### Detecção de passagem (motion)

Em `src/processors/leitura.ts:50-72`: faz diff de luminância na ROI (downscale a `motionProcWidth`).
Borda de subida (`ratio > passEnterRatio`, estado `clear`) = entrou caixa → conta passagem (com
debounce `passDebounceMs`); descida abaixo de `passClearRatio` = ROI livre.

### Decodificação throttled

Em `src/processors/leitura.ts:74-95`: a cada `decodeIntervalMs`, recorta a ROI (largura ≤ 1080),
chama `decodeFromCanvas` (assíncrono). Dedup: mesmo código dentro de `dedupWindowMs` = mesma caixa
em cena (não conta de novo) (`src/processors/leitura.ts:87-92`).

### Agregação por ponto (`src/reading/cluster.ts`)

Store em memória (singleton de módulo). Agrega por **PONTO DE LEITURA**: N câmeras no mesmo ponto.
Uma caixa é "lida" se **qualquer** câmera leu — dedup por `(ponto, code)` na janela
(`pushRead`, `src/reading/cluster.ts:41`). `pushPass` (`:65`) deduplica passagens físicas por
ponto+janela. `snapshot` (`:84`) gera as métricas para a UI: caixas recentes, throughput
(caixas/min), multi-reads, contribuição por câmera, taxa de leitura e fluxo ao vivo.
**LGPD**: só códigos/indicadores, nunca imagens (`src/reading/cluster.ts:4`).

### Parâmetros / thresholds (de `APP_CONFIG.reading`, `src/config.ts:64-92`)

| Parâmetro | Valor | Papel |
|---|---|---|
| `decodeIntervalMs` | 120 (~8/s) | throttle de decodificação |
| `dedupWindowMs` | 1500 | mesma caixa no ponto |
| `recentWindowMs` | 60 000 | janela p/ throughput |
| `motionProcWidth` | 160 | downscale do diff de motion |
| `motionPixelDelta` | 22 | "pixel mudou" |
| `passEnterRatio` / `passClearRatio` | 0.06 / 0.02 | entrada/saída de caixa |
| `passDebounceMs` | 600 | anti-flicker de passagem |
| `rateAlertPct` | 80 | taxa abaixo disso alerta |
| `rateAlertMinPassages` | 5 | mínimo p/ alertar |
| `captureWidth/Quality/Fps` | 1280 / 0.9 / 8 | captura de alta resolução |

### Entradas / saídas

- Entrada: `LeituraZone { x,y,w,h, ponto }` e `LeituraCtx { frame, now, cameraId, cameraLabel }`
  (`src/processors/leitura.ts:12-13`).
- Saída: `LeituraResult` (`src/processors/leitura.ts:14-24`): `reads` (deduplicados),
  `passes`, `perMin`, `passesCount`, `boxesCount`, `ratePct`, `noReads`, `kind` (backend),
  `decodeMs` (telemetria).

### Integração

`CameraWorkspace.tsx` chama `process`, depois envia cada `read` para `pushRead` e cada `pass` para
`pushPass` do cluster (`src/CameraWorkspace.tsx:246-251`), persistindo via `recordReads`/`recordPass`.
O painel exibe último código, perMin, passagens, taxa e no-reads. `dispose()` é no-op — o worker de
decode é compartilhado (`src/processors/leitura.ts:116`).

---

## 5. Modo OBJETOS — contagem / identificação + presença por setor

Arquivos: `src/processors/objetos.ts`, `src/objects/detector.ts`, `src/objects/owlvitWorker.ts`,
`src/objects/catalog.ts`.

### O que faz

Detecta, conta e identifica objetos por setor; monta matriz Setor×Classe, aplica heurística de
"pessoa carregando caixa" e gera transições de presença (entrada/saída) com histerese.

### Modelo / algoritmo (`src/objects/detector.ts`)

Backend primário **zero-shot OWL-ViT** em Web Worker (`src/objects/owlvitWorker.ts`), via
`transformers.js` (`@xenova/transformers`). Detecta objetos por **texto** (candidate labels), sem
treino — então a lista de objetos é só configuração. Modelo `Xenova/owlvit-base-patch32`
(`src/config.ts:96`), baixado do HuggingFace na 1ª vez e cacheado pelo navegador
(`src/objects/owlvitWorker.ts:8`).

Enquanto o OWL-ViT carrega, usa **coco-ssd como andaime** (`src/objects/detector.ts:90-101`) — só a
classe `person` das nossas categorias existe no coco — para o painel não ficar vazio. Estados do
backend (`ObjBackend`): `carregando | coco | owlvit | indisponível` (`src/objects/detector.ts:12`).

O worker recebe pixels RGBA (transferable) + labels, roda
`pipeline("zero-shot-object-detection")` com `threshold` e `topk: 50` e devolve
`[{label, score, box}]` (`src/objects/owlvitWorker.ts:29-41`).

### Catálogo (`src/objects/catalog.ts`)

`OBJECT_CATALOG` (`:8`) define 5 classes: **pessoa, caixa, empilhadeira, palete, paleteira**. Cada
uma tem `coco` (classes coco-ssd equivalentes — só "person" hoje), `prompts` (textos PT/EN p/
OWL-ViT — bilíngue aumenta o recall) e `color`/`emoji`. `keyForCoco` mapeia coco→chave (andaime);
`objClass` busca metadados por chave.

### Lógica do processador (`src/processors/objetos.ts`)

- **Detecção throttled assíncrona** a cada `detectIntervalMs` (`src/processors/objetos.ts:63-70`).
- **Contagem + matriz Setor×Classe** sobre a última detecção (`:72-80`); `zoneOf` atribui cada
  detecção a um setor pelo centro da caixa (`:52-55`).
- **Heurística de carregamento**: pessoa + caixa com `overlap > 0.02` → conta carregando; emite
  evento `carregamento` (cooldown 4 s) (`src/processors/objetos.ts:82-89`). `overlap` é a fração da
  área da menor caixa coberta (`:32-37`).
- **Recorder + presença** (1 amostra/s): acumula `samples/countSum/peak/present` por
  setor×classe; presença confirmada com histerese `PRESENCE_CONFIRM_MS` (1800 ms,
  `src/processors/objetos.ts:12`); pessoa é ignorada para presença (ruidosa,
  `src/processors/objetos.ts:102`). Transições geram eventos `entrada`/`saida` + toasts
  (`:103-112`).
- **Emissão de amostras** a cada 5 s (`src/processors/objetos.ts:116-123`).

### Parâmetros / thresholds (de `APP_CONFIG.objects`, `src/config.ts:94-100`)

| Parâmetro | Valor | Papel |
|---|---|---|
| `model` | Xenova/owlvit-base-patch32 | modelo zero-shot |
| `procWidth` | 640 | largura de rasterização |
| `threshold` | 0.1 | confiança mínima OWL-ViT (scores baixos) |
| `detectIntervalMs` | 700 | cadência de detecção |
| `objectScoreThreshold` (detection) | 0.5 | `minScore` do andaime coco | 
| `PRESENCE_CONFIRM_MS` | 1800 | histerese de presença (no processador) |

### Entradas / saídas

- Entrada: `process(setores, classes, ctx)` — `ObjetosSetor[]` (geometria + `contains?`),
  lista de classes selecionadas, `ObjetosCtx { frame, now }` (`src/processors/objetos.ts:14-15`).
- Saída: `ObjetosResult` (`src/processors/objetos.ts:16-26`): `dets`, `counts`, `matrix`,
  `carregando`, `backend`, `detectMs`, `samples` (5 s), `events`, `alerts`.

### Integração

`CameraWorkspace.tsx` chama `process` por zona, roteando `events` → `recordObjectEvent`, `alerts` →
toast, `samples` → `recordObjectSamples`, e contagens → painel
(`src/CameraWorkspace.tsx:253-258`). `dispose()` é no-op — o worker OWL-ViT é compartilhado
(`src/processors/objetos.ts:129`).

---

## 6. Resumo comparativo

| Aspecto | Atividade | Fadiga | Leitura | Objetos |
|---|---|---|---|---|
| Sinal base | motion (luma) + coco-ssd | MediaPipe Face/Hand + coco-ssd | decode (nativo/ZXing) + motion | OWL-ViT (coco andaime) |
| Onde roda o pesado | worker (coco, nível de frame) | wasm/worker (MediaPipe), Promise (coco) | worker (ZXing) ou nativo async | worker (OWL-ViT) |
| Estado/histerese | máquina de 5 estados, anti-flicker | motor de risco, grace/hold | passagem clear/occupied, dedup | presença confirmada, dedup por ponto |
| Calibração | sensibilidade + idleAlertMs por zona | 4 thresholds persistidos (localStorage) | thresholds fixos em config | classes selecionáveis + thresholds em config |
| Recorder | idle/active frames (emite ~3 s) | risco 1 s / emite 5 s | throughput janela 60 s | amostras 1 s / emite 5 s |
| `dispose()` | no-op | fecha modelos MediaPipe | no-op (worker compartilhado) | no-op (worker compartilhado) |
| View | `CameraWorkspace` | `FadigaView` + `CameraWorkspace` | `CameraWorkspace` + cluster | `CameraWorkspace` |

### Observações / a confirmar

- O OWL-ViT e o coco-ssd usam `loadDetector` com `base: "lite_mobilenet_v2"`
  (`src/vision/model.ts:8`), enquanto `APP_CONFIG.detection.base` indica `mobilenet_v2`
  (`src/config.ts:13`). **A confirmar** se há uma segunda via de carregamento que respeita
  `APP_CONFIG.detection.base`, ou se essa config não é aplicada no `loadDetector` atual.
- O tiling (`APP_CONFIG.detection.tiles`, `detectTileWidth`, `nmsIoU`) é referenciado no loop da
  view via `detectFrame` (`src/CameraWorkspace.tsx:222`); a implementação do tiling/NMS está fora
  dos arquivos deste documento (**a confirmar** em `detectFrame`/`vision`).
