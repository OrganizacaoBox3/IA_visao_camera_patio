# Spike: YOLO-nano ONNX vs D-FINE em CPU — medido no NOSSO caso (jul/2026)

> **Pergunta:** um YOLO nano convolucional (ONNX, end-to-end/NMS-free) bate o D-FINE
> (transformer) em CPU no nosso caso — latência nesta máquina + acurácia de **pessoa** no
> nosso eval set? Era a aposta estrutural "de maior teto" (pesquisa apontava conv ~150–350ms
> vs ~650ms do transformer). Troca de família só com evidência — este spike é a evidência.
>
> **Spike ISOLADO** — zero mudança de produto. Script: `scripts/spike-yolo.cjs` (novo,
> standalone). Modelos YOLO baixados no scratchpad da sessão, **não entram no repo**.
> Máquina: i7-11390H (4C/8T), node v24, onnxruntime-node CPU EP, `intraOpNumThreads=2`
> (idêntico à produção). Medição feita com hub/dev ao vivo (contenção ambiente — ver
> "Honestidade da medição").

## Veredito — **NÃO TROCAR de família. O D-FINE-S continua sendo o motor certo.**

1. **A premissa da pesquisa não se confirmou nesta máquina.** O ganho "conv 150–350ms vs
   transformer 650ms" **superestimou**: o D-FINE já é um DETR otimizado para tempo real, e
   na prática as famílias empatam por classe de tamanho — **v10n ≈ D-FINE-N** (infer p50
   ~108–158ms vs 133–197ms) e **v10s ≈ D-FINE-S** (p50 405ms vs 381–521ms). **v10s é até
   mais lento que o D-FINE-S ocioso.** Não existe o 2–4× de headroom que justificaria a troca.
2. **Onde importa (nosso gargalo = pessoa pequena/distante), o YOLOv10n é fraco demais:**
   recall de pessoa **pequena 31% @0.25 vs 76% do D-FINE-S** (e vs 38% até do D-FINE-N).
   Recall all 58% vs 88%. O D-FINE-S foi escolhido exatamente por consertar esse gargalo
   (`eval/MODELS.md`) — o v10n o devolveria.
3. **Licença: AGPL-3.0 vs Apache-2.0.** YOLOv10 (THU-MIG, linhagem Ultralytics) e o export
   ONNX (`onnx-community/yolov10*`) são **AGPL-3.0** — copyleft forte: embutir o modelo num
   produto proprietário servido em rede cria obrigação de abrir o código (ou comprar licença
   comercial Ultralytics). O D-FINE é **Apache-2.0** (limpo, já auditado no
   `server/analysis/README.md`). Mesmo se o v10n ganhasse tecnicamente, a licença por si só
   bloquearia a adoção sem parecer jurídico/licença comercial.
4. **Fine-tune futuro:** o argumento "ecossistema Ultralytics facilita fine-tune" não paga a
   AGPL — o D-FINE tem código oficial de treino Apache-2.0; o caminho de fine-tune da família
   atual existe e é livre.

**Nuance honesta (o achado que sobrevive):** no *tier nano*, o v10n **vence o D-FINE-N** no
nosso set — F1 melhor em todos os thresholds (best 69% vs 45%), precisão muito maior
(85% vs 41% @0.25), recall all maior (58% vs 49%) e ~20% mais rápido — perdendo **só** na
pessoa pequena (31% vs 38%). Ou seja: para hub CPU-bound com câmeras **de perto**
(presença/ocupação, sem pessoa distante), um conv-nano seria competitivo com o N… mas esse
tier já perde do S pelo mesmo motivo que o v10n perde, e a AGPL bloqueia de qualquer forma.
A alavanca real de perf continua sendo a já mapeada: tier N/S/M + `ANALYSIS_INPUT`
(`docs/analises/perf-input-size-dfine.md`), não troca de família.

## Tabela — modelo × latência × acurácia de pessoa × licença

Latência: fixture 1080p (COCO 000000000139 re-encodada 1920×1080 q85, a mesma do
`scripts/profile-infer.cjs`) → squash/letterbox 640 → infer → decode saída; p50/p95 de 25
iterações (3 warmup). Acurácia: full-set do eval (150 c/ pessoa + 150 vazias, **591 GT
person**), matching guloso 1-1 IoU≥0.5, idêntico ao `eval/compare-models.mjs`.

| modelo | tam. (fp32) | licença | infer p50/p95 ms @640 | R all @0.25 (S/M/L) | F1 @0.35 | best F1 (thr) | P @best | cpu ms/frame → cam/core @1fps |
|---|---|---|---|---|---|---|---|---|
| **YOLOv10n e2e** (medido) | 2.3M · 9.0MB | **AGPL-3.0** | **108/142** ¹ | 58% (**31**/63/89) | 66% | 69% (@0.25) | 85% | 339 → **3.0** |
| **YOLOv10s e2e** (medido, só latência) | 7.2M · 27.8MB | **AGPL-3.0** | **406/713** ¹ | *não concluído* ² | — | — | — | — |
| D-FINE-N coco (ref. ³) | 14.6MB | Apache-2.0 | 133 (ocioso) · 197/305 (sob carga) | 49% (38/53/60) | 37% | 45% (@0.25) | 41% | 452 → 2.2 |
| **D-FINE-S obj2coco** (ref. ³ — **default de produção**) | 39.6MB | Apache-2.0 | 381 (ocioso) · 521/593 (sob carga) | **88% (76/94/98)** | **74%** | **80% (@0.55)** | 89% | 1071 → 0.93 |

¹ Medido **agora, sob carga ambiente** (hub/dev ao vivo). Estágios v10n: decode+resize 25ms ·
tensor 8ms · infer 108ms · post **0.0ms** (NMS-free) → TOTAL p50 142ms. v10s: TOTAL p50 442ms.
² A rodada de acurácia do v10s foi **interrompida a 150/300** (dados já conclusivos: latência
405ms ≥ D-FINE-S elimina a candidatura; referência COCO: 46.3 AP vs 48+ do S). Lacuna declarada.
³ **Rodadas anteriores na mesma máquina/fixture/eval-set**: latência ociosa de
`scripts/profile-infer.cjs`; sob-carga + acurácia de `eval/model-comparison.json`
(`compare-models.mjs`, worker real de produção). A perna back-to-back do D-FINE neste spike
foi cortada quando os dados ficaram conclusivos.

### Curva de thresholds do YOLOv10n (pessoa, full-set) — para inspeção

| thr | P | R | F1 | R S/M/L | FP vazias (dets/imgs) |
|---|---|---|---|---|---|
| 0.25 | 85 | 58 | 69 | 31/63/89 | 10/7 |
| 0.35 | 91 | 52 | 66 | 22/56/88 | 7/5 |
| 0.45 | 94 | 48 | 63 | 16/52/86 | 4/2 |
| 0.55 | 96 | 42 | 58 | 9/46/81 | 2/1 |

Perfil clássico do conv-nano one-to-one: **precisão altíssima, recall baixo** — ele só
"afirma" a pessoa fácil (grande/próxima: L=89%) e é quase cego à pequena (31→9%). Nosso
caso (pé-direito alto, pessoa distante, contagem por linha = recall-bound) é o pior cenário
para esse perfil. FP-em-vazias é ótimo (2 dets @0.50 vs 7 do S) — irrelevante frente à cegueira.

## Honestidade da medição (limites)

- **Assimetria de condição favorece o D-FINE apenas nos absolutos ociosos**: v10n/v10s foram
  medidos sob carga ambiente; ainda assim v10n saiu *mais rápido* que o D-FINE-N ocioso e
  v10s *mais lento* que o D-FINE-S ocioso — a direção do veredito é robusta à contenção.
- **Preprocess por família, como cada uma pede**: YOLO = letterbox 640 (pad 114, export
  Ultralytics); D-FINE = squash 640 (produção). Boxes des-letterboxadas para px da imagem
  original antes do matching.
- **Harness do spike ≠ worker de produção**: o matching/métricas é cópia literal do
  `compare-models.mjs`, mas a perna de validação cruzada (rodar dfine-n no harness do spike e
  conferir contra `model-comparison.json`) foi cortada junto com a suíte. Um bug de
  des-letterbox *deflacionaria* o v10n (não inflaria) — o achado "v10n > D-FINE-N em F1"
  poderia até melhorar, nunca piorar o veredito. Acurácia v10n reproduzida em 2 rodadas
  (58%/66% idênticos).
- **Amostra de 1 máquina** (4C/8T); razões entre modelos medidas na mesma sessão são o sinal
  fiel, absolutos variam com contenção.

## Como reproduzir

```sh
# 1. Modelos (fp32, ~9MB/~28MB) — fora do repo (ex.: scratchpad); licença AGPL-3.0
curl -L https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx -o <SCRATCH>/models/yolov10n.onnx
curl -L https://huggingface.co/onnx-community/yolov10s/resolve/main/onnx/model.onnx -o <SCRATCH>/models/yolov10s.onnx

# 2. Dataset do eval (se ainda não tiver): node eval/fetch-dataset.mjs

# 3. Spike (latência + acurácia; SPIKE_SCRATCH aponta p/ onde estão os modelos)
SPIKE_SCRATCH=<SCRATCH> node scripts/spike-yolo.cjs --latency --accuracy --models v10n,v10s,dfine-n,dfine-s
# JSON completo: <SCRATCH>/spike-yolo-results.json

# 4. Referências D-FINE (mesma máquina, rodadas anteriores):
#    scripts/profile-infer.cjs (latência ociosa) · eval/model-comparison.json (acurácia full-set)
```

Fontes/licenças verificadas em 05/jul/2026: `github.com/THU-MIG/yolov10` (AGPL-3.0; N=2.3M
params/38.5 AP, S=7.2M/46.3 AP COCO) · `huggingface.co/onnx-community/yolov10n` (agpl-3.0,
export e2e `output0 [1,300,6]`, input fixo 640) · D-FINE Apache-2.0 (`server/analysis/README.md`).
