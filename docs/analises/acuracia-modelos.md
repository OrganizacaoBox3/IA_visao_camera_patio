# Acurácia das aferições — relatório consolidado (jul/2026)

> Executa o plano `docs/analises/plano-acuracia-modelos.md`. Três frentes de medição (ground truth
> COCO + campo real) respondem às 3 perguntas do dono do produto. Evidência: harness `eval/`
> (committado), `docs/analises/diagnostico-runtime-2026-07.md` (campo), imagens dos erros no
> scratchpad. **Honestidade:** números de campo são pseudo-GT (anotação visual) — ordem de
> grandeza e padrões sistemáticos, não 3ª casa decimal.

## As 3 respostas (com número)

### 1. "Ele enxerga pessoas?" — Sim, com teto conhecido; scores baixos
- **COCO (régua):** @0.35 recall 27% / precisão 61%; @0.25 recall 49%. **Metade do recall mora entre 0.25 e 0.35** — o D-FINE-N emite scores baixos.
- **Estratificado por tamanho** (o que importa p/ o CD de pé-direito alto): recall grande 60% → média 41% → **pequena/distante 8%** (@0.25). Pessoa <25px é limite de amostragem a 640 — nenhum threshold resolve.
- **Campo (Gorizia):** confirma — recall grande 59%, média 41%, pequena 8%; detecção **instável frame a frame** (mesma pessoa aparece/some entre rodadas).

### 2. "Ele enxerga pessoas onde não existem?" — Sim, mas de forma PREVISÍVEL e mascarável
- **Alucinação pura é rara:** COCO, 150 imagens sem pessoa → só 2,7% tiveram FP @0.35, **zero @0.50**; nenhum FP passou de 0.57.
- **Soak (1h, 3 câmeras, 6.510 dets):** ~66-72% das detecções são FP — **MAS 79% estão no piso 0.25-0.35 e presas a poucos objetos ESTÁTICOS**: grade/placa (47% de toda a Gorizia numa região), janela escura de van (Mošćenička), estruturas à beira-lago (Bled ~100% FP). **Acima de ~0.45 o motor praticamente não alucina** (todos os alto-score inspecionados eram pessoas reais).
- **Campo:** 86% dos FPs vinham de 2 objetos fixos (floreira 77, bicicletas 78).
- **Conclusão:** o FP não é aleatório — é **objeto fixo lido como torso/cabeça no piso de confiança**. Mascarável.

### 3. "Afere o que deve?" — Na contagem de linha, HOJE não (em cena difícil)
- **Contagem real (Gorizia, 10min): 31 travessias reais → 0 contadas.** Zero fantasmas.
- **Causa medida (não suposta):** 16 tracks existiram perto da linha, cada um vivo 1-5 rodadas parado de um lado; nenhum sobreviveu à travessia. Contar exige o MESMO id atravessar + histerese; com recall intermitente (~41% média) e **cadência efetiva 0,5fps** (metade do alvo, contenção de CPU no experimento), a chance é ~nula. **O `counting.js` está correto** (replay determinístico prova) — o gargalo é **recall × cadência**, não a lógica.
- **Presença/ocupação** (não depende de continuidade de track): funciona parcialmente — o bucket de atividade enche (peoplePeak real).

## Calibração recomendada (do que os números mandam)

| # | Medida | Justificativa | Risco |
|---|---|---|---|
| **A. Máscara de exclusão** por câmera (infra JÁ existe: zones/mask) sobre os hotspots fixos | mata ~47-86% dos FPs SEM tocar recall (os FPs são espacialmente fixos; pessoas se movem) | nenhum — é config por câmera, opt-in |
| **B. Threshold por finalidade** (hoje: nascimento 0.35 / sustain 0.25 únicos) | **contagem/linha** quer precisão → manter nascimento **0.35**; **presença/ocupação** tolera recall → **0.30 + confirmação de N rodadas**. Subir global mataria recall (metade dele vive no piso) — por isso **máscara > threshold** p/ os FP estáticos | baixo — decisão por uso, documentada |
| **C. Filtro de tamanho/aspecto** mínimo de bbox | os FP incluem caixas minúsculas/formas não-humanas em objeto fixo | **médio** — pessoa pequena legítima também é minúscula; só aplicar abaixo de um piso conservador, com número |
| **D. Cadência ≥1fps garantida** p/ câmeras com linha | a 0,5fps um caminhante cruza em 2-3 rodadas — insuficiente p/ nascimento+histerese | baixo — prioridade de CPU (o motor server-side já ajuda) |
| **E. Recall do modelo** (o teto real) | recall 8-40% em média/pequena é o limite do NANO nessa distribuição | ver `benchmark-modelos-alternativos.md`: D-FINE-S/M (drop-in) ou **fine-tune nas nossas cenas** |

**Prioridade:** A (grátis, imediato) → B (calibração) → D → E (com o harness medindo antes de trocar). C só se a medição justificar.

## Sensor permanente
`npm run eval` (Onda 3.3) — gate de regressão sobre fixture COCO commitável: qualquer troca de
modelo/threshold/NMS futura passa por ele (P/R/F1 e FP-em-vazias vs limiares). Recalibrar ao
trocar de modelo. Detalhes em `eval/README.md`.

## Veredito honesto
O motor **enxerga pessoas** (com teto de recall conhecido, pior em pequena/distante), **quase
não inventa gente do nada** (o que parece FP é objeto fixo no piso de score — mascarável), e a
**contagem de linha ainda não afere** em cena difícil por recall×cadência — não por bug de
lógica. Os ganhos estão mapeados e priorizados: máscara (grátis), calibração, cadência, e —
o teto — capacidade/fine-tune, sempre medidos pelo `eval/` antes de qualquer troca.

## Risco residual declarado
Pseudo-GT de campo tem ruído (anotador visual); soak cobriu ~60min (não 80) em cena de tarde
com movimento real (não noite vazia — proporção de FP em CD noturno tenderia a ser maior);
pessoa <25px fora do alcance de qualquer modelo desta classe a 640.
