# Retrofit 2 — Resultado (after vs baseline)

> Medição "after" (mesma régua do `01-baseline-metricas.md`) no commit `0a753ed`, após as 5
> frentes executadas em paralelo (F1 motor, F2 eval, F3 server core, F4 front visão, F5 front app).
> Gates: verify **476/476** · motor **229/229** · **eval PASS** (zero regressão de precisão) ·
> **eval:counting 9/9** (sensor novo) · e2e **8/8** · mobile **6/6**.

## Metas do plano — before → after

| Métrica | Before | After | Meta | Status |
|---|---|---|---|---|
| `CameraWorkspace.tsx` | 2.195 L / 437 com (20,5%) | **1.822 L / 193 com (11%)** | ≤1.850 / ≤200 | ✅✅ |
| `engine.js` | 952 L / ≥8 concerns | **623 L** / orquestração + pipeline/telemetry/focus testáveis | ≤550 | ⚠ residual declarado (restante = createState, seam vetado §C) |
| `ReportPage.tsx` | 1.018 L (6 modos sempre) | **472 L** (só o modo ativo computa) | ≤550 | ✅ |
| % comentário motor | 23,6% | **21,2%** | ≤15% | ⚠ residual declarado (`precision.js` denso POR DESENHO — o painel É a doc knob→sensor; o que sobrou passa no teste §B) |
| Knobs de precisão | 5 arquivos + inline | **`precision.js` (19 knobs, 1 dono, sensor por knob)** + config.ts no front | 1 painel | ✅ |
| Sensor de contagem (KPI) | não existia | **`npm run eval:counting` — 9 cenários, sensibilidade provada** | existir | ✅ |
| Bug eval default | full-set media **N** (recall 49%) como se fosse produção | paridade com produção (**S**, 88%) | fix | ✅ |
| Bug zoneOf (Objetos) | first-match (zona errada em sobreposição) | `assignZone` única (maior interseção) + teste | fix | ✅ |
| LGPD `recipients.json` | versionável (PII) | gitignored (verificado) | fix | ✅ |
| Testes | 386 unit | **476 unit** (+90) | ≥ | ✅ |
| Marcadores de história (`Onda/Fase/BUGFIX-autópsia`) | ~150+ | **0** em server/ e nos mandatados do front | 0 | ✅ |

Observação de leitura: o total do repo cresceu 35,5k→37,4k linhas **porque nasceram módulos com
testes ao lado** (+90 testes; precision/pipeline/telemetry/luma/ingestPolicy/view-models/lib do
eval/sensor de contagem) — enquanto o comentário ABSOLUTO caiu (4.926→4.905) com ~500 linhas de
narrativa trocadas por comentário-contrato. É o formato desejado: menos história, mais fronteira
testada.

## Donos novos (o "separar para conquistar" entregue)

| Eixo/Concern | Dono novo | Sensor |
|---|---|---|
| Knobs de precisão do motor | `server/analysis/precision.js` | eval gate/full-set/counting + status() |
| Pipeline por detecção | `server/analysis/pipeline.js` (testado) | pipeline.test |
| Telemetria do motor | `server/analysis/telemetry.js` (shape congelado) | telemetry.test |
| Metodologia do eval | `eval/lib.mjs` (1 fonte; catálogo importado de model.js) | paridade provada |
| Contagem fim-a-fim | `eval/counting.mjs` | 9 cenários PASS |
| Protocolo socket do hub | `server/sockets/{camera,dashboard}.js` | smoke 15/15 |
| Pipeline de alarme | `server/alarm/pipeline.js` + `classify.js` (desinvertido) | pipeline.test 4 |
| Invariante ADR-009 no cliente | `src/camera/ingestPolicy.ts` | ingestPolicy.test |
| Luma/motion | `src/vision/luma.ts` | paridade byte-a-byte |
| Atribuição de zona | `zones.assignZone` (regra única) | teste de sobreposição |
| Tipos do contrato analysis-tracks | `src/types/analysis.ts` | typecheck (re-export compat) |
| View-models do Relatório | `routes/report/use*VM.ts` | só-ativo-computa por gate |
| Nó de captura | `routes/camera/nodeRelay.ts` | contrato start/stop/setProfile |

## Residuais declarados (honestos, com causa)
1. engine 623>550 e motor 21,2%>15% — ver justificativas acima; forçar violaria os próprios princípios (§B/§C).
2. Paridade hub↔front dos ports (bytetrack/counting/zones) segue política de duplicação consciente — frente futura com testes de paridade.
3. pgstore JS×SQL sem teste de paridade (anotado, fora do escopo F3).
4. Espelho de knobs do `eval/counting.mjs` ↔ `precision.js` é pinado (documentado nos dois lados).
5. Harness de contagem usa dets sintéticas — replay de vídeo real de campo segue sem sensor (próximo nível).
