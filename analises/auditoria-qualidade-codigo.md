# Auditoria de qualidade de código — parecer consolidado (jul/2026)

> 7 revisores em paralelo, cada um sobre uma frente, contra uma rubrica de clean code (nomes, SRP,
> funções curtas, DRY sem dogma, comentário-porquê, TS strict, código morto, contratos, Radix/tokens,
> testabilidade, consistência, LGPD). Ancorado em `CLAUDE.md` + `../agentes/` (PRATICAS_ENGENHARIA,
> PADRAO_FRONTEND) + Clean Code / A Philosophy of Software Design / Refactoring. **Leitura, sem alterar código.**

## Notas por frente

| Frente | Nota | Puxa a nota |
|---|---|---|
| **ui/ + api + auth** | **8,3** | fundação sólida; wrappers Radix uniformes; TS strict impecável |
| **Visão / processadores** | **8,0** | libs puras testadas com rigor; alguns dead-config e funções longas |
| **Back core (hub)** | **7,8** | maduro; vazamento de credencial e robustez de erro |
| **Motor de análise** | **7,5** | `alarm/` exemplar; `engine.js` god-module sem teste |
| **Rotas & telas** | **7,3** | painéis de Relatório modelo; `ReportPage` god-component; dedup residual |
| **Dashboard** | **6,5** | filhos ótimos; `DashboardPage` god-component |
| **CameraWorkspace + render** | **5,5** | `CameraWorkspace.tsx` = 2832 linhas, ~10 responsabilidades |

**Média ponderada ≈ 7,3/10 — código saudável, pronto para produção, com dívida concentrada e bem entendida.**

## O que está SÓLIDO (preservar — é a identidade do código)

- **Comentário-porquê**: nota 9-10 em quase todas as frentes. Explicam decisão/contrato/LGPD, não o óbvio. Referência.
- **TS strict de verdade**: zero `any` na maioria das frentes; type-guards antes de cast; uniões discriminadas em `ui/`.
- **Contratos socket aditivos**: rooms/`watch`/`analysis-*` estritamente aditivos e retrocompatíveis. Invariante nº3 respeitada com rigor.
- **LGPD**: frames efêmeros comentados em cada ponto de aquisição; nada persistido além de metadados. Blindado por design.
- **Libs puras testadas** (`nms`, `bytetrack`, `counting`, `interpolate`, `filterExcludedPersons`): cada trade-off documentado E coberto por teste com o cenário de campo que motivou o número.
- **Módulos exemplares**: `server/alarm/` (9 módulos coesos), `src/ui/` (18 wrappers uniformes), `draw.ts`/`cineBuffer.ts`/`useCineLoop.ts` (extração-modelo), painéis de Relatório (`chrome`/`KpiRow`/`Heatmap`…).

## Smells RECORRENTES (dívida cruzada, ranqueada)

- **S1 — God components/módulos** (o maior): `CameraWorkspace.tsx` (2832 L), `DashboardPage.tsx` (~965 L), `ReportPage.tsx`, `engine.js` (938 L), `index.js` (423 L). Acúmulo natural da maratona; já previsto no CLAUDE.md §6 (R2).
- **S2 — Lógica pura presa em closures / sem teste**: `transportOf`, `activityScore`, `scheduler.ts`, auto-máscara e go2rtc-pull do `engine.js`, helpers de janela do `store.ts`, filtros do `ReportPage`. Fere o DoD (§6/§7: lógica pura vira teste).
- **S3 — Densidade de comentário**: blocos de 8-18 linhas por constante; **narrativa histórica/changelog no código** ("antes valia…", "BUGFIX jul/2026") que pertence ao ADR/git e vai apodrecer contra o código.
- **S4 — Duplicação real**: `H2_SEC` ×7 (o átomo `SectionTitle` já existe), `cx()` ×13, cliente de alarmes ×2 (`store.loadAlarms`×`api.listAlarms`), derivação de janela ×5, filtro-por-período ×4, IoU ×2.
- **S5 — Consistência de token/estilo**: dois vocabulários (`--ok/--idle/--alert` × `--state-*`); **verde-para-bom sobrevive fora de Atividade** (fere going-gray); `style={{}}` inline com px cru vs `cine.css`; cores hex hardcoded em `draw.ts`.
- **S6 — Sprawl de config / dead-config**: `objectIntervalMsTile` morto (verdade viva é `4000` mágico no componente); `trackMaxDist`/`trackTimeoutMs` legado; auto-máscara com 7 envs para feature observe-only; telemetria `recvFps`/`dropped` **write-only** (custo no hot-path sem consumidor).

## Achados de RISCO real (não só manutenção)

| # | Risco | Onde | Sev |
|---|---|---|---|
| **R1** | **Vazamento de credencial**: stderr do ffmpeg cru em `lastError` → broadcast a todos os painéis via `camera-status`; URL RTSP com `user:pass@` vaza. `redact()` só no log. | `server/rtsp.js:247-278` | **ALTA** |
| **R2** | `readBody` nunca resolve no overflow (`destroy()` sem `end`) → handler trava para sempre (DoS leve). | `server/index.js:38-47` | MÉDIA |
| **R3** | `catch {}` cego → **400 para todo erro** (inclusive bug/500 de server), sem log. Mascara defeito. | `server/index.js:107-120` | MÉDIA |
| **R4** | `persistViews` não-transacional (delete-all + N inserts) → falha parcial deixa views vazias. | `server/camcfg.js:154-166` | MÉDIA |
| **R5** | Leak do mapa `pulls`: stream que sempre falha nunca é podado (cresce sem teto). | `server/analysis/engine.js:665-756` | BAIXA |
| **R6** | `Holder` união NÃO-discriminada → ~8 casts `as XProcessor`; pareamento modo↔proc errado não é pego pelo compilador. | `CameraWorkspace.tsx:208-211` | MÉDIA |

## Plano de refactor priorizado (pequeno, reversível, sem quebrar contratos/ADRs)

### Onda A — Quick wins (baixo risco, alto ROI) — dias
- **R1 fix** (segurança, prioritário): `redact()` no `lastError`/`lastStderr` antes de emitir.
- **R2/R3 fix**: `readBody` resolve/rejeita no overflow + `close/error`; wrapper HTTP loga e distingue 400 (parse) de 500 (interno).
- **Dedup barata**: `SectionTitle`→`src/ui/` (mata `H2_SEC` ×7); `cx`→`src/ui/cx.ts` (×13).
- **Dead-config**: remover `objectIntervalMsTile`, `trackMaxDist`/`trackTimeoutMs` mortos; decidir `recvFps`/`dropped` (expor no HUD OU remover — YAGNI); enxugar envs da auto-máscara (fixar grid/janela).

### Onda B — Extrair lógica pura + testar (fecha o gap do DoD)
- Módulos puros exportados + Vitest: `scheduler.ts` (prioridade/coalescência), `engine`→`automask.js` (Welford) e `go2rtc-source.js` (resolve R5), `store` window-helpers, `dashboard/transport.ts` (`transportOf`) e `autoSurface.ts` (`activityScore`), `ReportPage` filtros→`report/store`.

### Onda C — God components (a onda R2 do CLAUDE.md; a maior)
- `CameraWorkspace`: extrair 5 abas do drawer → componentes; `useWebrtcTransport`, `useHubAnalysis`; sub-passos puros do rAF. Alvo ~1200-1400 L. **Não** move o rAF nem vira Radix Dialog (ADR-007 intacto).
- `DashboardPage`: `useDashboardSocket`, `useFrameRelay`, `useVideoTransport`, `useSavedViews`, `useAlarms`. Alvo ~150-200 L.
- `engine.js`: `model.js`, `worker-host.js`, `automask.js`, `go2rtc-source.js`. Alvo ~400 L de orquestração.
- `ReportPage`: builders de CSV por modo → `report/csv.ts`. `index.js`: `shed.js` + `http-auth.js`.

### Onda D — Consistência
- Unificar token semântico em `--state-*`; aplicar going-gray onde ainda pinta verde-para-bom (`Leitura`/`Fadiga`); `Holder` discriminado (mata R6 + os casts); mover `style` inline p/ `cine.css`; cores de `draw.ts` via `cssVar`.

## Veredito
Código **maduro e honesto** — a acreção de dívida (god components, densidade de comentário, dedup residual) é o esperado de uma maratona de features, e as **fundações são fortes** (contratos, tipos, LGPD, libs puras testadas, módulos-modelo). Prioridade: **R1 (segurança) já**, Onda A (limpeza barata), Onda B (fecha o débito de teste), e a Onda C (god components) como o retrofit R2 planejado. Nenhum bug funcional bloqueante foi encontrado.
