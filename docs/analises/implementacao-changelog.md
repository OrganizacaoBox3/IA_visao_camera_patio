# Changelog de Implementação — Ondas 1–3

Execução do `plano-desenvolvimento.md`. Status: **todas as frentes implementadas e validadas**.

## Validação final (Onda 3)
- `npx tsc --noEmit` → **OK** (0 erros, projeto inteiro)
- `npx vite build` → **OK** (só avisos pré-existentes: tamanho de chunk, `eval` no onnxruntime)
- `node --check` em index.js, rtsp.js, cameras.js, dispatch.js, whatsapp.js, validate-streams.mjs → **OK**
- `npx playwright test` → **3/3 passaram** (login+navegação, Select-em-Dialog x2); hub sobe limpo com `cameras.js`

## A1 — Pipeline & Performance
- `src/vision/scheduler.ts` (novo): scheduler global de inferência com prioridade + coalescência por origem.
- `src/CameraWorkspace.tsx`: gate de frame novo (pula reprocessamento ~4×), reuso/swap de buffers de luma, inferência via scheduler, overlay full com ESC + focus trap.
- `src/vision/detect.ts`: fallback coco main-thread só aquece sob falha do worker (fim da carga dupla de modelo).
- `src/processors/{fadiga,objetos,leitura}.ts`: pisos de cadência p/ coco na main thread; reuso de buffers em leitura.
- `src/frame.ts`: `ts?` opcional p/ o gate.

## A3 — UI / Maturidade
- `src/api.ts`: `ApiError` com mensagens amigáveis pt-BR; detalhe técnico só no console.
- `src/report/store.ts`: para de engolir erro de API (propaga).
- `src/routes/ReportPage.tsx`: estado de erro distinto de vazio + retry + toast.
- `src/routes/UsersPage.tsx`: catch+toast em destinatários/preview/CRUD; copiar com feedback e fallback não-HTTPS.
- `src/routes/ProfilePage.tsx`: toast ao salvar.
- `src/components/ErrorBoundary.tsx` (novo), `src/routes/NotFoundPage.tsx` (novo), `src/ui/clipboard.ts` (novo); `main.tsx` registra boundary + rota 404.

## A4 — Backend Multi-câmera
- `server/rtsp.js`: backoff exponencial + health-check (mata ffmpeg congelado); transporte por esquema de URL (RTSP/HLS/MJPEG), sem forçar TCP.
- `server/index.js`: endpoints `GET/POST/PATCH/DELETE /api/cameras` (auth superadmin); evento socket `camera-status` (aditivo); snapshot inicial.
- `server/cameras.js` (novo): persistência de câmeras dinâmicas em `cameras.json`.
- `docs/analises/contrato-multicamera.md` (novo): contrato consumido pela A2.

## A5 — Câmeras Demo
- `server/rtsp.sources.json` (novo): 3 fontes verificadas (Wowza RTSP, BBB HLS, Tears of Steel HLS).
- `server/rtsp.sources.extra.example.json` (novo): 5 fontes não verificadas opcionais.
- `scripts/validate-streams.mjs` (novo): valida feeds via ffprobe/ffmpeg (degrada se ausente).
- `docs/analises/runbook-demo-cameras.md` (novo): passo-a-passo + nota legal/LGPD.

## A2 — Config + Central + Câmera-nó
- `src/config.ts`: demo "Limite 10s" **OFF por padrão** (liga via `VITE_DEMO_MODE=1`); `dashboard.feedsPerPage`; defaults de captura reduzidos (960px/12fps/q0.75).
- `src/routes/DashboardPage.tsx`: consome `camera-status` (estado+fps por tile), paginação + grade adaptativa (só feeds da página rodam inferência), libera ImageBitmap de feeds inativos, eleva prioridade da câmera aberta.
- `src/routes/CameraPage.tsx`: status do nó reflete o socket real; JPEG configurável.

## Higiene/Segurança
- `.gitignore`: adicionados `server/cameras.json` e `server/wa-auth/` (contêm credenciais).

## Onda A — Quick wins do benchmark de interfaces (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` verdes.
- **Fundação (A0)** `src/index.css`, `src/config.ts`: tokens semânticos de estado ("going gray") + tokens dark da superfície de câmera; bloco `config.overlay` (confiança + camadas).
- **Backend de alarme (B)** `server/alarmPolicy.js` (novo), `alerts.js`, `dispatch.js`, `index.js`: dedup temporal por chave, supressão de inundação (rajada → 1 resumo), prioridade 3 níveis; envs `ALARM_*`; passthrough com `ALARM_POLICY_ENABLED=0`.
- **Câmera (A1a)** `src/CameraWorkspace.tsx`, `src/report/predict.ts` (novo): estados/zonas via tokens, palco dark + números no painel, toggles de camadas + slider global de confiança, estimativa de alertas/dia no slider de sensibilidade.
- **Central (A1b)** `src/routes/DashboardPage.tsx`: pílula `camera-status` e dots glanceable via tokens.

### "A confirmar" da Onda A (para validar em runtime / Onda B)
- Modelo de previsão de alertas/dia assume sensibilidade padrão; calibrar com dados reais.
- Slider de confiança não reabre o gate fixo `people.scoreThreshold`; confirmar semântica.
- Heatmap é de ocupação de pessoas (não dwell/objetos); não persiste entre sessões.
- Camadas/confiança são estado só de sessão; confirmar se persistem por câmera.
- CSS legado `.dot-status`/`.badge.*`/`.tile.alerting` em `index.css` ainda usa tokens-base antigos (`--ok/--idle/--alert`); alinhar aos `--state-*` numa próxima passada (afeta a tela `/camera`).

## Onda B — Diferenciais de produto maduro (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` verdes. Contrato em `docs/analises/contrato-eventos-alarme.md`.
- **Backend de eventos (B1)** `server/events.js` (novo), `index.js`, `schema.sql`: store de eventos de alarme **só metadados (LGPD)**, cache+Postgres+fallback JSON (`alarms.json`, gitignored), retenção `ALARM_EVENTS_*`; `GET /api/alarms`, `POST /api/alarms/:id/{ack,forward}`, sockets aditivos `alarm-event`/`alarm-update`.
- **Cine-loop (B2)** `src/camera/cineBuffer.ts` (novo), `cine.css`, `CameraWorkspace.tsx`: congelar + revisar últimos ~10s com scrubber e snapshot por download local; buffer **em memória/efêmero**, nunca no servidor (LGPD).
- **Relatório↔eventos (B3)** `ReportPage.tsx`, `report/{store,mock,csv}.ts`, `alarms.css`: aba Alarmes, cards sem thumbnail, ligação bidirecional pico↔eventos, filtros, CSV.
- **Fila na central (B4)** `DashboardPage.tsx`, `api.ts`, `alarms.css`: drawer ao vivo (socket + listAlarms), acknowledge/forward otimista, going-gray por prioridade/estado, filtros e contador.

### "A confirmar" da Onda B
- Live update via socket no relatório (hoje só fetch on-load); buckets de dia em UTC vs local.
- Exportar clipe/GIF do cine-loop (hoje só snapshot PNG) — TODO marcado.
- Paginação da fila de alarmes (hoje limite 200/500 na carga); persistência de filtros.
- Confirmar entrada na sala `dashboards` por role (verificado em `index.js:259` — OK).

## Onda B parte 2 + Onda C (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` verdes.
- **Modo-como-preset (item 9)** `config.ts` (MODE_PRESETS), `CameraWorkspace.tsx`: trocar de modo recarrega camadas+confiança+métricas de destaque sem apagar zonas; badge de preset ativo + reaplicar.
- **RBAC Setup×Live (item 12)** `server/users.js`, `index.js`, `src/auth.tsx`, `api.ts`, `UsersPage.tsx`, `CameraWorkspace.tsx`: papel "engenheiro" + `canConfigure`; operador em só-leitura (vê ao vivo/overlays/telemetria/cine-loop, não edita config/zonas/tripwires).
- **Política de alarme madura (item 14)** `server/alarmPolicy.js`: shelving com expiração (curinga), métricas de taxa/% crítico com aviso EEMUA, anti-flapping; novas funções `shelve/unshelve/listShelved/metrics` e envs `ALARM_SHELVE_*`/`ALARM_RATE_*`/`ALARM_FLAP_*` (endpoints ficam para depois).
- **Views salvas + auto-surface (item 11)** `DashboardPage.tsx`, `views.css`: views por setor em localStorage (por usuário+host), seletor + gerenciador; auto-destaque por atividade (alarmes recentes ponderados + fps), coerente com paginação. **[REMOVIDO jul/2026 — commit `e0d6963`: Central simplificada, sem views/auto-destaque/limite-curto/demo. Persistência de views no backend (Onda E abaixo) também removida.]**
- **Telemetria lateral (item 10)** `src/components/Sparkline.tsx` (novo), `telemetry.css`, `CameraWorkspace.tsx`: "nunca número cru" — valor + sparkline + faixa-alvo com realce fora da banda.
- **Tripwires + ocupação (item 13)** `src/vision/counting.ts` (novo, lógica pura), `CameraWorkspace.tsx`: linhas de contagem com direção (in/out) persistidas por câmera, editor gated por RBAC, HUD de contagem, heatmap de ocupação unificado na camada existente.

### "A confirmar" da Onda B2/C
- Tripwires reusam `tracks`, que só ligam com zona de Atividade presente — confirmar se a linha deve, por si, ligar a detecção de pessoas.
- Faixas-alvo da telemetria (ocupação OCC_HI=8 etc.) são heurísticas — calibrar; sem meta para lidas/min e total de objetos.
- Auto-surface pode "pular" tiles quando o ranking muda (sem histerese); critério/janela a calibrar.
- alarmPolicy: shelving/métricas voláteis por processo (sem persistência/multi-instância); endpoints de shelve/metrics ainda não expostos no index.js.
- RBAC: coluna `papel` é texto livre (sem CHECK no schema) — "engenheiro" persiste sem migração.

## Onda D — Saúde de alarmes + export de clipe (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` verdes; contrato de métricas conferido.
- **Endpoints de alarme** `server/index.js`: `GET /api/alarms/metrics`, `GET /api/alarms/shelves` (logado), `POST /api/alarms/shelves`, `DELETE /api/alarms/shelves/:key` (perfil de engenharia via requireConfigurer), ligando a lógica já existente de `alarmPolicy.js`.
- **Tela Saúde de alarmes** `src/routes/AlarmHealthPage.tsx` (novo), `alarm-health.css`, `api.ts`, `main.tsx`, `AppShell.tsx`: rota `/alarmes-saude` (link só p/ canConfigure), KPIs glanceable (taxa/min, % crítico com faixa-alvo EEMUA), distribuição por prioridade, gestão de shelves (criar/remover com curinga), auto-refresh 7s.
- **Export de clipe** `src/camera/clipExport.ts` (novo), `cineBuffer.ts`, `CameraWorkspace.tsx`: "Exportar clipe" no modo revisão via MediaRecorder/WebM (fallback montagem PNG), download local efêmero (LGPD), liberação de recursos.

## Onda E — Persistência de views/tripwires no backend (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` + `node --check` verdes.
- **Camada de contrato** `server/camcfg.js` (novo), `index.js`, `schema.sql`, `src/api.ts`: store compartilhado (cache+Postgres+fallback JSON `camcfg.json`); `GET/PUT /api/views` (logado), `GET /api/tripwires/:cam` (logado) + `PUT` (perfil de engenharia); client `getViews/saveViews/getTripwires/saveTripwires`.
- **Views (B-front)** `DashboardPage.tsx`: views compartilhadas via backend (antes localStorage), com migração única best-effort do legado; prefs locais (activeView/autoSurface) seguem em localStorage.
- **Tripwires (B-front)** `CameraWorkspace.tsx`: tripwires por câmera compartilhados via backend, leitura p/ todos, escrita gated por canConfigure (PUT exige engenharia), migração única best-effort, salvar otimista com rollback.

### "A confirmar" da Onda E
- Concorrência multi-operador é last-write-wins (PUT da lista inteira); sem merge incremental.
- Tripwires/views só recarregam ao abrir/trocar câmera ou no mount (sem polling/socket) — edições de outro turno aparecem na próxima abertura.

## Onda F — Live-sync e persistência de shelves (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` + `node --check` verdes. Decisões em `docs/analises/decisoes/` (ADR-001..006).
- **Live-sync (ADR-006)** `index.js`, `DashboardPage.tsx`, `CameraWorkspace.tsx`: hub emite `camcfg-updated {kind:"views"|"tripwires",cameraId}` na sala dashboards após PUT; central recarrega views e propaga `tripwiresRev` por câmera às tiles; CameraWorkspace re-busca tripwires (pulando se em edição local). Last-write-wins.
- **Persistência de shelves** `alarmPolicy.js`: shelves ativas gravadas atômico em `alarm-shelves.json` (gitignored) e restauradas no init (expiradas descartadas); métricas seguem voláteis por design.
- **ADRs** `docs/analises/decisoes/`: registro de decisões retroativo + desta rodada (paralelização, LGPD, going-gray, política de alarme, persistência, live-sync).

## Onda G — Migração para Radix primitives (implementada)
Validação: `tsc` + `vite build` + `e2e 3/3` verdes. Plano em `docs/analises/frontend-radix/`, decisão em ADR-007.
- **Fase 0 (fundação)** `package.json`, `src/ui/*`: instala `@radix-ui/react-alert-dialog`, `react-slot`, `react-toggle`; cria wrappers `Tabs`, `ScrollArea`, `DropdownMenu`, `AlertDialog`, `Toggle`/`ToggleGroup`; padroniza `forwardRef`+`asChild`; hex→tokens em `ui.css`.
- **Fase 1 (telas, 8 frentes paralelas)**: CameraWorkspace/FadigaView (drawer→Tabs, modos→Toggle, listas→ScrollArea, title→Tooltip; casca fullscreen preservada), Dashboard (drawer de alarmes→Dialog, grid responsivo, ScrollArea), Report (abas→Tabs, ScrollArea, limpar histórico→AlertDialog), Users (window.confirm→AlertDialog, seções→Tabs, ScrollArea), Profile (chips→ToggleGroup), AlarmHealth (ScrollArea, AlertDialog), AppShell+main (ConfirmProvider, Tooltips).
- **Fase 2 (responsividade)** `index.css`, `ui.css`, `index.html`: `100dvh`, `viewport-fit=cover`+safe-area, container queries para painéis laterais, `min-width` em tabelas, alvos de toque ≥44px, breakpoints canônicos (sm640/md900/lg1200).

### "A confirmar" da Onda G
- Grid do Dashboard usa dois mecanismos (data-cols desktop + media queries mobile) — unificar em `--dash-cols` é follow-up.
- Drawer de alarmes usa CSS `:has()` (baseline 2023+).
- Ampliar e2e para cobrir Tabs/AlertDialog (hoje cobre Select-em-Dialog).

## Faxina de produto — pesquisa fora do main (2026-07-12)
Auditoria código-por-código do produto vivo (aprovada pelo dono): só ~17% de `src/fusion` tinha
consumidor no produto — o resto rodava no CI guardando afirmações científicas. O arco de pesquisa
sai do main (≈7,4k linhas-fonte + ≈11k de teste), preservado INTEIRO na tag git
`research-fusion-arc-2026-07-12`; o conhecimento permanece em `docs/cientifica/`, ADRs 012–015 e
`docs/analises/tags-bluetooth/PENDENCIAS.md`. Decisão registrada no **ADR-016**.
- **Deleções (pesquisa)**: ilhas de `src/fusion` (petri-conservation, zone-assignment, zone-crossing,
  visit-metrics, event-metrics, anchor-policy, error-geometry, receiver-geometry,
  receiver-at-destino.test, theta-discriminator, static-tracks-triage, residual-autocorr,
  label-memory, regime-reliability, memory-metrics, persistence-*, floor-plan, floor-plan-gain,
  evidence.ts) + motor test-only de `src/localizacao` (engine, fusion-engine, guarded-engine,
  motion-engine, replay, scenarios, recording, simulate, metrics).
- **Fica**: bancada `/replay` (ferramenta interna, gated canConfigure) e os testes do motor vivo
  (associate, identity-metrics, replay-fusion, gates-recalibration, shuffle-baseline, world-spec,
  funnel-session).
- **Órfãos removidos**: emit socket `bt-locations` (nunca consumido — o mapa usa polling HTTP),
  listener `set-capture` (nunca emitido; o `capture` hub→nó segue vivo via shed), `deleteBtTag`,
  `reading/cluster.ts`, `server/_zxing_roundtrip_test.cjs`.
- **Segurança**: `POST /api/bt/reading`, `POST /api/bt/tag-name` e `GET /api/bt/tags` exigem
  `BT_STATION_TOKEN` em produção (503 explicativo se ausente; dev aberto com warn no boot);
  `GET /api/bt/tags` aceita token OU sessão.
- **Rota nova**: `GET /api/cameras/connected` (requireAuth) para a busca do shell.
- **UX**: `setCameraCfg` propaga erro; Selects desabilitados sem `canConfigure`; OWL-ViT com latch
  de falha permanente.

## Pendências para evolução futura (não bloqueantes)
- Merge incremental de views/tripwires (hoje last-write-wins) para edição concorrente.
- Métricas de alarme voláteis por processo (sem coordenação multi-instância).
- **Validação visual em runtime** (sem ffmpeg/câmera real neste ambiente): só estático + e2e headless até aqui.
- Estilos inline de status/pager na Dashboard → promover a classes CSS.
- Confirmar key de scheduler para câmeras de fadiga/"operador" (hoje só `:atividade` é priorizada).
- Validar feeds demo com ffmpeg instalado (`winget install Gyan.FFmpeg`).
- Code-splitting dos workers grandes (detectWorker 1.8MB) — avisos de chunk.
- Considerar migrar persistência de câmeras p/ Postgres (hoje JSON).
- **Recomendado: `git init` + commit inicial** para criar rede de segurança.

## 2026-07-21 — Fadiga destravada (init lazy + self-host) e objetos focado em CAIXAS

**Fadiga (causa-raiz achada por leitura de código):** `FadigaView` fazia `useRef(new FadigaProcessor())`
— o argumento é avaliado em TODA renderização (~7×/s pela cadência de UI) e o construtor baixa
modelo + abre contexto WebGL ⇒ esgotava os ~16 contextos do Chrome em segundos e vazava GPU/heap
("modelo não carrega/lento", intermitente; o caminho por ZONA via holders sempre foi correto).
- `FadigaView.tsx`: init lazy (padrão useCineLoop) — 1 processor por montagem.
- `fadiga/models.ts`: retry 3× com backoff + log do erro REAL (antes morria em catch silencioso).
- `processors/fadiga.ts`: contexto no log de falha (face/mão) + 1º erro de `detectForVideo` logado
  (context-lost em campo deixava EAR congelado sem pista).
- **Self-host** dos assets MediaPipe (`scripts/fetch-mediapipe.mjs`, predev/prebuild →
  `public/mediapipe/`, gitignored): wasm copiado do node_modules (versão do lockfile — elimina o
  CDN `@latest`, que podia dessincronizar do JS empacotado) e `.task` baixados com sha256 pinado.
  Rede corporativa bloqueando CDN deixa de matar o sensor; CSP `'self'` já cobria.

**Objetos → caixas (passo 1 da contagem de caixas):**
- Default de zona objetos: `["caixa"]` (escolha explícita preservada em zonas antigas).
- Marcador da caixa = estilo do de Pessoa (`--state-info` + rótulo "Caixa" em scrim; SEM número
  sobre a imagem — contagem vive no painel). Exceção deliberada ao "cor = categoria" do catálogo.
- **Fim da supercontagem**: `finalizeOwlDets` (puro, com teste-gate) aplica o piso de score do
  chamador (o caminho OWL-ViT IGNORAVA `minScore`) + NMS IoU/contenção POR CLASSE — os 3 prompts
  de caixa disparavam 2-3 dets na MESMA caixa física.
- Próximo passo (decisão de produto pendente): contagem de FLUXO (tracker/tripwire de objetos) —
  hoje `counts` é ocupação instantânea; atenção à Regra 9 (cadência OWL-ViT ~700ms).

## 2026-07-25 — Overlay "tempo real percebido": Ondas 0+1 da spec-overlay-tempo-real

Spec nova: `spec-overlay-tempo-real.md` (reenquadramento honesto do "nem um milésimo de atraso":
o alvo verificável é a caixa sentar na pessoa NO QUADRO EXIBIDO + cadência máxima MEDIDA; os
limites físicos — entrada em cena ≥ cadência+inferência, skew de relógio entre máquinas — ficam
declarados na spec, não escondidos).

**Onda 1a — o painel de precisão volta a MANDAR no tracker do motor:**
- `engine.js`: `byteTrackerOpts()` (puro, exportado p/ teste) passa TODOS os knobs do
  `precision.js` ao `createByteTracker` — fecha o ⚠ WIRING dos knobs 23-26 (estado estacionário),
  que até aqui só coincidiam com os defaults internos do bytetrack.js (mudar o painel não mudava
  produção). Valores idênticos aos que já rodavam ⇒ zero mudança de comportamento HOJE; muda quem
  manda. Teste de fiação em `engine.test.js`; `eval:counting` (12 travessias + suite estacionária
  + torneio do ttl) verde.

**Onda 1b — paralelismo da focada deixa de ser inerte no host pequeno:**
- `engine.js`: `focusInflightFor()` (puro, testado) — o default `poolSize-1` dava maxInflight=1
  com pool=2 (4-core, o homolog), anulando a spec 09 exatamente onde o overlay mais atrasa.
  Piso 2 quando pool≥2 (custo declarado: com pool=2 a focada pode ocupar os 2 workers; as demais
  degradam por último-vence, sem backlog). `ANALYSIS_FOCUS_INFLIGHT` segue mandando.
- `deploy/visao-hub.service.example`: documenta `ANALYSIS_FOCUS_INPUT=512` (Onda 1c, opt-in
  validado no 07-*: 1,0→1,6fps na focada).

**Onda 0 — réguas de latência no HUD (a medição que autoriza a Onda 2):**
- `camera/cadence.ts` (novo, puro+teste): intervalo REAL entre payloads `analysis-tracks`
  distintos (EMA, dedupe por ts — re-leitura no rAF não encolhe a medição).
- `useFrameRelay.ts`: `bmpTs` — carimbo de chegada DO FRAME QUE ESTÁ NO BITMAP (não do último
  recebido: com decode em voo divergem; expor `f.ts` cru dessincronizaria o gate de frame-novo e
  mediria o frame errado). O getter expõe `ts` (campo que o FrameSource já previa).
- `draw.ts` (drawTelemetryHud): linhas `vid +Nms` (idade chegada→draw do frame exibido; satura
  >500ms), `trk Nms` e `hub Nms` (réguas neutras — going-gray). `CameraWorkspace`: fiação
  (~12 linhas; ratchet 1620→1632 com justificativa no size.test — o grosso está extraído).

Validação: `npm run verify` verde (1119 testes) + `npm run eval:counting` OK.
Residual: linha `vid` não existe no WebRTC (o <video> nativo não carimba ts — medir lá exige
`requestVideoFrameCallback`, fica p/ a Onda 2); o trânsito LAN segue estimado (~5-20ms), nunca
medido (skew). Ondas 2-4 especificadas e pendentes.

## 2026-07-25 — Env por arquivo: `.env` na raiz carregado pelo hub (fim do "setar no terminal")

- `server/env.js` (novo, SEM dependência — o nativo basta): parser puro + `load()` do `<raiz>/.env`,
  chamado na 1ª linha do `index.js` (ANTES dos módulos que leem env na carga: precision/rtsp/motion).
  **Precedência invariante:** ambiente real (terminal/systemd EnvironmentFile/CI) NUNCA é
  sobrescrito pelo arquivo — em produção o systemd segue a autoridade (nota no service.example).
  Workers forkados (D-FINE/fadiga) herdam o env já resolvido. Log só com CONTAGENS (nunca
  chave/valor — o .env carrega segredos). Testes: `server/env.test.js` (parser + precedência).
- `.env.example` (novo, versionado): o MAPA completo (~100 vars) agrupado por domínio — núcleo,
  auth/segredos, Postgres, RTSP/ffmpeg, shed, go2rtc, RTMP, motor de análise (com a fronteira
  qualidade→precision.js/D.10 anotada), fadiga-hub, alarmes, WhatsApp, control-plane, VITE_* do
  front (o Vite lê o MESMO .env; só VITE_* chega ao browser) e scripts. Tudo comentado = default.
- `.gitignore`: **faltava a entrada `.env`** (invariante de segredos do CLAUDE.md — fechado):
  `.env` + `.env.*` ignorados, `!.env.example` versionado.
- Validação: `npm run verify` verde (1125 testes) + smoke da precedência (PORT do terminal vence).

## 2026-07-25 — Tracking: "2 caixas na mesma pessoa" consertado no lugar CERTO (guarda por contenção)

**Bug de campo (dono):** dependendo da movimentação, o marcador perde o track ou marca 2 pessoas
onde há 1. Causa da duplicata encontrada por leitura + medição: a query duplicada do D-FINE é uma
caixa PARCIAL (cabeça/torso) CONTIDA na caixa inteira — IoU ~0.1-0.3 passa pelo NMS (0.6) E pela
guarda de nascimento do tracker (birthIou 0.55 mede sobreposição, não contenção) → nascia 2º track.

**Tentativa 1 (REJEITADA pelo gate — o sensor funcionou):** dedupe por contenção no NMS do squash
(paridade com fuseTiles/nms.ts do front). `npm run eval` reprovou: recall_all@0.25 caiu 4,4pp
(83,2% < 87,6%) — pessoa parcialmente contida em cena densa é gente REAL. Revertido; a decisão
ficou TRAVADA em teste (worker.test.js: "parcial contida NÃO é suprimida no squash") e documentada
no knob 4 do precision.js.

**Conserto (entrou):** 2º eixo na guarda de NASCIMENTO do tracker — `birthContainment` (0.7,
knob 8b do precision.js · `config.people.track.birthContainment` no front): det alta sem par com
contenção ≥0.7 contra track FRESCO (misses 0) não nasce — track livre é ATUALIZADO (recupera,
inclusive corrigindo track que nasceu da caixa parcial), ocupado descarta. O gate "track fresco"
preserva o contrato do 2º estágio ("tamanho INCOMPATÍVEL não re-associa" → id novo) — pego por
teste existente na 1ª versão e refinado. Nascido no front (vision/bytetrack.ts), port 1:1 no hub,
fiação nos dois painéis. Custo declarado: quem está ≥70% contido em outro (oclusão profunda) só
nasce ao se separar — mesma classe de trade-off do birthIou.

**Validação:** bytetrack.test.(ts|js) espelhados (4 casos novos cada) · `npm run eval` VERDE
(recall 92,6% ≥ 87,6%) · `npm run eval:counting` OK (12 travessias + estacionária + torneio) ·
`verify` verde. **Residual honesto:** o "perde o tracking" em movimento rápido é limitado por
CADÊNCIA (1fps grade / inferência na focada) — mitigado nesta mesma data por focusInflight piso 2
+ ANALYSIS_FOCUS_INPUT=512 + go2rtc; abaixo disso é física, não bug.

## 2026-07-25 — Ambiente local: go2rtc no macOS + .env com todos os recursos

- **Lentidão da webcam no mesmo dispositivo — causa:** sem `bin/go2rtc` (o fetch só tem asset
  win/linux), o probe WHIP falhava e o nó caía no JPEG-socket (encode 1280@12fps na main thread da
  aba + decode no dashboard + D-FINE, tudo na mesma CPU; aba em 2º plano ainda é estrangulada).
  **Fix:** binário go2rtc v1.9.14 darwin/arm64 (mesma versão pinada no fetch) instalado em
  `bin/go2rtc` — o hub auto-liga pela presença; webcam publica WHIP (encode por hardware, sem
  estrangulamento) e o transporte "auto" da tile resolve WebRTC.
- **`.env` criado (gitignored) com todos os recursos ativos:** WHATSAPP_ENABLED, ANALYSIS_ENABLED,
  ANALYSIS_FADIGA, RTMP_INGEST(+AUTO_ENROLL), ANALYSIS_GO2RTC_PULL, ANALYSIS_FOCUS_INPUT=512.
  WhatsApp exige pareamento por QR no 1º boot (wa-auth/). Modelo S baixado (sha ok) p/ o eval.

## 2026-07-25 — Ondas 2–4 da spec-overlay-tempo-real (execução PARALELA: 2 agentes + frente principal)

Paralelizado por PROPRIEDADE EXCLUSIVA DE ARQUIVO (doutrina §5); revisão e verify serializados
no estado combinado ao fim. `verify` verde (1143 testes; único warning de lint é pré-existente
em rtmp-ingest.js, fora das frentes).

**Onda 2 — mecanismo do overlay↔quadro (frente principal):**
- `TrackInterpolator.sample(now, videoLagMs)` — a extrapolação pode mirar o instante do QUADRO
  EXIBIDO (now − delay − lag) em vez do agora absoluto (CA-4: vídeo e overlay corriam em
  relógios diferentes; com vídeo atrasado a caixa LIDERAVA a pessoa na imagem). Clamp ≥0;
  fade/expiração seguem pela idade do DADO (teste trava: lag alto não apaga caixa fresca).
- Knob `APP_CONFIG.overlay.videoLagMs` {mjpeg, webrtc}, DEFAULT 0 = inerte — calibrar SÓ com
  medição (HUD `vid` + cronômetro filmado). Fiação: CameraWorkspace (por transporte, via
  webrtcRef) e TrackOverlay (grade WebRTC).

**Onda 3a — bancada INT8 (agente, medição pura, repo intocado):**
- `model_quantized.onnx` (uint8 dinâmico, 11,2 MB) PASSA o gate no fixture (f1 85,1% · recall
  92,6% · precisão 80,4% · 0 FP) **mas é MAIS LENTA que o fp32 nesta máquina arm64/M5:
  inferMs ~78 vs ~65–69 (+13–20%)** — quantização dinâmica no CPU EP ARM paga o
  quantize/dequantize por op. `model_int8.onnx` CRASHA o ORT 1.27 (SIGABRT no create).
  **VEREDITO: não entra.** Residual: repetir no homolog x86 (AVX2/VNNI pode inverter — hipótese);
  full-set não rodado (fixture 21+8).

**Onda 3b — WebRTC default: JÁ ENTREGUE POR DESIGN (constatação, zero código):**
- Default de câmera é `transport:"auto"`; `transportOf` resolve WebRTC quando o go2rtc serve o
  stream, com fallback+cooldown. O que faltava era o binário (instalado ontem no dev).

**Onda 4 — consistência (frente principal + agente):**
- `HUB_TRACKS_STALE_MS` unificado em `types/analysis.ts` (fonte única; re-export de compat em
  useHubAnalysis; TrackOverlay perdeu a cópia — o TODO antigo fechou).
- `analysis-fatigue` no padrão do `analysis-tracks` (fadiga-host.js): room `dashboards` +
  volatile + payload NEM MONTADO sem espectador (ingest fad/estado seguem 24/7, intocados);
  `latencyMs` clampado ≥0 (skew nó→hub). PUROS testáveis extraídos (hasDashboardViewers/
  buildFatiguePayload) + fadiga-host.test.js (shape do contrato travado).
- F1b da fadiga (cliente consumir o espelho servido) segue pendente — gateada pela validação
  lado a lado da spec-fadiga (Regra 11).

## 2026-07-25 — fetch-go2rtc ganha os assets darwin (mac-arm64/mac-amd64)

O binário do Mac tinha sido instalado À MÃO na sessão (irreproduzível — pendência declarada).
Catálogo ganhou os dois zips mac do MESMO release v1.9.14, sha256 pinado, extração pela rota de
zip que o win64 já usava + chmod +x da rota linux; detectPlatform resolve darwin. PROVA: binário
manual apagado e recriado do zero pelo script (sha ok, `go2rtc version 1.9.14 darwin/arm64`).
