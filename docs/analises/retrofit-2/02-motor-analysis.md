# Retrofit-2 · Frente 02 — Motor de análise (`server/analysis/**` + `eval/**`)

> Leitura arquivo-a-arquivo do domínio-núcleo (reconhecimento de pessoas D-FINE no hub),
> aplicando a rubrica de `00-principios.md`. Medido em 2026-07-05 sobre o working tree
> (branch `master`, limpo). Todos os números de linha citados são do estado atual.
>
> **Fato que corrige o briefing:** `engine.js` NÃO tem mais 582 linhas — tem **951**
> (660 código + 243 comentário, `01-baseline-metricas.md §2`). As ondas pós-R5
> (Onda-Motion, Flow-Focus, Onda 5/autoscale, F3/F4) recresceram o orquestrador.

---

## 1. COMENTÁRIOS — inventário de ruído (piores 10)

Densidade do domínio: 23,6% (maior do projeto — baseline §1). A maior parte é
comentário-porquê legítimo (identidade da casa), mas há três famílias de ruído:
(a) **rótulos de onda/plano** ("F1/F2/F3/F4", "Onda-Motion", "Onda 5", "R5/retrofit",
"Fase 3/4", "Flow-Focus", "spike §N") colados em quase toda decisão; (b) **autópsia de
bug/changelog** ("antes era…", "bug real de produção", "leak do pulls"); (c) **duplicação
do README** (`server/analysis/README.md` já documenta arquitetura/contratos/modelo — os
cabeçalhos repetem).

| Arquivo | Linhas | Coment. | Removível (est.) | Ruído concreto (file:line) |
|---|---:|---:|---:|---|
| `engine.js` | 951 | 243 | **~45%** (~110 l) | Cabeçalho de 64 l (1–64) duplica README §Arquitetura/§Contratos quase inteiro; **42 linhas** com marcador de onda/plano/história (grep `Onda\|R5\|Fase\|F[1-4]\|spike\|plano-`); 98–102 narrativa da Fase 4 (ficar: regra + ponteiro p/ `acuracia-modelos.md §3`); 469–478 história do campo `vx`/`score` no emit ("antes era descartado"); 147–155 narrativa da Onda 5 |
| `automask.js` | 125 | 39 | **~40%** | 23–28 é changelog explícito ("ENV SPRAWL (R5/A)… antes ANALYSIS_AUTOMASK_COLS/ROWS…") — o exemplo canônico do `00-principios §B.Sai.1`; 2–7 "Extraído de engine.js (R5/retrofit)" é história de extração |
| `go2rtc-source.js` | 177 | 59 | **~35%** | 3–8 história da extração R5; 22–24 autópsia do leak ("R5: stream que SEMPRE falha nunca criava state…") repetida em 37, 141, 153–156 — ficar UMA vez como invariante ("entrada órfã é podada por idade"), sem o rótulo R5 |
| `autoscale.js` | 223 | 88 (39%) | **~35%** | 21–25 "SOBRE O MINI-BENCHMARK (por que NÃO fazemos)" é decisão arquitetural → ADR curto, não header; 54–57 e 148–156 contam o bug de homologação (4 cores/3 câmeras, tier M) duas vezes — ficar a REGRA (latency-bound: fps≪alvo com CPU/worker ≥ piso) + ponteiro |
| `motion.js` | 136 | 67 (49%) | **~30%** | Header 1–35 é bom (medição-âncora, nunca-cego, máscara) mas verboso; rótulos "Onda-Motion" saem; a matemática (compartilhada com `atividade.ts`) e o contrato nunca-cego FICAM |
| `worker.js` | 361 | 85 | **~30%** | 11–33 duplica o diagrama do README; 59–65 bloco de 7 l p/ a constante SIZE (destilar p/ 2 l + ponteiro `perf-input-size-dfine.md`); **37–48 (protocolo IPC) é O contrato — intocável** |
| `model.js` | 188 | 34 | **~30%** | 4–8 história da extração R5; 10–16 repete o racional N/S/M do README §Modelo (ficar só o ponteiro) |
| `worker-host.js` | 310 | 90 | **~25%** | Header 1–26 (por que pool, stateless por frame, nunca-cego) é majoritariamente contrato — fica; refs redundantes ao spike (§6/§7 citados 3×) e "O worker.js NÃO muda — só passa a ter N instâncias" (história da migração) saem |
| `counting.js` | 360 | 106 | ~15% | Header 1–30 é contrato de unidades/direção — padrão-ouro, fica; sai só o rótulo "F1 do plano" e paráfrases pontuais |
| `zones.js` / `bytetrack.js` | 196/197 | 63/66 | ~10–15% | Headers de PORT ("mudanças LÁ e re-portadas") são dependência de contrato entre frentes — FICAM; limitação declarada (sem re-ID) fica |

`eval/*.mjs` (headers com "ONDA 1 §1.1" etc.): ~15–20% removível — as referências de
plano viram ponteiro de evidência único; o "como mede" fica (é o contrato do harness).

**Regra de poda (deste domínio):** o cabeçalho de cada módulo vira *contrato do módulo*
(o que entra/sai + invariante + 1 ponteiro de evidência); arquitetura mora SÓ no
`README.md` do diretório; história mora no git/`implementacao-changelog.md`.
Sensor do after: grep `Onda|R5|Fase|antes (era|valia)|jul/20` = **0** em `server/analysis/`.

---

## 2. RESPONSABILIDADE — onde o "1 domínio por arquivo" quebra

### 2.1 `engine.js` (951 l) — declarado "orquestração", mas tem ≥8 responsabilidades

Teste do "e" com faixas de linha:

1. **Resolução de knobs/config** (96–155): escada de cadência FPS/LINE/FOCUS, HIGH_SCORE,
   TTL derivado do probe, LR_TILES, pins do autoscale — parâmetros de PRECISÃO misturados
   com wiring (ver §3.1).
2. **Registro de foco por socket** (171–179, 250–298, 760–771): domínio "qual dashboard
   olha o quê" — já tem teste próprio (`focus.test.js`) mas não tem módulo próprio; o teste
   importa o engine inteiro (singleton) para testar 2 funções puras.
3. **Fábrica de estado por câmera** (`createState`, 300–349): 20+ campos de 6 features
   diferentes (tracker, counter, gate, automask, foco, fonte).
4. **Pipeline por rodada** (`processDets`, 356–450): exclusão → observação do automask →
   logs rolantes → tracker → counter → ingest flow → atribuição de zona → janela ativ →
   emit. Isto é a LÓGICA DE DOMÍNIO do motor — não orquestração — e hoje só é testável
   subindo o engine inteiro (não há `processDets` em teste nenhum).
5. **Persistência inline**: `pgstore.ingest` chamado dentro do pipeline (411–421, 505–507)
   e `shiftOf` (181) — regra de TURNO do domínio relatório, **duplicada** de
   `src/report/calc/common.ts:8` (dois donos para "Manhã/Tarde/Noite").
6. **Aquisição/gating**: `decodeThumb` (535–547, dependência sharp no orquestrador) +
   `gateAndDispatch` (575–618) — metade do gate de movimento mora aqui, metade em `motion.js`.
7. **Telemetria**: `status()` (773–863, ~90 l) + `logMinute` (632–647) — montagem de
   payload lendo internals de motion/automask/autoscale/foco/go2rtc.
8. **Válvula do autoscale** (`evaluateAutoscale`, 655–701) + boot/timers/API (866–951).

### 2.2 Vazamentos de abstração (específicos)

- **Automask vaza Welford para o caller**: `engine.js:377–391` incrementa `am.rounds`,
  faz `am.cells.get(cell).present += 1` e mantém o `roundCells` — metade do algoritmo
  roda no engine, metade em `automask.js`. E `evaluateAutoMask(st, now)`
  (`automask.js:73`) recebe o **estado inteiro da câmera** do engine (usa `st.autoMask`
  e `st.id` para logar) — módulo "puro" acoplado ao shape do engine.
- **`status()` re-formata internals do automask** (`engine.js:810–829`): conversão
  célula→rect normalizado é apresentação do automask, deveria ser `automask.statusOf(am)`.
- **Defaults do tracker divididos em dois donos**: `iouThreshold: 0.25` é passado pelo
  engine (`engine.js:311`), mas `birthIouThreshold: 0.55` fica no default interno do
  `bytetrack.js:66` — quem tuna o tracker precisa saber que os knobs moram em 2 arquivos.

### 2.3 Duplicações entre camadas (mapa)

| O quê | Cópia 1 | Cópia 2(+) | Risco |
|---|---|---|---|
| Knobs do counter/tracker | `engine.js:311–318` (0.35/800ms/2/0.01) | `src/config.ts:70–80` (`APP_CONFIG.people.track`) | número calibrado em um lado e esquecido no outro; NENHUM teste de paridade de VALORES (só de comportamento) |
| Catálogo de modelo (arquivo/tier) | `model.js:24–51` (canônico, com sha) | `gate.mjs:32–40` (`MODEL_FILES`), `compare-models.mjs:41–45` (`CATALOG`), `run-eval.mjs:40`, `worker.js:55–56` | **BUG latente: `run-eval.mjs:40` e `worker.js:56` defaultam `dfine_n_coco.onnx` (N) enquanto o default de produção é S** — o full-set roda o modelo ERRADO se ninguém setar `ANALYSIS_MODEL_PATH`; `gate.mjs` já resolve certo (default s) |
| Cliente-worker do eval (`startWorker`) | `run-eval.mjs:65–96` | `gate.mjs:66–96`, `compare-models.mjs:63–…` | mudança no protocolo IPC exige 3 edições idênticas |
| Matching de métrica (`iou`+`matchGreedy`) | `run-eval.mjs:99–127` | `gate.mjs:99–127`, `compare-models.mjs:96–127` | um fix de matching num script descalibra o gate vs full-set silenciosamente |
| `sizeBucket`/limiares S-M-L | `fetch-dataset.mjs:42–44` | `run-eval.mjs:50–52`, `compare-models.mjs:37–39` | idem |
| IoU de bbox | `bytetrack.js:39` (`iouOf`) | `worker.js:124` (`iouXYWH`) + 3× no eval | duplicação DELIBERADA front↔hub (P7) — mas dentro do próprio hub+eval já são 5 cópias |
| Regra de turno (`shiftOf`) | `engine.js:181` | `src/report/calc/common.ts:8` | mudou o turno da fábrica → contagem "flow" diverge do relatório |
| Ports front↔hub (bytetrack/counting/zones) | `server/analysis/*.js` | `src/vision/*.ts` + `CameraWorkspace.zoneAtAtiv` | **duplicação consciente e protegida** (testes de paridade) — NÃO mexer nesta onda (P7 + frente paralela editando `src/vision/*`) |

### 2.4 O que está BEM separado (não tocar por tocar)

`motion.js`, `autoscale.js`, `automask.js` (modulo o vazamento §2.2), `model.js`,
`go2rtc-source.js`, `worker-host.js` são responsabilidades únicas, puras onde dá, com
teste ao lado — o padrão R5 funcionou. `worker.js` é coeso (inferência ponta-a-ponta),
mas seu pós-processamento puro (NMS/fusão/tiling, 123–238) **não tem unit test no hub**
— só o gêmeo do front (`src/vision/nms.test.ts`) e o eval (lento, manual) o cobrem.

---

## 3. ABSTRAÇÃO — fronteiras que faltam (e as que NÃO pagam)

### 3.1 `precision.js` — o PAINEL DE PRECISÃO (seam nº 1, critério-rei C.1)

**Problema:** os knobs de qualidade de detecção de pessoa estão em **5 arquivos + env**,
sem dono (tabela completa em §4.2). Tuning futuro (incl. fine-tune/troca de modelo)
exige hoje abrir worker.js, engine.js, bytetrack.js, motion.js e o eval.

**Proposta:** um módulo `server/analysis/precision.js`, SEM dependências, que resolve
1× (env→clamp→default) e exporta o painel nomeado:

```js
// CONTRATO (entra: process.env; sai: objeto congelado, serializável)
PRECISION = {
  detector: { scoreMin: 0.25, highScore: 0.35, nmsIou: 0.6, containment: 0.7,
              input: 640, tiles: { cols: 2, rows: 2, overlap: 0.1 } },
  tracker:  { iouThreshold: 0.25, birthIouThreshold: 0.55, ttlFloorMs: 1500, ttlRoundFactor: 3.5 },
  counter:  { minMove: 0.01, maxDist: 0.35, debounceMs: 800, minCrossingFrames: 2 },
  gate:     { motionRatio: 0.005, probeMs: 6000, probeFocusMs: 2000, pixelDelta: 22 },
}
```

- **Consumidores:** `engine.js` (tracker/counter/gate/tiles), `worker.js`
  (detector — o worker é OUTRO processo, então lê o MESMO módulo via `require`;
  env continua sendo o transporte, o módulo é o único que interpreta env),
  `eval/gate.mjs --json` (imprime o painel junto das métricas → todo commit de
  calibração registra knobs+resultado juntos).
- **Por que paga:** depois do corte, "mexer em precisão" = editar UM arquivo, medido
  por UM sensor (`npm run eval` + full-set p/ default — invariante D.10). Também
  desfaz a divisão tracker-em-2-donos (§2.2) e dá lugar canônico p/ o espelho dos
  números do front (`src/config.ts` referencia o painel em comentário, com teste de
  paridade de valores hub↔front se a frente do front topar o contrato).
- **O que NÃO entra no painel:** knobs de CUSTO puro (FPS/workers/threads/autoscale)
  — são capacidade, não qualidade; ficam nos donos atuais. Cadência afeta a CONTAGEM
  (recall×cadência), mas é dimensionamento — documentar a fronteira no header.

### 3.2 Demais seams que pagam

| Seam | Contrato (entra→sai) | Critério (00-princípios §C) |
|---|---|---|
| **`round.js`** — pipeline por rodada (extrai `processDets`+`flushAtiv`+`emitTracks`, engine.js:356–509) | `runRound(st, dets, now, deps)` onde `deps = { ingest(kind,sub,payload), emitTracks(payload), precision }` → muta `st`, retorna nada. `flushWindows(states, deps)` idem | C.4 (tira 3 "e"s do engine) + C.2 (pipeline vira testável com dets sintéticos, SEM worker/IPC — hoje impossível) |
| **`focus.js`** — registro de foco (engine.js:171–179, 250–298, 760–771) | `createFocusRegistry() → { set(socketId,camId), clear(socketId), union():Set, pickRoundMs(flags,rounds) }` | C.2/C.4; o teste `focus.test.js` JÁ desenha essa fronteira — só falta o arquivo |
| **`eval/lib.mjs`** — cliente do worker + métrica | `forkWorker(modelPath,{scoreMin}) → {ready,detect,kill}` · `matchGreedy(dets,gts,iouThr)` · `prf(acc)` · `sizeBucket(area)` | C.3 (3 cópias reais = regra dos 3 satisfeita); mata o risco de drift gate↔full-set (§2.3) |
| **Catálogo único de modelo** | `gate.mjs`/`compare-models.mjs`/`run-eval.mjs` importam `MODELS` de `server/analysis/model.js` (via `createRequire` — padrão já usado nos testes) e resolvem default = produção | C.3; corrige o default N stale do `run-eval.mjs:40` |
| **Contrato automask fechado** | `observeRound(am, feet[]) → { suppressed(cell):bool }` + `closeWindowIfDue(am, now, log)` + `statusOf(am)` — engine para de tocar `cells/rounds/present` | C.4; conserta o vazamento §2.2 sem mudar comportamento (teste já existe) |

### 3.3 O que NÃO pagar (vetos explícitos)

- **Unificar ports front↔hub** (bytetrack/counting/zones/nms): P7 — duplicação
  deliberada com 2 conjuntos de testes de paridade; e a frente paralela está DENTRO de
  `src/vision/*` agora (ADR-001: dono exclusivo). Fora desta onda.
- **Quebrar `worker.js`** em pre/post/nms: 1 consumidor, coeso, a fronteira de processo
  já é o seam; extrair só criaria pass-through. O que falta é TESTE (unit de
  `postprocess`/`fuseTiles`/`tileGrid` com fixtures de tensor), não fronteira.
- **Abstrair "fonte de frames"** (relé×go2rtc atrás de interface): 2 fontes que já
  convergem no mesmo `st.latest`; interface especulativa (P3).
- **Painel de precisão dinâmico/hot-reload**: YAGNI — troca de knob passa por gate e
  reboot; hot-reload adicionaria estado sem sensor.

---

## 4. MAPA DE ATAQUE — perf/precisão de PESSOA

### 4.1 Hot-path (custo por rodada, por câmera)

```
onFrame (ref de buffer, ~0)                             engine.js:706
→ tick @TICK_MS (varredura O(câmeras))                  engine.js:512
→ dispatchReady (guarda pura)                           worker-host.js:93
→ gateAndDispatch: decodeThumb sharp 64×48 (sub-ms)     engine.js:535/575
→ Buffer.from(frame.buf) + IPC (cópia do JPEG, 1×/rodada) engine.js:562
→ worker preprocess: sharp resize 640² + rgbToTensor
  (loop JS de 1,2M floats — ~5% do custo)               worker.js:100–119
→ session.run — **89–97% do custo** (130–650ms N/S;
  tiled = 4× sequencial)                                worker.js:324/272
→ postprocess 300×80 argmax + NMS (<5%)                 worker.js:154–181
→ IPC dets → processDets (excl→track→count→zones,
  O(dets·zonas), desprezível)                           engine.js:356
→ emitTracks (só monta payload se a room tem socket)    engine.js:458
```

Alavancas de CPU em ordem de impacto: (1) **não inferir** (gate de movimento — pulos
provados em `status().motionGate.skipped1m`); (2) **tier do modelo** (N=0,45 → S=1,07 →
M=1,88 core·s/frame — `MODELS.md`); (3) **input** (640→512 = −23% infer, MAS −7–8pp
recall pessoa pequena no full-set — trade rejeitado, `perf-input-size-dfine.md`);
(4) **cadência** (escada FPS/LINE/FOCUS); (5) pool/threads (throughput, não latência).

### 4.2 Knobs de PRECISÃO de pessoa — onde moram hoje (o problema que o §3.1 resolve)

| Knob | Default | Dono hoje | Efeito em pessoa | Sensor |
|---|---|---|---|---|
| `ANALYSIS_SCORE_MIN` | 0.25 | `worker.js:73` | piso de recall; sustenta tracks (2ª passada) | gate `recall_all@0.25` |
| `ANALYSIS_HIGH_SCORE` | 0.35 | `engine.js:117` | nascimento de track → recall de CONTAGEM | **sem sensor direto** (gate mede detector; contagem = método `acuracia-modelos.md §3`, Onda 2 pendente) |
| `ANALYSIS_NMS_IOU` | 0.6 | `worker.js:74` | duplicata vs pessoas lado a lado | gate `precision_all@0.35` |
| `CONTAINMENT_THR` | 0.7 | `worker.js:199` (const) | dedupe do tiling (caixa parcial) | `run-eval --mode tiled` |
| `ANALYSIS_INPUT` | 640 | `worker.js:66–72` | recall de pessoa PEQUENA × CPU | gate + **full-set obrigatório** (fixture já enganou: 512 passou gate e reprovou full — D.10) |
| `LR_TILES` 2×2/0.1 | fixo | `engine.js:145` (+dup `run-eval.mjs:47`) | recall distante/panorâmica, 4× custo | `run-eval --mode tiled` |
| tracker `iouThreshold` | 0.25 | `engine.js:311` | associação (id estável) | unit `bytetrack.test.js` |
| tracker `birthIouThreshold` | 0.55 | `bytetrack.js:66` (default interno) | pessoa duplicada em perda de associação | unit |
| `TTL_MS` | derivado | `engine.js:131–135` (max(1500, 3.5·round, probe+2s)) | sobrevivência em oclusão/probe — acoplado ao gate de movimento | unit + campo |
| counter `maxDist/debounce/minCrossingFrames/minMove` | 0.35/800/2/0.01 | `engine.js:312–318` (espelho de `src/config.ts:70–80`) | precisão da CONTAGEM de linha | unit `counting.test.js`; **sem replay de campo** |
| `ANALYSIS_FPS/_LINE/_FOCUS` | 1/2/6 | `engine.js:96–112` | recall×cadência da travessia | `status().perCamera.fps` |
| `ANALYSIS_MOTION_RATIO` + probes | 0.005/6s/2s | `motion.js:50–52` | risco: pulo esconde pessoa (defesa = piso de probe + TTL esticado) | `skipped1m` (custo) — **sem sensor de precisão do pulo** |
| automask `AM_*` + `ANALYSIS_AUTOMASK_JITTER` | hide/0.02 | `automask.js:40–47` | supressão de FP fixo vs ponto cego aprendido | `automasked1m` + log — sem sensor de recall |
| tier n/s/m + autoscale | s/auto | `model.js:24–46` + `autoscale.js:36–61` | **a maior alavanca única de recall** (R pequena @0.35: 21%→69%→76%) | `compare-models.mjs` (método MODELS.md) |
| `ANALYSIS_WORKERS`/`ANALYSIS_INTRA_THREADS` | auto/2 | `worker-host.js:47` / `worker.js:75` (**re-lido em `autoscale.js:44`**) | throughput (indireto: sustenta cadência) | `status().worker` |

**Lacunas de medição (honestas):**
1. **Contagem fim-a-fim não tem sensor** — os knobs do counter/tracker são os únicos do
   núcleo medidos SÓ por unit test sintético (a Onda 2 do plano-acurácia — replay de
   travessias reais — é o sensor que falta e que o painel §3.1 precisa p/ fechar o loop).
2. **Gate de movimento sem sensor de precisão** — sabemos o que ele economiza
   (`skipped1m`), não o que ele custa em recall (defensável pelo desenho nunca-cego,
   mas indefensável como número).
3. **Fixture cego ao FP-em-vazias do S** (declarado em `thresholds.json:4`): 8 vazias
   não amostram os 7/150 do full-set — decisão de default NUNCA só pelo fixture.

---

## 5. RISCOS de reescrita — o que NÃO tocar / dependências cruzadas

1. **Protocolo IPC do worker (`worker.js:37–48`) tem 4 consumidores**: engine (via
   worker-host) + `run-eval.mjs` + `gate.mjs` + `compare-models.mjs`. Mudar o shape das
   mensagens quebra OS SENSORES DE PRECISÃO junto com o motor — mudanças só aditivas, e
   o `eval/lib.mjs` (§3.2) deve nascer ANTES de qualquer mexida.
2. **Contratos socket aditivos** (CLAUDE.md §3): `analysis-status` (engine.js:351,
   snapshot 749–753) e `analysis-tracks` (payload explícito engine.js:461–485 — campos
   internos do tracker NÃO vazam; manter o filtro no emit). O front (frente paralela em
   `CameraWorkspace.tsx`/`src/vision/*`) consome ambos — congelar shape durante a onda.
3. **Ingest = contrato com o relatório**: `"flow"/"cross"` e `"ativ"/"samples"`
   (engine.js:411–421, 489–509) são os MESMOS shapes de `src/report/store.ts`. Extrair o
   pipeline (§3.2 `round.js`) não pode alterar 1 campo; `shiftOf` duplicado (§2.3) é
   armadilha aqui.
4. **LGPD/ADR-002**: frame efêmero em memória no relé, no engine (`st.latest`) e no
   worker. Nenhuma extração pode introduzir log/persistência de JPEG — inclusive em
   caminho de erro (hoje os catch só logam `e.message`, manter).
5. **Invariante nunca-cego é DISTRIBUÍDA**: `TTL_MS ≥ PROBE_MS + 2s` (engine.js:131–135)
   depende de `motion.PROBE_MS`; fail-open no decode (engine.js:596); respawn por-worker
   (worker-host.js:141–171); piso N do autoscale (autoscale.js:165). Se o painel §3.1
   centralizar knobs, a DERIVAÇÃO do TTL a partir do probe tem de ir junto (não virar
   dois números independentes).
6. **camcfg é dependência de contrato**: `ZONE_MODES` precisa aceitar `"exclusao"` e
   `cleanCamConfig` precisa preservar `longRange` (README:94–97, 124–126) — senão o
   motor silenciosamente perde a máscara/tiling. Qualquer refactor do camcfg está fora
   deste domínio mas quebra este.
7. **Engine é singleton com env lido no load** (engine.js:96–155): `focus.test.js`
   requere o módulo diretamente; extração precisa manter exports puros
   (`pickRoundMs`/`focusUnion`) ou migrar o teste na mesma mudança.
8. **Frente paralela é dona de `src/vision/*`** (ADR-001): os ports do hub declaram
   "mude LÁ e re-porte" — nesta onda o hub NÃO re-porta nada; paridade é validada ao
   fim da onda com os 2 conjuntos de teste.
9. **Toda mudança de knob passa pelo gate** (invariante D.10): `npm run eval` antes/depois;
   decisão de default exige full-set (`run-eval.mjs`) — e ANTES disso, corrigir o default
   N stale do `run-eval.mjs:40` para não comparar contra o modelo errado.

---

## Nota de separação-de-responsabilidade do domínio hoje: **7/10**

**A favor (+):** o padrão R5 é real — 8 módulos vizinhos com responsabilidade única,
lógica pura testada (386 testes no projeto, o motor é o mais coberto), worker isolado por
processo com contrato explícito, eval mede o pipeline REAL (fork do worker de produção,
nada reimplementado), gate de regressão determinístico calibrado.

**Contra (−):** `engine.js` recresceu para 951 l com ≥8 responsabilidades (o pipeline de
domínio e a telemetria moram no "orquestrador"); os knobs de precisão — a razão de ser da
plataforma — têm 5 donos + env sem painel; automask vaza internals; eval triplica
cliente/matching/catálogo com um default de modelo divergente da produção; e a contagem
fim-a-fim (o KPI) ainda não tem sensor.
