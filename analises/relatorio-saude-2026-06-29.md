# Relatório de Saúde — visao_computacional_mvp

**Data:** 2026-06-29  
**Método:** workflow de auditoria paralela (8 agentes, 348k tokens, 155 tool calls, ~7.5min)  
**Referência cruzada:** cd_analytics recebeu 4.7/10 antes do retrofit (2026-06-28)

---

## Scorecard

| Dimensão | Nota | Status |
|---|---|---|
| Segurança & LGPD | 5.5/10 | ⚠️ ATENÇÃO |
| Qualidade Backend | 6.5/10 | ⚠️ ATENÇÃO |
| Qualidade Frontend & TypeScript | 7.5/10 | ✅ BOM |
| **Testes & Verificação** | **2.0/10** | **🔴 CRÍTICO** |
| **Tooling & CI** | **2.5/10** | **🔴 CRÍTICO** |
| Documentação & Processo | 5.5/10 | ⚠️ ATENÇÃO |
| Arquitetura & Contratos | 7.0/10 | ✅ BOM |
| **Global (pond.: Seg×2, Testes×1.5)** | **5.1/10** | ⚠️ ATENÇÃO |

---

## Sumário Executivo

O `visao_computacional_mvp` apresenta um **perfil dividido**: arquitetura e design são exemplares — hub relé puro, LGPD local-first genuíno com zero frames no servidor, TypeScript strict com `tsc` zero erros, 7 ADRs e `alarmPolicy` ISA-18.2/EEMUA 191 — mas **tooling e testes estão em estado crítico** com notas 2.0 e 2.5.

A nota global 5.1/10 é puxada para baixo pela ausência total de unit tests para lógica de missão crítica (`counting.ts`, `predict.ts`, `alarmPolicy.js`), falta de ESLint/Prettier e inexistência de CI — todos itens declarados como **Onda 0 aberta no próprio CLAUDE.md** há mais de um ciclo.

Um deploy em produção hoje exporia a operação a regressões silenciosas na lógica de contagem e alarme, além de fallbacks hardcoded de `AUTH_SECRET` e `SUPERADMIN_PASSWORD` que permitem forjamento de tokens e bypass de senha caso o `.env` esteja ausente.

O projeto está **a um sprint focado de atingir maturidade de produção**: a infraestrutura Playwright E2E com webcam fake e o TypeScript strict já estão no lugar — o trabalho restante é de disciplina e cobertura, não arquitetural.

---

## P0 — Críticos (bloqueiam produção/segurança)

### P0-TEST-01 — Zero unit tests para lógica crítica de negócio
**Arquivos:** `src/vision/counting.test.ts`, `src/report/predict.test.ts`, `server/alarmPolicy.test.js` (criar)  
**Por quê agora:** `counting.ts`, `predict.ts` e `alarmPolicy.js` são o coração do produto — deduplicação de alarmes, contagem de objetos e predição de tendência. Uma regressão nessas funções não seria detectada antes de chegar ao CD. São funções puras e closure-based, testáveis em total isolamento — o custo de não ter cobertura aqui é desproporcional ao esforço de criá-la.

### P0-TEST-02 — Fluxo de alarme completamente sem cobertura E2E
**Arquivos:** `e2e/alarm-flow.spec.ts` (criar)  
**Por quê agora:** O fluxo alarme (detecção → evento → emissão socket → painel → acknowledge) é o caminho de maior valor operacional do sistema e não tem nenhum teste E2E. A infraestrutura Playwright com webcam fake já está configurada e pronta — a ausência de cobertura é um gap de execução, não de infraestrutura.

### P0-TOOL-01 — ESLint e Prettier ausentes (gap Onda 0 declarado)
**Arquivos:** `eslint.config.js`, `.prettierrc`, `package.json` (scripts lint/format)  
**Por quê agora:** Declarados como dívida técnica aberta no CLAUDE.md há mais de um ciclo. Sem lint, erros de estilo e bugs estáticos entram silenciosamente no main. Com TypeScript strict já ativo, adicionar ESLint é o passo de menor custo e maior retorno disponível.

### P0-TOOL-02 — Nenhum pipeline de CI (GitHub Actions inexistente)
**Arquivos:** `.github/workflows/ci.yml` (criar)  
**Por quê agora:** Sem CI, qualquer PR pode quebrar `tsc`, build ou playwright sem detecção automática. O setup Playwright com global-setup/teardown e credenciais fixas foi explicitamente engenheirado para CI headless — não usá-lo é desperdiçar um ativo já construído.

### P0-SEC-01 — `AUTH_SECRET` e `SUPERADMIN_PASSWORD` com fallbacks hardcoded
**Arquivo:** `server/users.js` linhas 17 e 75  
**Por quê agora:** Se o `.env` estiver ausente em qualquer deploy, `AUTH_SECRET` público torna tokens HMAC forjáveis e `SUPERADMIN_PASSWORD 'admin@box3'` é uma senha conhecida. A correção é trivial (`process.env.X ?? process.exit(1)`) e o risco é crítico em produção.

---

## Plano de Retrofit

### P0 — Imediato (~1 semana)
- [ ] Criar `src/vision/counting.test.ts` — núcleos de contagem, cooldown, reset de zona
- [ ] Criar `src/report/predict.test.ts` — tendência crescente, estável e queda com `sensitivityFactor` variável
- [ ] Criar `server/alarmPolicy.test.js` — deduplicação, flood suppression, prioridade ISA-18.2, shelving, anti-flapping
- [ ] Criar `e2e/alarm-flow.spec.ts` — detecção → alarm-event socket → painel → acknowledge → estado limpo
- [ ] Configurar ESLint com `typescript-eslint` strict + plugin `react-hooks` + plugin `import`
- [ ] Configurar Prettier com `eslint-config-prettier`
- [ ] Adicionar scripts: `lint`, `format`, `typecheck`, `test:unit`, `verify`

### P1 — Curto Prazo (~2 semanas)
- [ ] Criar `.github/workflows/ci.yml` — jobs: `typecheck`, `lint`, `build`, `e2e`
- [ ] `server/users.js` L17: remover fallback `AUTH_SECRET`; `process.exit(1)` se ausente
- [ ] `server/users.js` L75: remover fallback `SUPERADMIN_PASSWORD`; idem
- [ ] Rate limiting em `POST /api/login` — máx 10 tentativas/min por IP com resposta 429
- [ ] Configurar `husky` + `lint-staged` — pre-commit roda ESLint + Prettier nos arquivos staged
- [ ] Adicionar `verify` ao package.json: `tsc --noEmit && vite build && playwright test`
- [ ] Criar `.env.example` documentando todas as variáveis obrigatórias

### P2 — Médio Prazo (~3-4 semanas)
- [ ] Refatorar `CameraWorkspace.tsx` (1366 linhas): extrair `CameraStream`, `AlarmQueuePanel`, `ControlBar`
- [ ] Refatorar `server/index.js` (377 linhas, SRP violado): extrair rotas para `server/routes/` e middlewares para `server/middleware/`
- [ ] Substituir `console.*` em server/ por pino com nível configurável via `LOG_LEVEL`
- [ ] Investigar e documentar evento `set-capture`: nunca emitido pelo frontend — feature morta ou decisão?
- [ ] Atualizar `docs-regenerada/` para cobrir Ondas B a G
- [ ] Documentar rotação de credencial Postgres em `deploy/visao-hub.service`
- [ ] Avaliar expurgo do histórico git para eliminar hash scrypt do superadmin em commit `529512b` (`git filter-repo`)

---

## Achados Detalhados por Dimensão

### Segurança & LGPD (5.5/10)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| P1 | `AUTH_SECRET` com fallback público hardcoded | `server/users.js:17` — tokens HMAC forjáveis se `.env` ausente |
| P1 | `SUPERADMIN_PASSWORD` com default `'admin@box3'` | `server/users.js:75` — senha conhecida se `.env` ausente |
| P1 | Sem rate limiting no `/api/login` | `server/index.js:61-65` — brute force irrestrito |
| P1 | Hash scrypt do superadmin no histórico git | Commit `529512b` — `git show 529512b:server/users.json` exibe o hash para cracking offline |
| P2 | CORS wildcard `origin:*` incondicional | `server/index.js:54` e `:278` — enviado também em produção |
| P2 | `/api/ingest` sem validação de schema | Qualquer usuário autenticado pode injetar payload arbitrário |

**Pontos Positivos:**
- Scrypt + salt 16 bytes + `crypto.timingSafeEqual` — implementação correta e resistente a timing attacks
- Tokens HMAC-SHA256 com expiração configurável e validação em tempo constante
- Auth Socket.IO em middleware antes de qualquer handler — sem eventos sem token válido
- RBAC 3 papéis (superadmin/engenheiro/usuario) aplicado consistentemente em todos os endpoints
- SQL 100% parametrizado em `pgstore.js`, `events.js` e `users.js`
- **LGPD: zero frames no servidor** — só metadados persistidos (confirmado em `events.js` e `schema.sql`)
- `wa-auth/` corretamente excluído do git (confirmado por `git ls-files`)

---

### Qualidade Backend (6.5/10)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| P1 | `catch {}` vazio silencia erros sem logar | `server/index.js:274` — falha de Postgres vira 400 opaco |
| P1 | Logging inconsistente — 10 de 12 módulos usam `console.*` | Apenas `alarmPolicy.js` e `events.js` usam pino |
| P1 | `index.js` com 377 linhas, SRP violado | Auth + HTTP helpers + 18 rotas + socket + bootstrap num arquivo |
| P2 | `alarmPolicy.js` importa `dispatch.js` (cadeia indesejada) | Para testar `evaluate()` isolado, necessário mockar 5 módulos |
| P2 | `evaluate()` usa `Date.now()` interno — clock não injetável | Impossível testar janelas temporais sem fake timers |
| P2 | `pgstore.ingest()` sem fallback para falha transiente de Postgres | Se Postgres cair pós-boot, erros silenciados como 400 |

**Pontos Positivos:**
- **Todos os 9 contratos socket documentados implementados corretamente** — frame, cameras, set-capture, capture, alert, camera-status, alarm-event, alarm-update, camcfg-updated
- `alarmPolicy.js` com ISA-18.2/EEMUA 191 completo: dedup, flood suppression, shelving atômico, anti-flapping
- Fallback Postgres → JSON implementado em `recipients.js`, `settings.js`, `events.js`
- `volatile.emit()` correto no relay de frames — sem backlog de latência crescente

---

### Qualidade Frontend & TypeScript (7.5/10)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| P1 | `CameraWorkspace.tsx` com 1366 linhas, SRP violado | rAF loop + zonas + canvas + tripwires + UI num arquivo |
| P2 | Contratos socket não tipados via generics do `socket.io-client` | `Socket` sem `<ServerToClientEvents, ClientToServerEvents>` |
| P2 | Tipo `Tripwire` declarado em duplicidade | `src/vision/counting.ts:60` e `src/api.ts:198` divergem |
| P2 | ESLint não configurado (gap Onda 0 aberto) | Comentários `eslint-disable` sem efeito real |
| P2 | Wrapper `Select.tsx` não guarda contra `value=""` em runtime | Risco de crash Radix se convenção for violada |

**Pontos Positivos:**
- **`tsconfig.json` com `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `verbatimModuleSyntax`** — acima do padrão de mercado, `tsc --noEmit` passa com zero erros
- `counting.ts` exemplar como biblioteca pura: sem React, sem I/O, sem estado global
- `predict.ts` função pura com assinatura clara, sem efeitos colaterais
- Nenhum uso de `value=""` em `Select.Item` encontrado em nenhum `.tsx`
- Organização por domínio correta: `src/vision/`, `src/processors/`, `src/fadiga/`, etc.

---

### Testes & Verificação (2.0/10 — CRÍTICO)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| **P0** | **Zero unit tests para lógica crítica** | Nenhum `*.test.ts` ou `*.spec.ts` fora de node_modules/e2e |
| **P0** | **Fluxo de alarme sem cobertura E2E** | `e2e/app.spec.ts` cobre login + 3 regressões Radix, zero alarmes |
| P1 | Script `verify` ausente | package.json não tem `tsc --noEmit + build + playwright` combinados |
| P1 | `node --check` para `server/` ausente | Erros de sintaxe em alarmPolicy.js não são detectados antes do boot |
| P1 | ESLint e Prettier não configurados | Gap Onda 0 declarado |
| P2 | Relatório testado apenas por navegação de URL | Filtros, exportação CSV e gráficos sem validação E2E |
| P2 | `counting.test-notes.md` cria falsa sensação de cobertura | É documentação de API, não código de teste |

**Pontos Positivos:**
- Global setup/teardown bem engenheirado: hub E2E sobe em tmpdir isolado sem Postgres real
- Playwright com `--use-fake-device-for-media-stream` — testes headless de fluxos com webcam
- 4 testes de regressão para bugs Radix Select (z-index, ESC, clique fora)
- `workers: 1` e `reuseExistingServer: false` garantem isolamento entre runs

---

### Tooling & CI (2.5/10 — CRÍTICO)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| **P0** | **ESLint ausente** | Gap Onda 0 declarado no CLAUDE.md |
| **P0** | **Prettier ausente** | Gap Onda 0 declarado no CLAUDE.md |
| **P0** | **Nenhum CI** | `.github/workflows/` não existe |
| P1 | Sem pre-commit hooks | husky/lint-staged ausentes |
| P1 | Scripts incompletos | Sem `lint`, `typecheck`, `format`, `test:unit`, `verify` |
| P1 | Unit tests sem framework | Vitest/Jest não instalados |
| P2 | Vite sem configuração explícita de workers para TFJS/WASM | `worker: { format: "es" }` ausente em vite.config.ts |

**Pontos Positivos:**
- TypeScript strict acima do padrão de mercado
- Playwright E2E com webcam fake — infraestrutura de CI headless pronta
- CSP headers corretos para WASM/Workers em vite.config.ts
- `engines.node: ">=20"` declarado

---

### Documentação & Processo (5.5/10)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| P1 | `docs-regenerada/` desatualizada — Ondas B a G ausentes | AlarmHealth, cineBuffer, tripwires, RBAC, Sparkline sem cobertura |
| P1 | Todos os 4 itens da Onda 0 permanecem abertos | ESLint+Prettier, CI, unit tests, credencial Postgres |
| P2 | Decisão RBAC (papel `engenheiro` + `canConfigure`) sem ADR | Changelog menciona mas ADR-008 não existe |
| P2 | ~14 itens "A confirmar" acumulados sem rotina de revisão | Ondas A→G sem fechamento documentado |
| P2 | Specs de Ondas B2/C-G ausentes | ADRs retroativos ok, mas critérios de aceite pré-implementação faltam |

**Pontos Positivos:**
- CLAUDE.md exemplar: 9 seções, invariantes explícitos, mapa de artefatos, Onda 0 declarada
- 7 ADRs cobrindo decisões de maior impacto (incluindo ADR-007 fullscreen sem Radix Dialog)
- Changelog com resultado exato de verificação por onda — "pronto" rastreável
- Pre-implementação bem documentada para Ondas 1-3 + contratos multicâmera e eventos

---

### Arquitetura & Contratos (7.0/10)

**Achados:**

| Sev | Título | Evidência |
|---|---|---|
| P1 | Evento `set-capture` nunca emitido pelo frontend | `server/index.js:336-339` implementado, `grep emit("set-capture"` retorna zero em `src/` |
| P2 | Fallback JSON limitado a "pg não configurado" | Se Postgres cair pós-boot, login e alarmes falham sem degradação graceful |
| P2 | `/api/ingest` sem validação de conteúdo — risco LGPD teórico | Payload de até 200KB sem guard contra frames binários |
| P2 | `CameraWorkspace.tsx` e `FadigaView.tsx` na raiz de `src/` | Fora da estrutura de domínios |

**Pontos Positivos:**
- **Hub é relé puro confirmado** — nenhum import de ML em `server/`; IA 100% no browser
- **LGPD local-first sólido** — `events.js` persiste "SOMENTE METADADOS"; frames apenas em memória
- RTSP: frames em `Buffer` em memória, emitidos via socket, sem escrita em disco
- Fullscreen usa `div.cam-overlay`, não Radix Dialog — invariante ADR-007 respeitado
- Contratos socket aditivos respeitados — alarm-event, alarm-update, camcfg-updated adicionados sem quebrar contratos existentes
- RTSP com backoff exponencial e health-check de stream congelado

---

## Comparação com cd_analytics

O `cd_analytics` obteve nota global **4.7/10** antes do retrofit, com críticos em: ausência de TypeScript, ausência de guard SIAG write em todas as rotas, zero testes E2E e tooling inexistente.

O `visao_computacional_mvp` parte de uma base estruturalmente superior: TypeScript strict com zero erros, Playwright E2E com webcam fake configurado, hub relé sem ML no servidor, 7 ADRs, `alarmPolicy` ISA-18.2 documentada e LGPD local-first auditável.

**A convergência entre os dois projetos está nos mesmos gaps operacionais**: zero unit tests, zero CI e tooling ausente — o que sugere um **padrão sistêmico no ecossistema cd_inovacao**, não um problema isolado.

A diferença principal é o **custo de retrofit**: `cd_analytics` precisou construir a base arquitetural durante o processo (TypeScript, estrutura de domínios, guards de banco). O `visao_mvp` já tem esses fundamentos sólidos.

**Estimativa:** ~10-15 dias para `visao_mvp` atingir produção vs ~21 dias que o `cd_analytics` necessitou.
