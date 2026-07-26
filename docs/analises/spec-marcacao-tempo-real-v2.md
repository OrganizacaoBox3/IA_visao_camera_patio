# Spec — marcação em tempo real v2: o atraso escolhido e a pessoa que anda e não é marcada

> **2026-07-26. Pedido do dono:** _"está com delay e falhando em reconhecer pessoas se movimentando."_
> Sucessora de `spec-overlay-tempo-real.md` (2026-07-25), que fechou o arco "a caixa senta na pessoa".
> Esta trata dos DOIS sintomas que sobraram e que têm causas DIFERENTES: o **atraso** (hoje é em boa
> parte uma ESCOLHA — o modo síncrono de 2 s) e a **falha de marcação de quem anda** (não é escolha:
> é um gate cego para pessoa pequena, mais quatro caminhos de apagamento no tracker/contrato).
>
> ## ⚠ Procedência do diagnóstico (leia antes de citar qualquer número daqui)
>
> **Este diagnóstico foi obtido por LEITURA DE CÓDIGO, não por medição de campo.** Nenhuma das
> hipóteses abaixo (D1–D4, M1–M7) foi instrumentada no CD. É inferência sobre o código-fonte —
> forte, rastreável linha a linha, e ainda assim inferência. A **Onda 0 existe exatamente para
> converter hipótese em medida**, e ela vem primeiro por isso.
>
> **Regra de citação desta spec:** todo número apresentado como MEDIDO vem com a fonte
> (`07-diagnostico-overlay-lag.md`, `acuracia-modelos.md`, `perf-input-size-dfine.md`,
> `perf-round3/frente2-serrote-stagger.md`, `eval/MODELS.md`). Número sem fonte é **aritmética
> sobre constante do código** (declarado como tal) ou **hipótese** (escrito "hipótese"). Não há
> uma terceira categoria, e nada aqui pode ser levado ao cliente como "medido" sem passar pela Onda 0.

## 1. Limites físicos declarados (o que NENHUMA onda muda)

Herdados da v1, ainda válidos:

- **Entrada em cena / mudança de direção**: previsão não cobre o que nunca foi detectado. O piso é
  `cadência + inferência`. **Medido** (07-\*, S@1080p): a câmera FOCADA entrega **1,4 fps / caixa nova
  a ~727 ms**, com inferência **~640 ms**, porque a inferência serializa por câmera. O modelo N sobe
  para 3,9 fps / 258 ms — ao custo de recall (`eval/MODELS.md`).
- **Relógios de máquinas distintas não se comparam** (skew). Toda métrica nova é **duração por perna**
  (o hub mede o trecho dele; o cliente mede o dele) — nunca diferença de epoch entre máquinas. O
  trânsito LAN fica como estimativa declarada, não medição.

Novos, herdados do motor:

- **Pessoa abaixo de ~25 px não existe para o modelo** a 640 (`server/analysis/README.md`
  §Dimensionamento e §Longo alcance — limite de amostragem). Nenhuma onda de front, tracker ou gate
  cria esse pixel. As únicas alavancas são `input` maior (medido: 896 = +5 a +8 pp de recall em cena
  densa a **1,87× CPU** — `perf-input-size-dfine.md` via knob 5 do `precision.js`) e tiling `longRange`
  (**medido**: ~3,9× a inferência por rodada — README §Longo alcance). Ambas são custo, não mágica.
- **O gate de movimento não fica de graça mais sensível.** A inferência é **89–97% do custo do frame**
  (`motion.js`, medição-âncora): cada ponto de sensibilidade se paga em CPU. Gate mais fino = menos
  câmeras por core. É um trade-off, nunca um conserto.
- **O modo síncrono exige que o vídeo esteja ao menos tão atrasado quanto o dado.** Se
  `syncDelayMs + delayMs` for menor que `idade do keyframe + latencyMs`, não existe passado para
  interpolar e o `boxAt` cai em extrapolação (dead-reckoning). Isto é **aritmética do
  `interpolate.ts`**, não escolha de produto — e é a origem de D2.

## 2. Achados (todos por leitura de código — Onda 0 mede)

### 2.1 Atraso

| # | Achado | Onde |
|---|---|---|
| **D1** | `overlay.syncDelayMs = 2000` segura o vídeo WebRTC 2 s no jitter buffer e o overlay renderiza esse passado. **Foi a troca DELIBERADA do dono em 2026-07-26** ("nem que coloque delay, mas sem arrasto"). É a **maior parcela** do atraso percebido — e hoje é constante **GLOBAL**, sem UI, sem derivação da latência real. | `src/config.ts` §overlay · `camera/playoutDelay.ts` · `TrackOverlay.tsx` · `CameraWorkspace.tsx` |
| **D2** | O modo de interpolação **EXATA** só vale enquanto `idade do keyframe + latencyMs < syncDelay + delayMs` (~2100 ms). Com intervalo de payload **~727–1000 ms** e inferência **~640 ms** (ambos medidos no 07-\*), a folga é pequena: pool saturado, autoscale caindo para M (~2× o custo do S — README §Modelo) ou câmera `longRange` (rodada ~1,1 s — README) empurram a soma para perto do teto e o código **cai em silêncio** no dead-reckoning. O arrasto volta **sem nenhum sensor denunciar**. | `interpolate.ts` `boxAt` |
| **D3** | O modo síncrono só existe no **WebRTC**. No MJPEG cai em `videoLagMs.mjpeg = 0`. O **fallback de transporte muda o comportamento da marcação sem avisar** ninguém. | `TrackOverlay.tsx` L84-88 · `CameraWorkspace.tsx` L1226-1227 |
| **D4** | `dispatchReady` exige que o **slot absoluto** do grid da câmera tenha avançado: a 1 fps, um frame que chega logo após a fronteira espera até ~1 s para ser despachado **mesmo com o pool ocioso**. O stagger áureo **NÃO se remove** — ele existe por medição real (fila p95 **259→2 ms**, vales do pool **7-9%→0,1-1,7%**, cauda p95 da inferência **−14%**, `perf-round3/frente2-serrote-stagger.md`). A pergunta aberta é outra e é **hipótese**: dá para aproveitar a folga do pool ocioso **sem re-alinhar as fases**? | `worker-host.js` `dispatchReady`/`staggerPhaseMs` |

### 2.2 Falha em marcar quem anda

| # | Achado | Onde |
|---|---|---|
| **M1 (principal)** | **Gate cego para pessoa pequena/distante.** O limiar é `0.005` da fração **GLOBAL** do thumbnail 64×48: **aritmética** — 0,005 × 3072 células ≈ **15 células**. Quem está longe muda menos que isso, a rodada é **PULADA**, e o motor só volta a olhar no **probe (6 s; 2 s na focada)**. O próprio README do motor admite: o gate _"NÃO tem sensor direto de recall do pulo"_ (`precision.js` §gate, "lacuna honesta"). | `motion.js` · `precision.js` knobs 16-18 · `engine.js` `gateAndDispatch` |
| **M2** | `emitCoasting` **re-emite a bbox velha com `ts` fresco**, e o comentário afirma que _"o gate só pula com a cena ESTÁTICA, logo os tracks estão congelados"_ — o que **é falso** (M1: o gate também pula com pessoa distante andando). O cliente ingere a re-emissão **como keyframe legítimo** (o dedupe é por `ts`, que mudou) → fantasma congelado que não expira + teleporte quando o probe finalmente roda. | `pipeline.js` `emitCoasting` · `interpolate.ts` `ingest` |
| **M3** | `useDashboardSocket` monta o `HubAnalysis` **descartando `coasting` e `zonesProibidas`** — ambos existem no tipo e o `CameraWorkspace` já lê `hd.zonesProibidas`. Resultado: **a zona proibida nunca acende VIOLADA por esse caminho** e o cliente não tem como saber que o payload é re-emissão. Mesma classe do bug do `stations`/`points`: consumidor descartando um campo calado. | `useDashboardSocket.ts` L134-146 · `types/analysis.ts` |
| **M4** | `ghosted` é **global à rodada**: qualquer nascimento ou re-associação marca **TODOS** os tracks sem match como refutados. Em **cena movimentada** (gente entrando o tempo todo) a caixa de quem piscou uma rodada apaga. O custo está declarado no código ("pessoa A oclusa na exata rodada em que B entra pisca") — mas foi dimensionado para cena calma. | `bytetrack.js` L431-435 |
| **M5** | `birthContainment 0.7` + **extensão-por-rodada** (`extent`/`unionBox`) engolem a **2ª pessoa parcialmente ocluída**. O custo está declarado no knob 8b ("adiar track novo de quem está ≥70% contido até se separar") — só que num **corredor de CD** duas pessoas em fila são o caso comum, não o patológico. | `bytetrack.js` L373-422 · `precision.js` knob 8b |
| **M6** | `lostAfterMisses: 1` dá **1 rodada de graça (~1 s a 1 fps)**. Com recall intermitente a caixa pisca. O knob está certo para o rastro; o ponto é que a 1 fps "1 rodada" é muito mais tempo do que a intuição de quem calibrou pensando a 2 fps. | `precision.js` knob 22 |
| **M7** | **Squash 640 com `fit:"fill"`.** Correção importante: **isto não é bug** — casa com o preprocessor do próprio modelo (`RTDetrImageProcessor`, `do_pad:false` — `worker.js`). O custo é de **amostragem**: 1920×1080 → 640×640 encolhe a **horizontal 3×** e a **vertical 1,7×** (aritmética), então a **largura** de quem está longe some primeiro, empurrando a pessoa para o piso de ~25 px. O escape-hatch **medido** (`input: 896`: +5 a +8 pp de recall denso, precisão intacta, **1,87× CPU**) existe e está **off** por default para não dobrar CPU no box de 4 cores. | `worker.js` `preprocess` · `precision.js` knob 5 |

> **Correção de citação herdada (encontrada nesta leitura):** a v1 registra na Onda 1c
> _"`ANALYSIS_FOCUS_INPUT=512` … validado no 07-\* (1,0→1,6 fps)"_. O 07-\* mediu **416**, não 512.
> O que se sabe de 512 é o **custo** (−23% CPU) e o **recall** (−7 a −8 pp em pessoa pequena,
> `perf-input-size-dfine.md`); o ganho de **cadência da focada** a 512 **nunca foi medido**. Fica
> registrado como hipótese, e a Onda 3 mede antes de qualquer default.

## 3. Given/When/Then (critérios de aceite — cada um com SENSOR nomeado)

### Onda 0 — medir (converte hipótese em número)

- **CA-1 — o gate pula com movimento?**
  **G:** motor rodando com `ANALYSIS_MOTION_GATE=on`. **W:** uma rodada é pulada (`reason:"skip"`) com
  `ratio > 0`. **T:** `GET /api/analysis/status` expõe `motionGate.skipMoving1m` (pulos em 60 s com
  ratio > 0 — a refutação DIRETA do comentário de M2) e `perCamera[id].motionP50/P90/P99` (percentis
  do ratio na janela). **Sensor:** `telemetry.test.js` (agregação pura) + leitura de campo por câmera.
  *Se `skipMoving1m` for ~0 em cena com gente andando, M1 e M2 estão REFUTADOS e a Onda 2 não acontece.*

- **CA-2 — o modo síncrono está mesmo em modo EXATO?**
  **G:** câmera focada, HUD ligado, `syncDelayMs > 0`. **W:** o rAF amostra. **T:** o HUD exibe
  `exactPct` (fração das caixas servidas pelo ramo de interpolação exata do `boxAt`) e `coastPct`
  (fração servida por re-emissão `coasting`), janela rolante. **Sensor:** contadores no
  `TrackInterpolator` + `interpolate.test.ts`; visual no `drawTelemetryHud`. *É o sensor que faltava
  em D2: a queda silenciosa para dead-reckoning passa a ter número.*

- **CA-3 — quanto é o atraso de parede, por transporte?**
  **G:** cronômetro de milissegundos filmado junto com a tela. **W:** grava-se WebRTC com
  `syncDelayMs=2000`, WebRTC com `syncDelayMs=0` e MJPEG, ≥5 leituras cada. **T:** a tabela entra
  em `docs/analises/reconhecimento-pessoas/` com **n, método e dispersão** — nunca um ponto solto
  (Corolário da estatística honesta). **Sensor:** procedimento manual declarado; **não é teste
  automatizado** e não vira gate.

### Onda 1 — em entrega nesta leva (frentes paralelas)

- **CA-4 — o contrato chega inteiro ao cliente.**
  **G:** payload `analysis-tracks` com `coasting:true` e `zonesProibidas:[…]`. **W:** o handler do
  socket monta o `HubAnalysis`. **T:** os dois campos sobrevivem (ausente ≠ `[]`, conforme o tipo);
  a zona proibida acende VIOLADA no canvas. **Sensor:** teste de contrato do handler +
  `CameraWorkspace` lendo `hd.zonesProibidas`.

- **CA-5 — re-emissão não é observação.**
  **G:** o interpolador com um track vivo. **W:** chega payload com `coasting:true`. **T:** ele **não**
  vira keyframe novo (não estende o histórico, não desloca `t`, não zera a idade); a caixa segue
  envelhecendo e **é desenhada mais apagada**. **Sensor:** `interpolate.test.ts` ("coasting não
  rejuvenesce o keyframe") + `pipeline.test.js`.

- **CA-6 — `ghosted` é local, não global.** ✅ ENTREGUE 2026-07-26
  **G:** rodada em que nasce um track novo do outro lado do quadro. **W:** um track distante fica sem
  match. **T:** ele **não** é refutado (só os tracks efetivamente disputados pela realocação são).
  **Sensor:** `bytetrack.test.js` + `eval:counting` (salto extremo/oclusão longa não podem regredir).

  > **MEDIDO na implementação — um critério plausível foi REPROVADO pelo sensor.** A primeira versão
  > usou o critério puramente **RELATIVO** ("cada realocação refuta só o track vivo mais PRÓXIMO
  > dela"), com o racional de que teleporte é artefato de FONTE e portanto não tem escala física
  > estável. O `eval:counting` **reprovou**: em teleporte REPETIDO acumulam VÁRIOS tracks obsoletos,
  > e refutar só o mais próximo deixa os demais emitidos — o cenário "salto extremo 3×" quebrou com
  > **2 caixas simultâneas para 1 pessoa** (teto 1). Lição registrada: **o rastro é propriedade de
  > CADA track obsoleto, não do ranking entre eles.** O que entrou é o raio de plausibilidade
  > (`refuteMaxDist`, knob 22b — valor 0.6 **escolhido**, não medido; ver o knob para a margem sobre
  > as realocações de 0.35–0.50 dos cenários anti-rastro). Isolamento do diagnóstico: com o raio
  > desligado (`refuteMaxDist: 0`) o eval falhava **igual**, o que provou que a regressão vinha do
  > critério relativo e não do raio. Calibração honesta do 0.6 segue pendente de campo (Onda 2).

- **CA-7 — comentário que mente é bug.**
  **G:** os cabeçalhos de `pipeline.js` (`emitCoasting`) e do gate. **W:** revisão. **T:** a afirmação
  "o gate só pula com cena estática" sai; entra a verdade + o link para CA-1. **Sensor:** revisão de
  diff (o número de CA-1 é a evidência).

### Onda 2 — o gate (DEPENDE da Onda 0)

- **CA-8 — o limiar deixa de ser fração global do quadro.**
  **G:** os percentis de ratio de CA-1 por câmera. **W:** o gate decide. **T:** o limiar é derivado de
  **área mínima de pessoa** (quantas células do thumbnail uma pessoa de ~25 px ocupa naquela geometria)
  **ou** o teste passa a ser **local por janela** (uma janela que estourou basta). **Sensor:**
  `motion.test.js` (decisão pura) + CA-9, sem o qual isto é aposta. **Invariante D.10** vale: knob de
  qualidade não muda sem eval antes/depois.

- **CA-9 — o recall perdido pelo gate vira número.**
  **G:** sequência com ground-truth (o mesmo MOT que `eval/persons-cftv.mjs` já consome). **W:**
  replay do pipeline REAL com gate **ON** e com gate **OFF**, mesma sequência, mesmos knobs. **T:**
  `eval/gate-recall.mjs` reporta `recall_gate_off`, `recall_gate_on` e o **delta com intervalo de
  Wilson 95%** — nunca a proporção crua. **Sensor: ele mesmo, e ele é o entregável central da onda.**
  *Hoje esse harness NÃO existe: `persons-cftv.mjs` declara no cabeçalho que "NÃO roda o gate de
  movimento" e `stationary.mjs` roda o gate só em CENA ESTÁTICA. A pessoa pequena ANDANDO sob o gate
  é o ponto cego do motor — literalmente nenhum sensor olha para ela.*

### Onda 3 — a decisão do atraso (é do dono, não do código)

- **CA-10 — `syncDelayMs` por câmera e ajustável.**
  **G:** operador na tela de configuração da câmera. **W:** muda o atraso de reprodução. **T:** vale
  só para aquela câmera, persiste no `camcfg` e recarrega sem reboot (mesmo idioma de `longRange`/
  zonas). **Sensor:** teste de persistência do `camcfg` + e2e do controle.

- **CA-11 — o piso do atraso é DERIVADO, não constante.**
  **G:** `latencyMs` do payload + intervalo observado entre payloads (ambos já existem no cliente).
  **W:** o cliente resolve o atraso efetivo. **T:** `atraso ≥ latência + intervalo + margem`; abaixo
  disso o modo exato é impossível e a UI **diz isso** em vez de degradar calada. **Sensor:** função
  pura testada + `exactPct` de CA-2 subindo depois da mudança (antes/depois).

- **CA-12 — MJPEG não mente.**
  **G:** câmera servida por MJPEG (fallback de transporte). **W:** o overlay desenha. **T:** ou há
  paridade de comportamento, ou há **aviso explícito** de que a marcação está em modo preditivo.
  **Sensor:** teste do seletor de transporte + inspeção visual no fallback forçado.

- **CA-13 — baixar a latência para poder baixar o atraso.**
  **G:** câmera focada com `ANALYSIS_FOCUS_INPUT=512`. **W:** mede-se a cadência alcançada.
  **T:** o ganho de fps da focada é **medido** (o 07-\* mediu 416, não 512 — ver correção acima) e o
  custo de recall da focada é declarado. Só então vira default de deploy. **Sensor:**
  `scripts/measure-focus.cjs` + `perCamera[id].fps` no status. **Trade-off explícito: input menor
  agrava exatamente M1/M7** — é a razão de este CA ficar depois de CA-9.

### Onda 4 — clean code (dívida declarada)

- **CA-14 — paridade `bytetrack.js` ⇄ `bytetrack.ts` vira SENSOR.**
  **G:** um vetor de cenários (dets + tempos) versionado. **W:** roda nos dois runtimes com os
  **mesmos** opts. **T:** saída idêntica (ids, emissão, morte). **Sensor:** golden-vector
  cross-language nos dois lados do gate. *Motivação honesta: hoje a paridade é "por revisão em par".
  E os defaults **divergem de propósito** — `precision.trackTtlMs` dá 8000 no hub, `config.ts` fixa
  3000 no front, com racional medido no `front-tournament` (acima de ~5 s há herança de id). Isso não
  é bug: é exatamente por isso que o vetor tem de comparar **comportamento sob opts idênticos**, e
  não valores de config.*

- **CA-15 — a prosa de medição sai dos cabeçalhos.**
  **G:** os blocos longos de medição em `precision.js`/`bytetrack.js`/`interpolate.ts`. **W:** refactor.
  **T:** a medição vive em `docs/analises/` e o código carrega **o link + a uma-linha**. **Sensor:**
  revisão + `CameraWorkspace.size.test.ts` (o gate de tamanho que já existe).

- **CA-16 — morre o ramo legado de 2 keyframes do `boxAt`.**
  **G:** todo hub em produção emite `vx`/`vy` desde 2026-07. **W:** remoção do ramo legacy. **T:**
  comportamento idêntico; um caminho a menos para auditar. **Sensor:** `interpolate.test.ts` verde
  sem os casos legacy (que saem junto).

## 4. Ondas

| Onda | O quê | Sensor | Risco |
|---|---|---|---|
| **0 — medir** | `motionGate.skipMoving1m` + percentis de ratio no `/api/analysis/status`; `exactPct`/`coastPct` no HUD; cronômetro filmado por transporte | `telemetry.test.js`, `interpolate.test.ts`, HUD; procedimento manual documentado (CA-3) | ~zero (só medição/display). **Risco real é o oposto:** pular esta onda e "consertar" o gate no escuro |
| **1 — em entrega nesta leva** | Passthrough de `coasting`+`zonesProibidas`; coasting deixa de ser keyframe (e desenha apagado); `ghosted` local; comentários falsos corrigidos | teste de contrato do handler; `interpolate.test.ts`; `bytetrack.test.js` + `eval:counting`; revisão | baixo. `ghosted` local pode devolver algum rastro na rodada de realocação — `eval:counting` é quem barra |
| **2 — o gate** (depende de 0) | Limiar por **área mínima de pessoa** ou teste **local por janela**; e o harness `eval/gate-recall.mjs` que mede o **recall perdido pelo gate** (replay com GT, gate on × off) | `motion.test.js` + **`eval/gate-recall.mjs`** (novo) + `npm run eval` (D.10) | **CPU**: gate mais sensível pula menos e cada pulo economizado era uma inferência inteira (89–97% do custo do frame). Sem CA-9 esta onda é aposta — por isso ela **é** CA-9 |
| **3 — a decisão do atraso** (do dono) | `syncDelayMs` **por câmera** e ajustável, com **piso derivado** da latência medida; paridade ou aviso explícito no MJPEG; `ANALYSIS_FOCUS_INPUT=512` medido antes de virar default | persistência do camcfg + e2e; função pura do piso; `exactPct` antes/depois; `measure-focus.cjs` | input menor **agrava M1/M7** (recall de pessoa pequena na focada); atraso configurável por câmera é mais superfície de config para o operador errar |
| **3H — hipótese (D4)** | Investigar se a folga do **pool ocioso** pode ser usada **sem re-alinhar as fases** do stagger áureo. **Não remover o stagger** — ele é medido | bancada do `frente2-serrote-stagger.md` (fila p95, vales do pool, cauda p95) reproduzida antes/depois | **alto se feito de cabeça**: o serrote já foi medido e curado uma vez. Fica como hipótese a MEDIR, não como tarefa a executar |
| **4 — clean code** | Golden-vector cross-language `bytetrack.js` ⇄ `bytetrack.ts`; prosa de medição → `docs/` com link no código; matar o ramo legado de 2 keyframes do `boxAt` | golden vector nos dois runtimes; `CameraWorkspace.size.test.ts`; `interpolate.test.ts` | baixo; o golden vector pode expor divergência real — o que é o ponto dele |

## 5. Trade-offs declarados

1. **Caixa em coasting desenhada mais apagada.** Mostrar incerteza **como** incerteza. Custo: o
   operador vê uma caixa "fraca" onde antes via uma caixa cheia; alguém vai perguntar se quebrou.
   Ganho: o fantasma para de se disfarçar de dado fresco — e é ele que hoje sustenta a queixa
   "marcou onde não tem ninguém". Barato perto do falso-OK.
2. **`syncDelayMs`: mundo atrasado × zero arrasto.** Escolha do dono, e ela se paga. Por **câmera**
   ela deixa de ser um voto único: posto de conferência pode aceitar 2 s; portaria, não.
3. **`ANALYSIS_FOCUS_INPUT` menor: latência × recall de pessoa pequena.** É o trade-off invertido do
   eval — na câmera que se OLHA, frescor vale mais que recall. Mas é **exatamente o recall que M1/M7
   já acusam**. Por isso CA-13 vem depois de CA-9.
4. **Gate mais sensível: recall × CPU.** O gate existe porque a inferência é 89–97% do frame. Cada
   ponto de sensibilidade é menos câmera por core. Não existe versão gratuita disto.
5. **`ghosted` local: menos apagão × algum rastro.** Refutar só quem é disputado devolve uma janela
   pequena de rastro na rodada de realocação. Aceito, com `eval:counting` de guarda.
6. **`input: 896`: +5 a +8 pp de recall denso × 1,87× CPU** (metade das câmeras por core). Fica **off**
   por default; é decisão de dimensionamento por deploy, e é honesta como escape-hatch.
7. **Sensor custa código.** `skipMoving1m`, percentis, `exactPct` e o harness de gate são linhas que
   não entregam feature nenhuma ao operador. São o que separa "arrumamos" de "achamos que arrumamos".

## 6. Fora de escopo (decidido, não esquecido)

- **Re-ID por aparência.** O tracker segue geometria (IoU), e a limitação está declarada no
  `bytetrack.js`. Existe `spec-reid-visual.md` — arco próprio, não este.
- **Pool dual-modelo (N na focada).** Já rejeitado no 07-\* e na spec 09: perde recall, muda muito.
- **INT8/quantização.** **Medido e reprovado no custo** em 2026-07-25 (v1 Onda 3: +13–20% de
  `inferMs` no CPU EP ARM). Residual conhecido: repetir no x86 (AVX2/VNNI pode inverter o sinal) — é
  hipótese, e não é desta spec.
- **Sincronização de relógio hub⇄cliente (NTP-like).** Durações por perna bastam.
- **Remover o stagger áureo** (ver 3H). Ele é medido; mexer nele sem a bancada é regressão anunciada.
- **Alinhar o `ttlMs` do front ao do hub.** Medido e **reprovado** (`front-tournament`): acima de ~5 s
  aparece herança de id na reocupação de posto. Paridade é de **política**, não de número.
- **Persistir frame para depurar.** LGPD/ADR-002: frames são efêmeros em memória, inclusive no motor.
  O harness da Onda 2 roda sobre fixture do `eval/`, nunca sobre frame de produção.
- **Prometer "tempo real".** O entregável continua sendo: caixa alinhada ao quadro exibido + curva de
  cadência medida + o atraso escolhido **explicitamente** e por câmera.

## 7. Não-regressão (o contrato desta spec)

- **Contratos socket seguem ADITIVOS.** `analysis-tracks`, `analysis-status`, `frame`, `camcfg-updated`
  não mudam de shape. `coasting` e `zonesProibidas` **já são opcionais no tipo** — a Onda 1 só para de
  descartá-los no consumidor. Ausente ≠ `[]` (a distinção é semântica e está no `types/analysis.ts`).
- **A LÓGICA continua lendo tracks EXATOS.** Contagem, ocupação, zona e alarme não veem interpolação:
  tudo que esta spec faz no cliente é **display-only**. A única exceção é a Onda 2, que muda o **gate**
  — e por isso passa pelo eval (invariante D.10) e pelo harness novo.
- **A caixa da PESSOA nunca exibe NÚMERO** (nem id, nem contagem). `drawTracks.test.ts` quebra o build
  se um dígito voltar. Contagem vive no painel.
- **Nunca-cego permanece**: baseline, piso de probe e fail-open do gate não podem sair. Qualquer
  mudança de limiar mantém os três.
- **Nada de imagem persistida** em nenhum caminho, inclusive de erro (ADR-002).
- **`npm run verify` verde por onda**; mudança que toca o front/fluxo roda também `npx playwright test`.
  Knob de qualidade passa por `npm run eval` antes/depois (D.10) e, quando for do gate, por `eval/gate-recall.mjs`.
- **Vermelho não entra.** E "o teste passou" relatado não conta — só a execução.

## 8. Definition of Done (por onda)

- [ ] Funciona no fluxo real (câmera do CD, não fixture), não só no caso feliz.
- [ ] Critérios de aceite da onda atendidos, com o **sensor nomeado rodando** — e o número da Onda 0
      citado onde a onda afirma ter melhorado algo.
- [ ] `verify` verde; sem segredo; sem regressão conhecida em aberto sem plano.
- [ ] **Residual declarado por escrito.** Toda proporção reportada com **n e Wilson 95%**; toda
      hipótese ainda aberta continua marcada "hipótese".
- [ ] Decisão não-óbvia virou ADR curto em `docs/analises/decisoes/`.
