# ADR-015 — ReID visual é pilar de identidade de 1ª classe (a lacuna que o rádio nunca preencheria)

Data: 2026-07-12 · Status: aceito (direção); implementação gated · Origem: as 5 respostas de domínio
do dono (2026-07-12) + o gate de contagem (Regra 8). Complementa o ADR-014 e re-escopa a Onda 2.

## Contexto — o que as respostas do dono mataram

O dono respondeu 5 perguntas de domínio sobre o CD e três delas **refutaram a premissa da Onda 2**:

| Pergunta | Resposta | O que ela mata |
|---|---|---|
| Sequência típica? | **Circula LIVRE no turno** | A matriz de transição é UNIFORME ⇒ **prior de rota = informação ZERO**; conformance de sequência não tem o que conferir |
| Postos adjacentes? | **Mesas VIZINHAS, todas adjacentes** | **Não há zeros estruturais** ⇒ a topologia não corta candidato pelo movimento |
| Capacidade? | **1-2 pessoas/posto** | A regra "1 pessoa ⇒ conservar o conjunto É identificar" vale só METADE das vezes |
| Anônimos? | **Constantemente** (visitantes, empilhadeira, manutenção) | O balanço de conservação N = N₀ + E − X **deixa de fechar** |

**Consequência dura, por CONTAGEM (Regra 8), não por fraqueza de algoritmo:** se os postos são mesas
vizinhas, o movimento cotidiano é **mesa→mesa (3-5 m, T ≈ 2-4 s)** → com a tag real (advertising 2,5 s)
isso dá **1-2 leituras distintas** → o teste de Fisher (√(n_eff−3)) é **INDEFINIDO**. **O rádio NÃO
dispara no movimento cotidiano — que é ~95% do que o operador faz no turno.** Ele só dispara na
caminhada LONGA (entrada de turno, volta de intervalo, ~18 s): **2-4× por turno**.

**Logo o problema MUDOU:** a identidade é **estabelecida 2-4× por turno** e precisa ser **MANTIDA por
horas**. Essa não é a questão que a arquitetura resolvia. E os três mecanismos de manutenção que
tínhamos estão todos danificados: conservação topológica (furada pelos anônimos + capacidade 2),
workflow (morto pela circulação livre), track visual (já sabíamos frágil).

## Decisão

1. **ReID visual (reidentificação por aparência) entra como PILAR de 1ª classe** — é a peça que
   carrega identidade por HORAS e que a arquitetura nunca considerou seriamente. Ela não precisa de
   rádio, não precisa de movimento radial, **não precisa de n_eff**, e **sobrevive à morte do track**.
   O tracker atual (ByteTrack) usa **só movimento**; ReID adiciona **embedding de aparência** (é o que
   DeepSORT/BoT-SORT fazem). Operadores diferem em altura, compleição, cor de uniforme, EPI.
   **É biblioteca madura — não é pesquisa.**

2. **O desenho de instalação é o PORTAL DE IDENTIFICAÇÃO**: câmera cobrindo o **corredor de entrada**
   + receptor BLE **no fim dele** (no destino, sobre o eixo da caminhada). Todo operador que entra na
   área passa por ~18 s de aproximação radial → o rádio identifica ali, com alta confiança (100% de
   precisão medida na posição do destino, vs 55,6% do baseline). **ReID + conservação carregam o resto
   do turno.** Não se precisa de MUITAS identificações — precisa de **uma âncora confiável por turno**.

3. **A tag rápida vira decisiva por um motivo NOVO**: com Δt = 0,5 s, **T = 8 s já basta** (|r| ≥ 0,48)
   → o corredor exigido **encolhe de ~20 m para ~9 m** — a diferença entre "dá para instalar" e "não
   dá". A tag rápida e o portal são **o mesmo item de decisão**.

4. **LGPD — INVARIANTE, travada desde o 1º commit (não é remendo posterior):** o embedding de
   aparência é derivado do corpo da pessoa e é **adjacente a biométrico**. Portanto:
   - **O embedding é EFÊMERO EM MEMÓRIA**, escopo de sessão/turno, **NUNCA persistido** — a mesma
     disciplina que já vale para frames (ADR-002, CLAUDE.md §3).
   - **Nada de galeria de aparência entre turnos/dias.** Sem re-identificação de uma pessoa em outra
     data. O vínculo aparência→identidade só existe enquanto a âncora daquele turno existir.
   - Nenhum embedding sai do hub, nunca vai para uma IA externa, nunca entra em log.
   - Violar isto transforma um produto de conformidade de processo em vigilância biométrica — que é
     exatamente o que o posicionamento do ADR-014 recusa.

5. **Custo declarado (a única peça deste desenho que NÃO é grátis):** ReID exige rodar um modelo de
   aparência por pessoa por frame, no hub (que hoje roda D-FINE-S + ByteTrack). É a única peça que
   custa CPU. Medir antes de adotar como default (o gate `eval/` da casa vale aqui).

## O que sobrevive de "workflow" — as 4 restrições que estavam de graça

A SEQUÊNCIA morreu. Estas NÃO:

1. **Escala do turno** — quem trabalha hoje? Se são 3 operadores na área, o prior é sobre 3, não 20.
2. **Exclusividade** — um operador está em EXATAMENTE UM lugar. Se X está na mesa 4, X não está na
   mesa 7. É restrição **global de atribuição** — e é aqui que a atribuição ótima finalmente paga.
3. **Continuidade física** — ninguém se teleporta entre postos sem passar pelo caminho.
4. **🔑 O CONJUNTO DE TAGS PRESENTES** (nunca explorado): o scan BLE devolve os **MACs presentes**.
   Isso é **identidade de graça — sem correlação, sem movimento, sem n_eff. Só detecção.** E restaura
   o bookkeeping que os anônimos quebraram:
   **nº de ANÔNIMOS = pessoas(câmera) − tags(rádio).**
   Se a câmera vê 2 pessoas na mesa 4 e só 1 tag está por perto, **uma delas é visitante**.

## A mudança de nível (por que o Hungarian fracassou antes e agora paga)

O problema de atribuição **migra do TICK para a ZONA**:
- **Antes:** tag↔track por tick (500 ms, rápido, ambíguo) — onde o Hungarian foi **medido e rejeitado**
  (otimalidade sem ambiguidade modelada piora a honestidade).
- **Agora:** **operador↔zona**, horizonte de MINUTOS, restrito por capacidade (1-2), exclusividade,
  conjunto-de-tags e ocupante anônimo. **Problema muito mais fácil, e com estrutura real a explorar.**
- E o **"anônimo" é um destino de atribuição LEGÍTIMO e esperado** — o *dustbin* finalmente no nível
  certo (operador↔zona), não no nível onde ele fracassou (tag↔track).

## Consequências

- **L2 como "conformidade de ROTA" NÃO EXISTE — e o cliente nunca pediu.** Ele perguntou *"está
  trabalhando ou ocioso"*, não *"seguiu a rota"*. Sem sequência esperada, a pergunta reduz a:
  **está num posto? por quanto tempo? com evidência de atividade?** **O HSMM sobrevive inteiro**
  (duração no posto / em trânsito / anômala = ociosidade). **O Petri encolhe para ocupação e
  capacidade.** L3 vive, e ficou **mais simples**.
- **L0/L1 (fluxo anônimo: ocupação, permanência, gargalo, tempo de ciclo) segue INTACTO** — nunca
  precisou de identidade. É o que se vende hoje (escada do PO).
- **A caminhada anotada muda de LUGAR**: grava-se no **corredor de entrada**, não perto da mesa. O
  protocolo foi corrigido (`protocolo-teste-campo-indoor.md`, bloco de 2026-07-12).
- **Pergunta em aberto que vale ouro (ao dono/cliente):** existe algum **evento de sistema** quando o
  operador começa a trabalhar — leitura de código de barras, abertura de ordem, login em terminal,
  acionamento de máquina? **Se existir e carregar a matrícula, é uma âncora de identidade
  DETERMINÍSTICA** — melhor que qualquer coisa que o rádio possa dar, e **ressuscitaria tudo que a
  resposta "circula livre" derrubou.** É o item de maior ROI ainda não investigado.

## Retratação registrada

A Onda 2 foi desenhada sobre "workflow como sensor virtual" — rede de Petri de sequência, conformance
com limites, prior de identidade vindo da rota. **Tudo isso pressupunha uma sequência esperada que não
existe.** Cinco perguntas de domínio, que custaram dois minutos, derrubaram semanas de arquitetura no
papel — **e chegaram antes do código de produção.** É o aparato funcionando: perguntamos, a resposta
disse que a feature não valia ser construída, e não construímos. Nenhum número de workflow foi
inventado.
