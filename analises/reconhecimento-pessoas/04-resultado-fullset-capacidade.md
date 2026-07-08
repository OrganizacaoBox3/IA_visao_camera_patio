# Full-set (MOT20-02/03/05) — confirmação do S@896 + custo de capacidade

> Confirma o veredito do spike `03-*` (input 640→896 = alavanca de recall) nas 3 sequências de train
> restantes, e recalcula o custo de CPU (a ponte com a pergunta de hardware). 1 fps, D-FINE-S, GT à mão.

## Resultado (S@640 baseline × S@896)

| Sequência | densidade | S@640 recall / prec | S@896 recall / prec | Δ recall | inferMs 640→896 |
|---|---|---|---|---|---|
| MOT20-01 | ~46/frame | 57,3% / 74,6% | 65,4% / 75,4% | **+8,1pp** | 349→641 (1,8×) |
| MOT20-02 | ~56/frame | 53,2% / 79,6% | 60,7% / 80,5% | **+7,5pp** | 367→673 (1,8×) |
| MOT20-03 | ~130/frame | 41,6% / 90,1% | 48,7% / 91,0% | **+7,1pp** | 379→704 (1,9×) |
| MOT20-05 | ~195/frame | 26,0% / 84,5% | 30,5% / 84,9% | **+4,5pp** | 362→698 (1,9×) |

## Veredito (confirmado no full-set)

1. **O ganho do S@896 CONFIRMA-SE: +4,5 a +8,1pp de recall em TODAS as sequências, precisão INTACTA (até
   sobe).** A alavanca do input é real e consistente — não era artefato da MOT20-01. **Adotar 896 vale.**
2. **Mas o recall DESABA com a densidade — e é o muro do domínio COCO:** 46/fr→57%, 56→53%, 130→42%,
   **195/fr→26%**. Em multidão extrema (03/05) mesmo o 896 deixa recall baixíssimo (30-49%). O input
   ajuda, **não fecha**. Isso é o teto do modelo genérico — confirma o endgame: **vigilância/fine-tune**.
3. **Densidade realista de CD (01/02, ~50/fr): S@896 → ~60-65% recall** (+7-8pp sobre o baseline). É o
   ganho que dá pra colher JÁ; ainda perde ~35-40%, mas é melhora sólida e medida.
4. **Precisão ALTA nas cenas densas (03:91%, 05:85%)** — em multidão quase toda detecção é pessoa real; o
   FP (~25%) é mais problema de cena ESPARSA. Ou seja: recall e FP são problemas de regimes diferentes.

## Custo de capacidade (a ponte com "CPU melhor")

- **inferMs médio: S@640 ≈ 364ms · S@896 ≈ 680ms → razão 1,87×** (o número LIMPO — ambos sob a MESMA
  contenção, o hub do DVR rodando junto).
- **Câmeras por core @1fps** (≈ 1000/inferMs, contido — absoluto a re-medir limpo): 640 ≈ **2,7 cam/core**;
  896 ≈ **1,5 cam/core**. Ou seja: **adotar 896 ~corta a densidade de câmeras por core pela metade**.
- **Tradução da sua pergunta de hardware:** os +7pp de recall custam **~2× CPU por câmera**. Numa CPU
  melhor (mais cores, ou VNNI/GPU), você **afona rodar 896 em mais câmeras** — é assim que "CPU melhor"
  vira mais pessoas detectadas. Sem CPU extra, é trade recall×nº-de-câmeras.

## Decisão pendente (não mexer no default ainda)

Adotar `ANALYSIS_INPUT=896` como default é a mudança de motor JUSTIFICADA (medida). Mas envolve o trade
capacidade (1,87×). Opções (a decidir):
- **(a) default 896** — melhor qualidade; recalcular o dimensionamento do CD.
- **(b) input ADAPTATIVO** — 896 quando há folga de CPU/poucas câmeras, 640 quando apertado (como o
  auto-tier do modelo já faz — lição 05.1 melhor-por-default). É mais código no motor.
- **(c) segurar o input e ir pro endgame** (fine-tune/vigilância) — o único caminho pra passar do muro de
  densidade (recall 26-49% em crowd extrema que o 896 não resolve).

## Próximo passo sugerido
O ganho de +7pp está provado e é config-only. O **maior salto** (quebrar o muro de 26-49% em densidade)
é **fine-tune de um detector de pessoa nos frames de vigilância** (MOT20/CrowdHuman + eventualmente CD) —
o servidor roda o que o SoC da Intelbras não roda. É a fase que de fato **supera a Intelbras**.
