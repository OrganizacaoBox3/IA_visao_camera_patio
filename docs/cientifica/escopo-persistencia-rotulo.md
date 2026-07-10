# Escopo — persistência de rótulo no track (para revisão antes de construir)

> Doc de uma página, padrão v4 (regra antes do dado). O especialista ofereceu revisar antes da
> construção — este é o texto para essa revisão. Segue o esqueleto que ele propôs quase à risca;
> onde há decisão nossa (não dele), está marcado.

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
candidata ──(p calibrado ≥ limiar, N ticks consecutivos de fala, sem conflito)──▶ confirmada
confirmada ──(evidência fresca some / pessoa parada / não discrimina)──▶ memória
memória ──(evidência volta a discriminar, mesma tag)──▶ confirmada
{confirmada, memória} ──(quebra)──▶ candidata (ou removida)
```

**Quebra** = qualquer um: morte do track (tracker perdeu a pessoa) · contradição sustentada (outra
tag ganhando o MESMO track com margem alta, ou a MESMA tag ganhando OUTRO track) · salto físico
impossível do track (proxy barato de id-switch — posição no chão mudando mais rápido que uma pessoa
anda) · timeout.

**De onde vêm os parâmetros** (limiar de p, N ticks, timeout): da curva de calibração da Frente A
(reliability diagram) — o mesmo instrumento paga seu custo pela terceira vez (produto, dustbin,
agora memória). Não são números inventados nesta rodada.

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
erro alheio. **Sentinela específica desta rodada**: injetar id-switch do tracker **no instante exato
da confirmação** — o pior caso por construção (a persistência acabou de "acreditar" e o mundo já
mudou). Se essa sentinela não existir antes do torneio, a rodada repete o erro do v4 (aprovar sem
adversário).

## Métricas novas (as atuais não medem o que isto muda)

1. **Cobertura de experiência** — fração do TEMPO (integral, não por tick) com rótulo correto visível.
2. **Erro-segundos** — tempo acumulado exibindo rótulo errado. Reformula a invariante do dono para o
   tempo: 1 s de rótulo errado pesa mais que 1 s sem rótulo; erro persistido pesa mais que erro
   instantâneo porque **dura**.
3. **Latência de correção** — da quebra real até a tela parar de mentir.

## Regra a priori da rodada (nos moldes do v4 — números a preencher DEPOIS de medir)

Alvo qualitativo: multiplicar cobertura de experiência **sem** erro-segundos crescer (idealmente
caindo). Eixos: erro-segundos ≤ baseline (sem persistência) · cobertura de experiência ≥ N× a
cobertura por tick de hoje · sobrevive à sentinela de id-switch-na-confirmação · ganho decomposto
como conversão abstenção→acerto (não reembaralhamento).

## Honestidade visual (parte do escopo, não enfeite)

Rótulo em memória exibido **distinto** de rótulo fresco (o operador precisa distinguir "decisão de
agora" de "lembrança com validade") — mesma gramática dos 3 estados da âncora (amarelo/vermelho/
laranja) já em produção. Tradução na tela do contrato "identidade é hipótese, não fato" (dev.md §5).

## O gate do DEFAULT em produção (distinção que o backlog misturava)

O **hello world solo** (item nº1 do dono) mede viés corporal — alvo único, zero ambiguidade — e
**não testa id-switch de jeito nenhum** (só cena multi-pessoa testa isso). O risco específico da
persistência é justamente id-switch na confirmação. Portanto: **construir e tornear agora** (não
espera o campo — não introduz física nova, é política sobre decisões que o associador já toma, classe
de risco diferente da circularidade do v4); **decidir o DEFAULT em produção só com dado (ou proxy) de
id-switch com gente de verdade**. Proxy minerável já hoje, sem verdade anotada: **fragmentação de
tracks** (morte+renascimento próximos no tempo/espaço) na gravação passiva que recomeçou — não captura
troca SILENCIOSA entre duas pessoas que se cruzam (só verdade anotada mede isso), mas calibra a ordem
de grandeza real da instabilidade do tracker, que o simulador hoje só chuta.

## Próximo passo

Se este escopo for aprovado: (1) minerar fragmentação de tracks na gravação atual (barato, decisão
independente); (2) implementar a máquina de estados como camada sobre `useTagFusion`/`assign()` (sem
tocar `associate.ts`); (3) estender `sim.ts`/`replay-fusion.ts` com a sentinela de id-switch-na-
confirmação; (4) torneio com a regra a priori acima; (5) revisão adversarial antes de qualquer default.
