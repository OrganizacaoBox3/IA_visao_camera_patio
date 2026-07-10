# Input do D-FINE configurável — tradeoff medido (perf, jul/2026)

> **Pergunta:** baixar o input do resize (640 fixo → 512 / 416) corta inferência —
> mas a que custo de **recall de pessoa pequena/distante** (nosso gargalo, a razão do tiling)?
> Objetivo: tornar o input **configurável** e escolher o default **medindo o recall no eval**,
> não baixando às cegas.
>
> **Medido no harness real de produção** (`fork` de `server/analysis/worker.js`, tier **S**
> `dfine_s_obj2coco`, CPU EP `intraOpNumThreads=2`), full-set `eval/manifest.json`
> (150 com pessoa + 150 vazias, **591 GT** — 224 pequena / 204 média / 163 grande),
> matching guloso 1-1 IoU≥0.5. O D-FINE tem **eixo dinâmico** no ONNX → roda em qualquer
> múltiplo de 32 **sem re-exportar** (512/416 rodaram direto). Máquina: 8 cores, node v24,
> **hub NÃO rodando** (medição isolada). Buckets COCO: S <32² · M 32²–96² · L >96² px.

## Veredito

**Default = 640 — MANTIDO.** A evidência mandou não baixar: a 512, o recall de pessoa
**pequena** cai sistematicamente (**−6,7 a −8,0pp** no squash) por só **−23% de CPU** nesta
máquina — trade ruim para pé-direito alto, que é exatamente o gargalo que o tiling existe
para tratar (`acuracia-modelos.md §1`). **512 fica como escape hatch** (`ANALYSIS_INPUT=512`)
para hub CPU-bound cujo conjunto de câmeras **não** tem pessoa distante (presença/ocupação
de perto): lá ele segura média/grande e **passa o gate**. **416 é rejeitado** — reprova o
gate (F1 e FP-em-vazias) e afunda a pequena (−17 a −21pp).

## Como ficou configurável

- **`server/analysis/worker.js`** — o alvo do resize (antes `const SIZE = 640`) virou
  `resolveInputSize()` lendo **`ANALYSIS_INPUT`**. Default **640** (input de treino);
  arredonda para o múltiplo de **32** mais próximo (stride do backbone) e limita a
  **[160, 1024]**. Valor ausente/inválido/≤0 → **640** (default preservado — comportamento
  inalterado sem a env). O `SIZE` já era usado em `rgbToTensor`, `preprocess`, `detectTiled`
  (cada **tile** usa o mesmo input) e no warmup do boot → uma variável cobre squash **e** tiled.
- **`ready` message** ganhou `input: SIZE` (aditivo) para diagnóstico/eval saberem qual input rodou.
- **Eval** — nenhuma mudança necessária: `gate.mjs`/`run-eval.mjs`/`compare-models.mjs` já
  dão `fork` com `{ ...process.env }`, então `ANALYSIS_INPUT` flui direto para o worker.
  Medição: `ANALYSIS_INPUT=512 node eval/gate.mjs`.

## Tabela — squash (modo default de produção), tier S, full-set

**Latência** (infer médio/frame): **640 = 385ms** · **512 = 295ms (−23,4%)** · **416 = 232ms (−39,7%)**.
> Nota honesta: o a priori era "−33% em 640→512"; nesta máquina medi **−23%** (a inferência
> CPU não escala com a área de pixels — há overhead fixo por inferência). Trade ainda menos
> favorável que o esperado.

**@0.25** (teto "enxerga pessoa?"):

| input | R all | R S | R M | R L | P all | FP-vazias (dets) |
|-------|-------|-----|-----|-----|-------|------------------|
| **640** | **88.2** | **75.9** | 93.6 | 98.2 | 46.0 | 49 |
| 512 | 84.8 | 69.2 | 92.6 | 96.3 | 45.8 | 56 |
| 416 | 79.9 | 58.5 | 89.2 | 97.5 | 47.5 | 50 |

**@0.35** (nascimento/operação — ponto da contagem de linha):

| input | R all | F1 all | P all | R S | R M | R L | FP-vazias@0.50 |
|-------|-------|--------|-------|-----|-----|-----|----------------|
| **640** | **84.8** | **73.7** | 65.2 | **69.2** | 91.2 | 98.2 | 7 |
| 512 | 80.0 | 71.8 | 65.1 | 61.2 | 88.2 | 95.7 | 9 |
| 416 | 74.6 | 70.9 | 67.5 | 48.2 | 85.8 | 96.9 | 9 |

**Recall de pessoa PEQUENA (o ponto sensível), delta vs 640:**
- @0.25: 75.9 → **69.2 (−6,7pp)** → 58.5 (−17,4pp)
- @0.35: 69.2 → **61.2 (−8,0pp)** → 48.2 (−21,0pp)

Média perde ~3pp a 512; grande quase não muda. **A perda concentra-se na pessoa pequena** —
o alvo que menos pode perder resolução.

## Gate de regressão (`eval/gate.mjs`, fixture 21+8, `thresholds.json` calibrado no S@640)

| input | f1@0.35 (≥77.1%) | recall@0.25 (≥87.6%) | precision@0.35 (≥69.4%) | fp_empties@0.50 (≤0) | veredito |
|-------|------------------|----------------------|-------------------------|----------------------|----------|
| **640** | 82.1% ✅ | 92.6% ✅ | 74.4% ✅ | 0 ✅ | **PASSA** |
| 512 | 80.4% ✅ | 93.7% ✅ | 72.3% ✅ | 0 ✅ | **PASSA** |
| 416 | 76.8% ❌ | 88.4% ✅ | 72.2% ✅ | 2 ❌ | **REPROVA** |

> **Honestidade (por que o gate não decide sozinho):** o fixture é pequeno (95 GT, distribuição
> mais "fácil") e **512 passa** nele — inclusive com recall@0.25 um pouco maior por ruído de
> amostra. Mas o **full-set** (591 GT, 224 pequenas) é o sinal fiel do nosso caso e mostra a
> perda de −7 a −8pp na pessoa pequena. **Gate-verde ≠ seguro** para o uso com pessoa distante.
> Por isso a decisão do default é do full-set, não do fixture. 416 já nem passa o fixture.

## Tabela — tiled (perfil longRange, 2×2 overlap 0.1), tier S, full-set

**Latência** (infer médio/frame): **640 = 1789ms** · **512 = 1593ms (−11,0%)**.
> Tiling economiza **muito menos** ao baixar o input (4× overhead fixo por rodada domina).

**@0.25 / @0.35:**

| input | @thr | R all | F1 | R S | R M | R L |
|-------|------|-------|-----|-----|-----|-----|
| **640** | 0.25 | 79.5 | — | **78.1** | 84.8 | 74.8 |
| 512 | 0.25 | 79.0 | — | 75.0 | 84.8 | 77.3 |
| **640** | 0.35 | 77.8 | 62.0 | **75.4** | 82.8 | 74.8 |
| 512 | 0.35 | 78.2 | 61.5 | 72.8 | 84.8 | 77.3 |

No tiled, 640→512 ainda custa pessoa pequena (**−3,1pp @0.25 / −2,6pp @0.35**) por só −11%
de CPU — trade **pior** que no squash. Confirma: **640 também é o certo por tile.**
(Observação lateral: o tiling melhora a pequena @0.25 vs squash — 78.1 vs 75.9 — mas **derruba
a grande** — L 74.8 vs 98.2 — porque a pessoa grande é partida entre tiles; é o tradeoff
conhecido do perfil longRange, ortogonal ao input.)

## Risco residual

- Medição em 1 máquina (8 cores) sem carga do hub — a **razão** de latência entre inputs é
  robusta; o absoluto varia com contenção.
- Pessoa **<25px** continua fora do alcance de qualquer input desta classe (limite de
  amostragem) — nem 640 resolve; é o teto tratado por capacidade/fine-tune, não por input size.
- `thresholds.json` **não** foi recalibrado (default segue 640, sem regressão). Se algum dia
  512 virar default, recalibrar o gate (`node eval/gate.mjs --calibrate`) e revisar o diff.
