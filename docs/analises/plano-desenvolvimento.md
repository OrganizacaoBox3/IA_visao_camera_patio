# Plano de Desenvolvimento — Evolução do MVP

Plano-mestre que transforma as 4 análises (`docs/analises/`) em frentes de implementação,
com matriz de paralelização, contratos de integração e cronograma em ondas.

> ⚠️ **Sem controle de versão:** o projeto não é um repositório git. Não há revert
> fácil. Recomenda-se fortemente `git init` + commit inicial antes de editar em massa.
> Enquanto isso, os agentes editam de forma conservadora e incremental.

## Princípio de paralelização: propriedade exclusiva de arquivo

Três frentes (performance, UI, multi-câmera) competem pelos MESMOS arquivos. Para
paralelizar com segurança sem git/worktree, cada arquivo tem **um único dono**. As
mudanças cross-cutting de um arquivo são todas feitas pelo seu dono.

| Arquivo / área | Dono | Frentes que ali incidem |
|----------------|------|--------------------------|
| `src/CameraWorkspace.tsx`, `src/vision/*`, `src/processors/*`, `src/frame.ts`, `src/camera/*` | **A1** | Performance + scheduler (multi-câmera) + overlay ESC (UI) |
| `src/report/*`, `src/routes/{Report,Users,Profile}Page.tsx`, `src/api.ts`, `src/ui/*`, `src/auth.tsx`, `src/components/AppShell.tsx` | **A3** | UI/maturidade |
| `server/rtsp.js`, `server/index.js`, `server/cameras.js` (novo) | **A4** | Multi-câmera (backend) |
| `server/rtsp.sources.json` (novo), `scripts/*` (novo), runbook | **A5** | Câmeras demo |
| `src/config.ts`, `src/routes/DashboardPage.tsx`, `src/routes/CameraPage.tsx` | **A2** | Config + performance(feed) + UI(demo-10s/status) + multi-câmera(grade/seleção) |

A2 depende dos contratos de A1 e A4 → vai para a **Onda 2**.

## Cronograma em ondas

```
ONDA 1 (paralela — arquivos disjuntos)        ONDA 2 (após Onda 1)
┌─────────────────────────────┐               ┌──────────────────────────┐
│ A1 Pipeline & Performance   │──scheduler──┐ │ A2 Config + Dashboard +  │
│ A3 UI / Relatórios / Users  │             ├▶│    CameraPage            │
│ A4 Backend multi-câmera     │──contrato───┘ │  (consome A1+A4+A5)      │
│ A5 Câmeras demo (arquivos)  │──sources──────▶└──────────────────────────┘
└─────────────────────────────┘
ONDA 3: integração/validação (build, e2e, smoke test com stream demo)
```

---

## Frente A1 — Pipeline de Visão & Performance

**Objetivo:** acabar com lentidão/travamento. Ref.: `performance-diagnostico.md`.
**Arquivos:** `src/CameraWorkspace.tsx`, `src/vision/*`, `src/processors/*`, `src/frame.ts`, `src/camera/acquire.ts`.

Tarefas (ordem):
1. **Gate de frame novo** no loop rAF — pular tick quando o `ImageBitmap`/timestamp não mudou (corta 60–75% de trabalho). `CameraWorkspace.tsx:194,214,274`.
2. **Reuso de buffers de luma** (dois Float32Array com swap) — eliminar GC churn. `CameraWorkspace.tsx:215`, `leitura.ts:57`.
3. **coco-ssd fora da main thread + sem duplicar modelo** — aquecer fallback só sob falha do worker; afrouxar cadências de Fadiga/Objetos. `detect.ts:31-33`, `fadiga.ts:176`, `detector.ts:93`.
4. **Scheduler global de inferência** (singleton) — uma fila com prioridade para a câmera aberta, substituindo a guarda por-componente. `CameraWorkspace.tsx:220`. → **expõe contrato para A2** (como a Dashboard solicita/prioriza inferência).
5. **Overlay de câmera em tela cheia**: ESC + foco preso (item de UI residente aqui).

**Contrato exportado:** módulo de scheduler com API `requestInference(source, priority)` documentada no topo do arquivo do scheduler.
**Verificação:** `npx tsc --noEmit`.

## Frente A3 — UI / Relatórios / Usuários / Maturidade

**Objetivo:** comportar-se como produto maduro. Ref.: `auditoria-ui-ux.md`.
**Arquivos:** `src/report/*`, `src/routes/{Report,Users,Profile}Page.tsx`, `src/api.ts`, `src/ui/*`, `src/auth.tsx`, `src/components/AppShell.tsx` + novos `ErrorBoundary`/rota 404.

Tarefas:
1. **Erros de API visíveis no Relatório** — parar de engolir erro (`store.ts:20-21,128`); distinguir "erro ao carregar" de "vazio"; toast + estado de erro com retry.
2. **Estados loading/vazio/erro** padronizados nas telas de Relatório e Usuários.
3. **Promessas sem catch** em Usuários/Destinatários → tratar falha com feedback.
4. **Botão "Copiar"** com feedback (toast) e fallback fora de HTTPS.
5. **ErrorBoundary global + rota 404**; parar de vazar mensagens técnicas ("HTTP 500") ao usuário.
**Verificação:** `npx tsc --noEmit`.

## Frente A4 — Backend Multi-câmera

**Objetivo:** suportar muitas câmeras com robustez. Ref.: `conectividade-multicamera-rtsp.md`.
**Arquivos:** `server/rtsp.js`, `server/index.js`, novo `server/cameras.js`.

Tarefas:
1. **Health-check + reconexão com backoff** por stream ffmpeg (hoje retry fixo 3s).
2. **Status por câmera** (conectando/online/erro/fps) — evento socket `camera-status`.
3. **CRUD dinâmico de câmeras** (add/remove/list em runtime) persistido (DB/JSON), mantendo retrocompat com `rtsp.sources.json` no boot.
4. **Transporte flexível** (não forçar RTSP/TCP) para aceitar HLS/MJPEG dos feeds demo.
**Contrato exportado:** documentar eventos/endpoints novos em `docs/analises/contrato-multicamera.md` (para A2 consumir).
**Verificação:** `node --check` nos arquivos alterados; subir o hub e listar câmeras.

## Frente A5 — Câmeras Demo

**Objetivo:** ter feeds reais para demonstração. Ref.: `cameras-fontes-publicas-demo.md`.
**Arquivos (novos):** `server/rtsp.sources.json`, `scripts/validate-streams.mjs`, `docs/analises/runbook-demo-cameras.md`.

Tarefas:
1. Gerar `rtsp.sources.json` a partir do catálogo (seguindo o schema de `rtsp.sources.example.json`), começando pelos streams **verificados** (Wowza RTSP, Mux HLS).
2. Script de validação que testa cada URL com ffmpeg/ffprobe e reporta OK/falha.
3. Runbook: como adicionar uma câmera demo e validar o pipeline ponta-a-ponta.
**Verificação:** rodar o script de validação contra os feeds verificados.

## Frente A2 — Config + Central + Câmera-nó (ONDA 2)

**Arquivos:** `src/config.ts`, `src/routes/DashboardPage.tsx`, `src/routes/CameraPage.tsx`.
Depende de: A1 (scheduler), A4 (contrato de status), A5 (sources).

Tarefas:
1. **Demo "Limite 10s" desligado por padrão** em produção (`config.ts:44`, `DashboardPage.tsx:28`) — flag ligável só em modo demo.
2. **Performance de feed**: ajustar qualidade/tamanho do JPEG no envio (`CameraPage.tsx`) e otimizar decode/draw (`DashboardPage.tsx`).
3. **Paginação/seleção de feeds** na central + **grade adaptativa**; processar inferência só dos feeds visíveis/selecionados (usa scheduler de A1).
4. **Status por câmera na UI** (consome `camera-status` de A4); status do nó refletindo o socket real.

## Onda 3 — Integração & Validação

- `npm run build` (tsc + vite) verde.
- `npm run e2e` (Playwright) — corrigir regressões introduzidas.
- Smoke test: subir hub com `rtsp.sources.json` demo, abrir central, ver 1–2 feeds, validar que inferência roda sem travar.

## Matriz de dependências (resumo)

| Frente | Pode iniciar | Bloqueada por | Bloqueia |
|--------|--------------|---------------|----------|
| A1 | já | — | A2 (scheduler) |
| A3 | já | — | — |
| A4 | já | — | A2 (contrato) |
| A5 | já | — | A2 (sources), Onda 3 |
| A2 | Onda 2 | A1, A4, A5 | Onda 3 |
| Onda 3 | após A2 | todas | entrega |
