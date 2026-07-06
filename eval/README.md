# eval/ — Bancada de acurácia do motor (ground truth COCO)

Mede **o pipeline REAL de produção** — dá `fork` no próprio `server/analysis/worker.js`
(D-FINE ONNX, decode sharp → squash 640 → score → NMS/contenção; tiling 2×2 = perfil
longRange) e fala com ele pelo mesmo protocolo IPC do engine. Nada de pipeline
reimplementado: se o worker mudar, a régua mede a mudança.

**Núcleo compartilhado: `eval/lib.mjs`** — cliente do worker (fork IPC), matching
det×GT (`iou`/`matchGreedy`), `prf`, buckets S/M/L e a resolução de modelo. Os scripts
(`gate`, `run-eval`, `compare-models`, `fetch-dataset`) consomem a lib; o **catálogo de
modelos é importado de `server/analysis/model.js`** (nunca copiado). A resolução de
modelo é a MESMA da produção: **default S**; `ANALYSIS_MODEL=n|s|m` troca o tier;
`ANALYSIS_MODEL_PATH` fixa um `.onnx` explícito.

## Como rodar

```sh
# 1. dataset (idempotente): anotações COCO val2017 (~20MB, mirror HF) + 300 imagens (~50MB)
node eval/fetch-dataset.mjs

# 2. modelo: precisa do default de produção em server/models/ (dfine_s_obj2coco.onnx —
#    o hub baixa no 1º boot com ANALYSIS_ENABLED=1; ver server/analysis/README.md)

# 3. avaliação full-set (use --mode squash p/ só o default; tiled quadruplica o custo)
node eval/run-eval.mjs [--mode squash|tiled|both] [--no-errors]
```

## O que mede

- **Dataset** (`manifest.json`, commitável — ids + GT em pixels, determinístico seed 42):
  150 imagens COM pessoas (50 por tamanho dominante S/M/L, padrão COCO por área de bbox
  <32²/32²–96²/>96² px; varrendo de indivíduo a multidão; sem `iscrowd`) + 150 SEM pessoa
  nenhuma (falso positivo puro).
- **Métricas**: matching det×GT guloso por score, 1-1, IoU≥0.5 → precisão/recall/F1 por
  threshold (0.25→0.55, passo 0.05) × tamanho (S/M/L), nos modos squash e tiling 2×2;
  FP por threshold nas 150 vazias.
- **Piores erros com imagem**: top-15 falsos positivos e top-15 misses do modo squash →
  PNGs anotados em `eval/data/errors/` (verde = GT · ciano tracejado = detecção ·
  vermelho = FP · laranja = miss).

## Saídas

- Tabelas markdown no stdout.
- `eval/last-results.json` (gitignored): números completos + caminhos dos PNGs de erro.
- `eval/data/` inteiro é **gitignored** (anotações, imagens, erros) — só os scripts, este
  README e o `manifest.json` são versionados.

## Sensor de regressão (`npm run eval`)

A ONDA 3.3 do plano transforma esta bancada num **gate de acurácia** que roda em
segundos e vira vermelho se uma troca futura de modelo/threshold/NMS degradar o motor.

- **O que mede:** dá `fork` no mesmo `server/analysis/worker.js` (modo squash 640 —
  default de produção) sobre um **fixture commitado pequeno** (`eval/fixture/`, 29
  imagens COCO = 21 com pessoas S/M/L + 8 cenas vazias, ~5MB, GT em pixels em
  `manifest-fixture.json`) e compara com os limiares mínimos de `eval/thresholds.json`:
  `f1_all@0.35`, `recall_all@0.25`, `precision_all@0.35` (pisos) e `fp_empties@0.50`
  (teto = 0: zero pessoa inventada em cena vazia). **Determinístico** — mesmo modelo +
  mesmo fixture → mesmos números. Exit 0 passa; exit 1 + diff claro se regride.
- **Como rodar:** `npm run eval` (ou `node eval/gate.mjs`). Precisa do modelo default em
  `server/models/` (o hub baixa no 1º boot com `ANALYSIS_ENABLED=1` —
  ver `server/analysis/README.md`). **Não** está no `npm run verify` — é gate
  manual/CI opcional; rode-o **ANTES de trocar modelo, threshold de score ou NMS**.
- **Como recalibrar (ao TROCAR de modelo):** `node eval/gate.mjs --calibrate` remede o
  fixture e reescreve os `min`/`max` de `thresholds.json` a partir do novo patamar
  (medido − margem de tolerância `_margin_pp`, hoje 5pp). Revise o diff antes de
  commitar — **não** recalibre para mascarar uma regressão não intencional.
- **Regenerar o fixture:** `node eval/build-fixture.mjs` (após `fetch-dataset.mjs`) —
  reamostra o subconjunto do `manifest.json` e recopia as imagens para `eval/fixture/img/`.
  Se mudar o fixture, recalibre os limiares.

## Sensor de contagem fim-a-fim (`npm run eval:counting`)

O KPI da plataforma é a **contagem de travessias** — e o detector sozinho não a mede.
`eval/counting.mjs` fecha o elo dets→contagem: liga os **módulos de produção**
`server/analysis/bytetrack.js` + `counting.js` (importados, nada reimplementado) com o
MESMO wiring e knobs do engine (cadência de linha 2fps, highScore 0.35, TTL derivado,
histerese 2 rodadas, minMove/maxDist/debounce) e alimenta sequências **determinísticas**
de detecções sintéticas com nº de travessias **conhecido**.

- **Cenários (9):** travessia única, ida-e-volta, cruzamento simultâneo em direções
  opostas, multidão escalonada (4 pessoas), detecção intermitente (miss alternado —
  TTL/predição seguram o id), score que cai p/ 0.30 na travessia (2ª passada sustenta),
  score sempre 0.30 (não nasce track), micro-jitter sobre a linha (minMove filtra) e
  teleporte (id novo re-âncora, não conta).
- **PASS/FAIL:** travessias contadas = esperadas em TODOS os cenários → exit 0; qualquer
  divergência → exit 1 com a tabela in/out esperado×contado (o cenário diz QUAL mecanismo
  quebrou). Determinístico: sem env, sem aleatoriedade, timestamps fixos.
- **Fronteira honesta:** NÃO mede o recall do detector (sensor: gate/run-eval) nem vídeo
  real — replay de travessias de campo segue previsto (`analises/acuracia-modelos.md §3`).
  Knobs são espelho dos defaults de produção (`engine.js`); se mudarem lá, atualize o
  espelho em `counting.mjs`.

## Caveats declarados

- Precisão por tamanho é aproximação (TP no bucket do GT casado, FP no bucket do det);
  a coluna "all" é exata.
- COCO tem pessoas não-anotadas ocasionais: um "FP" de score alto pode ser gente real —
  por isso os piores erros saem COM imagem, para inspeção olho-no-olho antes de concluir.
- gate/run-eval respondem "enxerga? inventa?"; `eval/counting.mjs` responde "a travessia
  vira contagem?" sobre dets sintéticas. O que segue SEM sensor: contagem sobre vídeo
  REAL de campo (recall do detector × cadência na cena da fábrica).
