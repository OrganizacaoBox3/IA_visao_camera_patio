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

## Pendências para evolução futura (não bloqueantes)
- **Onda B parte 2 (não feita):** modo-como-preset completo e telemetria lateral (valor+sparkline+faixa-alvo) na câmera — ambos residem em `CameraWorkspace.tsx` (serial após cine-loop).
- **Onda C (não feita):** views salvas por setor + auto-surface, RBAC Setup×Live, tripwires com direção + heatmap de ocupação, filosofia formal de alarme.
- Estilos inline de status/pager na Dashboard → promover a classes CSS.
- Confirmar key de scheduler para câmeras de fadiga/"operador" (hoje só `:atividade` é priorizada).
- Validar feeds demo com ffmpeg instalado (`winget install Gyan.FFmpeg`).
- Code-splitting dos workers grandes (detectWorker 1.8MB) — avisos de chunk.
- Considerar migrar persistência de câmeras p/ Postgres (hoje JSON).
- **Recomendado: `git init` + commit inicial** para criar rede de segurança.
