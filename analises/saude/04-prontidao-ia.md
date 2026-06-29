# Auditoria de Saúde 04 — Prontidão para desenvolvimento com IA (context engineering + harness)

> **Dimensão:** AI-readiness — engenharia de contexto e harness para agentes.
> **Projeto auditado:** `visao_computacional_mvp`. **Data:** 2026-06-28. **Escopo:** somente leitura (nenhum código alterado).
> **Lente/critério:** `CLAUDE.md` (deste projeto) + `../agentes/exploracao/` (`PESQUISA_AUTONOMIA_AGENTES.md`, `MAPA_DE_LACUNAS.md` G7/G9, `PLANO_ONDA_4_AUTONOMIA.md`).
> **Tese da lente:** autonomia segura = **sensores determinísticos + guardrails + memória em git + gate antes do irreversível**.

**Legenda de evidência:** **(E)** = evidência direta no repositório (arquivo:linha) · **(I)** = inferência fundamentada · **⚠️** = risco/achado que exige ação.

---

## 0. Sumário executivo (veredito)

O projeto está **AI-assisted maduro, mas NÃO AI-autonomy-ready**. A base de **memória** é exemplar (git limpo, commits por intenção com atribuição `Co-Authored-By`, 7 ADRs, changelog) e a **doutrina de contexto** existe e é boa (`CLAUDE.md` enxuto, 78 linhas, apontando para ADRs/steering). Porém o **harness operacional não existe ainda**: o sensor `verify` que toda a doutrina pressupõe **não está implementado como comando** (`package.json` não tem script `verify`, nem ESLint/Prettier, nem testes de unidade), e **não há nenhum guardrail de máquina para o agente** (sem `.claude/settings.json`, sem deny de `.env`/`wa-auth/`). Pior: **dois segredos reais estão expostos** — senha Postgres em texto puro versionada e `users.json` (hashes + telefones) versionado — que um agente lê direto do working dir. Isso configura risco concreto de **trifecta letal**.

**Veredito de uma linha:** boa **memória e doutrina**, **harness e guardrails ausentes** → reprovado no pré-requisito (gate duro) da Onda 4 do `PLANO_ONDA_4_AUTONOMIA.md`.

---

## 1. Scorecard de capacidades de AI-readiness

| # | Capacidade | Estado | Evidência-chave |
|---|------------|:---:|-----------------|
| 1 | **CLAUDE.md existe e é enxuto (<200 linhas)** | 🟢 | 78 linhas, aponta p/ ADRs, steering, changelog, `../agentes/` (E: `CLAUDE.md:1-78`) |
| 2 | **Invariantes claras p/ um agente novo** | 🟢 | §2 princípios + §3 invariantes "NUNCA VIOLAR" + §8 coleira de IA (E: `CLAUDE.md:14-34,61-66`) |
| 3 | **`.claude/settings*.json` com guardrails (allow/deny .env)** | 🔴 | Diretório `.claude/` **não existe** (E: `ls .claude` → no such file) |
| 4 | **AGENTS.md (fonte única / interop)** | 🔴 | Ausente (E: `ls AGENTS.md` → no such file). Só `CLAUDE.md` |
| 5 | **Skills (`.claude/skills/`) p/ playbooks** | 🔴 | Ausente (não há `.claude/`) |
| 6 | **Git existe com histórico limpo / commits por intenção** | 🟢 | 30 commits Conventional (`feat/fix/docs/chore`), 1 responsabilidade cada (E: `git log`) |
| 7 | **Atribuição de IA nos commits** | 🟢 | `Co-Authored-By: Claude...` + `Claude-Session` em todo o histórico (E: `git log --format=%b`) |
| 8 | **ADRs cobrem decisões não-óbvias** | 🟢 | 7 ADRs + README índice em `analises/decisoes/` (E: ADR-001..007) |
| 9 | **Changelog de implementação** | 🟢 | `analises/implementacao-changelog.md` (E) |
| 10 | **Sensor `verify` determinístico executável** | 🔴 | `CLAUDE.md:51` promete `verify`, mas **não há script `verify`** no `package.json` (E: `grep verify package.json` → vazio) |
| 11 | **Lint / format como sensor** | 🔴 | Sem ESLint/Prettier (E: `ls .eslintrc* eslint.config.*` → none). Lacuna já declarada (E: `CLAUDE.md:53`) |
| 12 | **Testes de unidade (lógica pura)** | 🔴 | Só e2e (`e2e/app.spec.ts`); zero unit p/ `counting.ts`/`predict.ts`/`alarmPolicy.js` (E: `CLAUDE.md:53`) |
| 13 | **E2E como sensor** | 🟡 | Playwright configurado (`e2e/`, `playwright.config.ts`), mas não embrulhado num `verify` único |
| 14 | **CI / pre-push rodando o gate** | 🔴 | Sem `.github/workflows`, sem hook (E: lacuna declarada em `CLAUDE.md:53`) |
| 15 | **Log de run / observabilidade de agente** | 🔴 | Nenhum `runs/` nem template; pino loga o app, não a sessão de agente (I) |
| 16 | **`.gitignore` protege segredos do git** | 🟡 | Cobre `wa-auth/`, `cameras.json`, `rtsp.sources.json` etc. (E: `.gitignore:19-39`) — **mas** ver achados ⚠️ abaixo |
| 17 | **Guardrail contra leitura de segredos pelo agente** | 🔴 | Sem deny rules; `wa-auth/creds.json`, `users.json`, `rtsp.sources.json` ficam legíveis no working dir (E/I) |
| 18 | **Gate determinístico antes de irreversível** | 🟡 | Política escrita (`CLAUDE.md:65`), mas **não automatizada** (depende de disciplina humana) |
| 19 | **Observabilidade p/ revisão assíncrona (PR/branch)** | 🟡 | Git/branch permite, mas trabalho ocorre direto em `master` (E: `git branch` → só `master`); sem fluxo de PR |

**Contagem:** 🟢 7 · 🟡 4 · 🔴 8.

### Achados de segurança (⚠️ — bloqueiam autonomia)

- **⚠️ A1 — Senha Postgres em texto puro versionada.** `deploy/visao-hub.service` está **rastreado no git** e contém `Environment="PGPASSWORD=<SENHA-REDIGIDA>` (E: `git ls-files deploy/` + leitura do arquivo). A própria `CLAUDE.md:53` reconhece a pendência ("rotacionar a credencial Postgres em `deploy/visao-hub.service`"). Segredo real exposto a qualquer leitor do repo e ao contexto de qualquer agente.
- **⚠️ A2 — `server/users.json` versionado.** Está **rastreado** (E: `git ls-files server/users.json` → presente) e **não consta no `.gitignore`**. Contém `senhaHash` (scrypt, com salt), `papel` (`superadmin`) e telefones de WhatsApp (PII). Contradiz a invariante `CLAUDE.md:27` ("nunca versionar ... `*.json` de runtime"). Hashes não são texto puro, mas expõem estrutura de contas + PII.
- **✅ Bom contraste:** `wa-auth/creds.json` e `rtsp.sources.json` existem no disco mas estão **corretamente ignorados** (E: `git check-ignore` confirma). O `.gitignore` funciona — o problema é cobertura incompleta (A1/A2) e ausência de barreira para o *agente* (que lê o working dir, não só o git).

---

## 2. Gap analysis vs `PESQUISA_AUTONOMIA_AGENTES.md` / `PLANO_ONDA_4` — o que falta para a "Onda 4"

O `PLANO_ONDA_4_AUTONOMIA.md:10-16` define um **gate duro** (pré-requisito não-negociável). Confronto item a item:

| Pré-requisito da Onda 4 (gate duro) | Estado no projeto | Veredito |
|---|---|:--:|
| **Sensores verdes e bloqueantes** (`verify` = lint+typecheck+build+test) | `verify` não existe como comando; sem lint; sem unit; nada bloqueante | 🔴 **Falha** |
| **Repositório git com histórico limpo** (memória/retomada) | Sim — histórico exemplar, commits por intenção | 🟢 **OK** |
| **Segredos fora do versionamento** | **Não** — A1 (senha PG) e A2 (`users.json`) versionados | 🔴 **Falha** |

**Conclusão:** 2 dos 3 pré-requisitos do gate duro **falham** → a Onda 4 **não pode começar** pela própria régua do plano. A pesquisa é explícita: *"Sem sensores, autonomia é o anti-padrão que toda a pesquisa condena. Primeiro os sensores, depois a autonomia"* (`PLANO_ONDA_4:16`; `PESQUISA:62`).

### Mapeamento contra os pilares da tese (sensores · guardrails · memória · gate)

- **Sensores determinísticos** (`PESQUISA:23,53` "verify é o motor"): **lacuna crítica**. O loop `gather→act→verify→commit` (`PLANO_ONDA_4:33`) não tem o `verify` materializado. Um agente hoje não tem como se autoverificar de forma determinística. Mapeia a **G9** do `MAPA_DE_LACUNAS.md:92-96` ("decidir quais sensores já temos — o `verify` — e o que falta").
- **Guardrails / sandbox + corte da trifecta letal** (`PESQUISA:42-43`; `PLANO_ONDA_4:75`): **ausente no plano de máquina**. A trifecta (dados privados + conteúdo não-confiável + exfiltração) está **armada**: (a) dados privados = `wa-auth/`, `users.json`, senha PG no working dir; (b) conteúdo não-confiável = frames/RTSP de fontes externas, mensagens WhatsApp recebidas; (c) exfiltração = sem allowlist de rede, agente com acesso ao Baileys pode enviar mensagem externa. A perna mais barata de cortar (exfiltração / leitura de segredos) **não está cortada** — não há `.claude/settings.json` deny nem isolamento.
- **Memória em git** (`PESQUISA:24,54`; `PLANO_ONDA_4:22`): **forte**. git + ADRs + changelog = memória durável e revertível. É o ativo mais maduro do projeto. Falta só a peça operacional: **branch por run** (`auto/<tarefa>/<ts>`) e **log de run** (`runs/<ts>.md`, `PLANO_ONDA_4:37`).
- **Gate antes do irreversível** (`PESQUISA:45-46`; `PLANO_ONDA_4:24`): **escrito, não automatizado**. `CLAUDE.md:65` lista as ações irreversíveis (push em `main`, deploy, DROP, e-mail externo) e exige teste-verde ou aprovação humana — mas hoje isso é disciplina humana, não um gate de máquina. Trabalho ocorre direto em `master` (sem fluxo de branch/PR), o que enfraquece a "revisão assíncrona serializada" (`PESQUISA:56`).

### Mapeamento contra `MAPA_DE_LACUNAS.md` (G7 e G9)

- **G7 — Governança dos artefatos de contexto** (`MAPA:78-82`): **parcialmente resolvida.** `CLAUDE.md` existe, é <200 linhas, commitado, aponta para steering — exatamente o que G7 pede. **Pendente:** decidir **fonte única** `CLAUDE.md` × `AGENTS.md` (G7 manda escolher uma; hoje só há `CLAUDE.md`, sem `AGENTS.md` interoperável) e **não há Skills** versionadas.
- **G9 — Harness & sensores** (`MAPA:92-96`): **lacuna aberta.** O `verify` é citado como o sensor existente, mas **na prática ainda não é executável**. Falta o harness reutilizável (sensor + log de run + budget/circuit-breaker do `PLANO_ONDA_4:54`).

---

## 3. Retrofit recomendado (P0 / P1 / P2)

> Princípio (do `MANIFESTO`/`CLAUDE.md`): **o básico bem feito, sem overengineering**. Comece pelo risco zero e suba degraus.

### P0 — Risco real / bloqueia qualquer autonomia (fazer já)

1. **Estancar e rotacionar segredos versionados (A1, A2).**
   - Rotacionar a senha Postgres; mover `PGPASSWORD` de `deploy/visao-hub.service` para um `EnvironmentFile=` fora do git; remover o valor do arquivo rastreado.
   - Adicionar `server/users.json` ao `.gitignore` e removê-lo do índice (`git rm --cached`); fornecer `server/users.example.json`.
   - **Limpar o histórico** desses dois segredos (a senha PG e `users.json` já vivem em commits antigos) ou tratar a senha como comprometida (rotação obrigatória).
   - *Por quê:* sem isso, o pré-requisito "segredos fora do versionamento" (`PLANO_ONDA_4:14`) nunca fecha e a trifecta segue armada.

2. **Criar `.claude/settings.json` com guardrails de máquina (deny).**
   - `deny` de leitura para `**/.env*`, `server/wa-auth/**`, `server/users.json`, `server/rtsp.sources.json`, `server/cameras.json`, `server/*.json` de runtime, `deploy/*.service`.
   - `ask`/`deny` para Bash de ação irreversível (`git push`, `git merge`, `psql`/`DROP`, deploy, envio WhatsApp).
   - *Por quê:* corta a perna de **leitura de segredos/exfiltração** da trifecta (`PESQUISA:43`); o `.gitignore` protege o git, **não** o contexto do agente. É o guardrail que hoje não existe (Scorecard #3/#17).

3. **Materializar o sensor `verify` como comando real.**
   - Adicionar ao `package.json`: `"verify": "tsc --noEmit && vite build && node --check server/index.js && playwright test"` (alinhado ao que `CLAUDE.md:51` já promete).
   - *Por quê:* é o **motor da autoverificação** (`PESQUISA:53`) e o coração do gate duro da Onda 4. Hoje a doutrina referencia um comando inexistente — corrigir essa mentira de contexto é P0 de baixo custo.

### P1 — Capacidade que falta para a autonomia ser segura

4. **ESLint + Prettier + testes de unidade** das lógicas puras (`vision/counting.ts`, `report/predict.ts`, `server/alarmPolicy.js`) e plugá-los no `verify`. Fecha a "Onda 0" já declarada pendente (`CLAUDE.md:53`) — pré-requisito de G9.

5. **CI ou pre-push hook rodando `verify`** (GitHub Actions ou hook local) → torna o sensor **bloqueante**, satisfazendo a primeira linha do gate duro (`PLANO_ONDA_4:12`).

6. **Template de log de run + fluxo de branch/PR.** Criar `runs/TEMPLATE.md` (tarefa, passos, tool-calls, tokens, veredito, risco residual — `PLANO_ONDA_4:37`) e adotar branch `auto/<tarefa>/<ts>` em vez de commitar em `master`. Dá observabilidade e revisão assíncrona serializada (Scorecard #15/#19).

7. **Decidir fonte única de contexto (G7).** Manter `CLAUDE.md` como fonte e adicionar um `AGENTS.md` mínimo que **aponte para ele** (interop com outras ferramentas), ou consolidar. Evitar duplicação que gera drift (`MAPA:80-82`).

### P2 — Enriquecimento (só com dor concreta)

8. **Skills (`.claude/skills/`) para playbooks recorrentes** — ex.: "rodar `validate-streams`", "subir o hub + smoke test", "triagem de alarme". Empacotar como `SKILL.md` + scripts determinísticos (`PESQUISA:32-34`; `PLANO_ONDA_4:62`). **Só de fonte confiável** (risco de prompt-injection, `PESQUISA:36`).

9. **Tarefa scout read-only agendada (Onda 4.0)** — varredura de TODOs/código morto/deps desatualizadas/lacunas de teste, gerando relatório de formato fixo (`PLANO_ONDA_4:43-47`). Risco zero, valor imediato — o degrau certo para *depois* que P0/P1 fecharem.

10. **Budget / circuit-breaker** (teto de tokens/tempo/iterações, parar após N falhas) quando promover qualquer estágio com escrita (`PLANO_ONDA_4:54`).

---

## 4. Conclusão

A `visao_computacional_mvp` tem a **metade difícil da AI-readiness já resolvida**: cultura de memória durável (git impecável, ADRs, changelog, atribuição de IA) e doutrina de contexto enxuta e honesta. O que falta é a **metade operacional do harness** — o `verify` como sensor executável, os guardrails de máquina, e o saneamento de dois segredos versionados. Pela própria régua do `PLANO_ONDA_4`, o projeto **falha 2 de 3 pré-requisitos do gate duro**, então autonomia ainda não. A boa notícia: os três retrofits de maior alavancagem são baratos e desbloqueiam o caminho inteiro.

**Os 3 retrofits de maior alavancagem:** (1) rotacionar/desversionar os segredos (senha PG + `users.json`); (2) criar `.claude/settings.json` com deny de `.env`/`wa-auth`/`users.json`; (3) materializar o script `verify` (tsc+build+node --check+e2e) como sensor determinístico.
