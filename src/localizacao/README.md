# `src/localizacao/` — a costura (seam) de localização

Fronteira estável entre **quem calcula onde uma entidade está** e **quem mostra isso**.
Decisão do **ADR-012** (`docs/analises/decisoes/ADR-012-abordagem-cientifica-viabilidade.md`):
o motor científico futuro (factor graph) é uma trilha à parte. Para não acoplar a UI ao
motor de hoje, esta pasta define o contrato pelo qual a UI consome localização.

## A regra

> **A UI consome `LocatedEntity[]`. Quem calcula é intercambiável.**

- `entity.ts` — o **contrato**: `LocatedEntity` (id/label/position/accuracyM/seenAt/live/source),
  com campos reservados ao motor (covariance, revision, velocity) documentados mas ainda não usados.
- `adapters.ts` — funções **puras** que mapeiam as fontes de HOJE (`TagLocation[]` +
  `BtReading[]`, de `../api`) para `LocatedEntity[]`. Sem React, sem I/O — testáveis.
- `adapters.test.ts` — testes determinísticos do merge (posição + live), fallback de label e source.

## Roadmap

- **Hoje:** heurístico. `fromTagLocations()` reproduz o merge que a `TagsMapPage` faz (última
  posição do coletor + visibilidade ao vivo), com `source: "gps"`.
- **Futuro:** motor científico em `docs/cientifica/` produz `LocatedEntity[]` (com covariância,
  `source: "fusion"`) por outro caminho — **sem tocar a UI**.

## Estado atual (aditivo)

Este módulo estabelece a fronteira; os consumidores (ex.: `TagsMapPage`) **ainda não foram
religados** a ele. Rewire é trabalho futuro — a costura vem primeiro.
