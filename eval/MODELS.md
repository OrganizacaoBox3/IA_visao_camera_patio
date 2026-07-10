# eval/MODELS.md — Comparativo de capacidade do detector (N vs S vs M)

> **DECISÃO (jul/2026):** o **default de produção do motor é o D-FINE-S obj2coco**
> (`ANALYSIS_MODEL=s` no `engine.js`; ver `server/analysis/README.md §Modelo`). O gate de acurácia
> (`eval/thresholds.json`) foi **recalibrado sobre o S** — os patamares subiram (F1@0.35 32%→77%,
> recall@0.25 48%→88%). `ANALYSIS_MODEL=n` volta ao nano onde o CPU for o limite duro.

> **Pergunta:** mais capacidade conserta o recall de pessoa média/pequena (o nosso
> gargalo) — e a que custo de CPU? Medido no **harness real de produção** (`fork` de
> `server/analysis/worker.js`, modo **squash 640**, CPU EP, `intraOpNumThreads=2`),
> mesmas imagens/matching (IoU≥0.5) do `eval/`. D-FINE-N/S/M obj2coco são a **mesma
> arquitetura** → drop-in absoluto (só troca o `.onnx`; input/saídas/classes idênticos,
> verificado). Script: `eval/compare-models.mjs`. Números crus (gitignored):
> `eval/model-comparison.json`.
>
> Máquina: 8 cores, node v24, **hub+dev rodando ao vivo** durante a medição → execução
> **sequencial** (1 modelo por vez, nunca paralelo) + 1 warmup descartado. A contenção
> inflou o **wall-time** absoluto (N infer p50 133ms no fixture ocioso → 197ms no full sob
> carga, ~+48%); por isso o **custo é medido por CPU-time real** (`process.cpuUsage`
> user+system, robusto à contenção) e as **razões entre modelos** (medidas back-to-back na
> mesma máquina) são a comparação honesta. Os `cam/core` são **piso** (pessimistas, sob carga).

## Resultado — full-set (150 com pessoa + 150 vazias, 591 GT person), squash 640

| modelo | R S/M/L @0.25 | R S/M/L @0.35 | R all @0.25 | R all @0.35 | F1 @0.35 | P @0.35 | FP-vazias @0.35 / @0.50 | infer p50/p95 (ms) | CPU ms/frame | cam/core @1fps |
|---|---|---|---|---|---|---|---|---|---|---|
| **N** (baseline) | 38/53/60 | 21/32/29 | 49 | 27 | **37** | 61 | 4 / **0** | 197/305 | 452 | **2.21** |
| **S** obj2coco | **76/94/98** | **69/91/98** | 88 | 85 | **74** | 65 | 22 / 7 | 521/593 | 1071 | **0.93** |
| **M** obj2coco | 82/92/98 | 76/89/98 | 90 | 86 | 77 | 69 | 18 / 6 | 965/1393 | 1875 | 0.53 |

Custo relativo ao N (mesma máquina, back-to-back): **S = 2.4× CPU** (2.6× wall) · **M = 4.1× CPU** (4.9× wall).
> Nota: a estimativa a priori de "~3.6× o N" (razão de GFLOPs 25/7) **superestimou** — CPU
> real não escala linear com FLOP (memória/threads). S saiu **mais barato que o temido**.

## Leitura

- **O gargalo (pessoa média/pequena) é consertado — e muito.** Recall @0.25 pequena
  **38→76%** (S) / **82%** (M); média **53→94%** (S). No ponto de operação da contagem
  (**nascimento 0.35**) a pequena vai de **21→69%** (S) / **76%** (M) e a média de **32→91%**.
  F1@0.35 **dobra** (37→74% S / 77% M). Precisão @0.35 **não regride** (61→65→69%).
- **S captura ~toda a diferença; M acrescenta pouco.** M supera S em ~+3–7pp de recall/F1
  por **~2× o custo de S** (0.53 vs 0.93 cam/core). Só se justifica em hub forte com poucas
  câmeras.
- **Trade-off honesto — os modelos maiores inventam mais em cena vazia.** FP em vazias
  @0.50: **N=0 → S=7 → M=6** (em 150 cenas). Isso **quebra o invariante calibrado
  `fp_empties@0.50 = 0`** do `eval/thresholds.json` → **exige recalibrar o gate**
  (`node eval/gate.mjs --calibrate`) e casa com a Medida A (máscara de exclusão) do
  `docs/analises/acuracia-modelos.md`, já que esses FP tendem a ser objeto fixo no piso de score.

## Veredito

**S vale a troca; M não (na maioria dos hubs).** O ganho de recall médio/pequeno é grande o
bastante para justificar ~2.4× de CPU: é **exatamente o gargalo** que travava a contagem de
linha (recall×cadência — `acuracia-modelos.md §3`). Num hub de 8 cores @1fps, S entrega
~**0.9 câmera/core** (≈7 câmeras analisadas) contra ~**2.2** do N (≈17). Se a contagem de
câmeras couber no orçamento de CPU, **levar o D-FINE-S obj2coco para a calibração/produção**
(drop-in: trocar o `.onnx` + `--calibrate` do gate + combinar com máscara/threshold por
finalidade). Onde o CPU for o limite duro, **ficar no N + máscara + calibração** e reservar S
para as câmeras com linha crítica. **M** só como teto de robustez em hub sobrando CPU.

> Não medido de propósito (foco = squash; máquina ao vivo): tiling 2×2 no S (custaria ~4×
> a inferência → ~0.23 cam/core). Squash-S já resolve o gargalo; tiling fica como alavanca
> futura para <25px, que **nenhum** modelo desta classe resolve a 640 (limite de amostragem).
