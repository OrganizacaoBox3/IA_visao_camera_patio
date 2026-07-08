# Reconhecimento de pessoas — diagnóstico do sistema atual (2026-07)

> Foco exclusivo: por que o motor **perde pessoas andando** e **reconhece não-pessoas como pessoas**,
> e por que a Intelbras foi melhor no teste real. Leitura do CÓDIGO (não de memória); evidência
> `arquivo:linha`; separo **MEDIDO** de **HIPÓTESE**. Não altera código — é a base pra a próxima fase.

## 0. Como o pipeline de pessoa funciona hoje (mapa curto)

`worker.js` (D-FINE ONNX, CPU) detecta COCO-80 → `engine.gateAndDispatch` decide se infere (gate de
movimento) → `pipeline.processRound` **filtra só `person`** (`pipeline.js:60`) → `bytetrack.update`
associa/nasce/mata tracks **1× por RODADA DE DETECÇÃO** (`bytetrack.js:154`) → contagem/zonas/overlay.

Parâmetros de qualidade num painel único (`precision.js`): `scoreMin 0.25`, `highScore 0.35`,
`nmsIou 0.6`, `input 640`, tracker `iouThreshold 0.25`, `birthIouThreshold 0.55`, `reassocDist 0.12`,
`reassocMaxGapMs 2500`, `lostAfterMisses 1`. Modelo default **D-FINE-S** (`model.js:44`), COCO-80
genérico. **Cadência: 1 fps** base (`engine.js:44`), 2 fps em câmera com linha, 6 fps na câmera focada.

## 1. "Perde pessoas enquanto caminham" — causas, por impacto

### 1.1 A CADÊNCIA de 1 fps é a causa dominante (MEDIDO no código)
`FPS=1` → `ROUND_MS=1000ms` (`engine.js:44-45`). O ByteTrack roda **1×/segundo** (`bytetrack.js:154`).
Uma pessoa a ~1,4 m/s anda **~1,4 m entre uma rodada e outra**. O que isso quebra:
- **Associação por IoU** (`iouThr 0.25`, `bytetrack.js:180`): a caixa PREVISTA precisa sobrepor a nova
  detecção em 25%. Num track NOVO a velocidade é **zero** (`bytetrack.js:147`) → a predição fica
  PARADA → a 2ª detecção do caminhante está longe → **IoU=0 → não casa**.
- **2º estágio (re-associação por distância)** (`bytetrack.js:205-237`): raio = `reassocDist 0.12` +
  `|v|·gap`. Com `v=0` (track fresco), raio ≈ **12% do frame**. Um passo de 1,4 m costuma passar de 12%
  da largura → **não re-associa → vira ID novo** (parece "várias pessoas") **ou o track antigo vira
  LOST** (some do overlay = "perdeu a pessoa"). Só depois de 2 rodadas casadas a velocidade é aprendida
  e a predição melhora — mas conseguir 2 casamentos seguidos de um caminhante a 1 fps já é o problema.
- **A Intelbras roda 15-30 fps**: entre frames a pessoa move ~5 cm → IoU casa trivialmente → **nunca
  perde**. Amostrar a 1 fps (pra economizar CPU no servidor multi-câmera) é o **handicap nº 1**.

### 1.2 `lostAfterMisses=1` a 1 fps derruba com um único flicker (MEDIDO)
Track sem match por >1 rodada sai da emissão (`bytetrack.js:288`, `precision.js:114`). A 1 fps: **1
detecção falhada** (o modelo COCO piscar por 1 frame — comum em ângulo/luz de CFTV) já é 1 miss;
2 misses (2 s) = **LOST → some do overlay**. Em fps alto, um miss é irrelevante.

### 1.3 Recall do DETECTOR em CFTV — modelo COCO genérico (MEDIDO + HIPÓTESE)
`worker.js` roda **D-FINE COCO-80** (`worker.js:53`, `model.js`): pessoa é 1 de 80 classes, treinado em
**imagens web** (pessoas de frente, perto). Ângulos de CFTV (alto/oblíquo, distante, de costas, oclusão
parcial, blur de movimento) estão **fora da distribuição de treino** → o modelo simplesmente **não
enxerga** pessoas que a Intelbras (detector especializado em vigilância) enxerga. *HIPÓTESE a medir:
quanto de recall perdemos por domínio — hoje não medimos em CFTV (§3).*

### 1.4 Distorção do SQUASH (HIPÓTESE forte)
`worker.js:89` faz `resize(SIZE,SIZE,{fit:"fill"})` — **espreme** 1920×1080 (16:9) em 640×640 (1:1):
pessoas ficam **achatadas/largas**. Detector de pessoa é sensível a proporção. O comentário alega que o
processador do modelo usa `do_pad:false` (squash "casa" o treino), mas espremer 16:9→1:1 é agressivo.
*A medir: letterbox × squash no recall.*

### 1.5 Gate de movimento derruba caminhante pequeno/distante (HIPÓTESE, secundário)
Pra caminhante próximo o gate DISPARA (há movimento) — não é a causa principal. Mas o thumbnail é 64×48
e o limiar `motionRatio 0.005` (`motion.js`): um caminhante distante muda poucos pixels → pode ser
PULADO até o piso de probe (6 s) → sumido nesse intervalo.

### 1.6 Input 640 encolhe pessoa distante (MEDIDO, secundário)
1080p espremido a 640 encolhe a pessoa distante abaixo do detectável. O tiling 2×2 (SAHI) ajuda, mas só
liga em câmera marcada `longRange` — **desligado por default**.

## 2. "Reconhece pessoas que não são pessoas" — causas

### 2.1 Precisão do COCO genérico em CFTV (MEDIDO + HIPÓTESE)
`highScore 0.35` é o limiar de NASCIMENTO. Um modelo COCO fora de domínio dá rótulos **confiantes e
errados**: manequim, pôster/pessoa impressa, reflexo, sombra, casaco no cabide, formas de equipamento →
podem pontuar ≥0,35 como "person" → **nasce um track falso**. Subir `highScore` corta FP mas também corta
recall (o trade-off que só o eval de CFTV resolve — §3).

### 2.2 A 2ª passada de score baixo SUSTENTA o fantasma (MEDIDO)
Detecções 0,25-0,35 **sustentam** tracks existentes (`bytetrack.js:193`). Uma vez nascido um track falso
(um não-pessoa que pontuou ≥0,35 uma vez), ecos de score baixo o **mantêm vivo** → fantasma persistente.

### 2.3 Não há filtro temporal/de aparência (LACUNA)
Pessoa real ANDA; falso-positivo (pôster/sombra) costuma ser **estático ou piscante**. O sistema não usa
"tem que se mover pra ser pessoa" nem consistência de aparência — trata o fantasma estático igual a gente
real. *Oportunidade: confirmar por movimento/persistência.*

## 3. O PONTO CEGO (o achado mais importante): não medimos nenhum dos dois sintomas

- `eval/gate.mjs`: **29 imagens COCO ESTÁTICAS** (21 com pessoa + 8 vazias — `gate.mjs:5`). Mede recall/
  precisão de UM frame em imagem WEB. Não é CFTV, não é caminhada, não é ângulo de vigilância.
- `eval/counting.mjs`: sequências de detecção **SINTÉTICAS** (não é o detector real sobre vídeo).
- **Logo: nenhum sensor mede (a) recall do detector em CFTV real, (b) continuidade de tracking a 1 fps
  sobre movimento real, (c) FP em fontes reais de CFTV (manequim/pôster/sombra).** Estamos **cegos
  exatamente no que falha.** Melhorar sem esse eval é chutar (lição 02.2/02.4 batendo forte). **Este é o
  pré-requisito nº 1 de qualquer melhoria.**

## 4. Por que a Intelbras ganha (não é mágica)

1. **Framerate cheio (15-30 fps) no edge** → tracking trivial, nunca perde caminhante (§1.1).
2. **Detector especializado em vigilância** (pessoa/veículo treinado em ângulos/luz de CFTV) × nosso
   COCO genérico (§1.3, §2.1).
3. **SoC dedicado por câmera** → sem disputa de CPU forçando 1 fps.

## 5. Onde NÓS podemos vencer (a oportunidade real)

- **Servidor roda modelo MAIOR/melhor** do que um SoC de câmera barata: D-FINE-M, um detector
  especializado em vigilância, ou **fine-tuning nos ângulos reais do CD** (adaptação de domínio — bate
  um modelo genérico de vigilância).
- **Inteligência operacional** que a Intelbras não dá: identidade cross-câmera, zonas, contagem por
  linha, alarmes ISA-18, relatório. A Intelbras entrega caixa crua; nós entregamos significado.
- Mas pra isso valer, temos que resolver o handicap de **cadência** (§1.1) e o **gap de domínio** (§1.3),
  e **construir o eval** que mede isso (§3).

## 6. Alavancas priorizadas (próxima fase — nenhuma é código agora; ordem por impacto esperado)

1. **[pré-requisito] Eval de CFTV real** — capturar frames dos DVRs (Intelbras de casa + o do CD),
   rotular pessoas (incl. caminhando/distante) E fontes de FP (manequim/pôster/sombra), num conjunto
   estratificado. Sem isso não medimos nem os sintomas nem as melhorias.
2. **Cadência adaptativa** (o maior ganho no "perde andando"): subir os fps de análise nas câmeras
   com pessoa/movimento (ex.: 4-8 fps quando o gate vê atividade; cai a 1 fps vazia). O motion gate já
   sabe quando há gente. Trade-off: CPU — mas o retrofit de perf (gate, stagger, vigília) liberou
   orçamento pra gastar nas câmeras ATIVAS. Melhora associação E reduz o peso do `lostAfterMisses`.
3. **Gap de domínio do detector**: medir (no eval de §1) D-FINE-M × S; letterbox × squash; um detector
   especializado em vigilância; e avaliar **fine-tuning** nos frames do CD.
4. **Calibrar recall×FP** (`highScore`) no eval de CFTV + **filtro de confirmação por movimento/
   persistência** pra matar fantasma estático (§2.3).
5. **Tiling (SAHI) por default em câmera de visão ampla** (pessoa distante) — medir ganho × CPU.
6. **Sensibilidade do gate** para caminhante pequeno/distante (ratio/por-zona).

> **Ordem doutrinária:** §6.1 (eval) ANTES de tudo — é o sensor. Depois §6.2 (cadência, maior alavanca
> medível). O resto se decide pelos números do eval, não por opinião. Nada aqui é conclusão de "pronto"
> sem o eval provar.
