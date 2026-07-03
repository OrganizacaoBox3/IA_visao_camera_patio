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
  · dets "person" → bytetrack.js (por câmera) → counting.js (tripwires do camcfg)
  · zonas modo "atividade" (camcfg) → people/occupied por zona (janela ~3s)
  · pgstore.ingest DIRETO ("flow"/"cross" e "ativ"/"samples" — formatos do front)
  · emite `analysis-status {cameraId, engine:"hub"}` (anti-duplicação, F1-C)
      │  IPC fork(serialization:"advanced") — {id, cameraId, jpeg:Buffer}
      ▼
worker.js (child_process — processo SEPARADO: ORT serializa inferência por processo
           e um crash nativo não derruba o relé; respawn com backoff no engine)
  · sharp decode → squash 640×640 → tensor fp32 (pré/pós do spike validado)
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

## Contratos (todos ADITIVOS)

- **Ingest** (mesmos formatos de `src/report/store.ts`, direto no `pgstore` — sem HTTP):
  - `flow`/`cross`: `{ cameraId, cameraLabel, tripwireId, dir:"in"|"out", ts, shift }`
  - `ativ`/`samples`: `{ cameraId, samples:[{ zoneId, label, atividade, idleMs:0, frames,
    activeFrames, people }] }` — `people` = pico na janela (→ `people_peak`), `activeFrames` =
    rodadas com ≥1 pessoa (→ `activePct`). `idleMs` fica 0: ociosidade por MOTION (e os alarmes
    dela) continuam no front — fora da F1.
- **Socket** `analysis-status { cameraId, engine: "hub" | null }` → room `dashboards`
  (snapshot no connect + a cada mudança). F1-C usa p/ desligar o ingest do browser.
- **HTTP** `GET /api/analysis/status` (autenticado) → `{ enabled, model, targetFps,
  worker:{ready,pid,respawns,cpuPct}, perCamera:{ [id]: {fps, queue, lastMs, dets1m} } }`.
- **Shed**: câmera analisada conta como espectador — `rtsp.setAnalysisViewer()` impede o
  `idleSource` de pausar o ffmpeg. Webcam ainda pode ser rebaixada a `SHED_WEBCAM_FPS` (2fps ≥
  cadência de análise; o nó economiza CPU e o motor não perde nada).
- **camcfg**: zonas/tripwires recarregam no evento `camcfg-updated` (tee no index.js);
  `setTripwires` preserva contadores por id.

## LGPD / ADR-002

Frames continuam **efêmeros em memória** (hub → worker via IPC); nada de imagem é persistido.
Persistem-se apenas indicadores agregados/metadados — exatamente os mesmos de antes.

## Dimensionamento (spike §7)

~0,2 core/câmera @1fps (worker 1-2 threads) + ~190-240 MB RSS do worker (modelo carregado).
Ultrabook 4C/8T ≈ 8-10 câmeras @1fps; desktop 8C/16T ≈ 16-24. CPU EP **only** (DML retorna
saída errada; WebGPU crasha — spike §5). Pessoa <~25px segue fora do alcance do nano.
