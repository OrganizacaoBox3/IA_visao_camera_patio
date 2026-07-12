# Onda 2 — Atribuição OPERADOR↔ZONA sob restrições — SPEC (v2, RE-ESCOPADA)

> Status: spec v2. **Esta é uma RETRATAÇÃO DE ARQUITETURA, não um refinamento.** A v1 (conservação
> topológica + **prior de workflow**) foi construída, testada e **refutada por conhecimento de
> domínio**. O prior de rota MORREU; o núcleo da conservação SOBREVIVEU; e a peça que nunca havíamos
> explorado — **o conjunto de tags presentes** — passou a ser a base.
> Fonte de verdade desta frente. Deriva do ADR-014 (camada 3) e do gate das Ondas 0/1
> (`laudo-especialista-2026-07-12-gate-ondas-0-1.md`).

---

## 1. O que continua valendo do gate (o motivo de a camada existir)

O gate mediu o teto da identidade **por correlação de RSSI**: no melhor caso (tag a 2 Hz, aproximação
longa) ela cobre **~15,5% dos episódios** a ~98% de precisão. O gargalo é o `n_eff` (independência
temporal), não o span — e ele é limitado pelo advertising da tag.

> **≥84,5% dos episódios NÃO terão identidade por CORRELAÇÃO, em cadência nenhuma.**

Esses 84,5% precisam de identidade de fontes **independentes da correlação**. A v1 apostou em duas:
**topologia** (conservação por zona) e **workflow** (a sequência de postos). A segunda não existe.

---

## 2. RETRATAÇÃO — as 5 respostas do dono e o que elas MATARAM

O dono respondeu às perguntas de domínio que a v1 §5 deixou em aberto. As respostas **refutam a
premissa central da v1**. Registrado aqui com a honestidade que a doutrina exige (CLAUDE.md §2.5):

| # | Pergunta (v1 §5) | Resposta do dono | O que isso MATA |
|---|---|---|---|
| 1 | Qual a **sequência** típica? | **Não existe.** O operador **circula LIVRE** no turno. | ☠️ **P(próximo posto\|posto atual) é UNIFORME ⇒ INFORMAÇÃO ZERO.** Morre o **prior de rota**, morre o **conformance de sequência**, e a rede de Petri de **sequência** perde toda a estrutura restritiva. |
| 2 | Postos são **adjacentes**? | **Sim** — são **mesas vizinhas, todas adjacentes**. | ☠️ **Não há zeros estruturais** na matriz de transição. E os zeros eram o único valor real dela ("o zero vale mais que a probabilidade fina" — v1, CA-11). Sem zeros, sobra a uniforme: nada. |
| 3 | Capacidade real do posto? | **1–2 pessoas.** | ⚠️ A regra Δ1 ("1 pessoa/posto ⇒ conservar o conjunto É identificar") **só vale metade das vezes**. Com 2, o conjunto conserva {A,B} e **não decide** quem é quem. |
| 4 | Quem circula além dos operadores? | **Anônimos circulam CONSTANTEMENTE** (visitantes, empilhadeira, manutenção). | ⚠️ O balanço de conservação `N = N₀ + E − X` **deixa de fechar** por si. O ocupante anônimo, que a v1 tratava como "veneno" acidental, é o **regime normal**. |
| 5 | Quais são os postos? | Mesas de trabalho vizinhas (lista operacional do dono). | — (insumo de desenho de zona, não de modelo.) |

**Consequência de código (já aplicada):** `workflowPrior()`, `WorkflowModel`, `PriorCandidate`,
`PriorEntry` foram **REMOVIDOS** de `src/fusion/petri-conservation.ts` — não rebaixados a "não
usado", removidos. Um mecanismo cujo único modelo possível é a uniforme é um knob que não decide
nada: ruído com aparência de capacidade (CLAUDE.md §5, filtro Signal×Noise). A remoção está marcada
no arquivo com um bloco **RETRATAÇÃO** que aponta para esta seção. O CA-11 original virou um teste de
que **`lastZone` sobreviveu** — mas agora como insumo da **continuidade física**, não de um prior de
rota.

**NÃO INVENTAR UM MODELO DE WORKFLOW.** Ele não existe. Qualquer número de transição escrito daqui
para frente é ficção.

---

## 3. O que SOBREVIVEU (a nova base) — 4 restrições que continuam de graça

1. **ESCALA DO TURNO.** Quem está trabalhando hoje. Se são 3 operadores na área, o espaço de
   hipóteses é sobre **3**, não sobre os 20 do cadastro. Restrição de domínio, custo zero.
2. **EXCLUSIVIDADE.** Um operador está em **exatamente um lugar**. Se X está confiantemente na mesa
   4, X **não está** na mesa 7. É uma restrição **GLOBAL de atribuição** — é aqui que a atribuição
   ótima finalmente paga (por **propagação a partir de um pino**; ver §7, honestidade).
3. **CONTINUIDADE FÍSICA.** Ninguém se teleporta: alcançabilidade = saltos de vizinhança × tempo
   decorrido.
4. **🔑 O CONJUNTO DE TAGS PRESENTES.** O scan BLE devolve os **MACs presentes na área**. Isso é
   **identidade de graça: sem correlação, sem movimento, sem `n_eff`. Só detecção.** É a peça que
   nunca havíamos explorado — e a única que o gate das Ondas 0/1 **não** derrubou (o gate mediu a
   *correlação*, não a *detecção*). Ela permite o bookkeeping que a resposta 4 quebrou:

   > **nº mínimo de ANÔNIMOS = pessoas(câmera) − tags(rádio).**
   > Se a câmera vê 2 pessoas na mesa 4 e só 1 tag está na vizinhança, **uma delas é visitante.**

E do core da v1 sobrevivem, **intactos e ainda portantes** (sustentam L0/L1 **sem identidade
nenhuma**): ocupação por **balanço de fronteira**, **capacidade como sensor de saúde** (não como
restrição dura), **token segurado na morte de track** (CA-2 — o núcleo da H2), e **ambiguidade
exposta no tipo de retorno**.

---

## 4. A MUDANÇA DE NÍVEL (o insight que reposiciona tudo)

O problema de atribuição **migra do TICK para a ZONA**:

| | v1 / tentativas anteriores | v2 (esta spec) |
|---|---|---|
| Unidade | tag↔track por **tick** (500 ms) | operador↔**zona** |
| Horizonte | instantâneo | **minutos** |
| Estrutura | nenhuma (matching denso, ambíguo) | capacidade 1–2, exclusividade, conjunto-de-tags, ocupante anônimo |
| Resultado histórico | **Hungarian FRACASSOU** (registrado) | problema pequeno, com estrutura real |
| Dustbin | fabricado, no nível errado | o **anônimo** é um destino de atribuição **LEGÍTIMO e esperado** |

E a **ausência** de rádio muda de valor com o horizonte: fraca no tick (advertising perdido), **forte
em minutos** (uma tag a 1 Hz tem ~60 chances/min de ser vista). É por isso que a restrição 4 só é
utilizável **neste nível**.

---

## 5. Critérios de aceite (Given/When/Then)

### Sobreviventes da v1 (o core de conservação — continuam valendo, testes verdes)
**CA-1** balanço de fronteira conserva a ocupação · **CA-2** a identidade sobrevive à **morte de
track** (núcleo da H2) · **CA-3** com N pessoas o vínculo é **ambíguo e declarado** · **CA-4**
ocupante anônimo contamina o conjunto · **CA-5** saída ambígua degrada o conjunto para
**superconjunto** · **CA-6** nascer-dentro sem ocupante = ocupante novo · **CA-7** balanço negativo é
diagnóstico · **CA-8** capacidade é sensor de saúde · **CA-9** claim identifica o anônimo · **CA-10**
determinismo. *(Ver `petri-conservation.test.ts`. **CA-11 foi reescrito**: o que resta dele é que
`lastZone` continua saindo da conservação — hoje insumo da continuidade.)*

### Novos — a atribuição operador↔zona (`zone-assignment.ts`)

#### CA-A1 — O conjunto de tags presentes é identidade de graça
**Given** uma escala `[A,B,C]` e um scan que viu **só a tag de A**
**When** a atribuição roda
**Then** só **A** é atribuível; **B** e **C** saem como `ausente`; e uma tag vista **fora da escala**
não é atribuível — entra em `offRoster` (anônimo *com* tag). Se houver locality de receptor
(`nearZones`), ela **poda as zonas candidatas** — por **set-membership**, sem nenhum número de RSSI.

#### CA-A2 — A contagem de anônimos (a conta do dono)
**Given** uma zona onde a câmera conta **2 pessoas** e só **1 tag** presente na área
**When** a atribuição roda
**Then** `anonymousFloor = 1` e a zona reporta `anonymous.min ≥ 1` — **há PROVA de um anônimo**.
**And** se as tags presentes **excederem** as pessoas contadas, `tagsExceedPeople > 0` é emitido como
**diagnóstico** (tag esquecida na bancada / operador fora do FOV / subcontagem do detector) — nunca
silêncio, nunca clamp mudo.

#### CA-A3 — Exclusividade colapsa a ambiguidade da zona vizinha (é aqui que ela paga)
**Given** A **fixado** na MESA4 pela conservação (`pinned`), B presente, e a MESA7 com 1 pessoa
**When** a atribuição roda **com fechamento** (`tagsMustBeInSomeZone`)
**Then** B é **`decidida` na MESA7 `via: "exclusao"`** — sem rádio direcional, sem correlação: só
porque A **não pode** estar em dois lugares.
**And** **sem** o fechamento, B sai **`ambigua` com `zones: [MESA7]` e `foraPossivel: true`** — a
exclusividade **podou** a MESA4, mas **não decidiu**. A confissão está no tipo. *(Ver §7.)*

#### CA-A4 — Continuidade física: ninguém se teleporta
**Given** a última zona conhecida de A e uma topologia com `hopMs`
**When** a zona-alvo está a mais saltos do que o tempo decorrido permite
**Then** ela é **podada**. **And** sem topologia declarada, **nada é excluído** (ausência de modelo =
ausência de opinião — a mesma disciplina que matou o prior).

#### CA-A5 — Pino × rádio: a contradição é diagnóstico, não decisão silenciosa
**Given** A **fixado** na MESA4 pela conservação, mas **ausente** do scan de rádio
**When** a atribuição roda
**Then** o **pino vence** (evidência posicional independente; rádio silencioso pode ser
bateria/sombra) e a contradição sai em `pinnedNotDetected`.
**And** restrições contraditórias na entrada (dois pinos numa zona de 1 pessoa; o mesmo token fixado
em duas zonas) devolvem **`kind: "inviavel"` com as razões** — nunca uma saída inventada.

#### CA-A6 — Capacidade continua sendo sensor de saúde, não restrição dura
**Given** um posto de `capacity: 2` onde a câmera conta **3**
**When** a atribuição roda
**Then** `capacityViolation` sobe e a atribuição **prossegue** (o teto duro é a **ocupação vista**,
não a capacidade **declarada** — restringir pela declaração seria confiar num número contra o que a
câmera vê). Mesma semântica de `petri-conservation.ts` (CA-8).

#### CA-A7 — Entailment, ambiguidade e determinismo
**Given** o mesmo cenário em **qualquer ordem** de zonas/escala/tags
**When** a atribuição roda
**Then** a saída é **byte-a-byte idêntica**, sem NaN, com conjuntos ordenados; um operador só é
`decidida` se **TODA** atribuição viável o põe naquela zona (**entailment**, não score, não limiar,
não desempate); e se o **orçamento de busca** estourar, o resultado **degrada para ambíguo**
(`budgetExceeded`) — jamais afirma o que a busca não provou.

#### CA-A8 — A conservação alimenta a atribuição
**Given** um token que a conservação segurou numa zona através da **morte do track** (CA-2)
**When** `zoneObservationsFromConservation()` converte o estado
**Then** esse token vira **`pinned`** naquela zona (e dispara a exclusividade).
**And** se o conjunto da zona for um **SUPERCONJUNTO** (`supersetTokens` — houve saída ambígua),
**nenhum pino é emitido**: a conservação não sabe quem ficou, e **pino falso é pior que nenhum pino**.

---

## 6. FORA DE ESCOPO (explícito)

- **Qualquer modelo de workflow/sequência.** Morto por §2. Não voltará sem um fato novo do domínio.
- **Solver genérico de atribuição** (Hungarian, LP, min-cost-flow). A estrutura é **pequena**
  (poucos operadores, ocupação 1–2): um DFS com poda por ocupação enumera o espaço e devolve
  **entailment**. Abstração só no 3º caso (CLAUDE.md §2). *(E o Hungarian já fracassou no nível do
  tick — trazê-lo de volta para o nível da zona seria trazer a peça errada para o lugar certo.)*
- **Score/probabilidade de atribuição.** Não há prior legítimo para calibrar peso — §2. O retorno é
  **set-membership** (decidido / conjunto possível), não uma distribuição.
- **A restrição disjuntiva do superconjunto** ("um de {A,B} ainda está na MESA4"): é informação real
  que a conservação produz e que a atribuição hoje **descarta** (vira candidato comum). Registrado
  como **pendência**, não implementado — exige constraint disjuntiva por zona, e o ganho ainda não
  foi medido.
- **HSMM / estado operacional / conformance com limites** — camadas 4–5, Onda 3. *(Conformance de
  **sequência** está morto; conformance de **duração/limites** por posto continua vivo — não depende
  de rota.)*
- **ReID visual** (ADR-015) — fonte de pino independente, outra frente. O contrato `pinned` já a
  aceita sem mudança.
- **Wiring em produção/UI.** O core é puro e ainda sem consumidor (mesma disciplina de
  `floor-polygon.ts`).
- **Desenho das zonas** (polígonos de mesa) e a **escala do turno** — vêm do dono/operação.

---

## 7. Honestidade — a força REAL de cada restrição sobrevivente (medida ao implementar)

Pedido explícito do dono: *"se alguma das 4 restrições se revelar mais fraca do que parece, DIGA."*
Duas se revelaram mais fracas:

- **EXCLUSIVIDADE (2) sozinha NÃO ENTRANHA NADA.** Sem pinos e sem fechamento, todo operador pode
  estar **"fora"** (corredor, banheiro, zona sem câmera) — logo nenhuma atribuição é forçada. Ela
  **poda** o espaço; ela só **decide** combinada com (a) um **pino** da conservação/claim, (b)
  **saturação de ocupação**, ou (c) a assunção de **fechamento** (`tagsMustBeInSomeZone` — só válida
  se as zonas ladrilham a área observada). Isso está **exposto no tipo** (`foraPossivel`) e testado
  (CA-A3, 2º caso). **A leitura correta é: a exclusividade é o AMPLIFICADOR do pino, não uma fonte
  autônoma de identidade.** Consequência prática: **cobertura de câmera nas zonas importa** — cada
  buraco de FOV vira um "fora" que dissolve a força da restrição.
- **CONTINUIDADE (3) é quase inerte NESTE CD.** Se as mesas são todas adjacentes (resposta 2), a
  distância topológica entre qualquer par é **1 salto** — a restrição só exclui algo quando o tempo
  decorrido é menor que **um** salto. Mantida porque é de graça e porque **endurece** onde houver
  zonas realmente distantes (doca × mezanino). Hoje: quase zero informação. Testado explicitamente
  (CA-A4, 3º caso).

As duas que **se confirmaram fortes**:

- **CONJUNTO DE TAGS (4)** é a única fonte de identidade **barata e não-refutada** que temos. É o
  chão da atribuição — e é ela que torna a **contagem de anônimos** possível.
- **ESCALA (1)** encolhe o espaço de hipóteses de 20 para 3 antes de qualquer inferência. Barata,
  exata e imune a ruído de sensor.

## 8. Riscos residuais declarados

- **Anônimos são o regime normal** (resposta 4), não a exceção. Toda a métrica de identidade tem de
  ser reportada **com a faixa de anônimos** (`anonymous.min/max`) ao lado. Um número de identidade
  sem a contagem de anônimos ao lado é enganoso.
- **A atribuição é tão boa quanto a contagem da câmera.** `occupancy` errado ⇒ `anonymousFloor`
  errado nos dois sentidos (`tagsExceedPeople` é o sensor de que isso está acontecendo).
- **`tagsMustBeInSomeZone` é uma ASSUNÇÃO**, não um fato. Ligá-la sem que as zonas ladrilhem a área
  observada produz decisões **erradas com cara de certeza**. Default `false`, e assim deve ficar até
  que o desenho de zonas justifique.
- **Ausência de rádio ≠ prova de ausência** (bateria, sombra). No horizonte de minutos é evidência
  forte, mas o `pinnedNotDetected` existe justamente porque ela pode mentir.
