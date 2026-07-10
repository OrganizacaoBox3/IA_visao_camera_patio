# Plano — Retrofit 2 · "Separar para conquistar"

> Síntese dos artefatos 00-05 (exploração de 6 agentes, jul/05). Objetivo: cada domínio/arquivo/
> camada dono SÓ da sua funcionalidade e **cada eixo de perf/precisão com UM arquivo dono e UM
> sensor** — a serviço do motor de reconhecimento de pessoas. Execução em 5 frentes PARALELAS por
> propriedade exclusiva de arquivo (ADR-001); validação combinada + retorno MEDIDO contra o
> baseline (01) ao final. Princípios/política de comentário/fronteira: `00-principios.md` decide.

## Metas mensuráveis (before → alvo)

| Métrica (sensor) | Before (01-baseline) | Alvo |
|---|---|---|
| % comentário no motor (`server/analysis`) | 23,6% | ≤ 15% (só porquê/invariante) |
| `engine.js` (linhas / concerns) | 951 / ≥8 | ≤ 550 / orquestração + 2 módulos novos testáveis |
| `CameraWorkspace.tsx` | 2.195 (437 de comentário, ~55% ruído) | ≤ 1.850 e comentário ≤ 200 linhas |
| `ReportPage.tsx` | 1.017 (6 modos sempre computados) | ≤ 550 + view-model por modo |
| Knobs de precisão de pessoa | 5 arquivos + inline sem dono (hub); 4 órfãos (front) | **1 painel no hub** + config.ts como dono no front |
| Sensor de contagem fim-a-fim (KPI) | NÃO existe | harness determinístico no eval |
| Bugs achados | eval default = N (≠ produção S); `zoneOf` first-match em Objetos | corrigidos + teste |
| LGPD | `recipients.json`/`notif-settings.json` versionáveis | gitignored |
| Gates | verify 386 · e2e 8/8 · mobile 6/6 · eval PASS | **iguais ou melhores** (zero regressão) |

## As 5 frentes (propriedade exclusiva; contratos antes)

**F1 — Motor: engine emagrece + PAINEL DE PRECISÃO** · `server/analysis/*.js` (exceto eval/)
Extrai `processDets`→`pipeline.js` e `status()`→`telemetry.js` (testáveis sem subir o engine);
cria `precision.js` = dono único dos knobs (SCORE_MIN/NMS_IOU/HIGH_SCORE/birthIou/TTL/counter/
LR_TILES) com sensor apontado em cada um; conserta o vazamento do automask (Welford mutado pelo
caller); varredura de comentário (~45% do engine é rótulo de onda/história). CONTRATO: API pública
do engine, IPC do worker (4 consumidores!) e envs estáveis; exports de `model.js` estáveis (F2 usa).

**F2 — Eval: dedup + bug do modelo + sensor de contagem** · `eval/**`
`eval/lib.mjs` unifica startWorker/iou/matchGreedy/sizeBucket (triplicados) e o catálogo (5 cópias);
**corrige run-eval default N→S (paridade com produção)**; cria o harness de CONTAGEM fim-a-fim
(replay determinístico → tracks → travessias esperadas — o sensor do KPI que falta). CONTRATO:
consome `server/analysis/model.js` e o IPC do worker como estão (F1 preserva).

**F3 — Server core: sockets com dono + alarme no lugar + LGPD** · `server/*.js` + `alarm/` + `whatsapp/` + `.gitignore`
`.gitignore` += `recipients.json`/`notif-settings.json` (PII — PRIMEIRO commit); handler-deus de
socket (index.js:188-313) → `server/sockets/` (camera/dashboard) com o pipeline de alarme como
unidade nomeada; `classify()` sai do canal WhatsApp p/ `alarm/` (dependência desinvertida); dedup
triplicado → 1 mapa na policy; webcam `analysis.onFrame` entra no tee; invariante analysisViewer
no ramo webcam do shed + teste; varredura de comentário (~130 linhas). CONTRATO: eventos socket e
`ctx` das rotas byte-a-byte; API do engine intocada.

**F4 — Front visão: rAF por estágios + tipos neutros + luma única** · `src/CameraWorkspace.tsx`, `src/camera/**`, `src/vision/**`, `src/processors/**`, `src/types/` (novo), `src/config.ts`, `src/zones.ts`
Tipos do contrato (`HubTrack/HubAnalysis/Track`) → `src/types/analysis.ts` (CameraWorkspace
RE-EXPORTA p/ compat — zero mudança nos importadores de fora, que migram depois); tabela
`ingestPolicy(kind, engine)` substitui 6 cópias do invariante ADR-009; kernel de luma 3× →
`vision/luma.ts`; **fix do `zoneOf` first-match em objetos.ts** (alinha ao desempate por maior
interseção; teste); knobs órfãos (birthIou/CONTAINMENT_THR/GRID_TILES/counter) → `config.ts` com
dono; liga a telemetria pronta-e-desligada (faceMs/objMs/schedulerStats no HUD); rAF: estágios
nomeados SEM mudar ordem/semântica (ADR-007); varredura de comentário (a maior: ~240 linhas saem).
CONTRATO: props e contratos socket intactos; assinaturas do draw estáveis.

**F5 — Front app: ReportPage view-models + dedups** · `src/routes/**`, `src/report/**`, `src/ui/**`, `src/api.ts`, `src/auth.tsx`, `src/components/**`
ReportPage → view-model hook por modo (computa SÓ o modo ativo; agregações inline → `report/calc`);
rótulos/cores de alarme 4× (com RGB hardcoded) → módulo único usando tokens; `report/mock.ts` deixa
de mentir no nome (vira barrel declarado de `calc/`); seam `nodeRelay` do CameraPage (efeito de
~260 linhas com contrato start/stop); TrackOverlay memoiza cssVar/measureText (por frame hoje);
dedups da regra-dos-3 (camcfg-ensure, STALE_MS, KpiCard); varredura de comentário (CameraTile/
DashboardPage/useDashboardSocket ~50%). CONTRATO: NÃO migra os imports de tipos do CameraWorkspace
nesta onda (F4 mantém re-export); e2e roles/textos intactos.

## Regras de execução
- NUNCA `git stash/checkout/reset`. Comportamento byte-a-byte SALVO os 2 fixes declarados (eval-N e zoneOf) — cada um com teste.
- Lógica pura extraída nasce com Vitest ao lado. Comentário segue a política de `00-principios.md` §B (teste: "sobreviveria à reescrita?").
- Validação combinada ao fim (lead): `npm run verify` + e2e + mobile + `npm run eval` + suíte motor + **re-medição do baseline** (script do 01) = o "after" oficial.

## Fora de escopo (deliberado)
Dedup hub↔front de bytetrack/counting/zones (política declarada — frente própria futura com testes
de paridade); pgstore JS×SQL (exige teste de paridade primeiro — anotado); OffscreenCanvas p/ luma
(exige rAF assíncrono); prop-drilling NotificacoesTab (tolerável).
