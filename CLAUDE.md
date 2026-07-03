# CLAUDE.md — Guia de desenvolvimento do `visao_computacional_mvp`

> Fonte única de direção (steering) deste projeto. **Lê-se antes de codar.** Destila a doutrina do
> workspace (`../agentes/`) para o contexto deste MVP. Curto de propósito — se crescer demais, ninguém segue.
> Princípio-mãe: **o básico bem feito.** Features sólidas > impressionantes. Sem overengineering.

## 1. O que é este projeto

Inteligência operacional por câmeras para o CD da Grendene. A **análise de indicadores roda no HUB**
(pessoas/atividade/fluxo — motor **D-FINE-S** em worker process, `server/analysis/`, 24/7 sem espectador; configurável por `ANALYSIS_MODEL=n|s|m` — N mais leve, S/M mais recall; ADR-009);
o **navegador é espelho** (vídeo + overlays servidos via `analysis-tracks`) e roda os **modos
especializados** no cliente (Fadiga/MediaPipe, Leitura/ZXing, Objetos/OWL-ViT). O **hub Node** (`server/`)
segue relé de frames via Socket.IO + persistência (Postgres com fallback JSON) + notificações
(WhatsApp/Baileys, Andon). Nós de câmera (`/camera`, webcam) e RTSP (ffmpeg → JPEG) viram câmeras comuns
na central. Arquitetura detalhada: `docs-regenerada/`. Decisões: `analises/decisoes/` (ADRs). Histórico
de implementação: `analises/implementacao-changelog.md`.

## 2. Princípios inegociáveis (atemporais)

1. **Simplicidade primeiro (YAGNI/KISS).** A solução mais simples que resolve o problema real. Abstração só no 3º caso.
2. **Uma responsabilidade por unidade** (função, módulo, commit, tarefa). Se precisa de "e" para descrever, são duas.
3. **Organizar por domínio, não por tipo.** Tudo de uma feature perto.
4. **Contratos estáveis entre camadas.** Mudança de contrato sem teste é a regressão silenciosa nº 1.
5. **Honestidade técnica.** Validar contra a realidade antes de afirmar; separar medição de inferência;
   documentar até o que _não_ funciona. **Sem evidência, não há "pronto".** Nunca confiar no "o teste passou" relatado — só na execução.
6. **Entregas pequenas e reversíveis.** Lote pequeno = revert fácil. `main` sempre estável; commit por intenção.
7. **Segurança e LGPD não são opcionais** (ver invariantes).

## 3. Invariantes — NUNCA VIOLAR

- **LGPD / local-first:** nenhuma imagem/frame é persistida no servidor. Só metadados/indicadores.
  Frames são **efêmeros em memória** — no relé E no motor de análise (hub → worker via IPC; ADR-009).
  Cine-loop é **buffer em memória, efêmero**; "salvar" é download local manual. Eventos de alarme = só metadados. (ADR-002)
- **Segredos:** nunca versionar `.env`/credenciais/`wa-auth/`/`*.json` de runtime; nunca enviar segredos/PII a uma IA.
  `cameras.json`, `alarms.json`, `camcfg.json`, `alarm-shelves.json`, `rtsp.sources.json`, `wa-auth/` ficam no `.gitignore`.
- **Contratos socket aditivos:** `frame`, `cameras`, `set-capture`/`capture`, `alert`, `camera-status`,
  `alarm-event`/`alarm-update`, `camcfg-updated`, `analysis-status`, `analysis-tracks` são contrato.
  Adicione eventos novos; não quebre os existentes.
- **Casca fullscreen da câmera NÃO vira Radix Dialog** (Portal/scroll-lock remontaria o `<canvas>` e quebraria o rAF/editor). Trap de foco manual permanece. (ADR-007)
- **Radix é a camada de UI.** Todo controle interativo usa primitiva Radix via wrappers de `src/ui/`. (ADR-003, ADR-007)
- **"Going gray":** cor é informação. Base neutra (tokens `--state-*`); saturada só para anormalidade.
- **SQL/persistência:** queries parametrizadas; SIAG é **read-only**; `schema.sql` idempotente (aditivo, sem alterar tabelas existentes).

## 4. Stack & padrão da casa

- **Front:** React 19 + TS **strict** + Vite + **Radix** (wrappers em `src/ui/`, estilo por tokens `--state-*`/`--cam-*`/`--sp-*`).
- **Back:** Node `http` nativo + Socket.IO + `pg` (fallback JSON espelhando `recipients.js`); auth `scrypt` + token HMAC, RBAC por papel (`usuario`/`engenheiro`/`superadmin`; capacidade `canConfigure`).
- **Sem dependência supérflua** (a casa prova que `crypto` nativo + `node:http` bastam). Cada dep é passivo.

## 5. Como construímos (ciclo leve)

- **Mudança pequena (1–2 arquivos):** vai direto, sem cerimônia.
- **Feature multi-arquivo:** `spec` (o quê + critérios de aceite em **Given/When/Then** + **fora de escopo**) →
  `plan` (como + mapa requisito→implementação + riscos) → `tasks` (`[S]`/`[P]`) → implement → **validate**. A spec é a fonte da verdade.
- **Paralelização (multi-agente):** **paralelize execução, serialize revisão.** Particione por **propriedade exclusiva de arquivo** (sem git/worktree, edições concorrentes no mesmo arquivo se sobrescrevem); contratos entre frentes paralelas são explicitados antes; valide o estado combinado ao fim de cada onda.
- **Decisão arquitetural não-óbvia → ADR curto** em `analises/decisoes/` (Contexto→Decisão→Consequências).
- **Anti-overengineering:** sem arquitetura especulativa, sem DRY dogmático, sem processo pesado para mudança leve. Filtro Signal×Noise: se não aumenta capacidade real, não reduz carga e não move KPI, é ruído.

## 6. Verificação (o motor — onde mais investimos)

Quando gerar código é barato, **a verificação é o gargalo**. Sensores deste projeto:

- **`npm run verify` = `lint` (ESLint) + `typecheck` (`tsc --noEmit`) + `build` (Vite) + `test` (Vitest).** Gate local via **pre-push hook** (`.githooks/pre-push`, `core.hooksPath`) + CI (`.github/workflows/ci.yml`). **Vermelho não entra.** Para mudança que toca o front/fluxo, rode também o e2e: `npx playwright test`.
- **Critérios de aceite viram teste** (ao menos caminhos críticos/invariantes). "Validado manual" é ponto de partida, não chegada. Regressão corrigida → vira teste (ex.: Select-em-Dialog no `e2e/`). Lógicas puras com unit test em Vitest (`*.test.ts`/`*.test.js` ao lado do código).
- **Onda 0 fechada** (commits R0/R1): ESLint+Prettier, `verify`, pre-push hook, CI e 68 unit tests das lógicas puras existem. **Resíduos a baixar:** ~18 warnings de lint; `npm audit` com 4 vulns transitivas de `@xenova/transformers` (fix é breaking — avaliar). **Pendência de segurança humana:** rotacionar a senha Postgres e o `AUTH_SECRET` que estiveram expostos (já desversionados/purgados do histórico). Próximas ondas do retrofit: R2 (quebrar `CameraWorkspace.tsx`, unificar duplicações) e R3 (acabamento UI) — ver `analises/saude/00-relatorio-saude-e-retrofit.md`.

## 7. Definition of Done

- [ ] Funciona no fluxo real, não só no caso feliz.
- [ ] Critérios de aceite atendidos (os críticos viraram teste verde).
- [ ] `verify` verde; sem segredo no código; sem regressão conhecida em aberto sem plano.
- [ ] Diff revisado; decisão não-óbvia registrada (ADR). Risco residual declarado.

## 8. Uso de IA (coleira certa)

- **IA amplia quem tem fundamentos**; usar para o tedioso, não para terceirizar arquitetura. **Humano no loop** nos pontos irreversíveis.
- **Autonomy slider:** quanto mais crítico (produção, SIAG, segurança, LGPD), mais curta a coleira.
- **Tier comercial/no-train** para código não-público; **nunca** mandar `.env`/segredos/PII; **Trae proibida** para código proprietário. Revisão humana significativa de todo output (PI + qualidade).
- **Gate determinístico antes de ação irreversível** (push em `main`, deploy, DROP, e-mail externo): teste-verde **ou** aprovação humana.

## 9. Mapa de artefatos

| Onde                 | O quê                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `../agentes/`        | Doutrina completa: manifesto, práticas, política de IA, pesquisa de autonomia, glossário                            |
| `docs-regenerada/`   | Documentação técnica da arquitetura (gerada do código)                                                              |
| `analises/decisoes/` | ADRs (decisões com Contexto→Decisão→Consequências)                                                                  |
| `analises/`          | Planos, benchmarks de UI, changelog de implementação                                                                |
| `docs/`              | Backlog/planos originais do produto (preservados)                                                                   |
| `CLAUDE.md` (este)   | Steering: como desenvolvemos aqui. Atualizar quando uma regra mudar (corrigiu o agente 2× no mesmo fato → escreva). |

> **Atualização:** este guia é vivo. Mudou uma invariante/contrato? Atualize aqui **no mesmo PR**. Em conflito entre este guia e o código, este guia decide (ou é corrigido explicitamente).
