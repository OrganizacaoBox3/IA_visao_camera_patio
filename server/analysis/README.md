# server/analysis — Motor de análise no hub (ADR-009)

Detecção de pessoas + tracking + contagem por linha + ocupação por zona rodando **no hub**,
24/7, independente de espectador. O navegador segue exibindo vídeo/overlays; os INDICADORES
passam a nascer aqui. Plano: `analises/plano-analise-server-side.md` · medições:
`analises/spike-dfine-hub.md`.

## Arquitetura

```
relé de frames (index.js webcam · rtsp.js ffmpeg)
      │  onFrame(cameraId, jpegBuf, ts)  — último-vence por câmera
      ▼
engine.js (ORQUESTRADOR, in-process no hub)
  · amostra @ANALYSIS_FPS (default 1) e envia ao worker (1 pedido em voo/câmera)
  · câmera com CameraCfg.longRange (camcfg) → pedido leva tiles 2×2 (§Longo alcance)
  · pipeline.js (por rodada): dets "person" cujo PÉ cai em zona modo "exclusao" →
    DESCARTADAS (§Zona de exclusão) → automask.js → bytetrack.js (por câmera) →
    counting.js (tripwires do camcfg) → zonas modo "atividade" (people/occupied,
    janela ~3s) → pgstore.ingest DIRETO ("flow"/"cross" e "ativ"/"samples")
  · emite `analysis-status {cameraId, engine:"hub"}` (anti-duplicação hub⇄cliente)
  · emite `analysis-tracks {cameraId, ts, tracks, zones}` volatile → dashboards
  · telemetry.js monta o GET /api/analysis/status
      │  IPC fork(serialization:"advanced") — {id, cameraId, jpeg:Buffer}
      ▼
worker.js (child_process — processo SEPARADO: ORT serializa inferência por processo
           e um crash nativo não derruba o relé; respawn com backoff no worker-host)
  · sharp decode → squash 640×640 → tensor fp32 (pré/pós do spike validado)
  · com `tiles` (longRange): decode 1× → extract por tile → squash 640/tile →
    N inferências sequenciais → reprojeção tile→frame → NMS + contenção ≥0.7
  · D-FINE ONNX (tier N/S/M — autoscale) · onnxruntime-node CPU EP · 2 threads
  · sigmoid + argmax + score≥0.25 + NMS leve por classe → dets normalizadas
```

**Knobs de QUALIDADE (score/NMS/input/tiles/tracker/counter/gate) têm dono único:
`precision.js`** — cada um com o porquê e o SENSOR que mede o efeito. Mexer em
precisão = editar lá e medir (`npm run eval`; default exige full-set).

`bytetrack.js`, `counting.js` e `zones.js` são ports 1:1 dos módulos TS do front —
mesmas APIs, mesmos testes de paridade (mudanças de comportamento nascem LÁ).

## Modelo — N / S / M (env `ANALYSIS_MODEL`, default **S**)

O **default de produção é o D-FINE-S obj2coco** (`ANALYSIS_MODEL=s`): no harness de acurácia
(`eval/MODELS.md`) o recall de pessoa **média/pequena ~dobra** vs o N — exatamente o gargalo que
travava a contagem de linha (`analises/acuracia-modelos.md §3`) — a **~2.4× o CPU**. Os três são a
**mesma arquitetura D-FINE** (input `pixel_values` 640, saídas `logits[1,300,80]`+`pred_boxes[1,300,4]`,
COCO 80) → **drop-in absoluto**: só troca o `.onnx`. Todos `onnx-community/*-ONNX`, **Apache-2.0**, fp32,
`onnx/model.onnx`, baixados no boot com verificação de tamanho + sha256 (escrita atômica).

| `ANALYSIS_MODEL` | arquivo (`server/models/`, **gitignored**) | bytes | cam/core @1fps¹ | quando usar |
|---|---|---|---|---|
| `n` | `dfine_n_coco.onnx` | 15.258.358 | ~2.2 (≈17/8C) | **CPU-bound** — muitas câmeras num hub fraco; aceita recall menor |
| `s` **(default)** | `dfine_s_obj2coco.onnx` | 41.535.197 | ~0.93 (≈7/8C) | **produção** — o gargalo (média/pequena) consertado |
| `m` | `dfine_m_obj2coco.onnx` | 78.624.257 | ~0.53 (≈4/8C) | teto de robustez, hub sobrando CPU (+3–7pp sobre S por ~2× o custo) |

¹ medido no full-set squash 640, CPU EP 2 threads (`eval/MODELS.md`) — **piso** (medido sob carga).
**CPU-bound?** `ANALYSIS_MODEL=n` volta ao nano (mais câmeras/core, menos recall).

- **Fallback:** se o download do S/M falhar no boot (e `ANALYSIS_MODEL_PATH` não estiver fixado), o
  motor **cai para o N** com aviso e o hub segue analisando; se o N também falhar, o motor desliga
  (hub segue normal). Fixe `ANALYSIS_MODEL=n` para evitar o caminho de fallback.
- **Sem rede no deploy?** Copie o `.onnx` do modelo escolhido para `server/models/` — o boot valida o
  sha e segue. `ANALYSIS_MODEL_PATH=<.onnx>` fixa um arquivo explícito (sem catálogo/fallback; sha do
  catálogo não é forçado) — é o que o `eval/` usa para comparar modelos.

## Liga/desliga (contrato)

| `ANALYSIS_ENABLED` | Comportamento |
|---|---|
| `0` | motor DESLIGADO |
| `1` | LIGADO; baixa o modelo no boot se ausente; download falhou → desliga com aviso (hub segue) |
| _ausente_ (default) | LIGADO **se o modelo já existe**; sem modelo → desligado (log explica) |

Ou seja: rode o 1º boot com `ANALYSIS_ENABLED=1` (baixa o modelo); dali em diante o default liga.

## Env (defaults entre parênteses)

`ANALYSIS_MODEL` (**s** — `n|s|m`; ver §Modelo) · `ANALYSIS_FPS` (1) · `ANALYSIS_HIGH_SCORE`
(0.35 — nascimento/1ª passada do ByteTrack; o worker devolve ≥`ANALYSIS_SCORE_MIN`=0.25, que
sustenta tracks na 2ª passada) · `ANALYSIS_AGG_MS` (3000 — janela do ingest "ativ") ·
`ANALYSIS_INTRA_THREADS` (2) · `ANALYSIS_NMS_IOU` (0.6) · `ANALYSIS_MODEL_PATH` (fixa um `.onnx`
explícito; ignora `ANALYSIS_MODEL` e o fallback).

## Zona de exclusão (supressão de FP estático — Medida A)

Zona com **`modo: "exclusao"`** no camcfg: a detecção de pessoa cujo **PÉ (bottom-center do bbox:
`x+w/2`, `y+h`)** cai dentro dela (**mask-aware** se a zona tem máscara pintada) é **DESCARTADA no
engine ANTES de ByteTrack/counter/zonas/ingest/emit** — não conta, não rastreia, não vira overlay.

**Por quê:** o soak (`analises/acuracia-modelos.md §2`) mediu que **47–86% dos FP** vêm de poucos
**objetos fixos** (grade/placa, janela escura de van, estruturas à beira-lago) lidos como torso/cabeça
no piso de confiança. Como o FP é **espacialmente preso** e a pessoa real **se move**, mascarar o
hotspot mata o FP **sem custar recall**. Ancorar no **pé** (não no centro) casa a supressão com o chão
do objeto. Helper: `zones.js inExclusionZone(bbox|ponto, zonasExcl)`; o engine mantém `st.zonesExcl`
(recarregado no `camcfg-updated` kind `"zones"`, como as de atividade). `GET /api/analysis/status`
expõe `excluded1m` por câmera (aditivo) = dets suprimidas em 60s.

> Dependência de contrato (frente do front): `server/camcfg.js` precisa aceitar `"exclusao"` no
> conjunto de modos de zona (`ZONE_MODES`) e a UI precisa desenhar a zona nesse modo — senão o
> `cleanZone` rebaixa `modo` para `"atividade"` na persistência e o engine nunca vê a zona de
> exclusão. (Mesmo padrão da nota de `longRange` abaixo.)

## Longo alcance / Panorâmica (tiling 2×2)

Câmera com **`CameraCfg.longRange: true`** no camcfg (o mesmo perfil "Longo alcance /
Panorâmica" da central — `src/cameraConfig.ts`) é analisada com **tiling 2×2, overlap 0.1**
(estilo SAHI): o worker decodifica o JPEG 1×, recorta as 4 regiões (sharp extract), roda
**4 inferências sequenciais** a 640/tile, reprojeta as bboxes p/ frações do frame (mesma
conta de `src/vision/detect.ts`) e funde com NMS por classe + **dedupe por contenção ≥0.7**
(mantém o maior score — espelha `src/vision/nms.ts`; a caixa parcial do tile vizinho tem
IoU baixo com a caixa inteira e passaria no NMS clássico). O engine lê o flag no
`createState` e recarrega no `camcfg-updated` kind `"camconfig"` — liga/desliga sem reboot.

**Custo honesto (medido, ultrabook 4C do spike, câmera pública Bled 95 frames pareados):**
~**3,9× a inferência** por rodada — 242 → 952 ms (inferência) e 288 → 1074 ms a rodada
completa (decode+pré+infer) a 1920w. Recall medido na mesma cena: pessoas ≥0.35 (limiar de
nascimento de track) **5 → 22** em 95 frames (frames com ≥1 pessoa: 3 → 18; frame-a-frame o
tiling ganhou em 18, empatou em 74, perdeu em 3). A 720w o efeito quase some (0 → 3): tile de
fonte estreita não tem pixel novo — **panorâmica longRange pede fonte larga (Largura 1920 no
cadastro, como recomenda `docs/manuais/manual-incluir-cameras.md`)**.

**Recomendação:** use SÓ em câmeras panorâmicas/campo aberto com gente distante; o fps
continua `ANALYSIS_FPS` (1). Dimensionamento: câmera longRange custa ~4 câmeras comuns —
no ultrabook 4C, 1 câmera LR @1fps ainda cabe (rodada ~1,1 s < 1 rodada em voo por câmera;
a fila último-vence descarta o excedente sem acumular atraso). Pessoa <~25px no TILE segue
fora do alcance do nano (limite do modelo, não do tiling).

> Dependência de contrato: o store `server/camcfg.js` precisa PRESERVAR o campo
> `longRange` em `cleanCamConfig` (hoje o perfil chega ao hub via PUT do front); sem isso o
> flag não sobrevive à persistência e o motor fica no squash.

## Contratos (todos ADITIVOS)

- **Ingest** (mesmos formatos de `src/report/store.ts`, direto no `pgstore` — sem HTTP):
  - `flow`/`cross`: `{ cameraId, cameraLabel, tripwireId, dir:"in"|"out", ts, shift }`
  - `ativ`/`samples`: `{ cameraId, samples:[{ zoneId, label, atividade, idleMs:0, frames,
    activeFrames, people }] }` — `people` = pico na janela (→ `people_peak`), `activeFrames` =
    rodadas com ≥1 pessoa (→ `activePct`). `idleMs` fica 0: ociosidade por MOTION (e os alarmes
    dela) continuam no front — fora do motor do hub.
- **Socket** `analysis-status { cameraId, engine: "hub" | null }` → room `dashboards`
  (snapshot no connect + a cada mudança). O front usa p/ desligar o ingest do browser.
- **Socket** `analysis-tracks { cameraId, ts, tracks, zones }` (overlays servidos) →
  room `dashboards`, **volatile** (último-vence, sem backlog — mesmo padrão dos frames),
  emitido a CADA rodada de análise da câmera (@`ANALYSIS_FPS`; payload de KBs), inclusive
  com 0 tracks (rodada vazia apaga as caixas) e mesmo sem zona/tripwire configurada:
  - `tracks`: `[{ id, bbox:[x,y,w,h] normalizado 0..1, cx, cy, zone: label|null }]`
    (só pessoas — o que o ByteTrack devolve; campos internos do tracker NÃO vazam).
  - `zones`: `[{ id, label, people, occupied }]` — estado da rodada por zona de atividade
    (o mesmo que alimenta a janela do ingest).
  - Economia: sem socket na room `dashboards`, o payload nem é montado
    (`io.sockets.adapter.rooms.get("dashboards")?.size`).
- **HTTP** `GET /api/analysis/status` (autenticado) → `{ enabled, model, targetFps,
  worker:{ready,pid,respawns,cpuPct}, perCamera:{ [id]: {fps, queue, lastMs, dets1m,
  excluded1m, longRange} } }` (`excluded1m` aditivo — dets suprimidas por zona de exclusão em 60s;
  `longRange` aditivo — true = rodada com tiling 2×2).
- **Shed**: câmera analisada conta como espectador — `rtsp.setAnalysisViewer()` impede o
  `idleSource` de pausar o ffmpeg. Webcam ainda pode ser rebaixada a `SHED_WEBCAM_FPS` (2fps ≥
  cadência de análise; o nó economiza CPU e o motor não perde nada).
- **camcfg**: zonas/tripwires/camconfig recarregam no evento `camcfg-updated` (tee no
  index.js); `setTripwires` preserva contadores por id; kind `"camconfig"` religa/desliga
  o tiling longRange na próxima rodada.

## LGPD / ADR-002

Frames continuam **efêmeros em memória** (hub → worker via IPC); nada de imagem é persistido.
Persistem-se apenas indicadores agregados/metadados — exatamente os mesmos de antes.

## Dimensionamento (spike §7)

Custo por câmera @1fps depende do modelo (`eval/MODELS.md`, CPU EP 2 threads): **S** (default)
~1,07 core·s/frame → **~0,9 câmera/core** (8C/16T ≈ **~7 câmeras** @1fps); **N** ~0,45 → ~2,2
câmera/core (≈17); **M** ~1,88 → ~0,53 (≈4). RSS do worker ~190–260 MB (modelo carregado; S/M um
pouco acima do N). CPU EP **only** (DML retorna saída errada; WebGPU crasha — spike §5). Pessoa
<~25px segue fora do alcance do modelo a 640 (limite de amostragem, não do modelo).
