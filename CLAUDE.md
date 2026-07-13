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
- **Contratos socket aditivos:** `frame`, `cameras`, `capture`, `alert`, `camera-status`,
  `alarm-event`/`alarm-update`, `camcfg-updated`, `analysis-status`, `analysis-tracks` são contrato.
  Adicione eventos novos; não quebre os existentes. (`set-capture` e `bt-locations` removidos por
  órfãos na faxina de 2026-07-12 — o `capture` hub→nó segue vivo via shed; o mapa BLE usa polling HTTP. ADR-016.)
- **Endpoints da estação BLE** (`POST /api/bt/reading`, `POST /api/bt/tag-name`, `GET /api/bt/tags`)
  **exigem `BT_STATION_TOKEN` em produção** (503 explicativo se ausente; dev segue aberto com warn no boot). (ADR-016)
- **Casca fullscreen da câmera NÃO vira Radix Dialog** (Portal/scroll-lock remontaria o `<canvas>` e quebraria o rAF/editor). Trap de foco manual permanece. (ADR-007)
- **Radix é a camada de UI.** Todo controle interativo usa primitiva Radix via wrappers de `src/ui/`. (ADR-003, ADR-007)
- **"Going gray":** cor é informação. Base neutra (tokens `--state-*`); saturada só para anormalidade.
- **A caixa da PESSOA nunca exibe NÚMERO** — nem id de track, nem contagem. Sem tag BLE associada, o
  rótulo é o genérico **"Pessoa"**. O id do tracker é detalhe interno (muda a cada re-associação) e
  não significa nada para o operador; **contagem vive no PAINEL, nunca sobre a imagem** ("a imagem é
  soberana", ADR-003). Gate: `src/camera/drawTracks.test.ts` quebra o build se um dígito voltar.
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

> Nota (2026-07-12): os arquivos de pesquisa citados abaixo (`visit-metrics.ts`, `anchor-policy.ts`,
> `receiver-at-destino.test.ts`) saíram do main na faxina do ADR-016 — vivem na tag
> `research-fusion-arc-2026-07-12`. As regras permanecem: são doutrina, não código.

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
- **Regra 10 — O piso onde um teste é DEFINIDO não é o piso onde ele é CONFIÁVEL; e o piso operacional
  é ESCOLHA DE PRODUTO, não constante da natureza.**
  O gate de Fisher-z exige n_eff > 3 (é onde √(n_eff−3) existe). Isso **não** é onde ele é confiável: o
  nível de significância nominal é fantasia em n pequeno (a distribuição amostral de r é assimétrica; o
  atanh só corrige em parte). **Meça a curva precisão × n — e reporte a curva INTEIRA, porque ela não
  tem joelho.** *Medido (1464 episódios): em n_eff ∈ [3,5) o teste **não decide NADA** (barra |r| ≈
  0,97); a precisão sobe numa **rampa ruidosa de ~85% (piso 3) a ~94% (piso 20), SEM patamar**. Não há
  piso "natural" a descobrir — há um **trade-off**: piso 3 → 84,6% prec / 41,2% cob; piso 9 → 88,8% /
  34,7%; piso 19 → 94,2% / 17,6%. Alvo de 95% de precisão é **inalcançável** neste canal.*
  **Consequência: o piso se escolhe pelo alvo de negócio (a métrica-que-mata), e o alvo tem de caber
  sob o teto medido.** Corolário barato: **calar mais** — o sistema não estava quebrado, estava
  **falando quando não tinha nada a dizer**.
- **Corolário (estatística honesta, obrigatório):** **13/13 NÃO é 100%.** Toda proporção sai com **n e
  intervalo de Wilson 95%** (13/13 → ≥77%; 6/6 → ≥61%). `wilsonInterval()` existe em
  `visit-metrics.ts` — usar. Ao cliente se promete **a curva e o gate**, nunca o ponto.
- **Regra 11 — Meça a precisão do que o MECANISMO comprou, não a precisão GLOBAL.**
  Um agregado pode ser **inflado por um mecanismo diferente que funciona**, escondendo uma
  subpopulação **100% errada**. *Origem: ao testar o fechamento por planta baixa, ele produziu 12
  rótulos, **TODOS errados (0% de precisão)** — enquanto a precisão **GLOBAL** marcava **99,6%**,
  porque os **pinos** (verdadeiros, vindos da conservação) dominavam o agregado. Olhar só o global
  teria mandado rótulo falso **com cara de certeza** para produção.* **Toda feature nova reporta a
  precisão do SEU delta, isolada** — nunca só o número agregado.
- **Regra 13 — Dado independente NÃO significa ERRO independente. Meça a concordância-no-erro antes de somar evidências.**
  Somar evidências (Fisher-z, votos, ensembles) só rende o que a fórmula promete se os ERROS forem
  independentes. *Medido: episódios do mesmo operador têm **ZERO** dado compartilhado (janelas
  disjuntas — não é a inflação da Regra 8) — e ainda assim, **quando o 1º erra, o 2º repete o MESMO
  erro em 41,2%**, contra um teto model-free de independência de **8,8%: 4,7× acima.** É o mesmo viés
  corporal/geometria duas vezes. "n_eff 19+19=38" é FALSO como evidência independente.* A agregação
  ainda compra precisão (a **discordância** pega 58,8% dos erros), mas **compra menos do que a soma
  promete**. Sensor obrigatório: `agreementOnFailure` (em `anchor-policy.ts`) ao lado de qualquer
  agregação.
  **Corolário medido (2026-07-12) — a saída fácil NÃO existe: erro correlacionado é propriedade do
  SUJEITO, não do INSTANTE.** A hipótese natural ("aqueles 41,2% eram fragmentos colados de 1 s;
  separando os episódios no tempo, o erro decorrelaciona") foi testada e **REFUTADA**: a curva
  concordância-no-erro × separação temporal é **PLANA** — 24,4% [16,6–34,5] entre fragmentos de 0-2 s
  e **21,5% [20,1–23,0] entre episódios separados por MAIS DE 5 MINUTOS**, contra um teto de
  independência *bin-local* de ~6% (**3,6× acima, sem convergir**). Exigir separação (`minSeparationMs`)
  não compra precisão e **piora** a compra (remove âncoras ⇒ n cai ⇒ Wilson alarga). **Não conserte
  erro correlacionado com o relógio** — o que muda a causa (geometria da pessoa, vizinho confundível,
  colocação da tag) é *procedimento/hardware*, não *tempo*. Ver `receiver-at-destino.test.ts`
  ("ADR-015 §2") e `docs/analises/tags-bluetooth/PENDENCIAS.md`.
- **Regra 12 — Restrição GLOBAL não cria identidade; só AMPLIFICA um sinal assimétrico.**
  A exclusividade ("um operador está em exatamente um lugar") é **permutacionalmente simétrica**:
  remove a opção "fora" de **todos igualmente**, então com N operadores intercambiáveis toda
  permutação segue viável e **o entailment fica VAZIO**. *Medido: fechamento total das zonas →
  ganho **0,0%**.* Só quebra a simetria um sinal **assimétrico por operador** (pino de fronteira,
  localidade de receptor, ReID). **Antes de investir em restrição, pergunte: ela é simétrica? Se
  for, ela não decide nada sozinha — precisa de uma ÂNCORA.**
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
