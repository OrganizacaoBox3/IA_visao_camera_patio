# Perf Round 3 — Frente 3: hot-loops do hub Node (o que rouba CPU fora de ffmpeg/worker)

> **Missão:** perfilar o processo hub REAL sob bancada e responder: o que ao redor da inferência
> desperdiça CPU ou causa o serrote 0-100%? Com número medido; achado sem número = hipótese declarada.
> **Data:** 2026-07-06 · **Máquina:** i7-11390H (4C/8T), Windows 11 · **Código:** master d42c3a8 (só leitura — nada de produção foi alterado).

## TL;DR

1. **O hub NÃO é o serrote.** Processo hub inteiro (todas as threads): **5,4% de 1 core** com espectador
   (6,5 s CPU / 120 s), **5,1%** sem espectador — plano, sem oscilação (janelas de 5 s: 2-11% fora do boot).
2. **O serrote são os workers de inferência**: 2 workers a **80,4% de 1 core cada em média**, com a soma
   oscilando **p5=67% ↔ p95=313%, máx 525%** (desvio 94) — rajada de ~N×(tempo de inferência) toda vez
   que as câmeras vencem a cadência **em fase** (todas nascem com o mesmo `roundMs` e alinham no mesmo tick).
3. **go2rtc = 0,0% CONFIRMADO** (máx 0% em todas as amostras; só participa se alguém pede WebRTC/frame.jpeg).
4. Dentro do hub, os únicos achados acionáveis são **(g) `binExists`/`existsSync` síncrono 6×/s no event
   loop** (fix trivial, ~5-9% do CPU do hub) e **(h) `pgstore.flushNow` em fallback JSON que re-serializa o
   histórico INTEIRO a cada ≤2 s** — 566 ms/flush já com 50 k eventos, **síncrono no loop** (este vira
   travadinha/serrote do hub em produção sem Postgres, crescendo com as semanas).
5. Todo o resto medido é **ruído <2%**: demux/concat, pipeline por rodada, socket.io serialize, telemetry,
   GC, timers — lista do "não mexer" no §7.

---

## 1. Bancada (e desvios declarados)

| Item | Valor |
| --- | --- |
| Fonte RTSP | MediaMTX **próprio** porta **8557**, path `bench`, `clipe-jumpy.mp4` em loop (h264 1280×960@25fps). A bancada compartilhada da 8556 estava servindo `clipe.mp4` e **não é minha** — não mexi. |
| Hub de teste | Cópia isolada de `server/` em scratchpad (junction p/ `node_modules`), porta 4801, `ANALYSIS_ENABLED=1`, **S pinado** via `ANALYSIS_MODEL_PATH` (dfine_s_obj2coco), `ANALYSIS_WORKERS=2` (pinado; o default nesta máquina seria 4), go2rtc AUTO-ON (bin presente), sem Postgres (fallback JSON), 3 câmeras RTSP → mesma URL da bancada; `camcfg` com 1 tripwire (rtsp-1) + zonas de atividade (rtsp-1/2) p/ exercitar counter/ingest. |
| Espectador | **Cliente socket.io Node** (login real → `watch` das 3 câmeras → recebe `frame`+`analysis-tracks` + poll `GET /api/analysis/status` a cada 5 s). **Desvio declarado**: não usei Playwright+Vite — o caminho **hub-side** (rooms, serialize, ws, volatile) é idêntico, e Chromium+Vite adicionariam 1-2 cores de ruído na mesma máquina já saturada. O que isso NÃO cobre: tile WebRTC (mas nesse caso o hub só faz proxy de sinalização — o vídeo nem passa por ele). |
| Medições | `node --cpu-prof` no hub (2 runs de 150 s/120 s + 1 run de 75 s **sem** espectador); preload de bancada com `PerformanceObserver('gc')`, `monitorEventLoopDelay`, ELU e `process.cpuUsage()` por janela de 5 s; sampler PowerShell por **PID exato** (delta de `TotalProcessorTime` a cada ~0,5-1 s); micro-benchmarks isolados após os runs. |
| **Contaminação (limitação honesta)** | A máquina estava a **100% de load** durante os runs: bancadas de frentes-irmãs (outro hub de teste + MediaMTX na 8571) e 4 Vite dev servers de outros projetos. Consequências: (a) números **wall-clock inflados** (inferência S mediu 8-13,6 s/frame vs ~400 ms do baseline de produção — NÃO usar estes absolutos); (b) as âncoras absolutas aqui são **CPU por processo** (`cpuUsage`/`TotalProcessorTime`, exatas por PID mesmo sob contenção); (c) o **ranking intra-processo** do profile reproduziu entre os 2 runs (tabela §3), então a ordenação é confiável. |

## 2. CPU por processo (sampler PID-exato, run 2, 115 s)

| Processo | Média (% de 1 core) | Comportamento |
| --- | --- | --- |
| **worker** (×2, D-FINE S) | **80,4 cada** · soma: p5 **67** / p50 163 / p95 **313** / máx **525**, sd 94 | **SERROTE** — rajadas quando ≥2 câmeras despacham juntas |
| **ffmpeg ingest** (×3, 25fps→10fps 720w MJPEG) | **11,6 cada** (~35 somados) | contínuo, estável |
| **hub (Node)** | **5,4** (máx 35 só no boot) | plano |
| mediamtx próprio + publisher | 1,3 + 1,3 | ruído |
| espectador | 1,6 | ruído |
| **go2rtc** | **0,0 (máx 0)** | **confirmado ~0** — ocioso sem consumidor WebRTC |

Serrote da soma dos workers (1 s/char): `▂▂▅▃▃▅▆▃▇▄█▅▅█▅▄▃▅▂▅▄▃▄▄▅▃▃▂▃▆▃▄▄▂▃▄▄▂▆▂▃▂▄▃▂`

A/B espectador (âncora `process.cpuUsage`, hub inteiro): **com** = 5,4% de 1 core · **sem** = 5,1% →
o relé socket.io de ~24 fps agregado (759 KiB/s) a 1 dashboard custa **~0,3-1% de 1 core** no hub.

**Por que o serrote existe (número + mecanismo):** cada inferência é uma rajada que ocupa ~2 threads
(`intraOpNumThreads=2`) por ~400 ms (baseline de produção) e depois silêncio até a próxima rodada.
As câmeras nascem com o MESMO `roundMs` e o `tick` (50 ms) as despacha **na mesma janela** quando as
cadências alinham → picos de 2×N threads seguidos de vale. Duty-cycle teórico @1fps: 40% por câmera —
oscilação é estrutural, não bug. (Ver "fix de fase" no §6.)

## 3. Profile do hub (`--cpu-prof`) — TOP-10 por self-time

Base: "busy JS-visível" (wall-clock; sob contenção infla syscalls — usar como **ranking**, não absoluto;
CPU real do processo = 5-6% de 1 core). Reproduzido em 2 runs:

| # | Função (self) | run 2 | run 1 | O que é |
| --- | --- | --- | --- | --- |
| 1 | `writev` ← `ws sendFrame` | 25,6% | 22,2% | escrita do frame ao espectador (97% do writev) — syscall, CPU real pequena (A/B acima) |
| 2 | `(garbage collector)` | 5,7% | 4,3% | GC — ver (f) |
| 3 | `(program)` | 4,5% | 5,2% | nativo V8 fora de JS |
| 4 | `existsSync` ← **`binExists` go2rtc.js:69 (100%)** | 4,1% | 5,1% | **fs síncrono 6×/s no event loop** — ver (g) |
| 5 | `scryptSync` (login) | 3,8% | 3,4% | one-off por login (196 ms medidos/chamada, bloqueia o loop) |
| 6 | `nextTick` | 2,5% | 2,7% | internals engine.io/streams |
| 7 | `ws send` (framing) | 2,0% | 1,4% | idem #1 |
| 8 | `Buffer.concat` ← rtsp.js:259 (100%) | 1,6% | 3,7% | demux MJPEG — ver (a) |
| 9 | `indexOfBuffer` ← `drainFrames` (100%) | 1,5% | 1,2% | busca SOI/EOI — ver (a) |
| 10 | `drainFrames` (self) | 1,4% | 1,5% | idem |

Subárvores (inclui filhos): `drainFrames` total = **32,6%** (mas 3/4 disso é o emit socket.io/ws/writev
que roda SÍNCRONO dentro do callback de frame — é o relé, não o demux) · **`pullTick` = 8,2-9,1%**
(quase tudo o `existsSync` + fetch de boot) · `authenticate` 4,0% (scrypt) · `emitStatus` 1,5% ·
`decodeThumb` 1,0% · `processRound` 0,9% · `flushNow` 0,2-1,6% · `tick` 0,2% · `buildStatus` 0,05%.

Hub saudável no resto: heap 14-19,5 MB estável (sem leak), loopDelay p50 22 ms / p99 283 ms (contenção).

## 4. Veredito dos suspeitos (a)-(f)

| Suspeito | Veredito | Número |
| --- | --- | --- |
| **(a) demux/`Buffer.concat` do rtsp.js** | presente, **ruído** | concat+indexOf+drainFrames+alloc ≈ 5-6% do busy do hub ≈ **~0,3% de 1 core** absoluto. Micro: **880 µs/frame (53 MiB/s)**; protótipo com varredura incremental (concat 1× por frame): **331 µs/frame (142 MiB/s, 2,7×)** → ganho ~1,6% de core a 30 fps agregado. **Não mexer** (<2% do total) — só reavaliar com ≥10 câmeras/hub. |
| **(b) pipeline.js por rodada** (alocações/det, automask) | **refutado** | `processRound` subtree = **0,9-1,0% do busy** (445 ms/150 s); automask/zonas não aparecem individualmente. Mesmo ×10 de cadência fica <2%. Ruído. |
| **(c) socket.io serialize/emit** | **já correto; custo baixo** | Binário (sem base64 — `_deconstructPacket` confirma o caminho binary) + `volatile` (descarta em backlog). Custo medido do relé a 1 dashboard: **A/B 5,4%→5,1% de core** (~0,3-1%). Serialize JS (`encodeAsString`+`deconstructPacket`+broadcast) ≈ 3% do busy. O `writev` no topo é syscall/kernel, não user-CPU. **Atenção**: escala ~linear com espectadores×câmeras; dashboards LEGADOS (`dash-legacy`) recebem TODOS os frames — o `watch` por câmera já mitiga nos novos. |
| **(d) motion.js thumbnail via sharp** | **confirmado — e 10-20× mais caro que o assumido** | **8,28 ms de CPU/decode** (26 ms wall sob contenção) — o comentário "sub-ms" em `engine.js` está **errado**. Em produção: 3 cams × 1-2 fps ≈ **2,5-5% de 1 core**; 10 cams ≈ 8-17%. Roda no pool de threads do libvips (não bloqueia o loop). **Continua valendo MUITO**: 8 ms para economizar uma inferência de ~400 ms (se paga com 1 skip a cada ~50 decodes). Hipótese não medida: decodificar com `sharp(jpeg, { shrinkOnLoad })`/kernel `nearest` ou libjpeg scale 1/8 pode cortar isso — só vale investigar acima de ~8 câmeras. |
| **(e) telemetry/status por request** | **refutado** | `buildStatus` = **25 ms TOTAIS em 150 s** com polling de 5 s (0,05% do busy). Rota completa (auth+json) 575 ms ≈ 1,2% do busy. Ruído. |
| **(f) GC pressure** | **refutado** | 74 pausas / 2,43 s em 120 s (wall, contendida; run 3 mais limpo: 34 pausas / 0,57 s em 75 s, máx 117 ms). GC = 4-6% do busy do hub ≈ **<0,2% de 1 core** absoluto. Heap 14-19 MB estável, external ≤10 MB. Sem churn patológico. |

## 5. Achados NÃO pedidos (com número)

**(g) `go2rtc-source.pullTick` → `go2rtc.enabled()` → `fs.existsSync(bin)` 6×/s no event loop.**
O timer de pull roda na cadência mais rápida (167 ms) e CADA tick faz um stat síncrono de arquivo
(medido: **0,57 ms/chamada** nesta máquina) mesmo com todas as câmeras no relé (pull inerte).
= 100% do `existsSync` do profile (4-5% do busy do hub). **Fix trivial**: cachear `binExists` no
init (invalidar em `sync()`/`init()` — o binário não aparece/some em runtime). Ganho: ~5-9% do CPU
do hub (~0,3-0,5% de core) + menos jitter de loop. Custo do fix ≈ 3 linhas.

**(h) `pgstore.flushNow` (fallback JSON): re-serializa o histórico INTEIRO, síncrono, a cada ≤2 s de ingest.**
Medido (stringify+write+rename): **29 ms @1k · 78 ms @10k · 566 ms @50k eventos**. Com tripwires de fluxo
ativos, 30 dias de retenção acumulam dezenas/centenas de milhares de eventos (1 cruzamento/min × 3 câmeras
≈ 130k/mês) → **centenas de ms de CPU bloqueando o event loop a cada 2 s**, competindo com o relé — no hub
de produção SEM Postgres isso é um serrote/travadinha que só piora com o tempo. Na bancada apareceu pequeno
(arquivo novo) — a curva de crescimento é o achado. Opções (medir antes): ligar PG (caminho já existente,
moot); cap de `events` em memória; flush por kind alterado; append incremental (JSONL). Ganho estimado
(declarado, não medido): elimina picos de até ~30% de core e os bloqueios de loop correspondentes.

**(i) `scryptSync` 196 ms/login bloqueante** — one-off por login; em rajada de logins vira pausa série do
hub inteiro (é também um vetor de DoS barato). Fix barato se incomodar: `crypto.scrypt` async. Ruído p/ o serrote.

**(j) Alinhamento de fase do despacho (mecanismo do serrote).** Todas as câmeras nascem com o mesmo
`roundMs` e o mesmo `lastSentAt` de partida → vencem a cadência no MESMO tick de 50 ms → o pool recebe
N jobs de uma vez (rajada), depois vale. Medido na soma dos workers: p5 67% ↔ p95 313%. **Protótipo
sugerido (não medido)**: escalonar a fase inicial por câmera (`st.lastSentAt = now − i×roundMs/N` no
`createState`). Não muda a média de CPU; achata o pico de concorrência (estimativa: pico ≤ ~2 threads
contínuos em vez de 2×N em rajada) — endereça exatamente a QUEIXA (oscilação 0-100%), não o consumo.

**(k) Inventário de timers do hub (grep+profile)** — todos confirmados baratos: `tick` 20/s (105 ms
TOTAIS em 150 s), `pullTick` 6/s (caro só pelo item g), `statusTimer` 0,2/s/câmera (`emitStatus` 1,5%
busy), `sweepShed` 0,2/s (0,4%), `flushWindows` 0,33/s, `prune`/`logMinute` 1/min, `evaluateAutoscale`
1/janela. Nenhum outro timer frequente escondido.

## 6. Fix proposto → ganho (medido vs estimado)

| Fix | Ganho | Tipo |
| --- | --- | --- |
| (g) cachear `binExists` (go2rtc.js) | ~5-9% do CPU do hub (~0,3-0,5% core); −6 stats síncronos/s no loop | **medido** (0,57 ms/call × 6/s; 100% do existsSync do profile) |
| (h) pgstore: PG ligado OU flush incremental/cap | elimina picos de até ~0,5 s de bloqueio a cada 2 s com histórico grande | **medido o custo/curva** (29→566 ms de 1k→50k); ganho extrapolado |
| (j) fase escalonada por câmera no despacho | achata o serrote (pico 2×N threads → ~2 contínuo); média inalterada | **estimado** (mecanismo confirmado na série; fix não prototipado) |
| (d) thumbnail mais barato p/ o gate | 8,28→? ms/decode; só relevante ≥8 câmeras | hipótese (custo atual **medido**) |
| (a) demux incremental | 880→331 µs/frame (2,7×) = ~1,6% core @30 fps | **medido no protótipo** — engavetar até ≥10 câmeras |

## 7. O que NÃO vale mexer (anti-rearranjar-cadeiras, <2% do total)

- **Demux/`Buffer.concat`** (a): 0,3% de core na bancada. Protótipo 2,7× pronto na gaveta; só com ≥10 câmeras.
- **`processRound`/automask/zonas** (b): 0,9% do busy do hub.
- **Serialize do socket.io** (c): já binário+volatile; 1 espectador custa ~0,3-1% core.
- **Telemetry/status** (e): 25 ms totais em 150 s.
- **GC** (f): <0,2% de core, heap estável.
- **`analysisTee`** (aloca 2-3 objetos por emit): ~2% do busy wall — ruído.
- **`camera-status` a cada 5 s, `sweepShed`, `tick` de 50 ms**: todos <1,5% do busy.
- **go2rtc**: 0,0% — não há o que otimizar.

## 8. Limitações (honestidade técnica)

- Máquina compartilhada a 100% durante os runs (benches de outras frentes + 4 dev servers): absolutos
  wall-clock inflados; âncoras = CPU por processo (exata) e ranking intra-processo (reproduzido 2×).
- Inferência mediu 8-13,6 s/frame AQUI (laptop contendido, 2 workers×2 threads) — o baseline ~400 ms/frame
  do contexto é de outra classe de hardware; nada neste relatório re-deriva esse número.
- Gate de movimento nunca pulou na bancada (clipe-jumpy tem movimento contínuo) — o custo do decode (d)
  foi medido em micro-bench, não em regime de skip.
- Espectador socket.io-client em vez de Playwright (racional no §1) — caminho hub-side idêntico.
- pgstore em produção COM Postgres não exercita (h) — o achado vale para o fallback JSON.

## 9. Reprodução

Scratchpad da sessão: `tools/bench-preload.js` (GC/ELU/cpu por janela + auto-exit), `tools/spectator.js`,
`tools/cpu-sampler2.ps1` (PID-exato), `tools/profparse2.js` (self-time por delta próprio + atribuição por
chamador + subárvores), `tools/microbench.js`. Bancada: MediaMTX próprio na 8557 com `clipe-jumpy.mp4`;
hub isolado (cópia de `server/` + junction `node_modules`) na 4801 com `ANALYSIS_ENABLED=1`,
`ANALYSIS_MODEL_PATH=<models/dfine_s_obj2coco.onnx>`, `ANALYSIS_WORKERS=2`. Nenhum processo alheio foi
tocado; nenhum arquivo de produção foi alterado (única escrita em `analises/`: este arquivo).
