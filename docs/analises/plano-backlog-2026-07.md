# Análise do Backlog (jul/2026) — pela lente do CLAUDE.md

> Análise dos 7 itens com prazos. Evidência do código real (não memória). *Nada foi alterado.*
> Hoje: 01/07. Legenda esforço: baixo/médio/alto. Muitos itens já estão parcial/totalmente feitos.

## Resumo executivo (o que já existe vs. o gap real)
| # | Item | Prazo | Estado atual | Gap real | Esforço restante |
|---|------|-------|--------------|----------|------------------|
| 1 | Pipeline de deploy | 30/06 ⚠️ vencido | Só **CI** (`ci.yml` verify). Sem CD, **sem git remote** | Automatizar publish+restart | médio (+ infra/humano) |
| 2 | Performance da dash | 30/06 ⚠️ vencido | **Grande parte FEITA** (Onda 1) | Ganhos incrementais medidos | médio (gated em runtime) |
| 3 | Câmeras IP (rede) | 01/07 | **Backend PRONTO** (rtsp+CRUD+status); **sem UI** | Tela de cadastro (front) | médio |
| 4 | Layout responsivo + a11y | 01/07 | Radix + R3 (dvh/safe-area/container queries/touch) | Auditoria a11y + polish | médio (a11y gated em browser) |
| 5 | Persistência de config | 01/07 | Views+tripwires já no **backend** (camcfg) | Mover **zonas + config de câmera** p/ backend | médio |
| 6 | Menu lateral | 03/07 | AppShell rail+bottom-nav existe | Polimento UX (subset do #4) | baixo |
| 7 | Guia de usuário por tela | 03/07 | Não existe guia in-app | Criar guia (doc e/ou ajuda contextual) | baixo–médio |

---

## 1. Pipeline de deploy — 30/06 (não iniciado)
**Estado:** existe só `.github/workflows/ci.yml` (roda `verify`) e `deploy/nginx-visao.conf` + `deploy/visao-hub.service.example`; doc `docs/produto/deploy-digitalocean.md`. **Não há remote git nem job de deploy (CD).**
**Gap:** publicação automatizada no merge (build front → publicar `dist` + reiniciar o hub).
**Abordagem (doutrina):** (a) criar **remote GitHub**; (b) job de deploy no Actions via SSH ao droplet: `git pull`/`rsync dist` → `npm ci` → `systemctl restart visao-hub`, com **gate `verify` verde** antes; segredos (SSH key, host) em **GitHub Secrets** (nunca no repo); reusar o `visao-hub.service`. Alternativa mais simples: `deploy.sh` idempotente disparado manualmente.
**Bloqueadores (§8 gate antes de irreversível):** deploy é ação sensível → **não publicar antes de (i) rotacionar a senha PG/`AUTH_SECRET` expostos e (ii) decidir o merge da branch `chore/transformers-migration`.** Depende de acesso à infra (humano).
**Risco:** médio. **Prazo:** vencido; realista em ~1 dia com acesso à infra.

## 2. Performance da visualização na dash — 30/06 (majoritariamente feito)
**Estado (Onda 1, já entregue):** gate de "frame novo", scheduler global de inferência, reuso de buffers de luma, **paginação — só a página visível decodifica e roda inferência** (`feedsPerPage`), liberação de `ImageBitmap` de feeds inativos, JPEG reduzido (960px/12fps/q0.75).
**Gap:** ganhos incrementais que **exigem medição em runtime** (headless não mede): decode em `OffscreenCanvas`/worker, `createImageBitmap` com `resizeWidth`, `requestVideoFrameCallback`, throttle de draw, backend WebGL/WASM do TFJS.
**Abordagem (§2.5 honestidade):** **instrumentar** FPS/tempo-de-decode/heap → medir com N câmeras reais → otimizar o gargalo **medido**, não às cegas.
**Risco:** baixo. **Prazo:** o essencial já foi entregue; o refino depende de profiling seu no navegador.

## 3. Configuração e acesso a câmeras IP (RTSP) — 01/07
**Estado:** **backend pronto** — `server/rtsp.js` (ingest ffmpeg, backoff, health-check, transporte flexível RTSP/HLS/MJPEG), `server/cameras.js` (persistência), endpoints **`GET/POST/PATCH/DELETE /api/cameras`** (auth superadmin), evento `camera-status` já consumido no Dashboard. **Verifiquei: NÃO há UI chamando `/api/cameras`.**
**Gap:** **só a interface** — tela/form para cadastrar/editar/remover câmera IP (label, URL, transporte, fps/width/quality) consumindo os endpoints; o status (connecting/online/error/fps) já aparece nos tiles.
**Abordagem:** client em `api.ts` (`listCameras/createCamera/updateCamera/deleteCamera`) + seção "Câmeras IP" (aba em Usuários **ou** nova rota `/cameras`, gated engenheiro/superadmin) + validação de URL. **Requisito operacional:** ffmpeg no servidor (já instalado localmente).
**Risco:** baixo (backend já validado). **Prazo:** 01/07 viável. **Paraleliza** bem (arquivos front próprios + `api.ts`).

## 4. Layout geral responsivo + acessibilidade — 01/07
**Estado:** Radix migrado (Onda G) + R3: `100dvh`, `viewport-fit`/safe-area, **container queries** p/ painéis laterais, `min-width` em tabelas, alvos de toque ≥44px, going-gray unificado, ErrorBoundary/404/toasts, skip-link, `:focus-visible`, `prefers-reduced-motion`.
**Gap:** **auditoria a11y formal** (axe/Lighthouse — precisa de browser/runtime) para contraste/aria/ordem de foco/teclado; ajustes finos mobile/tablet remanescentes; **overlap com o item 6** (menu).
**Abordagem:** rodar axe/Lighthouse na app rodando → corrigir achados priorizados. O estrutural já está; falta o audit dirigido por ferramenta.
**Risco:** baixo/médio. **Prazo:** 01/07 parcial (estrutural pronto; a11y audit depende de runtime).

## 5. Persistência de config de câmera e dashboard — 01/07
**Estado (evidência do grep):** já no **backend** (`server/camcfg.js`): **views** e **tripwires** (por câmera, compartilhados). Ainda em **localStorage** (por navegador, não compartilhado): **zonas** (`zones.ts`), **config/thresholds de câmera** (`cameraConfig.ts`), **calibração de fadiga** (`fadiga/calibration.ts`), **prefs de dashboard** (`activeView`/`autoSurface`).
**Gap:** mover **zonas** e **config de câmera** (e opcionalmente calibração) para o backend (camcfg), para sobreviver a troca de navegador/operador — exatamente como views/tripwires já fazem. Prefs pessoais podem ficar locais.
**Abordagem:** estender `camcfg.js` (+ endpoints `GET/PUT /api/zones/:cam`, `/api/camconfig/:cam`) + migração única best-effort do localStorage (padrão **ADR-005/006** já estabelecido).
**Risco:** médio (zonas são centrais — cobrir com os testes de `zoneMask` + e2e). **Prazo:** 01/07 apertado, mas o padrão já existe (reuso). **Paraleliza** (backend camcfg + `zones.ts`/`cameraConfig.ts`).

## 6. Melhoria do menu lateral — 03/07
**Estado:** `AppShell.tsx` tem rail (desktop) + bottom-nav (mobile), links por papel, skip-link, foco no `<main>`.
**Gap:** UX — estados ativos mais claros, ícones+rótulos consistentes, colapsar/expandir, **menu do usuário** (DropdownMenu p/ Perfil/Sair), agrupamento de seções.
**Abordagem:** refinar `AppShell.tsx` + css. É **subconjunto do item 4**.
**Risco:** baixo. **Prazo:** 03/07 folgado. **Paraleliza** (AppShell + css próprios).

## 7. Guia de usuário step-by-step por tela — 03/07
**Estado:** **não existe** guia in-app. Há `docs/produto/manuais/` (câmera RTSP/leitores) e `docs/arquitetura/` (técnica), nada voltado ao usuário final por tela.
**Gap:** guia por tela — Central, Câmera, Relatório, Saúde de alarmes, Usuários, Perfil.
**Abordagem:** (a) **doc markdown por tela** em `docs/produto/guia-usuario/` (rápido, zero código) + botão "?" que abre a ajuda da tela; ou (b) **tour/coach-marks in-app** (mais valor, mais trabalho). Recomendo começar por (a) e evoluir para (b).
**Risco:** baixo. **Prazo:** 03/07 viável para (a). **Paraleliza** total (docs não conflitam com código; ou um componente `Help` novo).

---

## Plano de execução (paralelização por propriedade de arquivo)
Quando formos codar (mesmo modelo de ondas):
- **Paralelo (disjuntos):** #3 (UI câmeras: `api.ts` + rota/aba própria) ‖ #5 (backend `camcfg.js` + `zones.ts`/`cameraConfig.ts`) ‖ #6 (AppShell) ‖ #7 (docs `docs/produto/guia-usuario/`).
- **Depois/parcial:** #4 a11y (precisa audit em browser; parte overlap com #6) · #2 refino (precisa profiling runtime) · #1 deploy (precisa **remote + rotação de credenciais + infra**).
- **Contratos:** #3 e #5 tocam `api.ts` — se paralelos, um agente é dono de `api.ts` (aditivo) e o outro consome; ou sequencia a camada de contrato primeiro (padrão já usado).

## Sequência sugerida (respeitando prazos e gates)
1. **Hoje (01/07):** #3 (UI câmeras — backend pronto) + #5 (persistência — padrão pronto) em paralelo; iniciar #7(a) docs.
2. **02–03/07:** #6 (menu) + #4 (a11y audit no browser) + finalizar #7.
3. **#1 deploy:** desbloquear com **rotação de credenciais** (sua) + **criar remote** + decidir merge da branch transformers; então montar o CD.
4. **#2:** instrumentar e medir no seu ambiente; otimizar o gargalo medido.

## Bloqueadores que dependem de você (humano)
- 🔴 **Rotacionar** senha PG + `AUTH_SECRET` (pré-requisito de deploy seguro).
- 🔴 **Criar o remote GitHub** (pré-requisito do CD).
- 🟡 **Runtime-test** do modo Objetos (branch transformers) e do refino de performance.
- 🟡 Acesso à infra (droplet DigitalOcean) para o deploy.
