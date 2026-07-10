# Plano — Acurácia das aferições (o modelo enxerga o que deve? e só o que deve?)

> Perguntas do dono do produto: **(1) ele enxerga pessoas? (2) ele enxerga pessoas onde NÃO
> existem? (3) a aplicação está aferindo o que deve?** Doutrina: sem ground truth não há
> acurácia — só impressão. Este plano cria a régua, mede, calibra e deixa um SENSOR permanente
> (regressão de acurácia vira teste). Alvo primário: o motor do hub (D-FINE, ADR-009) — é ele
> que grava os indicadores; o pipeline do navegador é secundário (espelho).

## As 3 métricas que respondem às 3 perguntas

| Pergunta | Métrica | Como se mede |
|---|---|---|
| Enxerga pessoas? | **Recall** (por tamanho: pequena/média/grande) | dets × ground truth (IoU≥0.5) |
| Enxerga onde não existe? | **Precisão** + **FP/hora em cena vazia** | idem + soak em cenas sem gente |
| Afere o que deve? | **Erro de CONTAGEM** (in/out da linha vs travessias reais; pessoas na zona vs contagem real) | vídeo com verdade anotada |

## ONDA 1 — Bancada de avaliação com ground truth REAL (a régua)

**1.1 Harness offline `eval/` (Node, reusa o worker do motor):** script que roda o MESMO
pipeline de produção (worker.js: decode→letterbox 640→D-FINE→thresholds→NMS+contenção; com e
sem tiling LR) sobre um conjunto de imagens ANOTADAS e computa precisão/recall/F1 por
threshold (0.25→0.55, passo 0.05), estratificado por tamanho da pessoa (área do bbox:
<32², 32-96², >96² px — o padrão COCO).

**1.2 Dataset de verdade:** subconjunto do **COCO val2017** (anotações oficiais): ~300 imagens
baixadas individualmente (150 com pessoas variadas, 150 SEM pessoa nenhuma — estas medem o
falso positivo puro). Gratuito, licenciado p/ pesquisa/avaliação, verdade profissional.
(Anotações person do val: 1 download; imagens: só as escolhidas.)

**1.3 Saída:** tabela P/R/F1 × threshold × tamanho + curva de operação + os N piores erros
COM IMAGEM (falsos positivos salvos como PNG anotado — ver com os olhos O QUE o modelo
confunde com gente). Compara squash × tiling.

## ONDA 2 — Acurácia nas NOSSAS cenas (operação real)

**2.1 Falso positivo em cena vazia (soak):** rodar o motor por 2-4h nas câmeras públicas em
horário VAZIO (madrugada europeia: Pula/Gorizia ~2-5h locais) → **FP/hora por câmera** com
os frames dos FPs salvos e classificados (poster? sombra? reflexo? estátua?). Métrica de
aceite sugerida: < 2 FP/h por câmera no threshold de operação.

**2.2 Recall em cena real (pseudo-ground-truth):** amostra de ~100 frames com pedestres
(Gorizia de dia); anotador FORTE (visão multimodal — Claude conta/marca as pessoas por
frame; humano faz spot-check de 20) vs as detecções do motor → recall/precisão de campo.
Caveat declarado: pseudo-GT tem ruído; serve p/ ordem de grandeza e casos sistemáticos,
não p/ 3ª casa decimal.

**2.3 Erro de CONTAGEM (a métrica de negócio):** gravar 2-3 segmentos de ~10min da câmera com
linha desenhada; travessias REAIS contadas por observação (anotador assiste e marca ts+direção)
vs eventos `flow` do motor → **acurácia de contagem (%), trocas perdidas, contagens fantasma**.
Idem p/ "pessoas na zona" (amostras: contagem real × people do bucket).

## ONDA 3 — Calibração + defesas + SENSOR permanente

**3.1 Ponto de operação por uso:** com as curvas da Onda 1+2, fixar thresholds por FINALIDADE
(contagem/linha quer PRECISÃO alta — FP conta fantasma; presença/ocupação tolera recall mais
alto). Hoje é um único 0.35 no motor — pode virar dois pontos documentados em config.

**3.2 Defesas contra FP (só as que a medição justificar):**
- filtro de tamanho mínimo/aspecto de bbox (mata "pessoa" de 4px e formas não-humanas);
- confirmação temporal p/ PRESENÇA (pessoa só existe após N rodadas — counting já tem histerese);
- zona de exclusão (máscara já existe) p/ fontes fixas de FP (pôster, manequim, TV);
- se recall de pessoa PEQUENA for o gargalo comprovado: avaliar D-FINE-S (custo ~2×) — só com número.

**3.3 Sensor permanente `npm run eval`:** fixture pequeno commitado (~30 imagens COCO + 10
frames nossos anotados; ~10MB) + limiares mínimos (ex.: F1@0.35 ≥ X, FP em vazias = 0) →
roda local e em CI opcional. Qualquer mudança futura de modelo/threshold/NMS tem gate de
acurácia — regressão vira vermelho, não surpresa em produção.

**3.4 Relatório final:** `docs/analises/acuracia-modelos.md` com todos os números, imagens dos
erros típicos, thresholds decididos (e por quê) e o risco residual honesto.

## Execução (paralelizável)
- Onda 1 (harness+COCO) ∥ Onda 2.1 (soak vazio) ∥ Onda 2.2/2.3 (anotação de campo) — frentes
  independentes; Onda 3 consolida (calibração precisa dos números das duas).
- Esforço: O1 ~1 dia · O2 ~1 dia (soak é relógio, não trabalho) · O3 ~1 dia.

## Fora de escopo (registrado)
Acurácia dos modos especializados (Leitura/Objetos/Fadiga — já verificados funcionalmente;
acurácia fina deles é rodada própria se virarem críticos); re-ID/oclusão densa; datasets
proprietários do CD (quando houver câmeras internas, a Onda 2 se repete NELAS — o harness fica pronto).
