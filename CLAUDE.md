# CLAUDE.md — Guia de desenvolvimento do `visao_computacional_mvp`

> Fonte única de direção (steering) deste projeto. **Lê-se antes de codar.** Destila a doutrina do
> workspace (`../agentes/`) para o contexto deste MVP. Curto de propósito — se crescer demais, ninguém segue.
> Princípio-mãe: **o básico bem feito.** Features sólidas > impressionantes. Sem overengineering.

## 1. O que é este projeto

Inteligência operacional por câmeras para o CD da Grendene. A **análise de indicadores roda no HUB**
(pessoas/atividade/fluxo — motor **D-FINE-S** em worker process, `server/analysis/`, 24/7 sem espectador; configurável por `ANALYSIS_MODEL=n|s|m` — N mais leve, S/M mais recall; ADR-009);
o **navegador é espelho** (vídeo por **WebRTC** quando o gateway **go2rtc** está no ar — binário **empacotado no release** e auto-ligado pela **presença** de `bin/go2rtc[.exe]`, sem flag; **fallback MJPEG** automático por câmera; overlays servidos via `analysis-tracks`) e roda os **modos
especializados** no cliente (Fadiga/MediaPipe, Leitura/ZXing, Objetos/OWL-ViT). O **hub Node** (`server/`)
segue relé de frames via Socket.IO + persistência (Postgres com fallback JSON) + notificações
(WhatsApp/Baileys, Andon). Nós de câmera (`/camera`, webcam) e RTSP (ffmpeg → JPEG) viram câmeras comuns
na central. Arquitetura detalhada: `docs/arquitetura/`. Decisões: `docs/analises/decisoes/` (ADRs). Histórico
de implementação: `docs/analises/implementacao-changelog.md`.

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
- **Gravação de campo é artefato imutável e append-only.** Nenhum agente (nem humano, em modo automático) tem
  poder de deleção sobre sessões de gravação real (`server/bt/fusion-session*.jsonl` e afins). Nasceu de um
  incidente (2026-07-10): um `rm -f` num arquivo sob escrita ativa apagou ~7h de dado de campo irrecuperável.
  Mitigação em camadas: gravador segmenta por hora (perda máxima = 1h, não a sessão) + cópia de backup
  periódica fora do diretório de trabalho ativo. **Runbook se acontecer de novo:** NÃO reinicie o processo
  gravador — ele ainda segura o handle do arquivo e pode salvar o que resta; encerrar/reiniciar é o que perde
  os dados de vez. Isto é Windows: não existe o truque `/proc/PID/fd/` do Linux — a recuperação depende de
  ferramenta de undelete NTFS (ex. TestDisk) rodada **antes** de qualquer nova escrita no volume; sem garantia.
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
- **Decisão arquitetural não-óbvia → ADR curto** em `docs/analises/decisoes/` (Contexto→Decisão→Consequências).
- **Anti-overengineering:** sem arquitetura especulativa, sem DRY dogmático, sem processo pesado para mudança leve. Filtro Signal×Noise: se não aumenta capacidade real, não reduz carga e não move KPI, é ruído.

## 6. Verificação (o motor — onde mais investimos)

Quando gerar código é barato, **a verificação é o gargalo**. Sensores deste projeto:

- **`npm run verify` = `lint` (ESLint) + `typecheck` (`tsc --noEmit`) + `build` (Vite) + `test` (Vitest) + `audit` (`npm audit`).** Gate local via **pre-push hook** (`.githooks/pre-push`, `core.hooksPath`) + CI (`.github/workflows/ci.yml`). **Vermelho não entra.** Para mudança que toca o front/fluxo, rode também o e2e: `npx playwright test`.
- **Critérios de aceite viram teste** (ao menos caminhos críticos/invariantes). "Validado manual" é ponto de partida, não chegada. Regressão corrigida → vira teste (ex.: Select-em-Dialog no `e2e/`). Lógicas puras com unit test em Vitest (`*.test.ts`/`*.test.js` ao lado do código).
- **Sensores de acurácia no gate (CI):** `eval/` (detecção — `gate.mjs`, fixture COCO estratificado) e `eval/counting.mjs` (contagem fim-a-fim) rodam no CI e barram regressão de ML/heurística — toda mudança de knob de `precision.js` passa por eles (fonte única de config espelhada no eval).

### Regras de medição (compradas com sangue — violá-las já custou dois números errados publicados)

- **Regra 8 — Deduplique ANTES de qualquer estatística. `n_eff ≤ nº de medições DISTINTAS`.**
  Isso é **contagem, não modelo**: não existe mais evidência independente do que medições distintas.
  Um snapshot que repete a última leitura entre atualizações reais cria duplicatas com ρ=1 por
  construção — elas carregam informação ZERO. Vira **assert** (não comentário): o invariante
  `nEff ≤ nDistinct ≤ T/Δt_sensor` trava no CI. *Origem: reportamos n_eff=39 (exigiria episódio de
  97 s) porque o simulador anunciava 2,5× mais rápido que a tag real.*
- **Regra 9 — Antes de estimar um parâmetro físico, verifique se o pipeline consegue RESOLVÊ-LO.**
  Um app que posta a 550 ms **não enxerga** a física de uma tag que atualiza a 2,5 s — a ACF que sai
  é a **do pipeline**, não a do canal. Se a resolução do instrumento é mais grossa que a escala do
  fenômeno, o número medido é do instrumento. *É a mesma classe de erro dos tracks estáticos
  filtrados como "flicker de mobília" (medir a população errada), agora na dimensão do TEMPO.*
  Corolário: declare o **ponto cego** — "τ ≲ 1 s" NÃO é "τ = 0"; abaixo da cadência do sensor, nada
  é observável, e apostar ali é aposta, não medição.
- **Pendência de segurança humana (ainda aberta):** rotacionar a senha do Postgres e o `AUTH_SECRET`/senha de admin do homolog, que hoje aceitam defaults inseguros — ver `docs/analises/saude/01-auditoria-doutrina-2026-07.md` (achados P1). *Status histórico das ondas de retrofit vive no git e em `docs/analises/saude/`.*

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
| `docs/arquitetura/`   | Documentação técnica da arquitetura (gerada do código)                                                              |
| `docs/analises/decisoes/` | ADRs (decisões com Contexto→Decisão→Consequências)                                                                  |
| `docs/analises/`          | Planos, benchmarks de UI, changelog de implementação                                                                |
| `docs/produto/`              | Backlog/planos originais do produto (preservados)                                                                   |
| `CLAUDE.md` (este)   | Steering: como desenvolvemos aqui. Atualizar quando uma regra mudar (corrigiu o agente 2× no mesmo fato → escreva). |

> **Atualização:** este guia é vivo. Mudou uma invariante/contrato? Atualize aqui **no mesmo PR**. Em conflito entre este guia e o código, este guia decide (ou é corrigido explicitamente).
