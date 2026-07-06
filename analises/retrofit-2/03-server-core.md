# Retrofit-2 · Frente 03 — Server core (hub Node: transporte × domínio × persistência)

> **Escopo desta leitura:** `server/*.js` (index, http-auth, shed, rtsp, go2rtc, camcfg, db,
> pgstore, events, users, settings, recipients, cameras, alerts, dispatch, whatsapp,
> alarmPolicy) + `server/routes/**` + `server/alarm/**`. **Fora de escopo:** `server/analysis/**`
> (frente do motor) e todo o front. Leitura feita arquivo a arquivo em 2026-07-05, branch
> `master` limpo (HEAD `d42c3a8`). Baseline de linhas/comentários: `01-baseline-metricas.md`
> (área "server raiz + routes + alarm": 36 arquivos, 4.839 linhas, 638 de comentário = 14,2%).

**Veredicto em uma linha:** o server core já é o pedaço mais bem separado do sistema
(routes finos, `alarm/` exemplar — um mecanismo por módulo), mas o `index.js` ainda guarda um
handler-deus de socket com o pipeline de alarme embutido, a taxonomia de alarmes mora no módulo
de WhatsApp (dependência invertida), o dedup existe em 3 implementações, e o `pgstore.js` exige
escrever cada métrica DUAS vezes (JS em memória + SQL) — o maior risco de drift de contrato do
domínio.

---

## 1. COMENTÁRIOS — inventário do ruído

O comentário-porquê é identidade da casa e domina o volume — **a maior parte fica**. O ruído é
quase todo de UM tipo: **marcador de processo/plano** ("Onda A/B/C", "Fase 1", "R0–R3", "2.1",
"F1/F3/F4", "item 12/14") e **narrativa de changelog** ("antes era…", "extraído de…"). O git já
guarda isso. Referências a **ADR** ficam (são contrato); referências a **onda/fase/item de
plano** saem.

### Contagem do ruído (grep nos 34 arquivos do domínio)

- Marcadores de onda/fase/retrofit: **~60 ocorrências** — só `index.js` tem 18, `rtsp.js` 8.
- Changelog inline "era X → virou Y": `rtsp.js:109-111` (`// era 8`, `// era 480`, `// era 7`),
  `rtsp.js:253` ("antes era drenado e descartado"), `index.js:42-47` (parágrafo inteiro contando
  o que o R2 consertou), `camcfg.js:5` ("Antes viviam no localStorage"), `camcfg.js:104-106`
  ("Sem esta linha o flag era descartado" — post-mortem de bug que já virou código correto).
- Narrativa de extração: `http-auth.js:1-5`, `shed.js:1-3`, `index.js:19-20`, `index.js:183-185`
  — quatro lugares contando que "isto foi extraído do index.js na Onda C".

### Os 10 piores (comentário removível/condensável estimado, linha a linha)

| # | Arquivo | Coment. (linhas) | Removível | % do coment. | O que sai (exemplos) |
|---|---|---:|---:|---:|---|
| 1 | `server/alarmPolicy.js` | 54 | ~25 | ~46% | Banner de 33 linhas (`:1-33`): repete o título da Onda A/C, repete o ÍNDICE de `alarm/` (a árvore de arquivos já diz), repete o contrato de `evaluate` que o JSDoc de `:61-65` já declara. Fica: o parágrafo do "por quê ISA-18.2/EEMUA" e o comportamento de `ALARM_POLICY_ENABLED=0`. |
| 2 | `server/index.js` | 95 | ~35 | ~37% | Marcadores "Fase 1"/"2.1"/"Onda B"/"R2/R3" (`:42-47`, `:82`, `:105-106`, `:124`, `:171`, `:177-185`, `:203-205`, `:223-224`, `:243-247`, `:293-295`, `:345-348`); narrativa da extração do shed (`:183-185`). Fica: semântica do readBody no overflow (invariante real, condensada), o contrato do tee (`:131-135`), a razão do VOLATILE (`:202-205`, 1×, não 2×). |
| 3 | `server/events.js` | 36 | ~12 | ~33% | Banner (`:1-27`): "Onda B, item 7 — espinha dorsal", parágrafo repetindo o padrão de persistência que outros 5 módulos já descrevem. Fica: MODELO DE UM EVENTO (`:16-20`, é contrato), envs de retenção (`:22-26`), LGPD. |
| 4 | `server/rtsp.js` | 75 | ~18 | ~24% | `// era 8/480/7` (`:109-111`), refs a "plano-performance-imagem.md P1" (`:103`), marcadores R1/2.1 espalhados (`:144`, `:254`, `:358`, `:414`, `:509`). Fica: TODO o racional de redact (segurança), backoff/health-check, o guard de versão do ffmpeg (`:174-179` — invariante de ambiente real). |
| 5 | `server/shed.js` | 25 | ~8 | ~32% | Narrativa de extração (`:1-3`), "(2.1)" 3×. Fica: definição de ESPECTADOR (`:5-8` — é O contrato do módulo) e o porquê do WEBCAM_DEFAULT_FPS (`:13-15`). |
| 6 | `server/go2rtc.js` | 55 | ~10 | ~18% | "Fase 1 do retrofit de performance" (`:1`), "(Onda 2)" (`:7`). Fica: LGPD/record (`:18-20`), o porquê do `origin:"*"` (`:97-100` — comentário-ouro validado por teste), YAML fora do repo. |
| 7 | `server/http-auth.js` | 9 | ~4 | ~44% | `:1-5` — narrativa da extração + promessa "a forma do ctx NÃO muda" pode virar 1 linha de contrato. |
| 8 | `server/camcfg.js` | 30 | ~8 | ~27% | `:5` ("antes viviam no localStorage"), "Fase 1/go2rtc" 2× (`:26-27`, `:99-100`), post-mortem do longRange (`:103-106` → 1 linha: "longRange liga o tiling 2×2 no motor — F3/ADR-009"). |
| 9 | `server/alarm/persist.js` | 21 | ~5 | ~24% | Meio-parágrafo repetindo o que `saveShelves`/`loadShelves` já dizem no corpo (`:6-10` duplica `:21-23` e `:51-52`). Fica: o porquê do shelve sobreviver a restart (`:2-5` — excelente). |
| 10 | `server/routes/alarms.js` + `routes/config-routes.js` | 16 | ~4 | ~25% | "(Onda B)"/"(Onda C, item 14)" (`alarms.js:10`, `:57`); resto é bom (a nota de ordem das rotas `:59` é invariante real e FICA). |

**Total do domínio: ~130 de 638 linhas de comentário removíveis (~20%)** sem perder um único
porquê/invariante. Os módulos pequenos de persistência (`recipients.js` 2, `settings.js` 4,
`cameras.js` 4, `db.js` 6) e `alarm/config.js` (34 linhas, mas é a TABELA DE ENVS = contrato)
estão no ponto — não mexer.

---

## 2. RESPONSABILIDADE — misturas, funções-deus, duplicações

### 2.1 O que está BOM (registrar para não "consertar" o que funciona)

- **`server/routes/*` é a camada de transporte HTTP no formato certo:** handlers finos, zero
  lógica de domínio, contrato `handle(req,res,ctx) → bool` uniforme (`index.js:24-25`), RBAC
  aplicado na borda via `ctx` (`http-auth.js`). Nenhuma rota fala SQL.
- **`server/alarm/` é o modelo do retrofit inteiro:** um mecanismo por arquivo (config/state/
  keys/priority/flood/flap/shelve/persist/metrics), estado compartilhado explícito em
  `state.js`, política de volatilidade documentada (`state.js:5-8`).
- **Persistência por entidade** (users/recipients/settings/camcfg/events): cada um dono da sua
  tabela + fallback, queries parametrizadas, `schema.sql` como fonte única (`db.js:40-41`).

### 2.2 Misturas de concern (as reais)

1. **`index.js` ainda tem um handler-deus de socket** (`index.js:188-313`, ~125 linhas): num
   único `io.on("connection")` vivem (a) protocolo de nó-câmera (registro/relay/disconnect,
   `:191-219`), (b) protocolo de dashboard (rooms/watch/foco/snapshot, `:220-273`),
   (c) `set-capture` com memória de shed (`:277-284`) e (d) **o pipeline de alarme inteiro**
   (`:288-311`: policy → andon → whatsapp → events.record → emit "alarm-event"). O HTTP ganhou
   `routes/`; o socket não ganhou o equivalente. É o único arquivo do domínio que precisa de
   "e" quatro vezes para ser descrito.
2. **Pipeline de alarme é lógica de domínio dentro de callback de transporte**
   (`index.js:288-311`). A cadeia decisão→canais→persistência→broadcast não tem dono nem teste
   de integração próprio — só dá para exercitá-la abrindo um socket.
3. **`dispatch.classify()` é taxonomia de ALARME morando no módulo de WhatsApp**
   (`dispatch.js:13-21`). O domínio de alarme importa do canal: `alarmPolicy.js:34` e
   `alarm/shelve.js:11` fazem `require("../dispatch")` só para classificar. Dependência
   invertida: a política (núcleo) depende do adaptador (borda). Se amanhã o WhatsApp for
   trocado pela Cloud API ("trocar mexe só aqui", `whatsapp.js:4`), o `dispatch.js` não pode
   morrer sem quebrar a política.
4. **Dedup em TRIPLICATA:** `alarmPolicy` deduplica por chave lógica (`alarm/state.js:9`,
   `ALARM_DEDUP_MS`), `alerts.js:10` deduplica por texto (`lastSent`, `ALERT_DEDUP_MS`) e
   `dispatch.js:11` deduplica por número|texto (`sent`, mesmo `ALERT_DEDUP_MS`). Com a política
   ligada (default), os dois dedups de canal são quase código morto — só fazem diferença com
   `ALARM_POLICY_ENABLED=0`. Três mapas, duas envs, um conceito.
5. **"Que câmeras existem" tem 3 donos costurados no bootstrap:** o Map `cameras` do
   `index.js:165`, o Map `streams` do `rtsp.js:89` e a lista do `cameras.js` (cameras.json) —
   e o `go2rtc.init` recompõe a união legado+dinâmico por conta própria (`index.js:350-359`),
   duplicando a mesma composição que `rtsp.startRtspIngestion` faz (`rtsp.js:479-490`).
   Funciona, mas quem adicionar uma 4ª fonte de câmera vai ter que descobrir os 3 lugares.
6. **`rtsp.js` (512 linhas) faz 6 coisas**, das quais 5 são coesas ("ciclo de vida de um stream
   ffmpeg"): supervisão/backoff/health (`:205-333`), demux JPEG (`:151-160`), status (`:186-203`),
   shed idle/wake (`:418-455`), fontes legadas (`:116-140`). A 6ª não é: **resolução do binário
   ffmpeg + detecção de versão** (`:20-74`, 55 linhas de bootstrap de ambiente Windows/winget/
   choco/scoop). É concern de ambiente, não de stream.
7. **`go2rtc.js` declara as próprias 3 responsabilidades** (`:12-16`: gerar YAML, supervisionar,
   proxy). O proxy reverso (`:240-293`) é transporte HTTP puro. Aos 366 linhas ainda é legível;
   é o próximo candidato a split SE crescer (regra dos 3 — hoje não paga).
8. **`pgstore.js` escreve cada métrica DUAS vezes:** `J_INGEST` (JS em memória, `:90-285`) e
   `INGEST` (SQL, `:313-469`) implementam a MESMA semântica de merge por bucket, mais
   `BUCKET_SQL`/`EVENT_SQL` (`:472-485`) e `schema.sql` — **4 pontos de toque por métrica
   nova**, com paridade de forma garantida só por disciplina de comentário (`:7-9`). O kind
   "flow" recém-adicionado tocou os 4. Não há teste de paridade JSON×SQL.
9. **Padrão "cache + usingPg + saveFile + upsert + init com fallback" duplicado 6×**
   (`users.js`, `recipients.js`, `settings.js`, `camcfg.js`, `events.js`, variante em
   `pgstore.js`). A regra dos 3 foi estourada em dobro; o custo real é o boilerplate do
   `init()` try-PG-catch-JSON repetido (~15 linhas × 6).
10. **Assimetria do guard de análise no shed:** RTSP consulta `analysisViewer` antes de pausar
    (`rtsp.js:421-422`); webcam NÃO consulta antes de rebaixar para 2fps (`shed.js:37-48`).
    Hoje é inócuo (motor amostra @1fps ≤ 2fps), mas a invariante "análise conta como
    espectador" (ADR-009) está aplicada em só 1 dos 2 ramos — **e no módulo errado** (a decisão
    é do shed; o predicado foi parar dentro do rtsp).

### 2.3 Miúdos

- `server/_zxing_roundtrip_test.cjs` — script de teste de LEITURA (domínio do front) largado na
  raiz do server. Mover para `eval/` ou apagar.
- `settings.js` é "notif-settings" de fato (arquivo `notif-settings.json`, id `'notif'` no PG) —
  o nome genérico esconde o domínio; `routes/notif.js` é quem o consome.
- `users.js` mistura 3 concerns num arquivo só (criptografia/token `:24-69`, persistência
  `:72-152`, CRUD/regras `:154-242`) — 261 linhas, tolerável, mas a seção de token é candidata
  natural a `server/auth-token.js` se o RBAC crescer.

---

## 3. ABSTRAÇÃO — fronteiras que faltam (só as que pagam)

Ordenadas por retorno. Cada uma com contrato nomeado (o que entra/sai). Nada além disso —
qualquer outra extração hoje é especulação.

### S1. `server/sockets.js` — a camada socket ganha o que o HTTP já tem
**Contrato:** `attachSockets(io, ctx)` onde `ctx = { cameras, socketById, shed, analysis, rtsp, onAlert }`.
Move `index.js:188-313` inteiro. `index.js` vira só composição/bootstrap de verdade (hoje a
promessa do comentário `:19-20` está meio cumprida). Eventos socket permanecem byte-a-byte.
**Paga porque:** o handler-deus é o maior arquivo-alvo de mudança do domínio (watch/foco/shed
mexem nele a cada onda) e hoje qualquer mudança arrisca o pipeline de alarme que mora no mesmo
callback.

### S2. `server/alarm/pipeline.js` — o fluxo decisão→canais→persistência com dono
**Contrato:** `handleAlert(p: {text, ts?, cameraId?, zona?, tipo?}, { cameras, io }) → Promise<void>`
(efeitos: `alerts.notify`, `dispatch.dispatchAlert`, `events.record`, emit `"alarm-event"`).
Extrai `index.js:288-311` como função pura-de-orquestração, testável com fakes sem socket.
**Paga porque:** é o caminho crítico de notificação (Andon/WhatsApp) sem NENHUM teste de
integração hoje; os testes existentes (`alarmPolicy.test.js`) cobrem só a decisão.

### S3. Mover `classify()` para o domínio de alarme
**Contrato:** `alarm/classify.js: classify(text) → { critico: boolean, tipo: "atividade"|"fadiga"|"leitura"|"objetos" }`.
`dispatch.js` passa a importar de `alarm/`; `alarmPolicy.js:34` e `alarm/shelve.js:11` param de
depender do canal. Zero mudança de comportamento; desfaz a única dependência invertida do domínio.

### S4. Teste de PARIDADE JSON×SQL no pgstore (teste antes de abstração — P5/P8)
**Contrato do sensor:** para cada `kind:op`, ingerir o mesmo payload nos dois caminhos e
assertar que `buckets(kind)`/`events(kind)` devolvem objetos com as MESMAS chaves e a MESMA
aritmética de merge (idle_ms soma, people_peak = max, etc.). É o seguro barato contra o risco nº 1
de drift (item 2.2-8). **A abstração declarativa** (spec única por kind gerando J_INGEST e SQL)
só entra quando nascer o 6º kind — hoje seria DRY dogmático sobre 5 casos estáveis.

### S5. `server/store/init-fallback.js` — só o boilerplate comum, nada mais
**Contrato:** `initPgOrJson({ name, loadPg: () => Promise<T>, loadJson: () => T }) → Promise<{ data: T, usingPg: boolean }>`.
Mata as 6 cópias do try-PG-catch-JSON-log (~90 linhas), preservando cada `persist*` específico
onde está (as variantes de escrita são genuinamente diferentes — não unificar).

### NÃO extrair (YAGNI explícito)
- Proxy do go2rtc e resolução do ffmpeg: 1 consumidor cada, estáveis. Marcar as seções com
  régua de comentário basta.
- Unificar os 3 dedups num "dedup service": a decisão certa é o INVERSO — documentar que os
  dedups de canal são a rede de segurança do modo `ALARM_POLICY_ENABLED=0` e congelá-los.
- Registry único de câmeras: 3 fontes têm semânticas distintas (conectadas × ffmpeg × cadastro);
  o custo real hoje é só a composição duplicada em `index.js:350-359` — resolver expondo
  `rtsp.allSources()` (função, não módulo novo).

---

## 4. MAPA DE ATAQUE — perf e PRECISÃO de pessoa neste domínio

O motor D-FINE come **o que este domínio produz**. Os knobs de precisão que moram aqui são o
"pré-processamento invisível" do modelo.

### 4.1 Hot-paths (onde a CPU do hub mora, fora do motor)

| Hot-path | Onde | Custo | Como medir |
|---|---|---|---|
| Demux MJPEG do ffmpeg | `rtsp.js:259-278` (`Buffer.concat` por chunk + 2× `indexOf` em `drainFrames` `:151-160`) | O(buffer) por chunk × 10fps × N câmeras × JPEG 720px. O loop mais quente do hub depois do worker. | `process.cpuUsage()` com N streams ligados/desligados; `st.fps` já existe por stream (`:305-333`). |
| Relé de frame webcam | `index.js:206-211` | ~zero (passa referência; `analysis.onFrame` é last-wins) | contagem de emit por segundo |
| Ingest PG por amostra | `pgstore.js:314-339` (`ativ:samples` faz 1 `await db.query` POR zona, sequencial) | N zonas × M câmeras / flush | `pg_stat_statements` ou contador de queries |
| Retenção a cada alarme | `events.js:154-163` → `enforceRetention` roda 2 DELETEs (um com subselect `order by ts desc limit N`) **a cada `record()`** | irrelevante hoje; amplifica em rajada (que a flood-suppression normalmente impede) | duração do record sob rajada sintética |
| Proxy go2rtc | `go2rtc.js:248-293` | streaming pipe, ~zero CPU | — |

### 4.2 Knobs que afetam PRECISÃO de pessoa (com dono)

| Knob | Dono (arquivo) | Efeito na precisão | Estado |
|---|---|---|---|
| `RTSP_FPS`/`RTSP_WIDTH`/`RTSP_QUALITY` (defaults 10/720/4) + `fps/width/quality` por câmera | `rtsp.js:107-113` (defaults) · `cameras.js:59-61` (clamps por câmera, width ≤1920) | **É a resolução/compressão da ÚNICA imagem que o D-FINE vê** nas câmeras RTSP. 720px → o motor reamostra p/ 640 (ou tile 2×2 no longRange). Subir width melhora recall de pessoa distante; `-q:v` alto degrada bordas → menos detecção. | Dono claro, MAS o valor serve a dois senhores (fluidez de visualização × recall do motor) com um único ffmpeg. Não há knob separado "perfil de análise". **Eixo de ataque nº 1 deste domínio.** |
| Zonas modo `"exclusao"` | `camcfg.js:24` (validação) — motor lê via `getZones` (`analysis/engine.js:214`) | Máscara que SUPRIME detecções (anti-FP de objeto fixo). Zona errada = falso negativo permanente. | Dono claro; propagação ao vivo via `"camcfg-updated"` no tee. |
| `longRange` (tiling 2×2) | `camcfg.js:106` (persiste) — motor decide (`engine.js:232-234`) | 4× inferência, recall de pessoa pequena/panorâmica. | Dono claro. Nota: o comentário em `:103-106` registra que o campo JÁ foi silenciosamente descartado uma vez pelo `cleanCamConfig` — validação-allowlist é o ponto de falha; campo novo de precisão TEM que ser adicionado aqui ou morre mudo. |
| Tripwires (geometria de contagem) | `camcfg.js:36-55` | Precisão do fluxo in/out (Flow-C). | Dono claro. |
| `analysisViewer` (análise = espectador) | predicado em `rtsp.js:95-98/:421-422`, injetado em `index.js:331` | Se regredir, o shed mata o ffmpeg à noite e o motor **fome silenciosa** — é o pilar "24/7 sem espectador" (ADR-009). | Frágil: aplicado só no ramo RTSP e fora do módulo dono (ver 2.2-10). Sensor: `/api/analysis/status` → `perCamera.fps`. |
| `SHED_WEBCAM_FPS=2` | `shed.js:12` | Webcam rebaixada continua ≥1fps do sampler do motor — hoje OK. Se alguém baixar p/ <1, o motor de webcam degrada sem aviso. | Invariante implícita NÃO documentada nem testada. |
| `maxHttpBufferSize: 8e6` | `index.js:122` | Teto silencioso do tamanho de frame webcam (JPEG >8MB = drop). Limita resolução máxima de webcam para o motor. | Sem dono declarado; merece 1 linha de comentário-contrato. |
| go2rtc (WebRTC) | `go2rtc.js` | **NENHUM** — é transporte de visualização; o motor come o MJPEG do ffmpeg. Declarar isso evita "otimizar detecção" no lugar errado. | — |

### 4.3 Sensores existentes × faltantes

- **Existem:** `/api/analysis/status` (`routes/analysis.js` — fps/queue/lastMs por câmera),
  `camera-status.fps` por stream (`rtsp.js:305-333`), `/api/data/status` (`pgstore.js:511-529`),
  `/api/alarms/metrics` (`alarm/metrics.js`).
- **Faltam:** (a) idade fim-a-fim do frame — o `ts` nasce no demux (`rtsp.js:276`), então a
  latência câmera→hub é invisível; (b) CPU do relé por stream (hoje só o total do processo);
  (c) teste de paridade JSON×SQL do pgstore (S4); (d) teste da invariante "shed nunca mata
  stream analisado" (unit sobre `idleSource` + `analysisViewer`).

---

## 5. RISCOS de reescrita — o que NÃO tocar e dependências cruzadas

1. **Contratos socket são ADITIVOS** (CLAUDE.md §3): `frame`, `cameras`, `set-capture`/`capture`,
   `alert`, `camera-status`, `alarm-event`/`alarm-update`, `camcfg-updated`, `analysis-status`,
   `analysis-tracks` + os aditivos `watch` (`index.js:248-258`) e `analysis-focus` (`:264-268`).
   Qualquer extração (S1/S2) preserva payloads byte-a-byte.
2. **O tee de análise é invisível e vital** (`index.js:136-149`): o motor observa `"frame"` e
   `"camcfg-updated"` só porque `ctx.io` e `rtsp.startRtspIngestion` recebem `ioAnalysis`
   (`index.js:92`, `:365-370`). Trocar `ioAnalysis`→`io` em UM ponto desliga zonas/frames do
   motor **sem nenhum erro**. Em refactor, este é o fio a proteger com teste primeiro.
3. **Webcam tem caminho DIRETO fora do tee** (`index.js:209`): `analysis.onFrame` é chamado no
   handler, não via emit. S1 tem que carregar essa chamada junto.
4. **LGPD/ADR-002:** frame nunca toca disco neste domínio (relé e demux são memória);
   `redact()` (`rtsp.js:147`) é controle de segurança TESTADO (exportado `:509`) — toda linha
   que vira `lastError` broadcast passa por ele; YAML do go2rtc tem credenciais e é escrito
   FORA do repo (`go2rtc.js:47-49`). Preservar os três.
5. **GAP encontrado (agir, não só anotar):** `server/recipients.json` (números de WhatsApp =
   PII) e `server/notif-settings.json` são fallbacks de runtime criados por `recipients.js:8` e
   `settings.js:8` e **NÃO estão no `.gitignore`** (verificado com `git check-ignore`: exit 1).
   O CLAUDE.md §3 lista os outros JSONs de runtime mas esqueceu estes dois. Hoje não existem no
   disco (PG ativo), mas o primeiro boot sem PG os cria versionáveis.
6. **`alarmPolicy` restaura shelves no `require`** (`alarmPolicy.js:125-129`): reordenar
   imports/inicialização precisa manter a restauração antes do primeiro `evaluate`.
7. **Ordem do dispatch de rotas** preservada por não-colisão de padrões (`index.js:94-95`) e,
   dentro de `routes/alarms.js`, `metrics`/`shelves` casam antes de `:id` só porque `[\w-]+`
   não pega `/` (`alarms.js:57-59`) — mover blocos exige manter essa análise.
8. **Semântica do `dash-legacy`:** UM dashboard legado conectado desliga o shed de TODAS as
   câmeras (`shed.js:32-35` conta a room globalmente) — é retrocompat deliberada, não bug.
9. **Fora do nosso perímetro mas encostado:** `analysis/engine.js` lê `camcfg` diretamente
   (funções `getZones/getTripwires/getCamConfig` são contrato inter-frente); ADR-007 (casca
   fullscreen/rAF) é front — nada aqui pode forçar mudança lá. `schema.sql` só cresce
   (idempotente/aditivo).
10. **Pendência humana conhecida** (CLAUDE.md §6): rotação de `AUTH_SECRET` (default inseguro em
    `users.js:17`) e senha do Postgres — não é alvo do retrofit, mas nenhum refactor pode
    piorar (ex.: logar token/secret).

---

## Nota de separação-de-responsabilidade do domínio HOJE: **7/10**

**Ganha ponto:** routes finos e uniformes; `alarm/` como padrão-ouro; persistência por entidade
com fallback disciplinado; go2rtc/rtsp com fronteiras de processo claras; segurança (redact,
RBAC na borda, queries parametrizadas) no lugar certo.
**Perde ponto:** handler-deus de socket com pipeline de alarme embutido no `index.js` (-1);
`classify` invertido + dedup em triplicata no eixo de notificação (-1); `pgstore` com dupla
implementação sem sensor de paridade + padrão de persistência 6× duplicado (-1).
