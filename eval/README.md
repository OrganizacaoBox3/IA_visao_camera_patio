# eval/ — Bancada de acurácia do motor (ground truth COCO)

Régua da ONDA 1 de `analises/plano-acuracia-modelos.md`: mede **o pipeline REAL de
produção** — dá `fork` no próprio `server/analysis/worker.js` (D-FINE-N ONNX, decode sharp →
squash 640 → score → NMS/contenção; tiling 2×2 = perfil longRange) e fala com ele pelo mesmo
protocolo IPC do engine. Nada de pipeline reimplementado: se o worker mudar, a régua mede a mudança.

## Como rodar

```sh
# 1. dataset (idempotente): anotações COCO val2017 (~20MB, mirror HF) + 300 imagens (~50MB)
node eval/fetch-dataset.mjs

# 2. modelo: precisa de server/models/dfine_n_coco.onnx (o hub baixa no 1º boot com
#    ANALYSIS_ENABLED=1 — ver server/analysis/README.md)

# 3. avaliação (ambos os modos ~6-8 min em 4C; use --mode squash p/ só o default)
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

## Caveats declarados

- Precisão por tamanho é aproximação (TP no bucket do GT casado, FP no bucket do det);
  a coluna "all" é exata.
- COCO tem pessoas não-anotadas ocasionais: um "FP" de score alto pode ser gente real —
  por isso os piores erros saem COM imagem, para inspeção olho-no-olho antes de concluir.
- Este harness responde às perguntas 1 e 2 do plano (enxerga? inventa?). A pergunta 3
  (erro de CONTAGEM em fluxo real) é a Onda 2 — não se mede aqui.
