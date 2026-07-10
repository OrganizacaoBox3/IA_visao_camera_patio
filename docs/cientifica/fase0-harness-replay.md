# Fase 0 — Harness de replay (de-risco do motor de localização)

> Trilha de pesquisa do [ADR-012](../analises/decisoes/ADR-012-abordagem-cientifica-viabilidade.md).
> **Fase 0 = o subconjunto barato/JS que se adota AGORA** (dev.md §3: o investimento de maior ROI é
> gravar dado bruto + um harness que re-executa qualquer versão do motor e cospe métricas comparáveis).
> Data: 2026-07-09.

## O quê (spec)

Provar, **em miniatura e no nosso stack JS/TS**, a arquitetura que o motor científico (factor graph, fases
futuras) vai precisar — **sem hardware novo, sem Python, sem dados reais ainda**:

1. **Contrato de evidência** — a entrada do motor (`evidence.ts`): um "relatório do coletor" = GPS do
   celular + tags vistas (RSSI), com timestamp de captura. É o schema dev.md §1 no nosso modelo AirTag.
2. **Motor puro** — `(batch, estadoAnterior) → { estado, LocatedEntity[] }` (`engine.ts`). Sem I/O, sem
   rede, determinístico. A saída é a **costura** (`LocatedEntity[]`) que já existe.
3. **Gerador sintético** — cenários com ground truth, sem hardware (`simulate.ts`): entidade(s) com
   trajetória conhecida + coletor móvel + observações ruidosas. Seed fixo → determinístico.
4. **Harness de replay** — roda um motor sobre uma gravação e devolve **métricas comparáveis**
   (`replay.ts` + `metrics.ts`): RMSE de posição, cobertura (% de instantes com estimativa).
5. **Motor-baseline v0** — o heurístico AirTag de hoje (estampa o GPS do coletor na tag vista; última
   posição persiste) rodando pelo harness, com um **teste-gate Vitest** que barra regressão.

### Critérios de aceite (Given/When/Then)

- **G** um cenário sintético (entidade + coletor + ruído + ground truth) · **W** rodo `replay(gravação,
  baseline)` · **T** recebo um relatório de métricas (RMSE, cobertura) **determinístico**.
- **G** o mesmo cenário/seed · **W** rodo duas vezes · **T** as métricas são **idênticas** (sem `Date.now`/
  `Math.random` — seed injetado).
- **G** o contrato de evidência · **W** um motor NOVO produzir `LocatedEntity[]` · **T** o **mesmo harness**
  o mede sem mudança (o motor é plugável — é a costura do ADR-012 estendida à entrada).
- **G** a suíte · **W** `npm run verify` · **T** o teste-gate do harness passa (regressão de motor barrada,
  como o `eval/` faz p/ detecção).

### Fora de escopo (Fase 0 — explicitamente adiado)

Factor graph/GTSAM · gravação de dado REAL de produção (event-sourcing do ingest ao vivo — Fase 0 é
sintético) · múltiplas entidades com IDF1/troca-de-ID · incerteza calibrada (NIS) · simulador de câmeras ·
smoothing. Tudo gated por dados/hardware (ADR-012).

## Como (plan — requisito→arquivo)

Tudo em `src/localizacao/` (o domínio da costura), puro/TS, testado por Vitest:

| Arquivo | Responsabilidade |
|---|---|
| `evidence.ts` | contrato: `CollectorReport { ts, collectorPos, seen[] }` + `EvidenceBatch` |
| `engine.ts` | `LocalizationEngine` (interface pura) + `baselineEngine` (heurístico v0) |
| `simulate.ts` | `simulateScenario(opts, seed) → { batches, truth }` (LCG determinístico) |
| `metrics.ts` | `positionRmseM`, `coverage` (estimativa × ground truth, distância em metros) |
| `replay.ts` | `replay(recording, engine) → Metrics` (roda o motor batch-a-batch, coleta) |
| `replay.test.ts` | gate: cenário fixo → baseline → assere métricas (determinismo + sanidade) |

## Resultado (2026-07-09) — ✅ Fase 0 fechada

Harness implementado e **no gate** (`src/localizacao/replay.test.ts`, roda em `npm run verify`).
Métricas do **motor-baseline v0** no cenário-gate (60 instantes, ruído GPS 5 m, alcance 30 m, seed 42):

| Métrica | Valor | Leitura |
|---|---|---|
| **RMSE de posição** | **24,4 m** | erro ≈ dist. coletor↔tag no alcance + ruído do GPS. É o número que o motor futuro precisa **baixar**. |
| **Cobertura** | **1,0** | o coletor patrulha todo o alcance → as duas tags sempre têm estimativa. |
| **Amostras** | 120 | 60 instantes × 2 tags. |

**O que ficou provado (o de-risco):**
- O motor é uma **função pura plugável** — o baseline e um motor "burro" passam pelo MESMO harness sem
  mudança; o harness os distingue (cobertura 1,0 × 0). Trocar o motor é trocar uma função.
- A costura vale **ponta a ponta**: contrato de ENTRADA (`evidence.ts`) + motor + contrato de SAÍDA
  (`entity.ts`, já consumido pela `TagsMapPage`). O factor graph futuro entra como outro
  `LocalizationEngine` e é medido pelo mesmo número.
- **Determinismo**: seed injetado, sem `Date.now`/`Math.random` → replay reproduzível (base para bisseção
  de regressão, dev.md §3).

**24,4 m é o alvo a superar.** Qualquer motor de fusão (RSSI×movimento, âncoras, homografia) que baixe esse
RMSE no mesmo cenário é, por definição, uma melhoria medida — não uma alegação.

## Fase 1 (2026-07-09) — ✅ gravação real + motor de fusão v1 (paralelizada)

Duas frentes independentes (propriedade de arquivo exclusiva, contrato da Fase 0 fixo), integradas num
`verify` único (654 testes verdes):

**Frente A — gravação de dado REAL** (event-sourcing opt-in, metadados-only/LGPD):
- `server/bt/recorder.js` — grava 1 linha JSONL por relatório do coletor, **só com `BT_RECORD` ligado**
  (OFF por default), whitelist `{ts,lat,lon,acc,tags[mac,rssi,rotulo]}`, **nunca** frame/imagem, fail-safe
  (jamais lança no ingest). Arquivo `server/bt/bt-recording.jsonl` (gitignored). Ligado no `/api/bt/reading`
  de forma aditiva, só para relatórios COM posição.
- `src/localizacao/recording.ts` — loader **puro** `parseRecording(lines)`/`toRecording(lines)`: JSONL →
  `EvidenceBatch[]`, pula linha suja sem lançar. Dado real **não tem ground truth** → `truth: []` (RMSE
  espera rótulo, fase posterior); o harness ainda replaya qualquer motor sobre os batches reais.

**Frente B — motor de fusão v1** (`src/localizacao/fusion-engine.ts`), novo `LocalizationEngine`:
- Física de 1 estação: RSSI forte ⇒ coletor perto da tag ⇒ GPS informativo. Estima a posição como
  **centroide das posições recentes do coletor ponderado por proximidade** (peso `1/(dEst²+1)`, `dEst=-rssi-40`),
  ring de 8 leituras/tag no `memo`. Puro/determinístico.
- **RMSE 12,29 m vs. 24,4 m do baseline — ~metade do erro**, medido no mesmo cenário/seed (o teste compara
  fusão < baseline diretamente). **Honestidade:** o ganho é sintético (RSSI limpo); em campo (RSSI ruidoso/
  não-monotônico) tende a ser menor — é v1, como previsto.

## Fase 2 (2026-07-09) — ✅ modelo de movimento + suíte de benchmark (paralelizada)

Duas frentes independentes (arquivos novos exclusivos, contrato fixo), integradas num `verify` único
(661 testes verdes):

**Frente 1 — motor de fusão v2 com modelo de movimento** (`src/localizacao/motion-engine.ts`):
- Diagnóstico: o centroide do v1 estima a tag no instante-médio-ponderado do ring (passado) → *lagga* tag em
  movimento. v2 estima a **velocidade da TAG** (diferença dos centroides ponderados de duas janelas do ring —
  cada centroide colapsa o vaivém do coletor) e **extrapola** a base até o instante atual, com EMA da
  velocidade + ganho conservador + lead limitado (travas contra explosão por ruído do GPS).
- **RMSE 11,28 m no cenário-gate** (v1 = 12,29 m). Honestidade: o subagente **rejeitou** um config que dava
  10,08 m no seed 42 mas perdia em 5/7 outros seeds (overfit); escolheu por varredura de 12 seeds.

**Frente 2 — suíte de cenários + benchmark** (`src/localizacao/scenarios.ts`, 9 presets variando ruído/
alcance/seed/horizonte): torna "o motor é melhor?" uma pergunta sobre a suíte, não um seed.

### Tabela de benchmark (RMSE m, cobertura 100% em todos)

| | baseline | fusão v1 | movimento v2 |
|---|---|---|---|
| **média da suíte (9)** | **26,0** | **14,9** | **14,8** |
| ganha em… | — | 8/9 | 5/9 (vs v1) |

**Achado honesto (a suíte pagou o pão):**
- A **fusão v1 é o ganho robusto**: ~43% melhor que o baseline na média; ganha em 8/9 (perde só em
  `alcance-curto` 20 m, onde o "último GPS" já basta).
- O **movimento v2 NÃO é vitória limpa sobre o v1**: **empata** no agregado (14,8 vs 14,9 — só −0,1 m) e
  **perde em 4/9** (alcance-longo, horizonte-longo…) por *overshoot* da extrapolação; ganha onde o lag de
  movimento/ruído domina. O ganho decisivo exige **ganho adaptativo por confiança da velocidade** — não
  forçamos um salto que a medição não sustenta.

## Fase 3 (2026-07-09) — ✅ torneio de extrapolação adaptativa (v3) + teto físico

Duas hipóteses de v3 exploradas **em paralelo** (torneio — a medição decide), ambas medidas na mesma suíte
de 9 cenários contra o v1:
- **A — confiança por consistência** (coerência direcional² × proximidade): média **14,65 m**.
- **B — confiança por resíduo** (controlador do ganho pelo resíduo de predição + gate de confiança da base):
  média **14,35 m**. **Vencedor** (`src/localizacao/guarded-engine.ts`). O A foi descartado (dívida evitada).

### Tabela final (RMSE m — média da suíte de 9)

| baseline | fusão v1 | movimento v2 | **guarded v3** |
|---|---|---|---|
| 26,0 | 14,9 | 14,8 (empata) | **14,35 (−3,7% vs v1)** |

O v3 vence o v1 em **5/9** (inclusive `alcance-curto`, onde nem o v1 batia o baseline) e perde **só nos 4
do teto**.

### O achado que importa — o TETO FÍSICO (o real deliverable da Fase 3)

Varredura de ganho fixo (0→1) **provou** que 4 cenários têm **ganho ótimo de extrapolação = 0**
(`alcance-longo`, `seed-123`, `horizonte-longo`, `ruido-alto-alcance-longo`). Extrapolação **não pode**
ajudar ali — não é falha de tuning, é o **limite físico de 1 estação + RSSI**. O caminho ALÉM disso é
**âncora/multi-estação** (mais sensores), **não mais esperteza de extrapolação**. Isso quantifica, com
número, a física que o ADR-012 vinha afirmando.

### Veredito honesto (o que NÃO fazemos)

O ganho do v3 é **modesto (~3,7%)**, **sintético** (RSSI limpo) e os limiares de confiança do guarded estão
**afinados à geometria da suíte** (não transferem cegos p/ campo). Por isso **o v1 (fusão) segue a referência/
default**; o v3 é **candidato de pesquisa**, adotável só quando **dado de campo** (recorder da Fase 1) o
validar. Nenhum desses motores está no caminho ao vivo ainda (a UI usa o heurístico de `adapters.ts`).

### Próximas fases (gated, ADR-012)

1. **Coleta rotulada de campo** (`BT_RECORD` + posição-verdade) → RMSE-vs-truth REAL: aí sim se decide se o
   v3 (ou qualquer refino) paga fora do sintético.
2. **Âncora/multi-estação** — o único caminho contra o teto físico (não mais extrapolação).
3. **Métricas de identidade** (IDF1, troca-de-ID) quando o cenário tiver múltiplas entidades/oclusão.
