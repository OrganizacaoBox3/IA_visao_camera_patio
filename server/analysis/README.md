# server/analysis — Motor de análise no hub (F1 · ADR-009)

Detecção de pessoas + tracking + contagem por linha + ocupação por zona rodando **no hub**,
24/7, independente de espectador. O navegador segue exibindo vídeo/overlays; os INDICADORES
passam a nascer aqui. Plano: `analises/plano-analise-server-side.md` · medições:
`analises/spike-dfine-hub.md`.

## Arquitetura

```
relé de frames (index.js webcam · rtsp.js ffmpeg)
      │  onFrame(cameraId, jpegBuf, ts)  — último-vence por câmera
      ▼
engine.js (in-process no hub)
  · amostra @ANALYSIS_FPS (default 1) e envia ao worker (1 pedido em voo/câmera)
  · câmera com CameraCfg.longRange (camcfg) → pedido leva tiles 2×2 (F3, ver §Longo alcance)
  · dets "person" → bytetrack.js (por câmera) → counting.js (tripwires do camcfg)
  · zonas modo "atividade" (camcfg) → people/occupied por zona (janela ~3s)
  · pgstore.ingest DIRETO ("flow"/"cross" e "ativ"/"samples" — formatos do front)
  · emite `analysis-status {cameraId, engine:"hub"}` (anti-duplicação, F1-C)
  · emite `analysis-tracks {cameraId, ts, tracks, zones}` volatile → dashboards (F2)
      │  IPC fork(serialization:"advanced") — {id, cameraId, jpeg:Buffer}
      ▼
worker.js (child_process — processo SEPARADO: ORT serializa inferência por processo
           e um crash nativo não derruba o relé; respawn com backoff no engine)
  · sharp decode → squash 640×640 → tensor fp32 (pré/pós do spike validado)
  · com `tiles` (longRange): decode 1× → extract por tile → squash 640/tile →
    N inferências sequenciais → reprojeção tile→frame → NMS + contenção ≥0.7
  · D-FINE-N ONNX · onnxruntime-node CPU EP · intraOpNumThreads=2
  · sigmoid + argmax + score≥0.25 + NMS leve por classe → dets normalizadas
```

`bytetrack.js`, `counting.js` e `zones.js` são ports 1:1 dos módulos TS do front
(frente F1-B) — mesmas APIs, mesmos testes de paridade.

## Modelo

- Arquivo: `server/models/dfine_n_coco.onnx` (**gitignored**), fp32, 15.258.358 bytes,
  sha256 `0f684f409618ee8a822410e754a29caa817d1aa16283ce89cad936d0a48e2f35`.
- Fonte (a mesma do spike): `https://huggingface.co/onnx-community/dfine_n_coco-ONNX`
  (`onnx/model.onnx`, base `ustc-community/dfine-nano-coco`, **Apache-2.0**).
- Baixado no boot com verificação de tamanho + sha256 (escrita atômica). Sem rede no deploy?
  Copie o arquivo manualmente para `server/models/` — o boot valida o sha e segue.

## Liga/desliga (contrato)

| `ANALYSIS_ENABLED` | Comportamento |
|---|---|
| `0` | motor DESLIGADO |
| `1` | LIGADO; baixa o modelo no boot se ausente; download falhou → desliga com aviso (hub segue) |
| _ausente_ (default) | LIGADO **se o modelo já existe**; sem modelo → desligado (log explica) |

Ou seja: rode o 1º boot com `ANALYSIS_ENABLED=1` (baixa o modelo); dali em diante o default liga.

## Env (defaults entre parênteses)

`ANALYSIS_FPS` (1) · `ANALYSIS_HIGH_SCORE` (0.35 — nascimento/1ª passada do ByteTrack; o worker
devolve ≥`ANALYSIS_SCORE_MIN`=0.25, que sustenta tracks na 2ª passada) · `ANALYSIS_AGG_MS`
(3000 — janela do ingest "ativ") · `ANALYSIS_INTRA_THREADS` (2) · `ANALYSIS_NMS_IOU` (0.6) ·
`ANALYSIS_MODEL_PATH` (server/models/dfine_n_coco.onnx).

## Longo alcance / Panorâmica (tiling 2×2 — F3)

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
    dela) continuam no front — fora da F1.
- **Socket** `analysis-status { cameraId, engine: "hub" | null }` → room `dashboards`
  (snapshot no connect + a cada mudança). F1-C usa p/ desligar o ingest do browser.
- **Socket** `analysis-tracks { cameraId, ts, tracks, zones }` (F2 — overlays servidos) →
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
  longRange} } }` (`longRange` aditivo — F3: true = rodada com tiling 2×2).
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

~0,2 core/câmera @1fps (worker 1-2 threads) + ~190-240 MB RSS do worker (modelo carregado).
Ultrabook 4C/8T ≈ 8-10 câmeras @1fps; desktop 8C/16T ≈ 16-24. CPU EP **only** (DML retorna
saída errada; WebGPU crasha — spike §5). Pessoa <~25px segue fora do alcance do nano.
