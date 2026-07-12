# Onda 2 — Conservação de identidade (Petri) + prior de workflow — SPEC

> Status: spec (fundação da Onda 2). Fonte de verdade desta frente. Deriva do **ADR-014, camada 3**
> (zonas=places, operadores=tokens, cruzamentos=transições) e do gate medido em
> `laudo-especialista-2026-07-12-gate-ondas-0-1.md`.
> Escopo desta spec: **o MECANISMO**. O **MODELO** de workflow do CD é TBD (ver §5 — depende do dono).

## 1. Por que agora (o argumento aritmético que promoveu esta camada)

O gate das Ondas 0/1 mediu o teto da identidade por rádio: mesmo dobrando a cadência de advertising
(1→2 Hz), a identidade por RSSI cobre **no máximo ~15,5% dos episódios** a ~98% de precisão — e só
episódios LONGOS (≥~9 s de aproximação observada). Logo:

> **≥84,5% dos episódios NÃO terão identidade por rádio, em cadência nenhuma.**

A arquitetura não pode repousar sobre o rádio. Os outros ≥84,5% precisam de identidade de uma fonte
**independente do rádio**. As duas que o sistema tem são **topologia** (conservação por zona) e
**workflow** (a sequência de postos que o operador percorre). São grátis: sem hardware, sem bateria,
sem cadência. Isso reclassifica a camada 3 de "diferencial" para **PORTANTE**.

## 2. Conceito (a leitura literal do ADR-014, sem inventar formalismo)

- **Places = zonas na granularidade do POSTO** (regra Δ1 do ADR: uma pessoa por posto). A
  granularidade é o **parâmetro de projeto que controla a ambiguidade** — é por isso que se desenha
  zona de posto e não de área.
- **Tokens = identidades de operador.** Não são tracks. O track é o observador, não o objeto.
- **Transições = cruzamentos de fronteira** (`ZoneEvent` de `zone-crossing.ts`).
- **A conservação preserva o CONJUNTO de identidades presentes na zona, NÃO o vínculo individual
  track↔pessoa** (precisão já registrada no ADR-014). Com **1 pessoa/posto**, o conjunto DETERMINA a
  identidade. Com **N**, a topologia conserva {A,B,C} mas **não decide** qual track novo é qual — e
  o sistema **tem de dizer isso**, não chutar.
- "Petri" aqui é **contabilidade de conjuntos por zona com transições de fronteira** — não um motor
  genérico de redes de Petri, não um solver (YAGNI, CLAUDE.md §2).

Invariante de projeto herdada de `zone-crossing.ts`: **morte de track NÃO decrementa ocupação**
(decrementar seria confiar no tracker, exatamente o que a H2 rejeita). A identidade é segurada pelo
BALANÇO de fronteira.

## 3. Critérios de aceite (Given/When/Then)

### CA-1 — Balanço de fronteira conserva a ocupação
**Given** uma zona vazia e um track T com token A
**When** T "entrou" na zona e depois "saiu"
**Then** a ocupação vai 0→1→0 e o conjunto de tokens da zona vai {}→{A}→{} (e a última zona
conhecida de A passa a ser essa zona).

### CA-2 — A identidade sobrevive à MORTE DE TRACK (o núcleo da H2)
**Given** um posto com capacidade 1, onde o track T1 (token A) entrou
**When** T1 **morre dentro** (o tracker perdeu a pessoa) e, depois, um track novo T2 **nasce dentro**
da mesma zona, sem nenhum cruzamento de fronteira no intervalo
**Then** a ocupação permanece 1 (a morte não decrementa), T2 **não** é contado como novo ocupante
(sem dupla-contagem) e a identidade de T2 é **resolvida como A por CONSERVAÇÃO** — sem rádio, sem
tracker, sem ReID.

### CA-3 — Com N pessoas na zona, o vínculo individual é AMBÍGUO e o sistema o DECLARA
**Given** uma zona onde entraram A e B e ambos os tracks morreram dentro
**When** um track novo nasce dentro
**Then** o conjunto {A,B} permanece conservado, e a identidade do track novo é retornada como
**ambígua com candidatos [A,B]** — nunca como um dos dois. Rótulo errado é pior que nenhum.

### CA-4 — Ocupante ANÔNIMO contamina o conjunto e a ambiguidade é exposta
**Given** uma zona com o token A e **um ocupante sem identidade** (entrou sem claim)
**When** um track nasce dentro
**Then** a identidade **não** é resolvida como A (candidato único não basta): retorna ambígua com
candidatos [A] e `anonymousPossible: true`.

### CA-5 — Saída AMBÍGUA degrada o conjunto para SUPERCONJUNTO (honestidade, não silêncio)
**Given** uma zona com o conjunto {A,B} e um track de identidade ambígua dentro dela
**When** esse track "saiu"
**Then** a ocupação decrementa, mas **nenhum token é removido** (não se sabe qual saiu): a zona fica
com `tokens=[A,B]`, `occupancy` menor, e `supersetTokens: true` — o conjunto passa a ser um
SUPERCONJUNTO declarado dos presentes.

### CA-6 — Nascer-dentro sem ocupante disponível = ocupante NOVO (a fronteira nunca o viu)
**Given** uma zona com ocupação 0
**When** um track nasce dentro (pessoa já presente no início da observação)
**Then** a ocupação vira 1, o ocupante é contado como **anônimo**, e o diagnóstico
`bornInsideNew` incrementa (é o risco de dupla-contagem do `zone-crossing.ts`, agora **medido**).

### CA-7 — Balanço negativo é diagnóstico, não crash
**Given** uma zona com ocupação 0
**When** chega um "saiu" (a fronteira perdeu a entrada correspondente)
**Then** a ocupação é clampada em 0 e `negativeBalance` incrementa. Nenhum NaN, nenhuma exceção.

### CA-8 — Capacidade do posto é sensor de saúde
**Given** uma zona declarada com `capacity: 1` (posto)
**When** a ocupação passa de 1
**Then** `capacityViolations` incrementa (duas pessoas no posto **ou** track espúrio — o humano
decide), sem alterar a lógica de resolução.

### CA-9 — Claim de identidade (BLE) durante a visita identifica o anônimo
**Given** um ocupante anônimo dentro da zona
**When** chega um `IdentityClaim` (track→token) — a contribuição da camada 2 nos ~15,5% em que ela
fala
**Then** o token entra no conjunto da zona, o contador de anônimos decrementa e a identidade do track
passa a resolvida `via: "claim"`.

### CA-10 — Determinismo
**Given** o mesmo conjunto de eventos e claims em QUALQUER ordem de entrada
**When** a conservação roda
**Then** a saída é byte-a-byte idêntica (ordenação estável por ts; conjuntos emitidos ordenados) e
não contém NaN.

### CA-11 — MECANISMO do prior de workflow (o MODELO é TBD)
**Given** um `WorkflowModel` (matriz de transição P(próximo posto | posto anterior)) **fornecido de
fora** e um conjunto de candidatos com sua última zona conhecida
**When** um track entra numa zona e a identidade é ambígua
**Then** `workflowPrior()` devolve uma distribuição **normalizada** sobre os candidatos (soma 1, sem
NaN), ordenada; e se o modelo não tiver informação sobre a transição, devolve **uniforme** (ausência
de modelo = ausência de opinião, nunca uma opinião inventada).

## 4. FORA DE ESCOPO (explícito)

- **O MODELO de workflow do CD** — quais postos existem, que sequência o operador percorre, com que
  probabilidade. **Depende do dono** (ver §5). Só o MECANISMO entra agora.
- **Motor genérico de redes de Petri** (inibidores, pesos de arco, marcação simbólica, solver de
  alcançabilidade). Aqui Petri = contabilidade de conjuntos + transições de fronteira.
- **Desambiguação por ReID visual / aparência.** Fonte independente legítima (ADR-014), mas outra
  frente.
- **HSMM / estado operacional / conformance** — camadas 4 e 5, Onda 3.
- **Wiring em produção/UI** — este core é puro e sem consumidor ainda (mesma disciplina de
  `floor-polygon.ts`).
- **Desenho das zonas** (polígonos de posto) — vem do operador/dono, não deste módulo.
- **Δ5 (bandeira de id-switch por contradição chegada×saída)** — precisa da camada 2 acoplada; fica
  registrado como pendência, não implementado aqui.

## 5. GAP DE CONHECIMENTO DE DOMÍNIO — o MODELO precisa do DONO (não inventar)

O mecanismo do prior está construído e testado. **O modelo, não** — e ele não é inferível daqui sem
mentir. Perguntas abertas ao dono / cliente (Grendene CD):

1. **Quais são os POSTOS?** Lista dos postos de trabalho reais (mesa de conferência, expedição,
   picking, etc.), com nome estável.
2. **Qual a SEQUÊNCIA típica?** O operador segue uma ordem (A→B→C) ou circula livre? Existe posto
   inicial/final de turno?
3. **Capacidade real de cada posto** — é mesmo 1 pessoa/posto (regra Δ1)? Onde não for, a
   ambiguidade é estrutural e o produto tem de conviver com ela.
4. **Quem circula além dos operadores rastreados?** (visitantes, empilhadeira, manutenção) — cada
   pessoa sem tag é um "ocupante anônimo" que degrada a conservação (CA-4).
5. **Postos são adjacentes topologicamente?** (dá para ir de A a C sem passar por B?) — isso é o
   suporte da matriz de transição; zeros estruturais valem mais que probabilidades finas.

**Até essas respostas, `WorkflowModel` fica vazio → prior uniforme → a conservação carrega sozinha.**
Nenhum número de transição foi inventado no código.

## 6. Riscos residuais declarados

- A conservação é tão boa quanto a **detecção de fronteira**. Se a fronteira perde cruzamentos, o
  balanço vaza (`negativeBalance`, `bornInsideNew` medem exatamente isso). Já se sabe que o `ttlMs`
  do tracker (#27) é a alavanca barata que reduz o churn dentro da zona.
- Ocupantes anônimos são o **veneno da determinação**: um único não-rastreado num posto derruba
  CA-2 para CA-4. Isto é físico, não um bug — e está exposto no tipo de retorno.
- A ambiguidade da SAÍDA (CA-5) só cresce; nada neste core a resolve. Quem resolve é o rádio (nos
  ~15,5%), o workflow (quando houver modelo) ou o ReID.
