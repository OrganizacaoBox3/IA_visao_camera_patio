# `src/localizacao/` — a costura (seam) + a trilha de PRODUTO AirTag (outdoor/GPS)

Fronteira estável entre **quem calcula onde uma entidade está** e **quem mostra isso**
(ADR-012, `docs/analises/decisoes/ADR-012-abordagem-cientifica-viabilidade.md`).

> ⚠️ **Rótulo honesto (2026-07-10):** os motores e o simulador desta pasta modelam o **produto
> AirTag/outdoor** — a posição vem do **GPS do coletor** (celular). Isso vale para pátio/veículo/área
> externa. **NÃO é o motor científico indoor** (pessoas com tag no bolso, sem GPS): esse é
> câmera=posição (homografia) + BLE=identidade (associação) e vive em **`src/fusion/`**, com harness
> próprio (`docs/cientifica/harness-associacao-indoor.md`). As duas trilhas produzem `LocatedEntity[]`
> pela mesma costura, mas resolvem problemas diferentes — não confundir.

## A regra

> **A UI consome `LocatedEntity[]`. Quem calcula é intercambiável.**

- `entity.ts` — o **contrato**: `LocatedEntity` (id/label/position/accuracyM/seenAt/live/source),
  com campos reservados ao motor (covariance, revision, velocity) documentados mas ainda não usados.
- `adapters.ts` — funções **puras** que mapeiam as fontes de HOJE (`TagLocation[]` +
  `BtReading[]`, de `../api`) para `LocatedEntity[]`. Sem React, sem I/O — testáveis.
  Consumidor real: `TagsMapPage` (religada — a prova viva da costura).

## Trilha AirTag (outdoor) — o que há aqui

- `evidence.ts` / `engine.ts` / `replay.ts` / `metrics.ts` / `simulate.ts` / `scenarios.ts` —
  harness de replay determinístico (motor puro plugável, RMSE/cobertura, benchmark 9 cenários).
- Motores: `engine.ts#baselineEngine` (carimba o GPS do coletor) → `fusion-engine.ts` (v1, centroide
  ponderado por RSSI, **o default medido**: ~14,9 m na suíte) → `motion-engine.ts` (v2, empata) →
  `guarded-engine.ts` (v3, 14,35 m; teto físico provado: 4/9 cenários têm ganho de extrapolação = 0).
- `recording.ts` — loader do event-sourcing real (`server/bt/recorder.js`, flag `BT_RECORD`)
  + `labeledRecording` (verdade estática) p/ RMSE de campo.

Histórico e números: `docs/cientifica/fase0-harness-replay.md`.
