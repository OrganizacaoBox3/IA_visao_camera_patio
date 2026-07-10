# Escopo — persistência de rótulo no track (revisado, aprovado na arquitetura)

> Doc de uma página, padrão v4 (regra antes do dado). **Revisado pelo especialista (2026-07-10):
> arquitetura APROVADA, com 3 mordidas incorporadas abaixo antes do primeiro commit da máquina de
> estados** — nenhuma muda a arquitetura; todas mudam o que o torneio vai conseguir ver.

## O quê (o problema que resolve)

Hoje a cobertura (12–34%, ver `relatorio-consolidado-2026-07-10.md` §6) é medida **por tick de
decisão**: uma pessoa parada por 10 s gera ~20 ticks de "não sei", mesmo que ela tenha sido
identificada com confiança alta 1 segundo antes. Persistência muda a UNIDADE: um rótulo confirmado
com alta confiança deveria **valer** enquanto não houver motivo concreto para duvidar dele — não
precisar ser re-provado a cada 500 ms.

## Framing (decide a arquitetura do experimento)

**Persistência não é feature de UX — é uma política de MEMÓRIA sobre a crença tag↔track, numa
camada ACIMA do associador.** Não toca `associate.ts`. Isso mantém o experimento limpo: mesma
associação, políticas de memória concorrentes (com/sem persistência) comparáveis lado a lado no
harness — a mesma cirurgia de isolamento que fez o v4 ser auditável.

## Máquina de estados (mínima)

```
candidata ──(p calibrado ≥ limiar, N ticks consecutivos de fala, sem conflito LOCAL)──▶ confirmada
confirmada ──(evidência fresca some / pessoa parada / não discrimina)──▶ memória
memória ──(evidência volta a discriminar, mesma tag)──▶ confirmada
{confirmada, memória} ──(quebra)──▶ candidata (ou removida)
```

**MORDIDA 1 (a mais severa — corrigida aqui): "sem conflito" é LOCAL ao par (track,tag), NÃO o
`conflictRate`/tick-global de `identity-metrics.ts`.** Conflito é propriedade de ~47% dos ticks no
canônico e 90–98% em multidão (medido, Frente A) — exigir "tick inteiro sem NENHUM conflito em
NENHUM outro track" tornaria a confirmação quase inatingível em multidão (a confirmação de A
dependeria de B e C não disputarem um track do outro lado da cena — não faz sentido). A semântica
CORRETA já existe pronta: `Assignment.hadConflict` (`associate.ts`) é calculado **por par escolhido**
— margem daquele track especificamente contra seus concorrentes daquele tick. É essa flag, por
track, que a confirmação exige `false` — não o agregado de tick. Decisão explícita, documentada aqui
para não virar acidente de implementação.

**Quebra** = qualquer um: morte do track (tracker perdeu a pessoa) · contradição sustentada (outra
tag ganhando o MESMO track com margem alta, ou a MESMA tag ganhando OUTRO track) · salto físico
impossível do track (proxy barato de id-switch — posição no chão mudando mais rápido que uma pessoa
anda; **limitação estrutural registrada**: não captura troca de ID durante um cruzamento, onde as
posições são contínuas — ver Mordida 2) · timeout.

**De onde vêm os parâmetros:** limiar de `p` e `N` ticks vêm da curva de calibração da Frente A
(reliability diagram) — isso segue valendo (calibra a ENTRADA: quando confiar). **O `timeout` NÃO
vem dessa curva** (Mordida 3, abaixo) — a curva não diz nada sobre quanto tempo uma crença sem
evidência fresca sobrevive num mundo onde o tracker troca IDs; isso é outra pergunta, outra fonte.

## A interação que torna isto ciência, não só produto

Tag **confirmada** sai do pool de candidatas da associação corrente; track **confirmado** sai da
disputa. É a mesma cirurgia do `excludeTags` (o ganho real do v4) — aplicada **dinamicamente** em
vez de estaticamente (âncoras sempre fora; aqui, uma tag sai do pool só enquanto durar a confiança).

**Previsão falseável** (registrada, no costume da casa): no torneio, a `conflictRate` medida vai cair
visivelmente nos cenários com persistência ligada — cada confirmação reduz o tamanho do pool ativo
disputando. Parte do ganho de precisão dos **não-confirmados** virá daí. A decomposição obrigatória
(regra institucionalizada pelo v4) vai dizer exatamente quanto.

## O ângulo adversarial (onde a revisão deve morder)

**Rótulo errado confirmado envenena DUAS vezes**: exibe errado E rouba a tag certa do pool, forçando
erro alheio. **MORDIDA 2 (sentinela dupla, não única)**: a sentinela original (id-switch **no
instante da confirmação**) é necessária mas não é o pior caso. O pior caso real é **id-switch
DURANTE o estado `memória`** — o tracker troca de ID silenciosamente no meio de um cruzamento de
pessoas, com posições contínuas (nenhum salto físico detectável pelo proxy barato de "quebra"), e a
crença persistida segue **exibindo o nome errado até o timeout**, sem qualquer sinal de alarme
interno. É um ponto cego estrutural do proxy físico-de-salto: ele só pega troca com descontinuidade
espacial, e é exatamente durante `memória` (ausência de evidência fresca) que a troca mais silenciosa
pode ocorrer sem deixar rastro. **Duas sentinelas obrigatórias antes do torneio**:
1. id-switch-na-confirmação (a original — pior caso na ENTRADA da crença);
2. id-switch-durante-memória (a nova — pior caso na SOBREVIVÊNCIA da crença).

**Previsão registrada**: a sentinela #2 vai produzir mais erro-segundos que a #1, por margem larga —
é o cenário onde a persistência tem mais tempo (toda a duração de `memória` até o timeout) para
exibir um rótulo errado sem nenhum mecanismo de correção precoce. Se essa previsão falhar, é achado
também (documentar do mesmo jeito que o shuffle-baseline). Se as duas sentinelas não existirem antes
do torneio, a rodada repete o erro do v4 (aprovar sem adversário) — agora sabendo que o adversário
tem (pelo menos) duas formas distintas de atacar.

## Métricas novas (as atuais não medem o que isto muda)

1. **Cobertura de experiência** — fração do TEMPO (integral, não por tick) com rótulo correto visível.
2. **Erro-segundos** — tempo acumulado exibindo rótulo errado. Reformula a invariante do dono para o
   tempo: 1 s de rótulo errado pesa mais que 1 s sem rótulo; erro persistido pesa mais que erro
   instantâneo porque **dura**. **Refinamento**: decompor erro-segundos por **estado de origem**
   (fresco vs. memória) — a pergunta adversarial (Mordida 2) é justamente se o erro que sobrevive vem
   desproporcionalmente de `memória`; sem a decomposição essa pergunta não tem resposta.
3. **Latência de correção** — da quebra real até a tela parar de mentir.

## Regra a priori da rodada (nos moldes do v4 — números a preencher DEPOIS de medir)

Alvo qualitativo: multiplicar cobertura de experiência **sem** erro-segundos crescer (idealmente
caindo). Eixos: erro-segundos ≤ baseline (sem persistência, **mesma unidade** — cobertura de
experiência COM vs. SEM persistência, ambas em tempo-de-operador; **não** comparar contra a cobertura
por tick de hoje, que é outra unidade e infla o ganho artificialmente) · cobertura de experiência ≥
N× a baseline na mesma unidade · sobrevive às DUAS sentinelas (confirmação e memória) · ganho
decomposto como conversão abstenção→acerto (não reembaralhamento) E por estado de origem do erro.

## Decisões v1 explícitas (para não virar acidente de implementação)

- **Limiar de reentrada `memória → confirmada`**: decidido conscientemente aqui, não deixado para a
  implementação decidir de fato — usa o MESMO limiar de `p` calibrado que rege `candidata →
  confirmada` (não um limiar mais frouxo "porque já era confirmado antes"). Assimetria injustificada
  seria um viés não documentado; se o torneio mostrar que reentrada devia ser mais estrita/frouxa,
  vira ajuste explícito, não default silencioso.
- **Contradição sustentada fraca (abaixo do limiar de quebra) NÃO derruba ativamente a crença em v1**
  — o `timeout` é o único backstop para esse caso. Decisão consciente, não omissão: um mecanismo de
  "erosão gradual de confiança" é adiado para v2 (mais uma variável a calibrar, sem dado ainda para
  calibrá-la).
- **Fora de escopo (v2 natural)**: "bridging" de rótulo através de uma fragmentação de track (a
  crença sobrevive à MORTE do track, não só à ausência de evidência) — depende de mineração de
  fragmentação já madura o bastante para virar política, não só medição; não entra nesta rodada.

## Honestidade visual (parte do escopo, não enfeite)

Rótulo em memória exibido **distinto** de rótulo fresco (o operador precisa distinguir "decisão de
agora" de "lembrança com validade") — mesma gramática dos 3 estados da âncora (amarelo/vermelho/
laranja) já em produção. Tradução na tela do contrato "identidade é hipótese, não fato" (dev.md §5).

## O gate do DEFAULT em produção (distinção que o backlog misturava)

O **hello world solo** (item nº1 do dono) mede viés corporal — alvo único, zero ambiguidade — e
**não testa id-switch de jeito nenhum** (só cena multi-pessoa testa isso). O risco específico da
persistência é justamente id-switch na confirmação (e, pela Mordida 2, também durante `memória`).
Portanto: **construir e tornear agora** (não espera o campo — não introduz física nova, é política
sobre decisões que o associador já toma, classe de risco diferente da circularidade do v4); **decidir
o DEFAULT em produção só com dado (ou proxy) de id-switch com gente de verdade**.

**MORDIDA 3 (fonte do `timeout` — corrige a linha antiga que apontava para a curva de calibração):**
a curva de reliability calibra CONFIANÇA DE ENTRADA (quando confiar o suficiente para confirmar) —
ela não tem nenhuma informação sobre QUANTO TEMPO uma crença sobrevive sem evidência fresca num mundo
onde o tracker troca de identidade. Essas são perguntas diferentes; a curva não paga essa conta.
A fonte correta é a **taxa real de instabilidade do tracker**, medida via **fragmentação de tracks**
(morte+renascimento próximos no tempo/espaço) na gravação passiva que recomeçou — não captura troca
SILENCIOSA entre duas pessoas que se cruzam (só verdade anotada mede isso), mas calibra a ordem de
grandeza real da instabilidade do tracker, que o simulador hoje só chuta, e é exatamente o número que
falta para escolher `timeout` sem inventar. **Consequência prática: mineração de fragmentação deixa
de ser um item independente do backlog — vira DEPENDÊNCIA da máquina de estados** (o `timeout` não
tem de outro lugar para vir). Isso corrige a ordem de execução abaixo.

**Mineração FEITA (2026-07-10, leitura pura de `fusion-session.jsonl`, sem tocar no arquivo)** — ver
`PENDENCIAS.md` item 10 para o método e as ressalvas completas. Achado honesto: metade dos tracks da
câmera era ruído estático (deslocamento≈0), filtrado antes de medir; do restante (92 mortes de track
com movimento real em 90 min), só 38-50% religam perto no espaço/tempo — a distribuição do gap NÃO
converge limpo (sensível à janela de busca). **`timeout` v1 candidato: ~12 s** (zona mediana-a-p75,
ordem de grandeza — não valor definitivo; revisar com dado de campo real de gente cruzando).

## Próximo passo (ordem corrigida pelo especialista, 2026-07-10)

Se este escopo for aprovado: **(1) minerar fragmentação de tracks na gravação atual PRIMEIRO** (agora
dependência do `timeout`, não item independente/paralelo) → **(2)** implementar a máquina de estados
como camada sobre `useTagFusion`/`assign()` (sem tocar `associate.ts`), usando o `timeout` saído de
(1) → **(3)** estender `sim.ts`/`replay-fusion.ts` com a sentinela DUPLA (confirmação + memória,
Mordida 2) → **(4)** torneio com a regra a priori acima → **(5)** revisão adversarial antes de
qualquer default.

**Gate com o experimento Hungarian+dustbin (sequenciamento entre frentes, não interno a esta):** o
dustbin NÃO deve ser tornado/calibrado antes de (1)-(5) acima — a persistência muda a própria
paisagem de `conflictRate` que o custo do dustbin calibraria contra (menos tags disputando o pool a
cada confirmação = conflictRate menor por construção). Calibrar o dustbin contra o número de HOJE
seria calibrar contra um mundo que está prestes a ficar obsoleto. Ordem entre frentes: persistência
construída e medida → `conflictRate` re-medido com persistência ligada → SÓ ENTÃO decidir o dustbin
com o número pós-persistência. Se ainda houver curiosidade sobre o shuffle-baseline nesse momento, o
surrogate correto (deslocamento temporal circular por tag, controle positivo obrigatório — ver
`shuffle-baseline.ts`) pode ser rodado na mesma leva ("uma medição, duas perguntas") — prioridade
baixa, arquivado, não bloqueia nada acima.
