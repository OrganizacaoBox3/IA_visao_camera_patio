# Resultado — 1ª medição do reconhecimento de pessoas (CAVIAR, GT à mão)

> Re-medição do plano `01-*` no pipeline REAL (worker.js D-FINE-S + bytetrack.js + knobs de
> `precision.js`), contra ground-truth. **Honestidade primeiro: a medição REFUTA parte do diagnóstico
> `00-*`.** Sensor: `eval/persons-cftv.mjs`. Dataset: CAVIAR WalkByShop1cor (384×288 @25fps, 2360 frames,
> 11.348 objetos, **17 identidades**). Modelo: `dfine_s_obj2coco` (produção).

## A tabela (medido)

| fps | detector R / P | emitido (track) R / P | ID-switches (total / por seg) | rodadas |
|----:|:--------------:|:---------------------:|:-----------------------------:|--------:|
| 1 | **88,7% / 78,9%** | 88,0% / 84,3% | 37 / 0,39 | 95 |
| 4 | 89,6% / 79,9% | 89,4% / 84,3% | 53 / 0,56 | 394 |
| 8 | 89,7% / 79,4% | 89,5% / 83,5% | 72 / 0,77 | 787 |

*(94 s de clipe. "detector" = dets crus do D-FINE vs GT; "emitido" = tracks que o sistema MOSTRA depois
do tracker/LOST. IoU de match 0,5.)*

## O que a medição diz (medido, não inferido)

1. **REFUTA a hipótese nº1 do diagnóstico (cadência → "perde andando").** O recall é **alto (~88-90%) e
   quase INSENSÍVEL ao fps**; e a queda detector→emitido é mínima (88,7→88,0 a 1fps) — ou seja, **o
   tracker NÃO está perdendo gente** nesta cena, e subir o fps **não melhora o recall**. A tese de que
   "1fps derruba pessoa andando" **não se sustenta no CAVIAR**.
2. **REFUTA "mais fps conserta a continuidade".** Os ID-switches **SOBEM** com o fps (37→53→72; 0,39→0,77
   por segundo). Mais rodadas = mais decisões de associação = mais trocas em cruzamento/oclusão. Aqui o
   motor de ID-switch é **cruzamento/oclusão**, não movimento-entre-frames.
3. **CONFIRMA o sintoma "inventa pessoa" — e é o achado mais forte.** Precisão do detector **~79%**
   (≈1 em 5 detecções não casa GT). O tracker melhora p/ **~84%** (a guarda de nascimento/LOST filtra
   parte). **Mas há uma ressalva honesta grande:** o GT do CAVIAR **não rotula TODAS as pessoas** (gente
   de fundo, reflexo em vitrine) — parte desses "FP" pode ser pessoa REAL não-rotulada. Logo **79% é um
   PISO da precisão real**; quanto é fantasma vs não-rotulado só um spot-check visual resolve (próximo passo).
4. **O gargalo é o DETECTOR, não o tracker nem a cadência.** Teto de recall 88% e precisão 79% vêm da
   detecção; o tracker preserva recall e melhora precisão. Isso **inverte a prioridade** do diagnóstico.

## A ressalva que domina tudo: CAVIAR ≠ o cenário do CD/Intelbras

CAVIAR é **corredor de shopping, 384×288, pessoas quase frontais/próximas, boa luz, esparso** — cena
FÁCIL pra um modelo COCO. **Não é** o que você viu falhar (Intelbras 1080p, os ângulos/distâncias das
SUAS câmeras). É plausível que o "perde andando" que você observou seja **específico do ângulo/distância/
luz das suas câmeras** — pessoa distante/de cima/de costas que o COCO não vê — coisa que o CAVIAR
próximo-frontal **não exercita**. Então: o CAVIAR **prova o harness e dá um 1º sinal**, mas o veredito
sobre o SEU caso exige (a) MOT20 (densidade) e (b) idealmente frames das SUAS câmeras.

## Conclusão honesta

- O **harness funciona** (detector+tracker+GT reais, paridade) — o sensor que faltava existe.
- **No CAVIAR:** recall bom e cadência-insensível; **FP é o problema medível** (≥21%, com ressalva de GT);
  cadência **não** é a alavanca aqui (chega a piorar ID-switch). Isso **refuta** o diagnóstico `00-*` §1.1
  NESTE dataset — e a doutrina manda registrar a refutação, não escondê-la.
- **Ainda não sabemos do SEU caso.** CAVIAR é fácil demais pra reproduzir o que você viu.

## 2ª medição — MOT20-01 (DENSO, 1080p, o cenário que faltava)

MOT20-01: 1920×1080 @25fps, 429 frames, **19.870 objetos ≈ 46 pessoas/frame, 74 identidades** (multidão
= CD lotado). Mesmo pipeline/modelo (D-FINE-S). GT hand-labeled abrangente (MOT20, menos incompleto que CAVIAR).

| fps | detector R / P | emitido (track) R / P | ID-sw (tot / por seg) | rodadas |
|----:|:--------------:|:---------------------:|:---------------------:|--------:|
| 1 | **57,3% / 74,6%** | 52,2% / 82,2% | 191 / 10,6 | 18 |
| 4 | 57,9% / 74,4% | 53,8% / 80,9% | 190 / 11,0 | 72 |
| 8 | 58,6% / 75,2% | 55,2% / 80,5% | 243 / 14,2 | 143 |

### O que MUDA vs o CAVIAR (o achado que importa)

| | CAVIAR (fácil, ~5/frame) | MOT20-01 (denso, ~46/frame) |
|---|---|---|
| recall do detector | **88,7%** | **57,3%** ← despenca |
| recall emitido | 88,0% | 52,2% (tracker perde +5pp) |
| precisão detector | 78,9% | 74,6% |
| ID-switches | 37-72 | **191-243** |

1. **AQUI está o "perde pessoa": o recall do detector CAI pra ~57% na multidão** — o D-FINE COCO **perde
   42% das pessoas** em cena densa (oclusão, pessoa pequena/distante no meio da massa). Em cena fácil
   (CAVIAR frontal-próximo) ele acerta 88%; **é DENSIDADE/OCLUSÃO/domínio que quebra**, não a cadência.
2. **O tracker perde MAIS ~5pp em multidão** (57,3→52,2): em crowd o LOST/associação derruba gente que o
   detector até viu.
3. **A cadência quase não muda o recall** (57→59 detector; 52→55 emitido de 1→8fps). Sobe **~3pp** emitido —
   ajuda de leve, mas **não é a alavanca**; o teto é o detector.
4. **ID-switches explodem** (191-243, ~11-14/seg) e **sobem com fps** — cruzamento/oclusão em massa, não
   movimento-entre-frames. Continuidade em crowd é problema à parte.
5. **FP ~25%** persiste (precisão 75% detector) — GT do MOT20 é abrangente, então aqui é FP mais "real".

### Conclusão revisada (medida nos DOIS cenários)

- **O gargalo do "perde pessoa" é o DETECTOR em cena densa (~57% recall), não a cadência.** Meu diagnóstico
  `00-*` §1.1 (cadência nº1) está **refutado**; a causa real é **densidade/oclusão/domínio do modelo COCO**.
  Bate com o teste real: a Intelbras (detector de vigilância + framerate cheio) segura melhor a multidão.
- **A alavanca nº1 vira: melhorar o RECALL do detector em crowd** — modelo maior (M), tiling/SAHI p/
  pessoa pequena, input maior, ou modelo/fine-tune de vigilância. Tudo agora **medível** neste sensor.

## Próximas alavancas (reordenadas PELA medição — o detector em crowd é o gargalo)

1. **Experimento de RECALL do detector no MOT20** (o número ruim, ~57%): medir neste sensor, em ordem
   de custo — **D-FINE-M × S** (modelo maior), **tiling/SAHI** (pessoa pequena/distante na massa),
   **input maior** (640→768/896). Cada um vira +X pp de recall medido × custo de CPU. É o 1º
   experimento de motor JUSTIFICADO (o número pede).
2. **Rodar as outras sequências de train** (MOT20-02/03/05 — mais densas/longas) p/ confirmar que ~57%
   é o padrão, não um artefato da 01.
3. **Modelo de vigilância / fine-tune** nos ângulos do CD — se M+tiling+input não fecharem o gap, é o
   caminho pra bater a Intelbras (o servidor roda modelo que o SoC da câmera não roda).
4. **Continuidade em crowd** (ID-switch ~11-14/seg): tuning do tracker p/ multidão — secundário ao recall.
5. **FP ~25%**: spot-check visual + calibrar `highScore` — depois do recall (subir recall sem explodir FP).
6. **Frames das SUAS câmeras** quando houver acesso — o cenário final (ângulo/distância do CD real).
