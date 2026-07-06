# Frente 2 — O serrote 0-100%: alinhamento de rodadas provado e corrigido com stagger (medido)

> Perf round 3 · 2026-07-06 · bancada local (i7-11390H, 4C/8T) · **nenhum código de produção
> alterado** — protótipo e instrumentação em scratchpad; MediaMTX preexistente (:8556) intocado.
> Dados brutos: `frente2-dados/` · gráfico: `frente2-cpu-pool.svg`.

## TL;DR

O serrote **não é custo — é fase**. As câmeras **não têm offset**: a regra de despacho
(`now - lastSentAt ≥ roundMs`, avaliada num tick global de 50ms) faz as 3 câmeras dispararem
**no mesmo tick**, e o alinhamento é um **estado absorvente** (uma vez juntas, nunca mais
separam). 3 jobs simultâneos → 2 workers×2 threads saturam ~4 threads por ~1 pulso de
inferência, o 3º job espera a fila, e depois o pool fica **vazio** até a próxima rodada —
0↔100 a cada segundo. Um **stagger determinístico por câmera** (slots absolutos, fases por
razão áurea) com a **MESMA carga** (3 câmeras @1fps real, medido) entregou:

- fila fora da inferência **p95 259ms → 2ms** (eliminada);
- piso do pool **p5 12% → 126%** (o "0" do serrote sumiu) e picos ≥300% **22% → 8% dos bins**;
- desvio-padrão da CPU do pool **112 → 57** (forma lisa — ver gráfico);
- cauda da inferência **p95 327ms → 280ms** (−14% — a parte do 385→521ms que é alinhamento).

**hash(id) % roundMs NÃO basta**: colidiu na bancada (36ms entre 2 câmeras) e **manteve** o
serrote (dp 140, 25% dos bins <25%). O espalhamento precisa ser livre de colisão (razão áurea
por índice, medido) — não hash puro.

## 1. Mecanismo (leitura de código, produção)

| Onde | O quê |
|---|---|
| `engine.js:59-62` | `TICK_MS=50ms` (defaults 1/2/6 fps) — um único `setInterval` varre TODAS as câmeras |
| `worker-host.js:91` | Elegibilidade **relativa**: `now - st.lastSentAt < roundMs → não despacha`. Sem offset por câmera |
| `engine.js:205` | `lastSentAt: 0` no nascimento → a câmera dispara **no primeiro tick** após o 1º frame |
| `engine.js:332` | `st.lastSentAt = now` — o "now" é o MESMO para todas as câmeras processadas naquele tick |

Consequência: câmeras que ficam elegíveis no mesmo tick recebem `lastSentAt` idêntico e
reentram em fase para sempre. Qualquer tick atrasado (event loop ocupado por decode do
gate/IPC/GC) torna ≥2 câmeras elegíveis juntas → **colapso de fase é absorvente**; não existe
nenhum mecanismo que as separe de volta.

**Simulação determinística da regra** (mesma elegibilidade, tick 50ms, 3 câmeras nascendo
perfeitamente espalhadas 0/333/666ms, 5% dos ticks com atraso 20-140ms, 10min simulados):
**20/20 repetições terminaram colapsadas** — na maioria as 3 câmeras com fase final IDÊNTICA.
(Script `sim-phase.js` na bancada; resultado independe de carga da máquina.)

Na bancada real o colapso nem precisou de tempo: nos dois baselines as câmeras já **nasceram
em fase** (fases modais 250/250/100ms e 200/200/300ms; gap ao vizinho mais próximo p50 =
**4ms** e **2ms**) — porque todas nascem com `lastSentAt=0` e materializam na mesma janela.

## 2. Bancada (setup + honestidade)

- **Fonte:** MediaMTX preexistente `:8556/bench` (intocado) + instância própria `:8571/bench-jumpy`
  (clipe-jumpy.mp4 em loop). 3 câmeras: `camA` (bench), `camB` (jumpy), `camC` (bench, pull duplicado).
- **Ingest idêntico à produção** (`server/rtsp.js`): ffmpeg `fps=10, scale=720:-2, -q:v 4, mjpeg`.
- **Motor:** cópia byte-a-byte de `server/analysis/` em scratchpad + **único seam** `BENCH_STAGGER`
  no `tick()`; stubs p/ camcfg/pgstore/go2rtc (nada de produção tocado/escrito). `ANALYSIS_WORKERS=2`,
  intra-threads=2 (default), gate de movimento ON (default), ANALYSIS_ENABLED=1. Sem espectador (24/7).
- **Instrumentação:** `child_process.fork` patcheado ANTES do require do engine → timestamps de
  **cada dispatch e resposta** por job (prova de alinhamento + fila); sampler EXTERNO em PowerShell
  (~100ms, `TotalProcessorTime` por worker — contabilidade do kernel, independe do event loop);
  `os.cpus()` @500ms como **sensor de contaminação** da máquina inteira.
- **Máquina compartilhada (declarado):** ambiente com 600-800% (de 800 = 8 threads lógicas)
  ocupados por processos alheios durante os runs. Dois ajustes declarados para restaurar o regime
  da queixa (servidor dedicado, duty<1):
  1. **Tier N** em vez de S — com S a bancada saturava (aux abaixo) e o serrote nem existe;
     a mecânica de alinhamento é idêntica, só muda a largura do pulso (N≈240ms vs S≈400ms);
  2. **Prioridade AboveNormal só nos processos da bancada** (hub+workers), idêntica nos dois
     cenários (A/B justo). Com isso a inferência N mediu p50 237-243ms ≈ isolada (242ms, spike).
- **Blindagem contra drift:** runs **intercalados** A/B/C/A'/B' (130s cada). Os dois baselines
  reproduzem o serrote e os dois staggers a linha lisa → o contraste não é deriva de ambiente.
- **Validade:** a bancada NÃO é o hub completo (sem socket.io/relé/dashboards) — mede o MOTOR.
  O processo-hub da bancada (tick+gate+parse+IPC) consumiu **~5% de um core** (p95 ~25%) — o
  entorno da inferência no hub não é consumidor relevante de CPU.

## 3. Resultados (janela de 122s por run, mesma carga real ~1,0fps/câmera nos 5 runs)

CPU do pool = soma dos 2 workers, bins de 100ms (sampler externo). "low"=% de bins <25%
(vales do serrote), "high"=% de bins ≥300% (rajadas), saw=média de |Δ| entre bins vizinhos.

| run | dispatches | CPU média | dp | p5 | p95 | low | high | infer p50/p95 | fila p50/p95 (max) | gap vizinho p50 | fases modais (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **baseline** | 356 | 192% | **112** | **12%** | 373% | **7,1%** | **22,3%** | 243/327ms | 1/**259ms** (504) | **4ms** | 250·250·100 |
| **baseline²** | 353 | 182% | **115** | **5%** | 385% | **9,0%** | **20,2%** | 222/— | 1/2ms | **2ms** | 200·200·300 |
| **stagger áurea** | 363 | 218% | **57** | **126%** | 312% | **0,1%** | **8,0%** | 237/280ms | 1/2ms (69) | **388ms** | 0·650·250 |
| **stagger áurea²** | 367 | 159% | **62** | 52% | 259% | **1,7%** | **1,4%** | 175/— | 1/2ms | **337ms** | 0·650·250 |
| **stagger hash** | 368 | 176% | **140** | **0%** | 382% | **24,8%** | **27,4%** | 210/251ms | 1/2ms (77) | 176ms | **950·900**·200 |

Auxiliar — **S saturado** (run com tier S sob máquina 800/800, sem boost): inferência p50
2112ms/p95 6122ms, fila p50 **831ms**/p95 **6038ms**, câmeras a 0,22fps. Sob saturação o serrote
**desaparece** (vira platô com fila explodindo) — ou seja, o próprio 0-100 relatado em produção
é evidência de que **capacidade existe** (duty<1); o problema é a carga concentrada em rajada.

Leitura dos 5 runs (gráfico `frente2-cpu-pool.svg`):

1. **Alinhamento provado por timestamp:** no baseline, metade dos dispatches tem outra câmera a
   ≤4ms (p50); 114 rodadas/122s com as 3 câmeras no mesmo segundo. As fases modais mostram 2
   câmeras SEMPRE grudadas (nascem juntas — `lastSentAt=0`).
2. **Serrote:** baseline oscila 0↔400%+ (p5 12%/5%, min 0; p95 373/385%) com dp ~113. O mesmo
   trabalho em stagger áurea vira uma banda 126-312% (dp 57-62) — vales e rajadas somem
   (low 7-9% → 0,1-1,7%; high 20-22% → 1,4-8%).
3. **Fila:** o 3º job da rajada espera ~1 inferência inteira (p95 259ms, max 504ms no baseline
   com 22 rodadas ≤100ms). Stagger: p95 2ms nos DOIS runs. Detalhe fino: baseline² travou só
   2 de 3 câmeras (0 rodadas "apertadas") e a fila já não aparece — **o serrote de CPU precisa
   de ≥2 câmeras alinhadas; a fila só dói com as 3** — mas com N câmeras reais no CD qualquer
   subconjunto ≥3 alinhado paga fila de novo.
4. **Contention na inferência:** p95 327→280ms (−14%) e dp 44→28 no par baseline→stagger
   contemporâneo. É a fatia do "385ms isolada vs 521ms sob carga" que vem do alinhamento
   (4 threads brigando pelos mesmos 4 cores físicos + SMT); o resto é carga total.
5. **hash % roundMs reprova (medido):** `hash("camA-bench")%1000=949` e `hash("camB-jumpy")%1000=913`
   → 36ms de distância; serrote continua (dp 140, pior que baseline). Colisão não é azar raro:
   com 3 câmeras num round de 1000ms com "resolução efetiva" de ~4 slots de pulso (~250ms), a
   chance de 2 caírem no mesmo slot é ~60% (paradoxo do aniversário) — **espalhar por hash puro
   não dá garantia nenhuma**.

## 4. O protótipo que funcionou (e o contrato do fix de produção)

Seam medido (cópia do engine, `BENCH_STAGGER=even`) — **slot absoluto + fase áurea**:

```js
// fase determinística por câmera (índice de registro × razão áurea — livre de colisão p/ qualquer N)
function staggerPhase(id, roundMs) {
  if (!order.has(id)) order.set(id, order.size);
  return Math.round(order.get(id) * 0.6180339887 * roundMs) % roundMs;
}
// elegibilidade por SLOT ABSOLUTO (substitui now - lastSentAt >= roundMs):
// dispara na 1ª avaliação de um slot ainda não usado do grid próprio da câmera
const ph = staggerPhase(st.id, r);
return Math.floor((now - ph) / r) > Math.floor((st.lastSentAt - ph) / r);
```

Por que **slot absoluto** e não só "offset inicial": a cadência relativa re-colapsa (é o estado
absorvente — simulação §1). O grid absoluto é **auto-corretivo**: um dispatch atrasado não
desloca a fase da câmera; a cadência média continua exata (fps real medido = 1,0 nos dois runs).

Para produção (fora do escopo desta frente — NÃO implementado):

- O ponto único é `dispatchReady` (`worker-host.js`) + `lastSentAt` — ~10 linhas, coberto por
  `worker-host.test.js` (a assinatura ganharia um `phaseMs`).
- Fase por **índice de registro × áurea** (ou rank do hash entre câmeras ativas — qualquer
  esquema SEM colisão). **Não** usar `hash % roundMs` puro (§3.5).
- Interações verificadas na bancada: gate de movimento (o skip continua contando rodada — o
  seam preserva `lastSentAt=now` do gate) e foco/linha (fase é função de `st.roundMs` corrente;
  recalcula sozinha quando a cadência muda).
- Risco residual: câmeras com `roundMs` DIFERENTES (foco 6fps × normal 1fps) coincidem em
  harmônicos — a áurea minimiza mas não zera; irrelevante p/ CPU (o pool absorve 1 coincidência)
  e o autoscale segue vendo o mesmo cpuPct médio.

## 5. Ganhos (medidos na bancada; projeção p/ produção declarada)

| Efeito | Baseline → Stagger áurea | Status |
|---|---|---|
| Fila fora da inferência (p95) | **259ms → 2ms** por rodada da 3ª câmera alinhada | **MEDIDO** (2 réplicas) |
| Vales <25% do pool (o "0" do serrote) | **7-9% → 0,1-1,7% dos bins** | **MEDIDO** |
| Rajadas ≥300% (o "100") | **20-22% → 1,4-8% dos bins** | **MEDIDO** |
| Desvio-padrão da CPU do pool | **112-115 → 57-62** (forma lisa, mesmo trabalho) | **MEDIDO** |
| Cauda da inferência p95 (contention de rajada) | **327 → 280ms (−14%)** | **MEDIDO** (par contemporâneo; N-tier) |
| Latência média detecção→resposta por câmera | menor e ESTÁVEL (fila zerada; sem picos de 0,5s) | MEDIDO via fila |
| Em produção (S, 400ms/pulso, servidor dedicado) | mesmo mecanismo com pulso 1,6× maior → vales/rajadas idem; fila da 3ª câmera ~400ms → ~0 | **PROJEÇÃO** (aritmética do pulso; NÃO medida com S em máquina dedicada) |
| Throughput do pool | **inalterado** (356↔367 dispatches; fps real 1,0 nos 2 cenários) — stagger não cria capacidade, só desamontoa | MEDIDO |

O que o stagger **não** resolve (medido no aux S-saturado): pool subdimensionado. Se
Σ(inferência×fps) > workers×1, a fila cresce com ou sem stagger — a resposta certa continua
sendo tier/workers/hardware (`analises/hardware-ideal.md`).

## 6. Reprodutibilidade

Bancada em scratchpad da sessão (`frente2/`): `hub/` (cópia do engine + seam), `bench/run-bench.js`
(harness+instrumentação), `bench/sim-phase.js` (simulação), `bench/analyze.js` (métricas),
`bench/make-chart.js` (gráfico). Runs: `F2_BOOST=1 ANALYSIS_WORKERS=2 ANALYSIS_MODEL_PATH=<N>
BENCH_STAGGER=(|even|hash) node bench/run-bench.js`. Dados desta rodada: `frente2-dados/<run>/`
(summary.json + série de CPU do pool em bins de 100ms).
