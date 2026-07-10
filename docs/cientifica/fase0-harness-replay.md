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

### Próximas fases (gated, ADR-012)

1. **Gravação de dado REAL** (event-sourcing opt-in do `/api/bt/reading`, metadados-only/LGPD) → alimenta o
   mesmo harness com cenários reais.
2. **Motor de fusão v1** (RSSI×proximidade + modelo de movimento) como novo `LocalizationEngine`.
3. **Métricas de identidade** (IDF1, troca-de-ID) quando o cenário tiver múltiplas entidades/oclusão.
