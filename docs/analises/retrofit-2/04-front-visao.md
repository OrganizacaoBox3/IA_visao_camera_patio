# Retrofit-2 · Frente 04 — Front de visão (pipeline cliente: captura→detecção→processadores→desenho)

> Escopo lido na íntegra: `src/CameraWorkspace.tsx` (2194L no momento da leitura — **frente paralela editando**),
> `src/camera/**`, `src/vision/**`, `src/processors/**`, `src/objects/**`, `src/fadiga/**`, `src/zones.ts`,
> `src/cameraConfig.ts`. Leitura read-only; nenhuma linha de código alterada.
> Convenção: `arquivo:linha` referencia o estado lido em 2026-07-05 — **re-diffar antes de executar qualquer
> plano** (a frente paralela move linhas).

---

## 1. COMENTÁRIOS — inventário do ruído

Medição (linhas de comentário *full-line*, sem contar trailing `// ...` que o CameraWorkspace usa muito):

| Arquivo | Linhas | % comentário | Marcadores de plano/fase¹ | Veredito |
|---|---|---|---|---|
| `src/CameraWorkspace.tsx` | 2194 | ~20% (437L full-line + dezenas trailing) | **89 linhas** | pior caso — ver abaixo |
| `src/vision/counting.ts` | 496 | 33% | 6 | maioria BOM (contrato de coordenadas/direção); bloco "COMO A CW-3 INTEGRA" é processo morto |
| `src/vision/nms.ts` | 111 | 32% | 0 | BOM — trade-off declarado do containment 0.7, manter |
| `src/vision/bytetrack.ts` | 245 | 31% | 3 | BOM — algoritmo + limitação declarada (sem re-ID), manter; tirar "Onda 2 do plano-…" |
| `src/vision/scheduler.ts` | 153 | 30% | 3 | contrato bom, mas o header fala com "Frente A2" (audiência de processo, não invariante) |
| `src/cameraConfig.ts` | 150 | 28% | — | contrato ok; narrativa de produto no default `capture` (L36–41) condensável |
| `src/camera/cineBuffer.ts` | 141 | 27% | 1 | o banner LGPD é **invariante load-bearing** — manter na íntegra |
| `src/camera/interpolate.ts` | 265 | 25% | 1 | BOM (offset de timestamp, dead-reckoning) — manter |
| `src/camera/useWebrtcTransport.ts` | 147 | 24% | 2 | ok; header "Extraído… SEM mudança de comportamento" é changelog |
| `src/vision/detect.ts` | 486 | 22% | 9 | porquês bons enterrados sob numeração de plano (3.1/2.3/2.4a/2.4b/P5) |

¹ linhas com `(P0..P2)`, `Onda X`, `Fase Y`, `plano-*.md`, `(R2.1)`, `(1.10)`, `(3.4)`, `BUGFIX`, `Frente A/B/C`, `item N`.

### 1.1 O caso CameraWorkspace.tsx (pior arquivo, de longe)

O padrão dominante é **comentário-changelog**: narra o plano de performance por número de item e conta a
história do que o código *era* antes. `\bantes\b` aparece 14× só neste arquivo. Exemplos concretos:

- `CameraWorkspace.tsx:117-151` — **35 linhas** para 4 constantes de cadência. Cada bloco re-narra a fase do
  plano (`P0 + P2 (docs/analises/plano-performance-imagem.md)`, `Fase 0.3 (plano-retrofit-performance)`,
  `(P0 fluidez browser/webcam)`), inclusive a frase **stale** "Constantes locais (NÃO editar config.ts —
  outra frente)" (L125) — restrição de coordenação de uma onda já encerrada, hoje só desinforma.
  O que merece ficar: 1 linha por constante com o porquê ("análise de estado confirma em 900ms ≫ intervalo;
  dt pulado é acumulado — tempo real intacto").
- `CameraWorkspace.tsx:626-637` — histórico da mudança do `ensureDetectClient` ("que vivia aqui… foi movido
  p/ o rAF"). Narrativa de migração; o invariante real é 1 linha ("worker só nasce se o caminho local for
  agendado — câmera hub não paga tfjs").
- `CameraWorkspace.tsx:962-984` — bloco `BUGFIX` + trade-offs F2/F3 re-explicados (23 linhas). O trade-off
  do modo hub já está declarado na ADR-009 e no `useHubAnalysis.ts`; aqui bastaria a referência.
- `CameraWorkspace.tsx:1020-1032` — re-explica o scheduler ("1 TILE = 1 TAREFA…", deadlock com
  maxConcurrent=1) que **já está documentado em `detect.ts:316-322` e `scheduler.ts`** — 3ª cópia do mesmo
  aviso.
- `CameraWorkspace.tsx:1444-1461` — 15 linhas sobre a suavização display-only que repetem o header de
  `interpolate.ts:1-11` e de `useHubAnalysis.ts:106-112` (3 cópias do mesmo racional).
- Trailing comments por ref (L344-412): úteis em parte, mas vários repetem o nome da variável
  (`lastMotionAtRef // último readback de luma/motion` etc.).

**Estimativa honesta de remoção (mantendo porquê/invariante/ADR/LGPD):**

| Arquivo | % do comentário removível/condensável |
|---|---|
| `CameraWorkspace.tsx` | ~55–60% (≈250–280 linhas) — numeração de plano, "antes era", cópias 2ª/3ª de racional |
| `detect.ts` | ~35% — manter porquês (upscale 2×, containment, coalescência), tirar numeração e repetições |
| `counting.ts` | ~20% — remover L40-52 ("COMO A CW-3 INTEGRA", onda concluída); contrato de coordenadas fica |
| `scheduler.ts` | ~25% — reescrever header como contrato (sem "Frente A2 pode…") |
| `useTripwires.ts` | ~30% — header-changelog (L1-13) + racional ADR-006 repetido 2× (L170-187 e L188-199) |
| `useHubAnalysis.ts` | ~25% — header F1/F2/F3 e bloco L106-112 que descreve código REMOVIDO ("o antigo easeHubTracks…") |
| `useCineLoop.ts` / `useWebrtcTransport.ts` / `draw.ts` | ~15% — headers "Extraído do CameraWorkspace (R2.1/Onda C) SEM mudança de comportamento" (changelog puro, 1ª linha de cada) |
| `cameraConfig.ts` | ~25% — narrativa de decisão de produto condensável a 1 linha + link |
| `processors/atividade.ts` | ~20% — L72-94 (filterExcludedPersons) conta a história do bug em 8 linhas; invariante = 2 |
| `zones.ts` | ~15% — L98-101 história das zonas-semente removidas (decisão de produto, mover p/ changelog) |

Comentários **exemplares para preservar como padrão da casa**: banner LGPD de `cineBuffer.ts:3-14` e
`clipExport.ts:3-10`; convenção de direção de `counting.ts:17-38`; trade-offs declarados de `nms.ts:12-17`
e `bytetrack.ts:63-74`; a nota de contrato e2e em `CameraWorkspace.tsx:1802-1805` (`.tile[title=…]`).

---

## 2. RESPONSABILIDADE — violações de "1 domínio por arquivo"

### 2.1 CameraWorkspace.tsx segue componente-deus (2194L)

As extrações R2/Onda C funcionaram (hooks, tabs, draw, rafSteps) — mas o que restou acumula **6 papéis**:

1. **Orquestrador do rAF** (`:843-1399`, ~556 linhas em UM effect): gate de frame novo, corrente rVFC,
   captura cine, paridade de grade, readback de luma, agendamento de detecção, espelho do hub, filtro de
   exclusão, tracker, counter, occupancy, dispatch por zona, swap de buffers, tick de UI. Cinco estágios de
   pipeline inline num único closure.
2. **Compositor de cena** (`drawScene`, `:1401-1528`) — já delega às folhas de `camera/draw.ts`, ok, mas o
   ramo hub-interpolação (L1452-1461) é lógica de apresentação que caberia em `interpolate.ts`.
3. **Editor de geometria** (paint/draw/mask/tripwire handlers, `:1554-1735`) — mistura mouse→norm,
   cache de máscara, commit/persist.
4. **Casca de UI** (JSX tile+full, `:1799-2194`) + legenda/summary/preset-dirty derivados no corpo.
5. **Cola de persistência** (`persist`/`patchZone` `:1680-1689`) e **política de preset** (`dominantMode`,
   `applyPreset`).
6. **Lógica de domínio pura embutida**: `zoneAtAtiv` (`:760-784`, atribuição de zona com desempate por
   overlap — geometria pura), `updateTracks` (`:792-832`, adapter Detection→ByteTracker), `panelSig`/`twSig`
   (`:219-243`), `cropFor` (`:731-748`). Nenhuma dessas fecha sobre o rAF; todas extraíveis sem tocar a
   semântica do loop.

### 2.2 Política de ingest (ADR-009) espalhada em 6 pontos

A decisão "o que grava quando engine=hub" está repetida como condicional + comentário em:
`:1141` (recordFlow), `:1228-1241` (recordAlert — mantido), `:1248-1253` (recordReads/Pass — mantido),
`:1275-1279` (objetos — mantido), `:1285-1291` (fadiga — mantido), `:1313-1318` (recordSamples — suprimido).
Uma tabela de política única (`ingestPolicy(engine, kind)`) eliminaria 5 cópias do racional e daria dono ao
invariante.

### 2.3 Tipos de contrato morando no componente

`HubTrack`/`HubZone`/`HubAnalysis`/`Track` são exportados **do arquivo do componente**
(`CameraWorkspace.tsx:160-279`) e importados por `camera/useHubAnalysis.ts:10` e pela central
(DashboardPage). Hook importando tipo do componente que o consome é inversão de dependência de contrato —
o shape do evento socket `analysis-tracks` (contrato aditivo!) merece módulo neutro.

### 2.4 Duplicações entre camadas (candidatas reais, regra dos 3 satisfeita)

| O quê | Ocorrências |
|---|---|
| **IoU/containment de bbox** | `vision/nms.ts:23-60` (iouXYWH+containment), `vision/bytetrack.ts:92-102` (iouOf), `fadiga/landmarks.ts:106-111` (rectIou), `processors/objetos.ts:57-63` (overlap≈containment) — 4 implementações |
| **RGBA→luma + ping-pong de buffers** | `CameraWorkspace.tsx:1000-1019` (frame-level), `processors/atividade.ts:220-249` (fallback LR), `processors/leitura.ts:58-97` (motion da ROI) — 3 implementações do mesmo kernel 0.299/0.587/0.114 + swap |
| **Ponto-em-zona / atribuição de zona** | `zones.ts:225-233` (pointInZone), `CameraWorkspace.tsx:760-784` (zoneAtAtiv, desempate por overlap), `processors/objetos.ts:93-104` (zoneOf, first-match!), `processors/atividade.ts:277-293` (loop occupied) — 4 variantes com **critérios de desempate divergentes** (objetos ainda usa first-match, o bug que o zoneAtAtiv corrigiu para atividade) |
| **Letterbox/content-rect** | `camera/draw.ts:53-59` (getContentRect) e `fadiga/draw.ts:20-26` (contentRect, cópia local) |
| **União de modos** | `zones.ts:17` (`ZoneMode` c/ exclusao), `processors/types.ts:4` (`ZoneMode` sem exclusao), `cameraConfig.ts:12` (`CameraMode`) — 3 uniões quase idênticas em 3 camadas, com mesmo nome exportado 2× |
| **Boilerplate de worker-client** | `vision/detect.ts:22-89` e `objects/detector.ts:23-63` — dois protocolos (`pending` map, reqId, ready/error/result) copiados; além disso `objects/detector.ts:105-115` ainda rasteriza na MAIN thread (getImageData por chamada) enquanto `detect.ts` já tem o caminho bitmap sem readback — assimetria de maturidade entre os dois clientes |

### 2.5 Mistura de domínio na pasta `src/camera/`

`camera/whip.ts` (publisher WHIP do nó de webcam) e `camera/acquire.ts` (getUserMedia) são consumidos **só**
por `routes/CameraPage.tsx` (o NÓ de câmera). A pasta mistura dois domínios: *viewer/workspace* (draw, hooks,
cine, tabs) e *nó publicador*. Custo hoje: baixo; custo de navegação/propriedade em frentes paralelas: real.

Menores: `fadiga/draw.ts:5` importa `cssVar` de `camera/draw` (cross-domain admitido no próprio comentário);
`vision/counting.test-notes.md` é documento de notas dentro de `src/` (mover p/ `docs/analises/`).

### 2.6 O que está BEM separado (não tocar por "melhoria")

`vision/bytetrack.ts`, `vision/counting.ts`, `vision/nms.ts`, `camera/interpolate.ts`, `vision/scheduler.ts`
são libs puras, sem React/DOM, testadas (203+416+93+218+145 linhas de teste ao lado). Os processadores
(`processors/*.ts`) têm contrato claro (ctx in → result out, efeitos devolvidos como dados — a view faz IO).
As tabs (`camera/tabs/*`) são componentes puros por props. **Este é o padrão-alvo do retrofit; o débito é o
miolo do CameraWorkspace, não as folhas.**

---

## 3. ABSTRAÇÃO — fronteiras que faltam (só as que pagam)

Padrão comprovado no próprio repo: `camera/rafSteps.ts` (decisões puras extraídas do rAF, testadas em
`rafSteps.test.ts`) — replicar, não inventar.

1. **`src/vision/geometry.ts` — consolidar IoU/containment** (regra dos 3: 4 implementações).
   Contrato: `iouXYWH(a,b): number`, `containment(a,b): number` sobre `[x,y,w,h]` na MESMA unidade.
   `bytetrack`, `nms`, `objetos.overlap` e `fadiga.rectIou` passam a consumir. Zero mudança de semântica
   (funções idênticas); ganho: um único lugar para otimizar/testar a primitiva mais quente da associação.

2. **`src/vision/luma.ts` — kernel de motion** (regra dos 3: 3 implementações).
   Contrato: `LumaPair` (canvas offscreen + ping-pong de `Float32Array`, `willReadFrequently`) com
   `sample(el, w, h): {luma, prev, pw, ph}` e invalidação por mudança de tamanho. CameraWorkspace, fallback
   LR do AtividadeProcessor e LeituraProcessor consomem. É também o pré-requisito para mover o readback para
   `OffscreenCanvas`/worker no futuro **num ponto só** (hoje seria em 3).

3. **`src/camera/hubTypes.ts` (ou `vision/tracks.ts`) — contrato do espelho do hub**.
   Mover `HubTrack/HubZone/HubAnalysis/Track` para módulo neutro; `CameraWorkspace`, `useHubAnalysis`,
   `DashboardPage` importam de lá. Mata a importação hook→componente e dá endereço ao contrato do evento
   socket `analysis-tracks` (que é invariante do CLAUDE.md §3).

4. **`src/camera/ingestPolicy.ts` — tabela única da ADR-009**.
   Contrato: `shouldIngest(kind: "flow"|"ativ"|"alert"|"reads"|"pass"|"object"|"fadiga", engine): boolean`
   com o racional escrito UMA vez. Os 6 call-sites do rAF viram `if (shouldIngest(...))`. Não é abstração
   especulativa: a tabela já existe, só que espalhada.

5. **`src/camera/zoneGeometry.ts` — atribuição de zona unificada**.
   Contrato: `assignZone(zones, point, bbox?): label|null` com o desempate por overlap→menor-área
   (semântica atual do `zoneAtAtiv`). `ObjetosProcessor.zoneOf` migra para ela — **isso é correção de
   consistência de precisão**, não estética (objetos ainda sofre do bug de zona-primeira-da-lista descrito
   em `CameraWorkspace.tsx:754-759`). `pointInZone` (zones.ts) continua a primitiva.

6. **Estágios nomeados do rAF (extração conservadora, ADR-007 intacta)**.
   O loop, a ordem e as mutações de ref ficam no componente; extraem-se APENAS closures nomeados no mesmo
   arquivo ou funções com params explícitos (padrão rafSteps): `motionStage`, `detectStage` (já quase é —
   L1033-1059), `trackingStage` (updateTracks+counter+occupancy), `zoneStage` (o `for` de L1161-1304).
   Ganho: o rAF de ~556 linhas vira ~80 de orquestração legível, cada estágio testável/medível.

**Não propor** (YAGNI declarado): unificar os dois worker-clients (coco vs OWL-ViT — protocolos e ciclos de
vida genuinamente diferentes; só se objetos virar KPI, e aí a 1ª medida é dar o caminho bitmap ao OWL-ViT);
plugin-system de processadores (a união discriminada `Holder` resolve tipado e barato); mover `whip/acquire`
só quando alguém tocar o CameraPage (renomeio de pasta puro não paga conflito com frente paralela).

---

## 4. MAPA DE ATAQUE — PERF e PRECISÃO de pessoa neste domínio

### 4.1 Onde mora o hot-path (main thread do cliente)

| # | Custo | Onde | Dono / medição |
|---|---|---|---|
| 1 | **Readback de luma** `drawImage+getImageData O(pw·ph)` + loop RGBA→luma por frame analisado | `CameraWorkspace.tsx:1010-1017` (+cópias §2.4) | medível via `FrameMeter.avgProcMs` → HUD (`draw.ts:384`); pisos já existem (hub 500ms / local 100ms / grade paridade) |
| 2 | **Processadores main-thread por zona**: fadiga (`detectForVideo` MediaPipe síncrono), leitura (decode ROI), objetos (rasterize p/ OWL-ViT) | `processors/fadiga.ts:301,332`; `leitura.ts:100-140`; `objects/detector.ts:105-115` | fadiga JÁ devolve `faceMs/handMs/objMs` (`fadiga.ts:101-103`) e objetos `detectMs` — **o CameraWorkspace descarta esses campos** (r.faceMs nunca lido). Telemetria pronta e desligada: ligar antes de otimizar |
| 3 | **drawScene todo frame** (heatmap 32×18, tracks, zonas, máscaras, tripwires) | `CameraWorkspace.tsx:1401-1528` + `camera/draw.ts` | dentro do mesmo avgProcMs; sem medição isolada |
| 4 | **detectFrame → worker** (fora da main; custo de main = grabTile/rasterize) | `vision/detect.ts:329-486` | `schedulerStats()` existe (`scheduler.ts:148`) e **nada o consome** — profundidade de fila invisível |
| 5 | Modo hub: cliente vira espelho — hot-path de PESSOA migra p/ o servidor; sobra 1+3 | `useHubAnalysis.applyHubAnalysis` | HUD `overlayAgeMs` já expõe staleness |

### 4.2 Knobs de PRECISÃO de pessoa — dono claro × órfão

**Com dono (config.ts, correto):** `people.scoreThreshold` 0.4, `longRange.peopleScoreThreshold` 0.3,
`people.track.{iouThreshold, ttlMs, counterMaxDist, minCrossingFrames, debounceMs}`, `detection.{minScore,
maxBoxes, nmsIoU, tiles, detectTileWidth}`, `detection.longRange.*`, `fadiga.*` (+ calibração persistida em
`fadiga/calibration.ts`).

**Órfãos (hardcoded fora do config — espalham a calibração):**

| Knob | Valor | Onde | Afeta |
|---|---|---|---|
| `birthIouThreshold` (guarda de nascimento — bug "2 pessoas onde há 1") | 0.55 | `vision/bytetrack.ts:119` (default de opts; nenhum caller passa) | precisão de contagem/presença |
| `CONTAINMENT_THR` (dedupe do tiling) | 0.7 | `vision/detect.ts:172` | recall×duplicata de pessoa |
| `GRID_TILES_PER_CALL` / `GRID_CACHE_TTL_SWEEPS` (rotação LR) | 4 / 2 | `vision/detect.ts:185-186` | latência de bbox na grade LR |
| `minMove` / `ttl` do counter | 0.01 / 1500 | `CameraWorkspace.tsx:1104-1110` (metade dos params do MESMO counter vem do config, metade inline) | contagem por linha |
| `TRACK_COVER_IOU/CONTAIN` (1 pessoa = 1 caixa, display) | 0.45/0.7 | `camera/draw.ts:473-474` | só visual, mas duplica valores do nms |
| Cadências: `TILE_OBJECT/HEAVY_INTERVAL_MS`, `HUB_MOTION_INTERVAL_MS`, `LOCAL_MOTION_MIN_INTERVAL_MS`, `WEBRTC_TICK_MS`, `WEBRTC_VFC_STALE_MS` | — | `CameraWorkspace.tsx:126-193` (a nota "NÃO editar config.ts — outra frente" está stale) | latência×CPU de tudo |
| Cadências de fadiga/objetos: `PHONE_DETECT_*`, `SLOW_*_INTERVAL_MS`, `COCO_SCAFFOLD_MIN_INTERVAL_MS` | — | `processors/fadiga.ts:33-48`, `processors/objetos.ts:22` | latência de alerta |
| Heatmap `HEAT_COLS/ROWS`, decay 0.97, addAmount 0.6 | — | `CameraWorkspace.tsx:114-115,1111-1119` | só visual |

**Ataque recomendado:** consolidar os órfãos de PRECISÃO (linhas 1–4 da tabela) em
`config.people.track`/`config.detection` — é onde um ajuste de campo hoje exige caçar 4 arquivos.
Cadências podem permanecer locais (são política de UI, não calibração), mas sem a nota stale.

### 4.3 O que é mensurável hoje (e o que falta ligar)

- **Ligado:** HUD de telemetria (fps, ms/frame, pipe, overlayAge — `draw.ts:365-419`); `FrameMeter`;
  testes de comportamento das libs puras (`bytetrack.test.ts` cruzamento denso; `counting.test.ts`
  histerese/teleporte; `interpolate.test.ts`; `nms.test.ts`; `rafSteps.test.ts`).
- **Pronto mas desligado:** `faceMs/handMs/objMs/decodeMs/detectMs` dos processadores (descartados no
  dispatch do rAF); `schedulerStats()` (nunca chamado). Ligar ambos ao HUD custa ~10 linhas e dá a régua
  por estágio que o retrofit precisa **antes** de mexer em qualquer cadência.
- **Inexistente:** harness de precisão de pessoa no cliente (dataset rotulado → precision/recall do caminho
  local). Como o motor D-FINE do hub é a autoridade de precisão (ADR-009) e o cliente é espelho no modo hub,
  investimento de precisão CLIENTE só se justifica no fallback `engine="local"` + zonas de exclusão +
  histerese de tripwire — priorizar o harness no servidor, não aqui.

---

## 5. RISCOS de reescrita — o que NÃO tocar

1. **rAF é dono do loop (ADR-007).** A ORDEM dos estágios do tick é semântica: gate de frame novo →
   captureFrame(cine) → pause → paridade/pisos de motion → luma → agendar detecção → `applyHubAnalysis` →
   `filterExcludedPersons` → tracker (só em `freshDets`) → counter/occupancy → laço por zona → swap de luma →
   drawScene → tick de UI. Extrair estágios ≠ reordenar; as mutações de `tracksRef/detsRef` são compartilhadas
   entre o caminho hub e o local e são sensíveis a ordem. O `eslint-disable exhaustive-deps` em `:1398` é
   intencional (loop 1× por câmera). Casca fullscreen NÃO vira Radix Dialog (focus-trap manual `:639-688`).
2. **Contrato socket `analysis-tracks`** (`HubTrack` com `score?/vx?/vy?` opcionais-retrocompatíveis) —
   qualquer mudança é aditiva; a central (DashboardPage) e a grade consomem o mesmo shape.
3. **LGPD:** `cineBuffer`/`clipExport`/`downloadSnapshot` — buffer em memória, download local manual, nada
   ao servidor. Os banners são invariantes, não ruído. Frames efêmeros também no relé (`getFrame`).
4. **Atributos do canvas travam no 1º `getContext`** — `drawScene` (`:1409-1424`) e `drawReviewFrame`
   (`draw.ts:191-196`) pedem os MESMOS atributos de propósito; o `key` por transporte no JSX (`:1961-1965`)
   remonta o canvas na troca mjpeg↔webrtc. Qualquer refactor de desenho preserva isso.
5. **Contratos de e2e:** `.tile[title='Abrir câmera']` (`:1802-1805`), labels do select de modo no
   `ConfigZonaDialog` (`:16-24`).
6. **Unidades de bbox:** `Detection.bbox` em PIXELS (contrato coco), tracker/counting/zonas em NORMALIZADO
   0..1 — as conversões vivem em `updateTracks`, `applyHubAnalysis` e `filterExcludedPersons`; centralizar
   geometria não pode misturar as unidades (fonte clássica de regressão silenciosa).
7. **Frente paralela AGORA em `CameraWorkspace.tsx`, `src/vision/*`, `src/fadiga/models.ts`,
   `src/processors/fadiga.ts`** — todo `file:line` deste doc precisa de re-diff antes de virar tarefa;
   particionar qualquer execução por propriedade exclusiva de arquivo.
8. **Retrocompat declarada em todo o espelho do hub** (props opcionais `tripwiresRev/analysisEngine/
   getHubAnalysis/transport` — `:290-317`): remover defaults quebra hub antigo/central antiga.

---

### Nota de separação-de-responsabilidade do domínio hoje: **6.5/10**

Folhas exemplares (libs puras testadas, processadores com contrato, hooks e tabs extraídos) puxam para cima;
o miolo do `CameraWorkspace` (rAF de ~556 linhas com 6 papéis), a política ADR-009 espalhada em 6 pontos,
4 implementações de IoU/ponto-em-zona com semânticas divergentes e a calibração de precisão parcialmente
órfã de config puxam para baixo.
