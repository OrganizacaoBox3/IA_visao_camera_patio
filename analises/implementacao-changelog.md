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
- `analises/contrato-multicamera.md` (novo): contrato consumido pela A2.

## A5 — Câmeras Demo
- `server/rtsp.sources.json` (novo): 3 fontes verificadas (Wowza RTSP, BBB HLS, Tears of Steel HLS).
- `server/rtsp.sources.extra.example.json` (novo): 5 fontes não verificadas opcionais.
- `scripts/validate-streams.mjs` (novo): valida feeds via ffprobe/ffmpeg (degrada se ausente).
- `analises/runbook-demo-cameras.md` (novo): passo-a-passo + nota legal/LGPD.

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
Validação: `tsc` + `vite build` + `e2e 3/3` verdes. Contrato em `analises/contrato-eventos-alarme.md`.
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
- **Views salvas + auto-surface (item 11)** `DashboardPage.tsx`, `views.css`: views por setor em localStorage (por usuário+host), seletor + gerenciador; auto-destaque por atividade (alarmes recentes ponderados + fps), coerente com paginação.
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

## Pendências para evolução futura (não bloqueantes)
- Shelving/métricas de alarme são voláteis por processo (sem persistência/multi-instância).
- Sincronização ao vivo (socket) de views/tripwires entre operadores (hoje só on-load).
- **Validação visual em runtime** (sem ffmpeg/câmera real neste ambiente): só estático + e2e headless até aqui.
- Estilos inline de status/pager na Dashboard → promover a classes CSS.
- Confirmar key de scheduler para câmeras de fadiga/"operador" (hoje só `:atividade` é priorizada).
- Validar feeds demo com ffmpeg instalado (`winget install Gyan.FFmpeg`).
- Code-splitting dos workers grandes (detectWorker 1.8MB) — avisos de chunk.
- Considerar migrar persistência de câmeras p/ Postgres (hoje JSON).
- **Recomendado: `git init` + commit inicial** para criar rede de segurança.
