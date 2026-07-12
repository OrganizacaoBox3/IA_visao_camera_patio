# `src/localizacao/` — a costura (seam) entre localização e UI

Fronteira estável entre **quem calcula onde uma entidade está** e **quem mostra isso**
(ADR-012, `docs/analises/decisoes/ADR-012-abordagem-cientifica-viabilidade.md`).

## A regra

> **A UI consome `LocatedEntity[]`. Quem calcula é intercambiável.**

- `entity.ts` — o **contrato**: `LocatedEntity` (id/label/position/accuracyM/seenAt/live/source),
  com campos reservados ao motor (covariance, revision, velocity) documentados mas ainda não usados.
- `adapters.ts` — funções **puras** que mapeiam as fontes de HOJE (`TagLocation[]` +
  `BtReading[]`, de `../api`) para `LocatedEntity[]`. Sem React, sem I/O — testáveis.
  Consumidor real: `TagsMapPage` (a home `/` — a prova viva da costura).

## Onde foi parar o resto

A trilha de pesquisa AirTag/outdoor que vivia aqui (motores `engine`/`fusion-engine`/
`motion-engine`/`guarded-engine`, harness `replay`/`scenarios`/`simulate`/`metrics`/`recording`,
contrato `evidence`) **saiu do main na faxina de produto** (ADR-016, 2026-07-12): era código
test-only, sem consumidor de produção. Está íntegra na tag git **`research-fusion-arc-2026-07-12`**;
os números e lições vivem em `docs/cientifica/fase0-harness-replay.md` e no ADR-012.
Critério para voltar: virar feature com consumidor vivo.
