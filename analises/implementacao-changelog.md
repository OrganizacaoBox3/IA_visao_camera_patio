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

## Pendências para evolução futura (não bloqueantes)
- Estilos inline de status/pager na Dashboard → promover a classes CSS.
- Confirmar key de scheduler para câmeras de fadiga/"operador" (hoje só `:atividade` é priorizada).
- Validar feeds demo com ffmpeg instalado (`winget install Gyan.FFmpeg`).
- Code-splitting dos workers grandes (detectWorker 1.8MB) — avisos de chunk.
- Considerar migrar persistência de câmeras p/ Postgres (hoje JSON).
- **Recomendado: `git init` + commit inicial** para criar rede de segurança.
