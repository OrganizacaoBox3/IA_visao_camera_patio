# Auditoria de Saúde — Dimensão 1: Verificação, Sensores e Tooling

> Prontidão "Onda 0" do `visao_computacional_mvp`. Auditor de qualidade (não altera código).
> Data: 2026-06-28. Lente: `CLAUDE.md` §6–§7 · `MANIFESTO_DESENVOLVIMENTO.md` §4 · `PLANO_ONDA_0_1.md`.
> Tese-âncora: **"quando gerar código é barato, a verificação é o gargalo — sensores (lint/CI/testes) são o motor."**
>
> Convenção: **(E)** = evidência direta verificada · **(I)** = inferência · **⚠️** = a confirmar.
> Comandos executados nesta auditoria: `tsc --noEmit`, `vite build`, `npm audit`, `git log`, `node --check`.

---

## 0. Veredito da dimensão

**🔴 NÃO PRONTO para "Onda 0".** O projeto tem **dois sensores fortes** (TS strict verde + e2e Playwright real) e **toda a metade automatizável do gate ausente**: sem ESLint, sem Prettier, sem `verify`, sem CI, sem git hook, sem um único teste de unidade das lógicas puras/críticas. O gate é **100% manual** — exatamente o gargalo que o manifesto §4 chama de "o inegociável". Some-se a isso **um segredo real versionado** (senha Postgres de produção no `deploy/visao-hub.service`) e **9 vulnerabilidades de dependência (8 high, 1 critical)**. O código está bem escrito e as lógicas críticas são puras e triviais de testar — a lacuna é de *instrumentação*, não de *qualidade de código*.

---

## 1. Scorecard da dimensão

| # | Sub-item | Estado | Evidência |
|---|----------|:------:|-----------|
| 1.1 | **ESLint** | 🔴 | Nenhum `eslint.config.*`/`.eslintrc` no projeto (só dentro de `node_modules/`). **(E)** Glob na raiz não retorna config própria. |
| 1.2 | **Prettier** | 🔴 | Nenhum `.prettierrc`/`.prettierignore` próprio. **(E)** |
| 1.3 | **Scripts npm de qualidade** | 🔴 | `package.json` tem só `dev/build/preview/hub/start/e2e`. **Não existem** `lint`, `format`, `typecheck`, `verify`. **(E)** `package.json:6-13` |
| 1.4 | **Typecheck (tsc strict)** | 🟢 | `tsconfig.json`: `strict:true`, `noUnusedLocals/Parameters:true`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`. `tsc --noEmit` → **EXIT 0, limpo**. **(E)** `tsconfig.json:19-24` |
| 1.5 | **Typecheck do back-end** | 🟡 | `server/*.js` são **14 arquivos JS puros** sem `// @ts-check`/JSDoc tipado; `tsconfig` só inclui `src`. Back-end fora do radar do typechecker. Mitigado parcialmente por `node --check` manual (`CLAUDE.md:51`). **(E)** `tsconfig.json:26` (`"include":["src"]`) |
| 1.6 | **Build limpo** | 🟡 | `vite build` → **EXIT 0**, mas **avisa chunks > 500 kB**: `index-*.js` **1.94 MB** (gzip 532 kB), `detectWorker` **1.88 MB**, `owlvitWorker` **807 kB**, `zxingWorker` **410 kB**. Sem `manualChunks`/code-splitting no `vite.config.ts`. **(E)** saída do build + `vite.config.ts:14-18` |
| 1.7 | **Testes e2e** | 🟢 | Playwright real (login, socket autenticado, webcam fake): `e2e/app.spec.ts` (5 testes) + `global-setup/teardown`. Boa prática: **regressões viraram teste** (Select-em-Dialog). **(E)** `e2e/app.spec.ts:1-115`, `playwright.config.ts` |
| 1.8 | **Testes de unidade (lógicas puras)** | 🔴 | **Zero.** Sem Vitest/Jest (nenhum `vitest.config.*`, ausente em `package.json`). Único "teste" extra é o ad-hoc `server/_zxing_roundtrip_test.cjs` (script, não framework). **(E)** |
| 1.9 | **Gate `verify`** | 🔴 | Não existe `npm run verify` (definido só em prosa no `CLAUDE.md:51`). Imposição **manual**. **(E)** |
| 1.10 | **CI** | 🔴 | Sem `.github/workflows/`. **(E)** Glob não encontra `.github/**`. |
| 1.11 | **Git hooks (pre-push)** | 🔴 | `git config core.hooksPath` → vazio; sem `.husky`. Nenhum enforcement local. **(E)** |
| 1.12 | **Supply-chain (vulnerabilidades)** | 🔴 | `npm audit`: **9 vulnerabilidades — 8 high + 1 critical.** Critical: `protobufjs` (RCE/poluição de protótipo) via `@xenova/transformers`→`onnxruntime-web` e via `@whiskeysockets/baileys`. High: `ws` (DoS) puxado pela cadeia `socket.io`/`engine.io`. **(E)** |
| 1.13 | **Supply-chain (higiene de deps)** | 🟢 | Sem pacote alucinado: todas as deps são reais e conhecidas. Versões Radix **consistentes** (cada primitiva no seu major estável; versionamento independente é o padrão do Radix). `package-lock.json` presente (lockfile íntegro). **(E)** `package.json:25-55` |
| 1.14 | **Segredos no versionamento** | 🔴 | `deploy/visao-hub.service` **está versionado** e contém **senha Postgres de produção em claro** (`PGPASSWORD=<SENHA-REDIGIDA>`) + host real (`PGHOST=<HOST-REDIGIDO>`). Viola invariante `CLAUDE.md:27`. Pendência já reconhecida (`CLAUDE.md:53`) e **ainda aberta**. **(E)** `deploy/visao-hub.service:31-35` |
| 1.15 | **`.gitignore` de segredos** | 🟡 | Cobre bem os JSON de runtime (`cameras.json`, `alarms.json`, `camcfg.json`, `alarm-shelves.json`, `rtsp.sources.json`, `wa-auth/`). **Mas não há regra `.env`** — só `*.local` (pega `.env.local` do Vite, **não** `.env`/`.env.production`). `.env.production.example` é versionado (ok, é template). **(E)** `.gitignore` (sem linha `.env`) |
| 1.16 | **Observabilidade / logging** | 🟡 | **Misto/inconsistente.** `pino` (estruturado) em só **3** arquivos (`alarmPolicy.js`, `events.js`, `whatsapp.js`); `console.*` em **12** arquivos do `server/` (49 ocorrências) incl. `index.js`, `rtsp.js`, `db.js`, `users.js`. Sem logger único/níveis padronizados no hub. **(E)** Grep |

**Resumo:** 🟢 4 · 🟡 5 · 🔴 7. A coluna verde é toda do que já existia "de fábrica" (TS strict, e2e). O vermelho é toda a camada de sensores automatizados que a Onda 0 exige.

---

## 2. "Como chegou aqui" (a trajetória que produziu a lacuna)

O `git log` mostra **30 commits** organizados explicitamente em **ondas de feature A–G** (changelog em `analises/implementacao-changelog.md`), todas validadas pelo trio **`tsc` + `vite build` + Playwright e2e** — nunca por lint/CI/unit. **(E)** `git log --oneline`:

- **Import inicial** (`529512b`) → **docs/benchmark** → **Onda A** (política de alarme, going-gray, previsão) → **Onda B** (RBAC, fila de alarmes, eventos) → **Onda C** (presets, tripwires, ocupação, shelving, métricas) → **persistência compartilhada** (views/tripwires, ADRs) → **migração Radix** (fundação → telas → responsividade) → **fix Radix Select-em-Dialog** → **`CLAUDE.md`**.

O padrão é coerente e disciplinado: cada onda fecha com evidência (changelog, ADRs), regressões viram e2e, e o steering (`CLAUDE.md`) reconhece a própria dívida em §6 ("**Lacunas da 'Onda 0' ainda abertas**: ESLint+Prettier, CI/pre-push, testes de unidade das lógicas puras"). Ou seja: **a casa sabe que está em débito** — o débito é deliberado e documentado, não acidental.

Por que o débito persistiu: o trio `tsc+build+e2e` foi *bom o bastante* para manter `main` estável durante a fase de features (o e2e cobre o caminho crítico de UI ponta-a-ponta, e o TS strict pega a maior parte dos erros de contrato). Com gerar código barato, **o custo marginal de cada feature caiu, mas a dívida de verificação não foi paga em paralelo** — e é justamente o cenário que o manifesto §4 e a tese-âncora preveem como "o maior risco". O `PLANO_ONDA_0_1.md` (2026-06-22) chega a listar este MVP como candidato, mas com diagnóstico hoje **desatualizado** ("`visao_computacional_mvp`: (…) nem são repositórios git ainda") — na verdade **já é repo git com 30 commits** **(E)**; o restante do diagnóstico (sem ESLint/Prettier/CI, só Playwright e2e) **permanece exato** **(E)**.

Consequência prática: as **lógicas mais críticas e mais testáveis do sistema estão sem rede**. `vision/counting.ts` (contagem por tripwire — geometria de cruzamento, dedup de jitter, TTL de tracks), `report/predict.ts` (previsão de alertas/dia), `reading/cluster.ts` (agregação multi-câmera, dedup, throughput) e `server/alarmPolicy.js` (dedup, supressão de inundação, shelving, anti-flapping, métricas EEMUA) são **funções puras / estado encapsulado sem I/O** — o caso ideal para teste de unidade — e hoje só são exercitadas de raspão (ou nem isso) pelo e2e de UI.

---

## 3. Ações de retrofit priorizadas

Prioridade: **P0** = bloqueia "Onda 0"/risco de segurança · **P1** = fecha o gate · **P2** = endurece. Esforço: baixo/médio/alto.

### P0 — Segurança e supply-chain (fazer antes de qualquer feature nova)

| Ação | Esforço | Passo concreto |
|------|:------:|----------------|
| **P0.1 — Remover e rotacionar o segredo versionado** | médio | `git rm --cached deploy/visao-hub.service`; substituir os valores por placeholders (`PGPASSWORD=<defina-em-runtime>`); **rotacionar a senha Postgres** `<SENHA-REDIGIDA>` no servidor `<HOST-REDIGIDO>` (a credencial já vazou no histórico git — trocar é obrigatório, não opcional). Mover segredos reais para `.env`/systemd `EnvironmentFile=` fora do repo. (Pendência já listada em `CLAUDE.md:53`.) |
| **P0.2 — Fechar o `.gitignore`** | baixo | Adicionar `\.env`, `.env.*` e `!.env.*.example` ao `.gitignore`. Garante a invariante `CLAUDE.md:27`. |
| **P0.3 — Tratar as 9 vulnerabilidades** | médio | `npm audit fix` (resolve `ws`/`socket.io` sem breaking, provável); avaliar `npm audit fix --force` para a cadeia `protobufjs`/`onnxruntime`/`baileys` em branch isolada com e2e verde. Onde o fix for breaking, **registrar risco residual** (ADR) — `@xenova/transformers` roda no browser (não no servidor), o que reduz, mas não zera, a exposição do `protobufjs`. |

### P1 — Ligar os sensores automatizados (o "inegociável" da Onda 0)

| Ação | Esforço | Passo concreto |
|------|:------:|----------------|
| **P1.1 — ESLint flat config + Prettier** | baixo | Criar `eslint.config.js` (flat) com `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-config-prettier`; `.prettierrc` curto. Reusar o template previsto em `agentes/templates/` (`PLANO_ONDA_0_1.md` §Onda 0). Rodar e corrigir em **lotes pequenos** (warning→error onde gerar ruído). |
| **P1.2 — Script `verify`** | baixo | Adicionar ao `package.json`: `"typecheck":"tsc --noEmit"`, `"lint":"eslint ."`, `"verify":"npm run lint && npm run typecheck && npm run build && npm run e2e"` (+ `node --check server/*.js`). Materializa o `verify` que hoje só existe em prosa (`CLAUDE.md:51`). |
| **P1.3 — pre-push hook** | baixo | `git config core.hooksPath .githooks` + `.githooks/pre-push` rodando `npm run verify`; **vermelho barra o push**. É o gate que não depende de nuvem (`PLANO_ONDA_0_1.md` T004). |
| **P1.4 — CI GitHub Actions** | baixo | `.github/workflows/ci.yml`: node 20 → `npm ci` → `npm run verify` (com Playwright browsers). Gate bloqueante de merge (`MANIFESTO §4`). Requer remoto GitHub. |

### P2 — Testes de unidade das lógicas puras + endurecimento

| Ação | Esforço | Passo concreto |
|------|:------:|----------------|
| **P2.1 — Vitest + 1ª bateria de unit (ordem de alavancagem)** | médio | Adicionar Vitest; integrar ao `verify` (`npm test`). Testar **nesta ordem** (puro + crítico + maior risco primeiro): **(1)** `vision/counting.ts` — `orient`, `segmentsIntersect`, `createCounter` (in/out por direção, jitter `minMove`, TTL, troca de tripwire); **(2)** `server/alarmPolicy.js` — `evaluate` (dedup, inundação→resumo, shelving, anti-flapping) e `priorityOf` (meta EEMUA ≤5% critical); **(3)** `reading/cluster.ts` — `pushRead`/`pushPass`/`snapshot` (dedup multi-câmera, throughput, readRate); **(4)** `report/predict.ts` — `predictAlertsPerDay` (escala por sensibilidade, no-data). Todas são puras/estado encapsulado → custo de teste baixo, retorno alto. |
| **P2.2 — Code-splitting do bundle** | médio | `vite.config.ts`: separar TFJS/coco-ssd, `@xenova/transformers` (OWL-ViT) e ZXing em chunks lazy (dynamic import / `manualChunks`); hoje o `index.js` carrega 1.94 MB no caminho inicial. Remove o aviso e melhora o load real. |
| **P2.3 — Padronizar logging do hub** | médio | Migrar `console.*` (12 arquivos) para `pino` com `child` por módulo e níveis; o padrão já existe em `alarmPolicy.js`/`events.js`. Habilita observabilidade estruturada em produção (journald). |
| **P2.4 — Typecheck do back-end** | médio | Adicionar `// @ts-check` + JSDoc incremental nos `server/*.js` (ou `tsconfig` separado em `checkJs`), começando por `alarmPolicy.js`/`db.js`. Fecha o ponto cego do 1.5. |

---

## 4. Notas de confiança

- Tudo marcado **(E)** foi verificado por execução nesta máquina (`tsc`, `vite build`, `npm audit`, `git log`, `node --check`, leitura dos arquivos citados). **(E)**
- A severidade do `protobufjs`/`ws` é a reportada pelo `npm audit` na data; **⚠️ a confirmar** se `npm audit fix` resolve sem regressão (exige rodar em branch + e2e verde).
- O bundle de 1.94 MB é o estado atual do `vite build`; o impacto real de UX depende de quanto é lazy em runtime — **⚠️ a medir** com profiling, mas o aviso do bundler é fato. **(E)**
