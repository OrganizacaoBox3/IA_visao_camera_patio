# Relatório de Saúde + Plano de Retrofit — `visao_computacional_mvp`

> Leitura do projeto inteiro pela lente do `CLAUDE.md` (doutrina de `../agentes/`). Consolida 5 auditorias
> (`01`–`05` nesta pasta). Evidência (E) × inferência (I); `⚠️` = a confirmar. *Nada foi alterado nesta análise.*

## Veredito geral: 🟡 **Fundamentos sólidos, com bloqueadores P0 de segurança e verificação**
O projeto está **acima da média** em arquitetura, contratos e privacidade — mas **não pode ser chamado de "saudável"
hoje** porque viola invariantes do próprio `CLAUDE.md` em **segredos versionados** e tem **zero verificação
automatizada além de tsc/build/e2e**. A boa notícia: a dívida é **concentrada e endereçável**, não difusa.

## Scorecard
| Dimensão | Estado | Síntese |
|---|---|---|
| Arquitetura & contratos | 🟢 | Padrão da casa; contratos socket/HTTP aditivos e estáveis; scheduler exemplar |
| LGPD / privacidade | 🟢 | Confirmado nas 5 camadas: nenhuma imagem persistida; SQL parametrizado; RBAC consistente |
| Memória/rastreabilidade (git, ADRs) | 🟢 | Git limpo, commits por intenção, 7 ADRs + changelog, CLAUDE.md enxuto |
| Frontend / UI (Radix) | 🟡 | Migração madura; restam tokens legados, grid redundante, Tooltip parcial, e2e sem Tabs/AlertDialog |
| **Verificação & sensores** | 🔴 | Sem ESLint/Prettier/CI/hooks; **`verify` prometido no CLAUDE.md não existe**; zero unit test |
| **Segredos** | 🔴 | Senha Postgres de prod e `users.json` (hash admin) **versionados** |
| Dependências (supply-chain) | 🔴 | `npm audit`: 9 vulns (8 high, 1 critical) |
| Tamanho/complexidade | 🟡 | `CameraWorkspace.tsx` = 1366 linhas (2,7× a régua); gargalo estrutural |
| Prontidão p/ autonomia (Onda 4) | 🔴 | Falha 2 de 3 do gate duro (sensores + segredos); sem guardrails `.claude/settings` |

## Como chegou até aqui (narrativa honesta)
O projeto cresceu por **ondas A–G de features** (≈30 commits), paralelizadas por **propriedade de arquivo** e
validadas **só por `tsc + build + e2e`**. Isso produziu entrega rápida e contratos limpos, mas acumulou três
dívidas previsíveis desse processo:
1. **Verificação adiada** — o gate ficou manual; o débito é explícito no `CLAUDE.md §6` (não é surpresa, é escolha a pagar agora).
2. **`CameraWorkspace.tsx` inchado** — por ser tocado por quase toda onda (perf, cine-loop, telemetria, tripwires, RBAC), virou sumidouro de responsabilidades.
3. **Redundâncias entre frentes paralelas** — tipos/CSS/mecanismos duplicados quando dois agentes resolveram o mesmo conceito em arquivos diferentes (ex.: `AlarmEvent` 2×, grid `data-cols` × `--dash-cols` morto, tokens `--ok/--idle/--alert` × `--state-*`).
Os segredos versionados vêm do **import inicial** (`529512b`), quando o git foi criado sobre arquivos que já existiam.

## Achados P0 (corrigir antes de qualquer push/deploy/autonomia)
1. **Senha Postgres de produção em texto plano e versionada** — `deploy/visao-hub.service:34` (`PGPASSWORD=…`), banco de **IP público** (`:31`), usuário `postgres`; rastreada no git desde `529512b`. (E) — viola `CLAUDE.md §3` (segredos).
2. **`server/users.json` versionado** com hash scrypt do superadmin + telefones, e **fora do `.gitignore`** (que cobre os outros JSON de runtime). Com a senha default `admin@box3` (`users.js:75`), a conta admin é efetivamente pública. (E)
3. **`npm audit`: 9 vulnerabilidades (8 high + 1 critical)** — `protobufjs` (RCE, via transformers/baileys), `ws` (DoS, via socket.io). (E)
4. **`verify` inexistente** — `CLAUDE.md §6` promete `npm run verify`, mas não há o script, nem ESLint/Prettier, nem CI (`.github/` ausente), nem git hook. O "sensor" é 100% humano. (E)
5. **Sem guardrails de agente** — não há `.claude/settings.json` com `deny` de `.env`/`wa-auth/`/`users.json`; **trifecta letal armada** (dados privados + conteúdo não-confiável RTSP/WhatsApp + exfiltração via Baileys). (I)

> Itens secundários de segurança: login **sem rate-limiting** (`index.js:61-65`); `AUTH_SECRET` com default público (`users.js:17`); token em `localStorage` (XSS). → P1.

## Correção de honestidade
O briefing mencionou um "TODO no `clipExport`": **não existe** — `src/camera/clipExport.ts` está completo e não há TODO/FIXME reais em `src/`. Registrado para não propagar afirmação sem evidência (princípio §2.5).

---

# Plano de Retrofit (em ondas, P0 primeiro — doutrina)

Cada onda paralelizável por propriedade de arquivo; cada onda fecha com `verify` verde.

## R0 — Segurança & Segredos (🔴 bloqueador, fazer já)
- **R0.1** Remover `deploy/visao-hub.service` e `server/users.json` do versionamento (`git rm --cached`), adicionar ao `.gitignore`, e criar `*.example` sanitizados. *(esforço: baixo)*
- **R0.2** **[HUMANO]** **Rotacionar** a senha Postgres exposta e o `AUTH_SECRET` (estão comprometidos — desversionar não basta). Mover credenciais para `EnvironmentFile=` fora do repo. *(humano/infra)*
- **R0.3** Limpar o histórico git dos segredos (sem remoto ainda → baixo risco; `git filter-repo`/re-init do checkpoint). *(médio)*
- **R0.4** `npm audit fix` (avaliar breaking) + fixar versões; registrar o que não tem fix. *(baixo/médio)*
- **R0.5** `.claude/settings.json`: `deny` de `.env*`, `server/wa-auth/**`, `server/users.json`, `**/*.local`; `allow` mínimo. *(baixo)*

## R1 — Sensores / Onda 0 (🔴 o motor do dev com IA)
- **R1.1** ESLint (flat config) + Prettier + `eslint-config-prettier`. *(médio — gerar ruído; corrigir em lotes, warning→error)*
- **R1.2** Scripts `lint`/`typecheck`/`verify` no `package.json` (`verify = lint && typecheck && build && test`); incluir `node --check` dos `server/*`. *(baixo)*
- **R1.3** **pre-push hook** (`core.hooksPath`) rodando `verify` — o gate que não depende de nuvem. + `ci.yml` quando houver remoto. *(baixo)*
- **R1.4** **Vitest** com unit tests das lógicas puras, nesta ordem de alavancagem: `vision/counting.ts` → `server/alarmPolicy.js` → `reading/cluster.ts` → `report/predict.ts` → `zones.ts`. *(médio)*

## R2 — Arquitetura & dedup (🟡 reduzir dívida concentrada)
- **R2.1** Quebrar `CameraWorkspace.tsx` (1366→ módulos/hooks): extrair `useTripwires`, `useCineLoop`, `useTelemetry`, desenho/overlay e holders para arquivos próprios. *(alto — fazer incremental, com testes antes)*
- **R2.2** Unificar `AlarmEvent` numa fonte (ex.: `src/types/alarm.ts`), consumida por `api.ts` e `report/*`. *(baixo)*
- **R2.3** Remover o grid morto (`--dash-cols`) **ou** migrar para ele e apagar `data-cols` — um mecanismo só. *(baixo)*

## R3 — Acabamento UI & AI-harness (🟡/P2)
- **R3.1** Completar "going-gray": migrar `--ok/--idle/--alert` (~69 usos) → `--state-*`; alinhar `/camera` e cards de zona. *(médio)*
- **R3.2** Tooltip/IconButton na toolbar do `CameraWorkspace`; scroll horizontal em heatmap/matriz (mobile). *(baixo/médio)*
- **R3.3** Ampliar e2e para Tabs e AlertDialog. *(baixo)*
- **R3.4** Template de **log de run** (`runs/<ts>.md`) + decidir fonte única CLAUDE.md×AGENTS.md; preparar terreno da Onda 4 (só depois de R0/R1). *(baixo)*

## Sequência recomendada
**R0 (agora, com a ação humana R0.2) → R1 → R2/R3 em paralelo.** Só após R0+R1 verdes faz sentido falar em
autonomia (Onda 4). Métrica de "saudável": `verify` verde no CI bloqueante + zero segredo versionado + núcleo
crítico com unit test + nenhum arquivo-sumidouro sem plano.

## Onde isto deixa o projeto
Com **R0+R1** fechados, o `CLAUDE.md` deixa de ser aspiracional e passa a ser **imposto por máquina** — o projeto
vira de fato "orientado ao desenvolvimento com IA": sensores determinísticos que um agente (e um humano) podem
confiar, segredos fora do alcance do contexto, e gate antes de ação irreversível.
