# Experimento (spike) — recuperar recall do detector em multidão (MOT20-01)

> Guiado pela medição (`02-*`): o gargalo do "perde pessoa" é o **recall do detector em cena densa
> (~57%)**, não a cadência. Spike (lição 03.3): variar SÓ o detector, medir no sensor `persons-cftv.mjs`,
> terminar com **veredito escrito** (config × recall × precisão × custo). **Não altera o motor** — só
> mede qual configuração recupera mais pessoas. Cadência fixa em **1 fps** (recall é cadência-insensível
> — `02-*` — e 1 fps é o mais rápido).

## Hipóteses a testar (ordem de custo)
1. **Modelo maior:** D-FINE-**M** × S (baseline). +recall? quanto +CPU?
2. **Input maior:** S @**896** × @640 (pessoa pequena/distante ganha pixels).
3. **Tiling/SAHI:** S @640 **2×2** (o perfil longRange) — recupera pessoa pequena por bloco. Custo ~4× inferência.
4. **Combinar** o que pagar (ex.: M+tiling, M@896) só se as isoladas mostrarem ganho.

## Métrica e critério
- **Recall do detector** (o teto) é o alvo; **precisão** não pode desabar (recall sem virar FP);
  **inferMs médio** é o custo (a alavanca tem que caber no orçamento de CPU/câmera).
- Veredito por config: Δrecall (pp) × Δcusto. "Vale" = ganho de recall material sem estourar CPU nem FP.
- **Fixture pequeno decide barrar, full-set decide default (lição 02.2):** MOT20-01 é UMA sequência —
  o vencedor aqui vira candidato, confirmado depois em 02/03/05 antes de qualquer mudança de default.

## Matriz (MOT20-01, 1 fps, GT hand-labeled) — MEDIDO

| Config | recall det. | Δ recall | precisão det. | inferMs | custo × |
|---|---|---|---|---|---|
| **baseline** S@640 | 57,3% | — | 74,6% | 349 | 1,0× |
| M@640 | 60,7% | +3,4pp | 75,3% | 680 | 1,9× |
| **S@896** ⭐ | **65,4%** | **+8,1pp** | 75,4% | 641 | 1,8× |
| M@896 (teto) | 66,4% | +9,1pp | 74,7% | 1037 | 3,0× |
| S@640+tiles2×2 | 58,0% | +0,7pp | **54,5%** ⛔ | 1159 | 3,3× |
| M@640+tiles2×2 | 59,3% | +2,0pp | 55,2% ⛔ | 2270 | 6,5× |

## VEREDITO (com número)

1. **A alavanca é o INPUT, não o modelo.** Subir 640→896 = **+8,1pp de recall** (57→65%) a **1,8× CPU,
   precisão INTACTA**. Subir S→M = só +3,4pp a 1,9× — dominado pelo input. Faz sentido físico: a multidão
   tem gente PEQUENA; espremer 1080p em 640 destrói esses pixels, 896 preserva. É um knob (`ANALYSIS_INPUT`),
   **sem trocar modelo nem mexer na lógica do motor**.
2. **TILING/SAHI REFUTADO neste cenário.** Ganho de recall ~zero (+0,7pp) E a **precisão DESPENCA** (75→54%
   — o tiling fragmenta pessoas na borda dos blocos e gera FP que a contenção não mata em crowd) a 3-6× o
   custo. **Não tilar em cena densa.** (Contraria a intuição SAHI — daí medir, não supor.)
3. **M@896 é o teto (+9,1pp, 66%) mas retorno decrescente** — +1pp sobre S@896 por +1,6× CPU. Não paga.
4. **Mesmo o teto (66%) ainda perde 34%.** Input+modelo ajudam, mas o **gap de domínio do COCO permanece** —
   fechar o resto exige **modelo de vigilância / fine-tune nos ângulos do CD** (a próxima fase).
5. **Responde à pergunta do CPU (com número):** CPU melhor **AJUDA SIM — via input maior** (S@896, +8pp
   medido). NÃO via mais fps (+3pp, `02-*`) nem tiling (falha). "Otimizar pro máximo" = rodar **S@896**
   (melhor recall/CPU) e dimensionar a CPU pra o 1,8× de custo × nº de câmeras.

## Ressalvas (doutrina) e próximo passo
- **Fixture barra, full-set decide (lição 02.2):** isto é UMA sequência. Antes de virar default: confirmar
  S@896 (e M@896) em **MOT20-02/03/05**.
- **Custo × capacidade:** 896 = 1,8× CPU/frame → recalcular câmeras/core (`hardware-ideal.md`) — é o elo
  com a sua pergunta de hardware.
- **Não mexer no `precision.js` (input default 640→896) ainda** — só após o full-set + o recalc de capacidade.
  O `perf-input-size-dfine.md` fixou 640 medindo em cena ESPARSA; a cena DENSA inverte a conta (aqui 896
  paga) — a decisão de default precisa dos dois cenários + o orçamento de CPU.

## Fora de escopo
- Fine-tune / modelo de vigilância (fase seguinte, se M+tiling+input não fecharem o gap).
- Tracker/ID-switch e FP-tuning (alavancas 4-5 do `02-*` — depois do recall).
- Mudar default de `precision.js` (só após confirmar no full-set das 4 sequências).

## Resultado + veredito
(preenchido após a rodada — abaixo)
