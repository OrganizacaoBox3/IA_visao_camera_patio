# Spec — paralelismo da câmera FOCADA (mais cadência SEM perder recall)

> Problema (07-*, feedback do dono): mesmo com o fix #1, o marcador atrasa em MUDANÇA DE DIREÇÃO e na
> ENTRADA — os dois casos que previsão não resolve; só **mais updates/segundo** resolvem. A cadência da
> focada trava em ~1,4fps porque a inferência (~640ms) SERIALIZA (≤1 job em voo por câmera). Modelo leve
> (N) subiria pra ~3,9fps MAS perde recall — **inaceitável** ("zero perda"). Solução: a câmera focada usa
> VÁRIOS workers em PARALELO, mantendo o modelo S (recall intacto).

## Given/When/Then
- **G** câmera focada, pool com ≥2 workers livres. **W** o tick avalia o despacho. **T** a focada pode ter
  até `maxInflight` (>1) inferências em voo ao mesmo tempo → cadência efetiva sobe (≈ maxInflight × 1/lat).
- **G** 2 inferências da MESMA câmera voltam FORA de ordem (t2 antes de t1). **W** a emissão. **T** só a de
  captura MAIS NOVA alimenta o tracker; a mais velha é DESCARTADA (nunca faz o tempo do tracker voltar).
- **G** câmera normal/linha (não focada). **T** comportamento IDÊNTICO de hoje (`maxInflight=1`).
- **G** worker morre com 2 jobs da focada em voo. **T** os 2 slots são liberados (contador zera certo) —
  nunca-cego por-worker preservado.

## Fora de escopo
- Modelo leve (N) na focada (perde recall — rejeitado). Paralelismo em câmera NÃO-focada (só a olhada paga).
- Reordenar/bufferizar frames fora de ordem (DESCARTE do mais velho basta — o mais novo cobre o momento).

## Design — TODA a concorrência num módulo de responsabilidade única (`inflight.js`)

> Diretriz do dono ([[simplicidade-abstracao-responsabilidade-unica]]): não espalhar mutação de estado.
> A lógica de "quantos em voo + órfã + ordem" vive num ÚNICO arquivo, testado isolado; o motor só chama.

**`server/analysis/inflight.js`** — `createInflightSlots()` → API:
- `count()` = nº em voo (é o `Set.size` — o próprio Set é contador E validador de órfã).
- `canBegin(max)` = há folga? (`size < max`).
- `begin(jobId)` = ocupa um slot.
- `abort(jobId)` = libera SEM aplicar (worker morreu / send falhou / dropped / erro). Idempotente.
- `settle(jobId, captureTs)` = resposta de SUCESSO: libera o slot e devolve `true` só se for NOSSA e a
  MAIS NOVA (`captureTs > lastAppliedTs`); `false` = órfã ou fora de ordem (descarta, não regride o tracker).

**Fiação (o motor só chama a API — sem lógica de contador espalhada):**
- **engine.createState:** `st.slots = createInflightSlots()` (remove `busy`/`inflight`/`inflightTs`);
  `st.maxInflight = maxInflightFor(focus.has(id))` (focada = `clamp(ANALYSIS_FOCUS_INFLIGHT|poolSize-1)`; resto 1).
- **engine.applyRoundMs:** `st.maxInflight = maxInflightFor(focus.has(st.id))` (recalcula ao (des)focar).
- **engine.dispatchToWorker:** `const jobId=++seq; st.slots.begin(jobId)`; msg leva `id:jobId, ts:frame.ts`;
  catch → `st.slots.abort(jobId)`.
- **worker.js:** ECHOA `ts: job.ts` na resposta (tiled e squash).
- **worker-host.dispatchReady:** `st.latest && st.slots.canBegin(st.maxInflight)`.
- **worker-host.onWorkerMessage:** `dropped/erro → st.slots.abort(id)`; sucesso → `if (st.slots.settle(id,ts))
  onDets(st, dets, ts, Date.now()-ts)`.
- **worker-host.onWorkerExit / releaseJob:** `st.slots.abort(jobId)` p/ cada job liberado.
- **telemetry.js:** `st.slots.count()` no lugar de `st.busy`.
- **pipeline.js:** `now` = TS DE CAPTURA (ordena o tracker sob paralelismo); `latencyMs` vem por PARÂMETRO
  (`Date.now()-captureTs`, calculado no worker-host) — determinístico no teste (substitui `st.inflightTs`).

## Invariante que NÃO pode quebrar
- **Zero perda de recall:** MESMO modelo S, MESMA inferência por frame — paralelismo só muda QUANTAS por
  segundo, não a qualidade de cada uma. O descarte de ordem só larga um frame REDUNDANTE (mais novo cobre).
- **Tracker monotônico:** `now` (=captura) sempre crescente na entrada do tracker (a guarda garante).
- **Background não starva:** `maxInflight` da focada = `poolSize-1` (deixa ≥1 worker p/ as outras).

## Resultado (medido, 2026-07-08)

`inflight.js` (responsabilidade única: contador via Set + guarda de órfã + guarda de ordem) + fiação fina
no engine/worker-host/pipeline/telemetry/worker. Testes: `inflight.test.js` (limite, abort, órfã, ordem) +
ajustes em worker-host/telemetry/pipeline. **`verify` verde (566).**

Medição (`measure-focus`, S 1080p, cena com movimento, máquina de dev CONTIDA):
- **Câmera FOCADA: 1,1 → 2,1 fps** (caixa a cada 727→**471ms**). Controle NÃO-focada: 0,9fps (segue serial).
- **Recall intacto** (mesmo modelo S — paralelismo só muda QUANTAS/segundo). Zero perda, como exigido.
- Subiu ~1,5× sob contenção (2 câmeras + dev); servidor dedicado (mais workers livres) sobe mais. Ajuste
  fino por `ANALYSIS_FOCUS_INFLIGHT` (default `poolSize-1`).

Combinado com o fix #1 (compensação de latência) + maxExtrap: mais updates/seg + previsão pro agora =
o marcador acompanha melhor GIRO e ENTRADA (os dois resíduos do feedback).

## Verificação (o gate)
- `worker-host.pool.test.js` (estender): N em voo p/ focada; DESCARTE de resposta fora de ordem; contador
  zera no exit/prune; câmera não-focada segue serial.
- `pipeline.test.js`: latencyMs = Date.now()−now (ajustar o teste do fix #1).
- **Medição:** `scripts/measure-focus.cjs` — focada S 1080p deve subir de ~1,4 p/ ≈ maxInflight×1,4 fps,
  recall inalterado (mesmo modelo). `npm run verify` verde. Sem isso, não está pronto.
