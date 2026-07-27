# SPEC (RASCUNHO) — Conformidade de EPI por reconhecimento de partes do corpo

> Status: **RASCUNHO para decisão do dono** — nada implementado, nada aprovado · Data: 2026-07-27
> Pedido do dono: *"reconhecer partes específicas do operador — mãos, tronco, cabeça — pra definir
> se devem usar EPIs."*
> Insumos: aritmética de tamanho aparente (feita aqui) · limites JÁ MEDIDOS no repo (ADR-009,
> `server/analysis/README.md`, `acuracia-modelos.md`) · mapa do 2º modelo (`fadiga-host.js`) · mapa
> de zonas/dwell/alarme ISA-18 · o fine-tune que a casa já documentou
> (`reconhecimento-pessoas/05-*`, `08-*`) · pesquisa de modelos, datasets, licenças e normas de
> densidade de pixel (§2.4/§1.5 — licenças conferidas na fonte; o que ficou sem verificação está
> marcado como tal).
> **NÃO decide runtime** — isso é do `ADR-020-runtime-de-inferencia` (§6).

## 0. Resposta curta

**Confirmo a hipótese do dono, com a conta — e refino a razão de um caso.**

| Peça | Câmera de área? | H mín. da pessoa | Por quê |
|---|---|---|---|
| **Colete** | **SIM**, cobertura inteira | ~70 px | cabe ABAIXO do gate de movimento (~90 px): onde o produto vê gente, vê colete |
| **Capacete** | **SIM**, ~72% do alcance | ~125 px | 1,4× o gate ⇒ encolhe a distância útil em ~28% |
| Botina | marginal | ~146 px | tamanho OK; **oclusão** (palete/prateleira/perspectiva) domina |
| **Luva** | **NÃO** | ~194 px | pixel quase dá; matam **oclusão + borrão + 1 fps** (§1.5/§1.6) |
| **Óculos** | **NÃO** | ~438 px | lado menor de 4 cm; e é **frontal-only** — a câmera de teto que vê capacete NUNCA vê óculos |
| Auricular | **NÃO** | ~389 px (concha) | perfil-only; plugue não tem assinatura visual |

**Escopo defensável: CAPACETE + COLETE em câmera de área. LUVA/ÓCULOS só em câmera dedicada de
ponto de passagem**, com lente/distância projetadas para a peça.

**Três coisas que engenharia não decide:**

1. **Sem evidência visual (ADR-002)** o produto não é inviável, mas **muda de categoria**: deixa de
   ser *prova de não-conformidade* e vira *indicador de aderência por área/turno*. Foto exige **ADR
   novo** (§4.1).
2. **EPI é conduta INDIVIDUAL.** Seis documentos prometem hoje *"por área, não vigilância
   individual"* / *"sem identificação individual"*. Eles passam a **mentir** no dia em que a caixa
   acende sobre uma pessoa (§4.3).
3. **~2.500–4.000 recortes anotados** do CD real para uma afirmação defensável, mais ~2.000–3.000
   para treinar. **~25–45 h de anotação humana paga**, não um script (§5.4).

**E uma coisa que esta spec deliberadamente NÃO decide:** entre as duas arquiteturas viáveis —
**(a′)** o detector de pessoa emitindo classes de conformidade (custo incremental **zero**, medido
**melhor** na literatura, mas que **acopla EPI à contagem**) e **(c)** recorte + classificador
(falha isolada, ~4 pp pior no único paper que comparou) — **quem decide é a régua, não o papel**
(§2.2). O que a spec fixa é a **pré-condição dura**: (a′) só entra se passar, **sem regressão**, nos
sensores de pessoa que já existem.

---

## 1. O LIMITE FÍSICO (vem antes de qualquer promessa)

### 1.1 Os limites já medidos neste repo

| Limite | Valor | Fonte |
|---|---|---|
| Gate de movimento não acorda | pessoa **≲ 90 px** (1080p) | medição do dono |
| Detector some | pessoa **< ~25 px NO INPUT (640)** ≈ **42 px em 1080p** | ADR-009:26,56 · `spike-dfine-hub.md:65` · `README.md:175` |
| Recall por tamanho @0.25 | grande 60% → média 41% → **pequena 8%** | `acuracia-modelos.md:13` |
| Squash 640 de 1920×1080 | horizontal ÷3, vertical ÷1,69 → **anisotropia 1,78×** | `spec-marcacao-tempo-real-v2.md:70` · `worker.js:89` (`fit:"fill"`) |
| Custo do detector | **1,07 core·s/frame** (S) ⇒ ~1 câmera/core @1fps | `hardware-ideal.md:24-35` |
| Cadência | **`ANALYSIS_FPS`=1** (2 com tripwire) | `README.md:79` |

Duas réguas independentes concordam: 42 px em 1080p ≈ o degrau **Detection do DORI (IEC 62676-4:
25 px/m ⇒ pessoa de 1,75 m = 44 px)**. Bom sinal de calibração.

*Consistência do ~90 px:* o thumbnail do gate é 64×48 e o limiar `motionRatio=0.005` ⇒ **15,4
células** (`motion.js:33-37`). Pessoa de H px ocupa `(H/2,5)/1920·64 × H/1080·48` células; andando
muda ~2× isso. Dá 9,6 células em H=90 (não passa) e 17,1 em H=120 (passa). **A conta cai entre 90 e
120 — coerente com o medido.** Registro como consistência, não medição independente.

### 1.2 Tamanho aparente por peça

Pessoa de 1,75 m; pixel quadrado ⇒ peça de `d` metros num corpo de `H` px ocupa `d/1,75·H` px.

| Peça | real (m) | fração da estatura (w × h) | H=120 | H=200 | H=450 |
|---|---|---|---|---|---|
| Colete (ombro→quadril) | 0,42 × 0,50 | 0,240 × 0,286 | 29×34 | 48×57 | 108×129 |
| Capacete (aba × alt.) | 0,29 × 0,14 | 0,166 × **0,080** | 20×10 | 33×16 | 75×36 |
| Botina (perfil) | 0,27 × 0,12 | 0,154 × 0,069 | 19×8 | 31×14 | 69×31 |
| Luva / mão | 0,09 × 0,19 | **0,051** × 0,109 | 6×13 | 10×22 | 23×49 |
| Óculos | 0,14 × 0,04 | 0,080 × **0,023** | 10×3 | **16×5** | 36×10 |
| Abafador (concha) | 0,09 × 0,09 | 0,051 × 0,051 | 6×6 | 10×10 | 23×23 |

Numa pessoa de 200 px — **gente grande no quadro** — os óculos têm **5 px de altura**. Não é
limitação de arquitetura; é de amostragem.

### 1.3 O critério de decidibilidade (PREMISSA declarada, a refutar pelo sensor)

> **lado maior ≥ 20 px E lado menor ≥ 10 px, no frame FONTE.**

Mais permissiva que o piso de pessoa (decidir presente/ausente numa região JÁ localizada é mais
fácil que localizar); mais exigente que "1 pixel de cor" (JPEG 4:2:0 subamostra croma pela metade;
luz de CD tem CRI ruim). **É PREMISSA, NÃO MEDIÇÃO.** O primeiro entregável do §5 é **medir a curva
precisão × px da peça** e substituir este número. **Toda a tabela abaixo está pendurada nela.**

| Peça | **H mínima (fonte)** | binding | vs. gate (90 px) |
|---|---|---|---|
| **Colete** | **70 px** | lado maior | **abaixo do gate** — cobertura = a atual |
| **Capacete** | **125 px** | lado MENOR (aba de 14 cm) | 1,39× |
| Botina | 146 px | lado menor | 1,62× |
| **Luva** | **194 px** | lado menor | 2,16× |
| Abafador | 389 px | lado maior | 4,3× |
| **Óculos** | **438 px** | lado menor (4 cm) | **4,9×** |

### 1.4 O squash mata "mais uma classe no D-FINE"

Se a peça virasse só mais uma classe no mesmo passe 640 squashed:

| Peça | H mín. COM recorte | H mín. SEM recorte (no squash) | penalidade |
|---|---|---|---|
| Colete | 70 | **125** | 1,8× |
| **Capacete** | 125 | **363** | **2,9×** |
| Luva | 194 | 584 | 3,0× |
| Óculos | 438 | 750 | 1,7× |

**363 px de pessoa para ver um capacete é 34% da altura do quadro — isso é close-up, não câmera de
área.** ⇒ **O recorte da pessoa em resolução nativa não é otimização, é requisito de viabilidade.**
Isto já refuta a abordagem (a) na forma ingênua (§2.1).

### 1.5 Distância × lente, e a linha de visada

`H·d` é constante por lente (sensor 1/2.8", 1920 px):

| Lente | hFOV | H·d (px·m) | d p/ H=90 | **d p/ H=125 (capacete)** | d p/ H=194 (luva) | d p/ H=438 (óculos) |
|---|---|---|---|---|---|---|
| 2,8 mm | 90° | 1.680 | 18,7 m | **13,4 m** | 8,7 m | 3,8 m |
| **4,0 mm** | 70° | 2.400 | 26,7 m | **19,2 m** | 12,4 m | 5,5 m |
| 6,0 mm | 50° | 3.600 | 40,0 m | **28,8 m** | 18,6 m | 8,2 m |

**Cross-check normativo (IEC 62676-4).** ⚠ A revisão **2025 aposentou o acrônimo DORI** e passou a
sete níveis: Overview 20 · Outline 40 · Discern 80 · **Perceive 125** · **Characterize 250** ·
Validate 500 · Scrutinize 1500 px/m. (DORI 2014, legado: Detection 25 · Observation 62,5 ·
Recognition 125 · Identification 250.) Para pessoa de 1,75 m:

| px/m | 25 | 62,5 | 125 | **250** |
|---|---|---|---|---|
| altura da pessoa | 44 px | 109 px | 219 px | **438 px** |

Capacete (125 px) cai entre os dois primeiros degraus. **Óculos (438 px) cai EXATAMENTE no degrau
de 250 px/m — "Identification" no vocabulário de 2014, "Characterize" no de 2025. Uma câmera que vê
óculos de segurança é, por construção, uma câmera com densidade de identificação de pessoa.**
Guardar para §4.3.

**Corroboração independente do piso de ~90 px (a melhor evidência externa desta spec):** a **AXIS
Object Analytics** publica, para detecção de humano, **mínimo de 4% da altura da imagem** e
**recomendado 8%** — em 1080p isso é **43 px** e **86 px**. **O 8% recomendado da Axis (86 px) bate
com o ~90 px medido pelo dono**, por um caminho totalmente independente. E a Axis **ainda ships um
cenário "PPE monitoring (BETA)"** (detecta humano sem capacete, caixa vermelha na cabeça) **sem
publicar densidade de pixel própria para ele** — ou seja, **um fabricante com silício na câmera não
afirma que EPI precisa de menos densidade que a detecção de pessoa.** É o mesmo veredito desta spec,
vindo de fora.

**⚠ O limite que pixel NENHUM resolve — LINHA DE VISADA (independente e mais duro):**

- Câmera de teto (30–60°, o padrão de CD) vê o **topo da cabeça**: geometria **ótima para capacete**
  (a aba é o que aparece de cima), **cega para óculos**. **O ângulo que maximiza uma peça minimiza a
  outra.**
- Óculos exigem visada frontal; abafador, perfil. Numa câmera fixa só as pessoas voltadas para ela
  são avaliáveis — e essa subpopulação **não é aleatória** (quem vem em direção à câmera caminha;
  quem está de costas trabalha). Aderência estimada ali é **viés de seleção**, não amostra.
- **Mão é a parte mais ocluída que existe** num CD: caixa nos braços, paleteira, bolso, atrás do
  corpo, dentro da prateleira. Não há ângulo que resolva.

**Refutação parcial registrada:** o dono supôs que luva e óculos falham **por tamanho**. Os óculos
falham por tamanho (438 px, sem discussão). **A luva quase passa** no teste de tamanho (194 px ⇒
12 m com 4 mm — instalável): ela falha por **oclusão, borrão e cadência**. Importa porque significa
que **comprar câmera melhor não conserta luva**.

### 1.6 Cadência (1 fps) — fatal para a mão

- Colete/capacete são quase estacionários no corpo: qualquer amostra serve; amostras sucessivas são
  redundantes. Ótimo para agregação temporal (§2.3).
- **Mão se move a ~1–2 m/s.** Com obturador de câmera IP em luz interna (1/30–1/60 s) ela percorre
  1,5–6 cm na exposição, sobre uma largura aparente de **6–10 px**: borrão total. E a 1 fps não há
  como escolher o frame bom.
- ⇒ luva exigiria **≥10 fps em câmera dedicada** — outra ordem de grandeza de CPU (§6.1).

### 1.7 ⚠ Bloqueio operacional: o manual manda usar o SUB-STREAM

`manual-incluir-cameras.md:41`: *"sempre que possível, o **sub-stream** (resolução menor → menos
CPU/banda; a detecção já roda em resolução reduzida)"*. Sub-stream típico é **640×480**. A altura
mínima **em px** não muda — mas a mesma pessoa tem **3× menos pixel na mesma distância**, então a
**distância útil cai 3×**:

| Peça | d @1920 (4 mm) | d @640 |
|---|---|---|
| Colete (H≥70) | 34,3 m | **11,4 m** |
| Capacete (H≥125) | 19,2 m | **6,4 m** |

**EPI é incompatível com a receita de instalação atual.** Requisito duro: **câmera com EPI ligado
entrega ≥1920 de largura** (muda banda, ffmpeg e CPU do site). **Se isto passar despercebido, a
feature nasce medindo 6 m de doca e ninguém descobre — o sintoma é "aderência 100%", não "erro".**
É o falso-OK que o CLAUDE.md chama de pior que erro.

---

## 2. As abordagens — quatro, não três

A pesquisa acrescentou uma quarta que o enunciado não previa, e que **é a medida como melhor na
literatura**. Ela precisa entrar na comparação.

| Eixo | **(a) detector de PEÇAS** (capacete/colete como objetos) | **(a′) detector de PESSOA com classes de conformidade** | **(b) pose + classificação da região** | **(c) recorte da região + classificador** |
|---|---|---|---|---|
| **O que é detectado** | a peça (objeto pequeno) | **a PESSOA**, rotulada `com/sem capacete` — o objeto é do tamanho do corpo | pessoa → keypoints → região | pessoa → região → classifica |
| **Inferência** | caro se somar ao D-FINE (2× 1,07 core·s) | **ZERO custo incremental** — é o MESMO passe, só com mais classes | pose por pessoa: **RTMPose-t 3,2 ms / -s 4,5 ms** (ORT CPU, **1 thread**, 256×192) + classificador | classificador 128×256: ordem de **1–5 ms**/pessoa |
| **Dado de treino** | caixas por peça | **caixas de pessoa com rótulo de conformidade** — é o formato do *Construction Site Safety* (CC BY 4.0) | pose é pré-treinada; só o classificador precisa de dado do CD | rótulo por recorte, sem caixas (~5× mais rápido de anotar) |
| **Amostragem (§1.4)** | ❌ **refutado**: capacete exigiria pessoa de **363 px** no squash | ⚠ **não precisa LOCALIZAR a peça, só DISCRIMINAR** num alvo do tamanho da pessoa — requisito **entre** os dois números da §1.4, e **ninguém mediu onde** | recorte nativo (sem penalidade de squash) | recorte nativo (sem penalidade de squash) |
| **⚠ Direção do erro** | **PARA "CONFORME"** — ausência de detecção é ambígua. É o modo de falha mais perigoso desta spec | ⚠ **PIOR ACOPLAMENTO**: dúvida entre `com`/`sem` **divide a confiança e derruba a pessoa abaixo do `highScore` 0,35** ⇒ **a pessoa some da CONTAGEM**. Uma ambiguidade de EPI corromperia o indicador de ocupação | **PARA ABSTENÇÃO** — o keypoint tem *score de visibilidade*; some antes de o classificador errar. **A única com "não sei" nativo** | **neutro — e essa é a armadilha**: sigmoide sempre devolve número. Exige a banda do §2.3 |
| **Isolamento de falha** | bom | ❌ **nenhum** — substitui o detector de produção; EPI e contagem passam a morrer juntos | bom | **bom** — EPI pode falhar inteiro sem tocar em pessoa/contagem/zona |
| **Veredito** | ❌ **refutado pela aritmética** (§1.4) | ⚠ **CANDIDATO FORTE, com pré-condição dura** | ⚠ só se a MÃO entrar | ⚠ **CANDIDATO** |

### 2.1 ⚠ A evidência que contraria a escolha óbvia — e o que ela não decide

**Nath, Behzadan & Paal (Automation in Construction, 2020 — o paper do Pictor-v3) mediu as três
arquiteturas head-to-head:**

| Arquitetura | mAP |
|---|---|
| A1 — detectar peças separadas + classificador de associação | (a pior) |
| **A2 — detector emite direto as classes W/WH/WV/WHV** (= nossa **a′**) | **72,3%** |
| A3 — detectar pessoa → **recorte → CNN** (VGG-16/ResNet-50/Xception) (= nossa **c**) | **67,93%** |

**A duas etapas foi ~4,4 pontos de mAP PIOR que o detector único, custando um modelo a mais.** Isso
contraria a escolha intuitiva, e a spec não pode ignorá-lo.

**O que essa medição NÃO decide para nós — dois motivos, ambos declarados:**

1. **Domínio diferente.** É canteiro de obra em **imagem de resolução nativa**. O SH17 mede que
   **52% das anotações de EPI ocupam <1% da área da imagem** e **78% <5%**; os números publicados
   saem de stills de **1920×1002 a 8192×5462**. **Nosso pipeline faz squash para 640.** Nada garante
   que a ordem A2 > A3 sobreviva ao nosso pré-processamento — a §1.4 diz que é justamente aí que a
   penalidade cai desigualmente sobre as duas.
2. **A métrica é mAP de detecção, não risco de produto.** A2 ganha em mAP e **perde no eixo que esta
   casa mais protege**: ela **substitui o detector de pessoa em produção**. O produto inteiro
   (contagem, ocupação, tripwire, zona, alarme de presença) pende de um número — recall de pessoa —
   que a ADR-009 existe para proteger e que `eval/gate.mjs` e `eval/persons-cftv.mjs` medem. **Trocar
   esse modelo para ganhar uma feature é apostar o KPI no delta.**

### 2.2 A recomendação — dois candidatos, decididos pelo sensor, com pré-condição

**Esta spec NÃO escolhe entre (a′) e (c) no papel.** Escolher sem medir seria exatamente o que a casa
proíbe. O que ela fixa é:

- **Ambos entram no S1 (§5.1)**, medidos no MESMO fixture, com a curva precisão × tamanho de cada um.
  A régua decide. **A literatura favorece (a′); a arquitetura favorece (c); o nosso pipeline
  (squash 640) é a variável que nenhum dos dois lados mediu.**
- **PRÉ-CONDIÇÃO DURA para (a′), inegociável:** um D-FINE fine-tunado com classes de conformidade só
  pode ser considerado se passar **sem regressão** em `eval/gate.mjs` (`f1_all@0.35`,
  `recall_all@0.25`, `precision_all@0.35`, `fp_empties@0.50`) **e** em `eval/persons-cftv.mjs`.
  **Regressão de pessoa reprova a feature inteira, por melhor que seja o EPI.** O indicador que já é
  vendido não paga a conta de um indicador novo.
- **Se (a′) reprovar na pré-condição, a resposta é (c)** — mesmo sabendo que ela mede ~4 pp pior no
  paper, porque **falha isolada vale mais que 4 pp num sistema cujo KPI é outro**.
- **(b) fica fora** — não porque seja cara (RTMPose-t custa **3,2 ms/pessoa**, mais barato do que eu
  supunha), mas porque **cabeça e tronco já são deriváveis do bbox** (topo ~18%, 20–62%) e o único
  ganho real da pose é o **punho**, que está fora por física (§1.5/§1.6). O custo dela no nosso
  runtime é de **reimplementação em JS**, não de FLOPs (§6).

*O pedido "partes do corpo" tem resposta barata para as partes viáveis e cara para as inviáveis.*

### 2.3 ⚠ O que acontece quando o modelo não tem certeza

O dono nomeou o problema: *"errar para conforme é inútil; errar para não-conforme vira alarme-lixo e
o operador desliga."* Não se resolve escolhendo modelo — **desenha-se a abstenção**. Quatro
mecanismos, todos obrigatórios:

1. **TRÊS estados, nunca dois.** `CONFORME | NÃO-CONFORME | INDETERMINADO`, com `τ_alto`/`τ_baixo` e
   a banda entre eles. O erro é empurrado para o estado que não gera alarme **nem falso conforto**:
   gera **cobertura declarada**.
2. **O gate FÍSICO precede o de confiança.** `H < piso_da_peça` ou recorte cortado pela borda ⇒
   **INDETERMINADO por construção, o modelo nem roda.** É a Regra 9 aplicada: abaixo da resolução do
   instrumento nada é observável, e apostar ali é aposta. Barato, determinístico, e mata a classe
   inteira de erro "silêncio em área não coberta".
3. **Cobertura SEMPRE ao lado da aderência.** `aderência = conformes/(conformes+não-conformes)`
   **junto com** `cobertura = avaliados/observados`. Aderência sem cobertura é a **Regra 11**
   esperando: o agregado marca 98% porque 90% das pessoas nunca foram avaliáveis.
4. **Agregação temporal com o custo declarado (Regra 13).** N observações do mesmo track votam antes
   de alarmar. **MAS** dado independente ≠ erro independente: os erros aqui são **fortemente
   correlacionados por sujeito** (ângulo, cor do uniforme, posição), e o corolário medido de
   2026-07-12 diz que **separar no tempo não decorrelaciona**. ⇒ a agregação compra **menos** do que
   o `n` promete; `agreementOnFailure` é obrigatório ao lado do voto. Prometer "10 frames
   concordando = 99%" repetiria o erro que já custou dois números errados publicados.

### 2.4 Modelos e datasets públicos — **a licença é o gargalo, não a acurácia**

**Critério eliminatório da casa** (`05-plano-finetune-vigilancia.md §1`): **licença limpa**. O
catálogo de produção é 100% **Apache-2.0**.

> Licenças conferidas na fonte (repo/README/HF API) nesta pesquisa. **Ainda assim, registrar URL +
> data antes de usar** — licença muda, e o próprio SH17 tem texto conflitante entre paper e repo.

| Dataset | Imagens | Peças | Licença | Veredito |
|---|---|---|---|---|
| **Hard Hat Workers** (Roboflow) | 7.041 | capacete/cabeça/pessoa | **CC0 / domínio público** | ✅ **a mais limpa que existe** |
| **Construction Site Safety** (Roboflow Universe Projects) | 2.801 | 10 classes: `Hardhat`, `NO-Hardhat`, `Safety Vest`, `NO-Safety Vest`, `Person`, máscara, cone, máquina… | **CC BY 4.0** | ✅ **usável com atribuição — e já traz os NEGATIVOS e o formato da abordagem (a′)** |
| SHWD | 7.581 | capacete/cabeça | **MIT** no repo ⚠ | ⚠ MIT cobre o *código*; imagens raspadas da web + SCUT-HEAD — **proveniência não auditada** |
| CHV | 1.330 | capacete (4 cores) + colete | "livre", **sem licença formal** | ⚠ ambíguo juridicamente |
| GDUT-HWD | 3.174 | capacete por cor | **não declarada** | ⚠ inutilizável sem contatar o autor |
| Pictor-v3 | ~1.472 | trabalhador/capacete/colete | **sem LICENSE no repo de origem** | ⚠ ambíguo |
| **SH17** | 8.099 (75.994 inst.) | **17 classes — a ÚNICA com luva + óculos** | **CC BY-NC-SA 4.0** | ❌ **BLOQUEADO** (não-comercial + ShareAlike) |
| **Ultralytics Construction-PPE** | 1.416 | 11 classes com luva/óculos/botina | **AGPL-3.0 — no PRÓPRIO DATASET** | ❌ **BLOQUEADO** |
| CPPE-5 | ~1.000 | EPI **médico** (luvas, óculos) | anotações Apache-2.0; imagens Flickr, autores não detêm copyright | ⚠ domínio errado |

**⚠ O achado de licença, em uma frase: as DUAS únicas fontes públicas que cobrem luva e óculos —
SH17 (CC BY-NC-SA) e Ultralytics Construction-PPE (AGPL-3.0) — são ambas proibidas para produto
comercial fechado.** Somado à física da §1, **luva e óculos ficam sem dado público E sem pixel.**

**Modelos:**

| Categoria | Situação verificada |
|---|---|
| **EPI pré-treinado em ONNX permissivo** | ❌ **não existe.** Praticamente todo modelo de EPI publicado (HF, Roboflow, GitHub) é fine-tune de **Ultralytics YOLOv8/11 ⇒ AGPL-3.0 herdado**, inclusive nos pesos |
| **Bases de fine-tune permissivas** | **D-FINE** (`ustc-community/dfine_*`, **Apache-2.0** — o que já usamos) · **RF-DETR** (Roboflow, **Apache-2.0**) · RT-DETR original da Baidu (Apache-2.0; o *port* da Ultralytics é AGPL) |
| **Pose** | **RTMPose** via **rtmlib** (Apache-2.0, ORT puro, **sem mmcv/mmpose**): `-t` **12,0 MB / 3,20 ms** · `-s` **19,5 MB / 4,48 ms** · `-m` 48,4 MB / 11,06 ms (i7-11700, **1 thread**, 256×192). ❌ **YOLOv8/11-pose = AGPL-3.0** · ❌ **OpenPose = não-comercial (US$25k/ano p/ comercial)** |
| **Classificador do recorte** | **MobileNetV3-Small** (BSD-3) · **EfficientNet-Lite**/timm (Apache-2.0) — export ONNX trivial |

⚠ **Duas ressalvas de licença a resolver antes de qualquer adoção:** (1) os repos-espelho
`onnx-community/*` **não declaram campo `license`** na metadata — a licença tem de ser citada do
repo **upstream** (`ustc-community/dfine_s_coco` = Apache-2.0); (2) `mmpose#2393` pergunta se
`projects/rtmpose` é GPL-3.0 ou Apache-2.0 e **a resposta não foi recuperada** — ler a thread antes
de usar RTMPose. Além disso, os checkpoints `body7` são treinados em mistura de 7 datasets, vários
com termos de pesquisa: **Apache cobre o código, não necessariamente os pesos.**

**⚠ Números publicados que NÃO transferem — e um que contraria a intuição desta spec.** O SH17 reporta
YOLOv9-e por classe (mAP@50): **capacete 77,0 · óculos 76,4 · luva 66,5 · colete 57,7 · abafador
57,1 · pé 29,3**. Duas leituras obrigatórias:

1. **É em still de resolução nativa (1920×1002 a 8192×5462), não em frame de vigilância squashed a
   640.** Com 52% das anotações abaixo de 1% da área, esses objetos caem na faixa de 10–30 px depois
   do nosso pré-processamento. **Os números não são transferíveis** — e um paper independente reporta
   que ROIs de **60×60 px já produzem detecção instável em YOLOv8** (fonte com fetch 403, marcada
   como não verificada).
2. ⚠ **O colete pontua em 4º, abaixo do capacete e dos óculos** — o oposto do que a geometria da §1.2
   prevê. Minha ordenação "colete é o mais fácil" é **argumento geométrico**, e o único número
   público disponível **discorda**. Explicação plausível (não medida): variedade de colete e oclusão
   por carga/braços. **Isto é uma hipótese que o S1 tem de testar — não um detalhe.**

**⇒ O caminho é fine-tune próprio — que a casa já sabe fazer e já documentou:**
`reconhecimento-pessoas/05-*` + `08-*` descrevem o pipeline completo (repo **`Peterande/D-FINE`,
Apache-2.0**, Colab T4 grátis, `export_onnx.py` no **mesmo shape** que `worker.js` consome ⇒
**drop-in absoluto**), com os riscos já catalogados — **incluindo licença dos dados de treino como
item de revisão jurídica**. ⇒ **os 2.500–4.000 recortes do §5.4 não são evitáveis comprando modelo
pronto.**

---

## 3. Encaixe no que JÁ EXISTE

### 3.1 A tese "é só uma zona com regra + dwell + alarme" — verificada

**Meio verdadeira. A metade falsa é a cara.**

| Camada | Reusa? | Evidência |
|---|---|---|
| Geometria de zona (`zones.js`: `resolveZone`, polígono, máscara) | **100%, zero arquivo** | mesmo módulo do modo `proibida` |
| Dwell + histerese (`presence-alert.js`) | **~90%** | falta parametrizar o predicado de contagem (~10 linhas) |
| **Pipeline ISA-18 inteiro** (dedup, flap, flood, shelve, prioridade, fila, WhatsApp, Andon, persistência, socket) | **100%, ZERO arquivo alterado** | `tipo` é string livre **não validada** em todo ponto de persistência (`events.js:40`: `clean(e.tipo)\|\|"atividade"`; `schema.sql:151` `tipo text` sem constraint) |
| Modo de zona novo (`modo:"epi"`) | **NÃO** | **não existe registry**: ~14 sites de igualdade de string + 4 `Record<ZoneMode,…>` exaustivos no front + 3 suítes que fixam a lista dos 6 modos |
| Gate de turno/`arming` p/ o tipo novo | **NÃO** | `alarm/shift.js:106`: `if (tipo !== "atividade" && tipo !== "presenca") return null;` ⇒ **`tipo:"epi"` alarmaria 24/7 ignorando turno e `arming`** |
| Detalhe estruturado no evento | **NÃO** | allowlist fechada em 4 pontos; o **único** carregador hoje é o `text` livre. Campo `meta` = contrato em 6 arquivos + schema |
| **O booleano por pessoa** | **NÃO EXISTE** | `pipeline.js:73` descarta não-`person`; `:86` guarda só `{score,bbox}`; Track (`bytetrack.js:91`) é `{id,cx,cy,foot,bbox,score,firstSeen,lastSeen}`; modelo é COCO-80. Grep `epi\|capacete\|helmet\|colete\|vest\|ppe` em `src/`+`server/`: **zero** |

> **Reformulação que sobrevive:** EPI **reusa o pipeline de alarme inteiro sem tocar em um arquivo**
> e ~90% da maquinaria de zona/dwell. O custo está em (a) **produzir o sinal por pessoa** ponta a
> ponta e (b) a **ausência de registry de modo de zona**.

### 3.2 O delta proposto ("Path A" — sem `modo:"epi"` até a Onda 3)

**Onda 0 — só o sensor, zero linha de produção** (§5). Sem isto nada abaixo tem direito de existir.

**Onda 1 — o sinal por pessoa (o trabalho de verdade).** ⚠ **A tabela abaixo dimensiona o pior caso,
(c).** Se o S1 escolher **(a′)**, a Onda 1 encolhe para *trocar o `.onnx` + carregar a classe no
Track + preservar até o pipeline* — os quatro arquivos novos somem, e o custo migra inteiro para o
fine-tune e para a pré-condição de não-regressão (CA-10).


| Arquivo | Mudança | Molde |
|---|---|---|
| `server/analysis/model-epi.js` **(novo)** | catálogo (sha256 + bytes exatos + escrita atômica `.tmp`+rename) | **espelha `model-fadiga.js`** |
| `server/analysis/worker-epi.js` **(novo)** | fork dedicado; decode **1×** → `extract` por pessoa → classifica | reusa o padrão de `detectTiled` (`worker.js:225`) e `squareCrop` (`worker-fadiga.js:88`) |
| `server/analysis/epi-host.js` **(novo)** | fila último-vence, respawn, roteamento | **espelha `fadiga-host.js`** |
| `server/analysis/epi-state.js` **(novo)** | banda de abstenção, voto, `agreementOnFailure` | novo (a lógica do §2.3) |
| `server/analysis/pipeline.js` | preservar o atributo até o Track; `epi.observe(...)` ao lado de `presence.observe` (linha 164) | pequeno |
| `server/analysis/bytetrack.js` | carregar o atributo no Track (`:252-257`) | pequeno |
| `server/camcfg.js:170` | `cleanZone` aceitar `epiRequerido`/`epiAlertMs` — **não é opcional**: campo fora do allowlist é descartado **mudo** (armadilha A5 documentada no próprio arquivo) | pequeno |
| `src/zones.ts` | espelho do campo em `Zone` + `withDefaults` | pequeno |

**Onda 2 — o alarme (quase tudo já existe):**

| Arquivo | Mudança |
|---|---|
| `server/analysis/epi-alert.js` **(novo)** | irmão de `presence-alert.js`, reusando os **puros** `offDelayMs`/`dwellMsOf`; emite `raiseAlarm({…, tipo:"epi"})` |
| `server/alarm/shift.js:106,119-121` | incluir `"epi"` — **senão alarma 24/7** |
| `server/alarm/classify.js:16` | ramo de keyword (o `shelveKeyFor` cai em `classify(text).tipo` quando falta `p.tipo` → sem isto a UI de shelve quebra) |
| `server/settings.js:16-21` | `DEFAULTS.tipos` (o `normalize()` descarta tipo desconhecido) |
| `ReportTools.tsx:51` + `NotificacoesTab.tsx:30` | `TIPO_LABEL` — senão aparece o slug cru |
| painel de aderência **+ cobertura** | novo — no PAINEL, nunca sobre a imagem |

**NÃO mudam:** `alarm/pipeline.js`, `alarmPolicy.js`, `alarm/{flap,flood,shelve,keys,priority,metrics,persist,state,config}.js`,
`events.js`, `schema.sql`, `routes/alarms.js`, `control-plane-forwarder.js`, drawer de alarmes.

**Modo `"epi"` fica para a Onda 3**, se a régua aprovar (14 sites + 4 `Record` + 3 suítes não se
pagam antes de saber se a feature funciona).

### 3.3 Herança de graça — e duas pegadinhas

- **A histerese já é a certa:** `offDelayMs(dwell)=max(5000,dwell/2)`, um evento por violação, rearma
  ao sair. É literalmente o padrão de EPI.
- **Rodada pulada pelo gate NÃO zera o dwell** (`presence-alert.test.js:41-59`) — exatamente o que
  EPI precisa.
- ⚠ **O `⚠` no início do `text` é load-bearing:** `alarm/priority.js:6` deriva `priority:"critical"`
  de `text.includes("⚠")`. Decidir conscientemente, não por copiar-e-colar.
- ⚠ **Dívida da fadiga que o EPI NÃO deve herdar:** `fadiga-host.js` **não usa o gate de movimento**
  (5 fps incondicional) — o EPI deve usar, é o mesmo `motion.js`. E `fadigaHost.status()` **está
  morto**, `decodeMs`/`inferMs` são medidos e **descartados**, fadiga é invisível a `telemetry.js` e
  `autoscale.js`. **O EPI não pode nascer cego:** `GET /api/analysis/status` tem de expor
  `epi:{avaliados1m, indeterminados1m, ms}`.
- Existem **3 cópias** do conversor CHW (`worker.js:77`, `worker-fadiga.js:102,119`). O EPI seria a
  4ª — **extrair `server/analysis/tensor.js` antes** é a melhoria de infra mais barata da área.

*O que a fadiga já provou:* 2º modelo ONNX no hub funciona — fork separado, CPU EP, download com
sha256, fila último-vence, emissão `volatile` só com espectador, ingest de agregados, zero imagem.
Medido: FaceMesh **7,4 ms**, YuNet full-frame **28 ms**, **9 ms** com box hint.

---

## 4. Invariantes: o que NÃO pode cair

### 4.1 ADR-002 — nenhuma imagem persistida

O padrão de mercado em EPI é **guardar o print como evidência** — a foto *é* o produto. **Aqui não
pode**, e a única saída é ADR novo. O evento fica assim:

```
{ id, ts, cameraId, cameraLabel, zona:"Doca 3", tipo:"epi", priority:"high",
  text:"⚠ Doca 3: pessoa sem capacete há 24s (confiança 0,81; 7 de 9 observações)", state:"new" }
```

Note que **todo o detalhe estruturado está espremido no `text` livre** (§3.1): peça ausente,
confiança, `n` e id efêmero de track **não têm campo próprio hoje**.

**O que se perde sem imagem:**

1. **Contestação impossível nas duas direções** — o operador não prova que usava; a supervisão não
   prova que não. **O evento vira palavra do algoritmo contra a do humano**, e o algoritmo não leva
   intervalo de confiança no WhatsApp.
2. **Não há auditoria do falso positivo depois do fato.** Sem o frame, ninguém diz se o alarme das
   14h32 estava certo — some o loop de melhoria mais importante que existe.
3. **Não há uso disciplinar defensável.** O cliente descobre isso na primeira contestação. **Tem de
   ser dito na venda.**
4. **A rotulagem do §5.4 fica sem fonte.** Existe caminho legítimo (campanha de coleta com prazo,
   consentimento e descarte, como projeto separado) — **não é grátis nem automático.**

**Parecer técnico explícito: o produto NÃO é inviável sem evidência — mas muda de categoria.** Deixa
de ser *prova de não-conformidade individual* e vira *indicador de aderência a EPI por
área/zona/turno*, do mesmo caráter dos indicadores de ocupação que já existem. **Nessa categoria ele
é honesto, útil e cabe no ADR-002 sem mudar nada.** Para a categoria "prova" é preciso ADR novo
(retenção curta, cripto em repouso, acesso auditado, escopo só ao recorte, descarte automático) +
o parecer do §4.4. **Decisão do dono — aqui está a informação, não a decisão.**

### 4.2 Caixa sem número, contagem no painel

- O overlay pode indicar **estado** (mesmo mecanismo do `presenca` violada em
  `analysis-tracks.zonesProibidas`), **nunca** id, contagem ou percentual sobre a imagem.
  `src/camera/drawTracks.test.ts` quebra o build se um dígito voltar.
- Aderência, cobertura, `n` e Wilson vivem no **PAINEL** (ADR-003, "a imagem é soberana").
- **"Going gray":** a caixa só satura em **não-conformidade confirmada**. `INDETERMINADO` é neutro —
  **não pode parecer acusação.** Um indeterminado pintado de laranja é o alarme-lixo entrando pela
  porta da UI.

### 4.3 ⚠ A TENSÃO DE POSICIONAMENTO — EPI é conduta INDIVIDUAL

**Não é resolvível por engenharia. É a decisão mais importante desta spec.**

O produto promete hoje, por escrito e em badge na tela:

| Onde | O que promete |
|---|---|
| `docs/produto/VISAO-GERAL.md:11` | *"por área, **não vigilância individual**… **sem identificação individual**"* |
| `docs/produto/PLANO-MVP.md:11` | *"ocupação, movimentação e ociosidade por zona/turno/fluxo — **nunca ranking individual**"* |
| `docs/produto/PLANO-MVP.md:15` | *"**badge** 'processamento local · sem identificação individual'"* |
| `docs/produto/PLANO-MVP.md:45` | *"Identificação individual… ranking de pessoas (**proibido por posicionamento**)"* |
| `docs/produto/PLANO-MVP.md:191` | risco *"Percepção de vigilância (LGPD/cultural)"* → *"sem rosto/indivíduo, badge de privacidade"* |
| `docs/arquitetura/01-visao-geral-arquitetura.md:29` | *"sem identificação individual. Pessoas recebem IDs efêmeros"* |

**A tensão em uma frase:** ocupação é propriedade da **ÁREA**; usar capacete é propriedade da
**PESSOA**. *"Alguém sem capacete na Doca 3"* é sobre área. A caixa acesa na tela, que é o que o
operador de fato lê, é sobre **indivíduo**. **Não existe versão de EPI puramente "por área".**

| Nível | O que o sistema faz | Posicionamento sobrevive? |
|---|---|---|
| **N1 — indicador de área** | só painel: *"aderência a capacete na Doca 3: 87% [Wilson 81–91], cobertura 62%"*. Sem alarme, sem caixa acesa, sem evento por pessoa | **SIM, intacto** — mesmo caráter de ocupação/atividade |
| **N2 — alarme de zona, anônimo** | alarme + caixa acesa ao vivo; evento só metadado; sem id, sem histórico por pessoa | **Enfraquecido** — ao vivo a caixa **aponta um indivíduo**, e quem está ao lado sabe quem é. **Os 6 documentos acima precisam ser reescritos no mesmo PR** |
| **N3 — conduta rastreável** | vincula a identidade (crachá/ReID/matrícula) para reincidência | **MORTO** — vigilância individual explícita. Exige ADR + jurídico + sindicato, e reabre o ADR-015 §4 (embedding efêmero, **sem galeria entre turnos/dias**) |

**Recomendação técnica: comece em N1** — é a única faixa que entra sem reescrever o posicionamento,
e é onde a régua do §5 se constrói com honestidade. **N2 é decisão do dono.**

**Cruzamento com o ADR-015:** ele registra que o CD tem **anônimos constantemente** (visitantes,
manutenção, terceiros). **Essa é exatamente a população de maior risco de não-conformidade — e a que
o sistema menos consegue tratar.** Um indicador que não separa operador de visitante mede população
misturada: é a **Regra 11** em forma de produto.

### 4.4 O que precisa de parecer (sinalizando, NÃO dando parecer jurídico)

Antes de N2 ou N3, um jurista/RH/SESMT tem de responder:

1. **LGPD — base legal e finalidade.** Monitoramento de conduta individual do empregado não se
   sustenta em "legítimo interesse" como contagem anônima. Muda base legal, necessidade de RIPD/DPIA
   e dever de transparência ao titular.
2. **LGPD — o dado é sensível?** Imagem de pessoa identificável em conduta laboral + qualquer vetor
   de aparência navega perto de biométrico. O ADR-015 já reconhece "adjacente a biométrico".
3. **NR-06 / segurança do trabalho.** A obrigação de *fiscalizar* o uso é do empregador. O sistema
   pode ser **auxílio**; se laudo/auditoria passarem a **depender** dele, a cobertura (§2.3.3) vira
   responsabilidade legal — "0 não-conformidades" com 30% de cobertura é afirmação perigosa.
4. **Relação sindical / acordo coletivo.** Monitoramento eletrônico de conduta individual costuma
   exigir comunicação prévia e política escrita; alarme automático via WhatsApp é o ponto sensível.
5. **Uso disciplinar.** Se o evento não pode ser contestado (§4.1), qual o valor probatório? Definir
   por escrito para que serve **e para que não serve**.
6. **A câmera que vê óculos vê rosto** (§1.5) — muda o cartão de instalação e a comunicação ao
   trabalhador, mesmo que o software não faça reconhecimento facial.

---

## 5. Sensor ANTES da feature

### 5.1 Quatro sensores, não um (Regra 11: medir o delta do mecanismo, isolado)

Molde: `eval/counting.mjs` + `eval/stationary.mjs` — importar os **módulos de produção** (nada
reimplementado), knobs derivados de painel único, régua **pinada a priori** (`PASS` 0 / `FAIL` 1),
fronteira honesta declarada.

| Sensor | Arquivo | Mede |
|---|---|---|
| **S1 — decidibilidade × tamanho** | `eval/epi-size.mjs` | a **curva** precisão/recall × altura da pessoa em px, por peça, **para (a′) e (c) no MESMO fixture**. **É o que refuta ou confirma a premissa 20/10 px do §1.3 E decide entre os dois candidatos do §2.2** |
| **S2 — conformidade fim-a-fim** | `eval/epi.mjs` | dets → pipeline → track → abstenção → voto → alarme, em sequências determinísticas (mede a **lógica**, não o modelo) |
| **S3 — modelo em imagem real** | `eval/epi-gate.mjs` | fixture commitado pequeno (padrão `gate.mjs`), limiares em `eval/thresholds-epi.json` |
| **S0 — não-regressão de PESSOA** | `eval/gate.mjs` + `eval/persons-cftv.mjs` (**já existem**) | a **pré-condição dura** de (a′): trocar o detector de produção não pode custar recall de pessoa. **Reprovou aqui, reprovou a abordagem** |

### 5.2 Dataset e ground truth

- **Público (0a, barato):** **Hard Hat Workers (CC0)** e **Construction Site Safety (CC BY 4.0)** —
  as duas únicas fontes com licença limpa (§2.4), ambas **só capacete + colete**, o que por si já
  fecha o escopo. Servem para **calibrar a curva de tamanho** e pré-treinar. **Não** servem para
  afirmar precisão operacional: são canteiro de obra, ao ar livre, em resolução nativa.
  ⚠ E a *Construction Site Safety* já vem no **formato da abordagem (a′)** (`Hardhat`/`NO-Hardhat`,
  `Safety Vest`/`NO-Safety Vest`, `Person`) — é o dataset que permite testar (a′) **sem anotar nada**.
  **Fazer isso na Onda 0 é o experimento mais barato desta spec.**
- **Do CD real (0b, o caro, e o único que permite prometer número):** amostragem **estratificada por
  altura de pessoa** (buckets 90–125, 125–175, 175–250, 250+ px) × câmera × turno (dia/noite muda
  tudo) × zona.
- **Ground truth:** por recorte, **três valores por peça** — `presente | ausente | não-avaliável`.
  O `não-avaliável` é **obrigatório**: sem ele o anotador chuta e a régua herda o chute.
- **Degradação sintética:** downsamplear recortes grandes simula distância sem re-anotar. **Não
  substitui** dado real (não reproduz borrão, compressão nem ruído de ISO alto) — vale como **limite
  superior otimista** e assim deve ser reportado.

### 5.3 Métricas e como reportar

- **precisão/recall/F1 da classe NÃO-CONFORME**, isolada (a classe CONFORME é majoritária e infla
  qualquer agregado);
- **`cobertura` sempre ao lado** — precisão sem cobertura é a Regra 11 esperando;
- **curva precisão × px da peça, INTEIRA**, por bucket, **sem procurar joelho** (Regra 10: pode não
  existir; o piso é escolha de produto, não constante da natureza);
- **toda proporção com `n` e Wilson 95%** — 13/13 **não** é 100%, é ≥77%. **Não reimplementar:**
  `wilson(k,n)` já existe em `eval/multi-antena.mjs:151` (o `wilsonInterval()` citado no CLAUDE.md
  saiu do main no ADR-016 e vive na tag `research-fusion-arc-2026-07-12`);
- **`agreementOnFailure`** ao lado de qualquer voto (Regra 13);
- **`n_eff` deduplicado ANTES de qualquer estatística** (Regra 8): observações em rodadas **puladas
  pelo gate** não são medições distintas. `n_eff ≤ rodadas ANALISADAS` vira **assert**, não
  comentário.

**Regra 9 aplicada:** a 1 fps sob gate, uma pessoa que cruza a zona em 4 s gera **≤4 observações**;
fora do bucket de tamanho, gera **zero**. O número que sai é do **instrumento**. **Declarar o ponto
cego:** a aderência medida vale para a subpopulação `H ≥ piso` **e** visada compatível — e essa
subpopulação **precisa ser reportada**.

### 5.4 Quantos frames anotados — e o custo humano

O binding é o **Wilson na classe minoritária** (não-conformidade é rara: 2–10%).

| Objetivo | Aritmética | Recortes |
|---|---|---|
| Precisão ±5 pp em torno de 90% | `n ≈ 4·0,9·0,1/0,05² ≈ 140` **positivos preditos** | — |
| Com prevalência de 5% | `140/0,05` | **~2.800** |
| Curva por bucket (4 buckets) | ~150–250 por bucket | **+600–1.000** |
| Fine-tune do classificador | backbone pré-treinado | **+1.500–3.000** (treino) |

**~2.500–4.000 recortes para MEDIR e ~2.000–3.000 para TREINAR.** A 15–25 s por recorte (o
julgamento "não-avaliável" é o mais lento) ⇒ **~25–45 h de anotação humana** para a régua, outro
tanto para o treino. **Trabalho humano pago, não escopo de agente.** Exige pessoa que conheça a
operação, ferramenta de anotação, e **acordo prévio sobre retenção dos frames** (§4.1 item 4).

**Obrigatório: 2º anotador em ~10% da amostra.** Se dois humanos discordam em 15% dos recortes,
**nenhum modelo pode ser reportado acima disso** — esse número é o teto real da feature.

### 5.5 Régua pinada a priori (proposta — o dono ajusta o alvo)

No espírito do CA-8 de `stationary.mjs` (critérios de **sucesso**, não baselines de falha):

1. `precisão(NÃO-CONFORME) ≥ 0,90` com **Wilson inferior ≥ 0,85**, por peça, no bucket `H ≥ piso`;
2. `cobertura ≥ 0,60` no bucket alvo — **e reportada, nunca omitida**;
3. **zero** alarme em recorte rotulado `não-avaliável` (o gate físico tem de morder);
4. `agreementOnFailure` medido e **publicado ao lado** de qualquer voto;
5. a **curva inteira** no relatório — não o ponto.

**⚠ Aviso da Regra 10:** *não há garantia de que 0,90 seja alcançável neste canal.* No arco BLE o
alvo de 95% era **inalcançável**, e isso só se soube medindo. Se a curva do S1 disser que o teto é
0,80, **o alvo de negócio tem de caber sob o teto medido** — ou a peça sai do escopo. **Este é o
ponto em que a spec pode se refutar, e isso é o aparato funcionando.**

---

## 6. O que esta spec exige do runtime (insumo para o `ADR-020`)

> **NÃO decide o runtime.** O eixo Node × sidecar Python é do `ADR-020-runtime-de-inferencia`.

**Os dois candidatos do §2.2 exigem pouco — e isso foi critério de escolha, não coincidência:**

- **(c)** um `.onnx` em `onnxruntime-node` **CPU EP** (DML dá saída errada, WebGPU crasha — medido,
  ADR-009, `worker.js:335`); entrada 128×256 com resize + normalize no `sharp` que já existe;
  pós-processamento **sigmoide + limiar** — sem NMS, sem decoder exótico, sem operador custom.
- **(a′)** exige **ainda menos**: é o **mesmo** `.onnx` D-FINE com mais classes, o **mesmo**
  `postprocess` de `worker.js`, o **mesmo** caminho de download/sha256. Zero código de inferência
  novo. (O que ela exige é caro em outro lugar: a pré-condição de não-regressão do §2.2.)

**Se o ADR-020 decidir "fica em Node", esta spec continua inteira.**

**Onde aperta (o insumo forte para o ADR-020) — e uma correção ao meu próprio palpite:**

- **Pose (b) NÃO é cara em FLOPs.** Eu supunha que fosse a mais cara; **os números publicados
  refutam**: RTMPose-**t** roda a **3,20 ms** e **-s** a **4,48 ms** por pessoa (ONNXRuntime, CPU,
  **1 thread**, 256×192), com artefatos de **12,0 MB** e **19,5 MB** — dentro do orçamento de bundle.
  **O custo da pose no nosso runtime é de REIMPLEMENTAÇÃO, não de FLOPs:** o caminho só-`.onnx` exige
  reescrever em JS o pré/pós (transformação afim bbox→input, decodificação SimCC/heatmap, argmax por
  keypoint) — exatamente a classe de bug que `worker-fadiga.js` já registrou em campo (*"RGB e/ou
  0..1 NÃO detectam — medido"*: um canal trocado custou uma sessão de depuração). A alternativa
  pronta (`rtmlib`, Apache-2.0, ORT puro sem mmcv) é **Python**. **Este é o eixo de capacidade real
  do ADR-020 — e é de engenharia, não de hardware.**
  ⚠ Antes de contar com RTMPose: `mmpose#2393` (Apache × GPL em `projects/rtmpose`) segue **sem
  resposta recuperada**, e os checkpoints `body7` misturam 7 datasets com termos de pesquisa.
- **Fine-tune** (obrigatório em qualquer abordagem) é Python **sempre** — mas **offline**, e o
  artefato é um `.onnx`. **Treino em Python NÃO é argumento para sidecar Python em produção**; a
  casa já provou o caminho (`08-finetune-colab-setup.md`: Colab T4 → `export_onnx.py` → drop em
  `server/models/`), sem nada de Python no hub.

**A frase para o ADR-020:** *se a decisão for "Node puro", a mão (pose) sai do roadmap de EPI por
custo de reimplementação, não por física; se for "sidecar Python", a mão volta a ser questão de
câmera e cadência — que continua sendo o limite dominante.* **O runtime não desbloqueia a mão; só
muda quem é o gargalo. Não vale decidir o ADR-020 por causa de EPI.**

### 6.1 Orçamento de CPU

O orçamento é **~1 câmera/core @1fps** (D-FINE-S). EPI adiciona custo **por PESSOA**, não por câmera
— o tipo mais difícil de dimensionar (doca com 8 pessoas custa 8× a de 1).

| Item | Estimativa | Status |
|---|---|---|
| **(a′) detector com classes de conformidade** | **0 ms incrementais** — mesmo passe | ✅ o único eixo em que (a′) ganha de lavada |
| (c) classificador 128×256/pessoa | ordem de **3–10 ms** (FaceMesh 256×256 mede 7,4 ms) | **INFERÊNCIA, não medição** — a frente de custo por etapa tem de medir |
| (c) câmera @1fps, 3 pessoas | ~10–30 ms/rodada = **1–3% de um core** | idem |
| (b) pose RTMPose-t/s por pessoa | **3,20 / 4,48 ms** (ORT CPU **1 thread**, 256×192) | ✅ publicado — mas fora de escopo por §2.2 |

**Mitigações de graça:** o **gate de movimento** (que a fadiga não usa, §3.3); avaliar **só tracks em
zona com EPI**; **1× a cada N rodadas por track** (capacete não muda em 1 s, e o voto já quer
observações espaçadas); e o **gate físico** (`H < piso` ⇒ nem roda), que em câmera de área descarta
a maioria dos tracks antes de qualquer inferência.

**Teto declarado:** se EPI custar mais que **~15% do orçamento de uma câmera**, a feature precisa de
câmera dedicada — para onde luva e óculos já foram por física.

---

## 7. Critérios de aceite (Given/When/Then, com sensor nomeado)

> Escopo: **capacete e colete**, abordagem (c), N1 (Onda 2); N2 só com aval explícito (§4.3).

**CA-1 — o gate físico morde antes do modelo.** *Given* zona com `epiRequerido:["capacete"]` e pessoa
com altura de bbox `< piso_capacete`, *When* a rodada processa o track, *Then* o resultado é
`INDETERMINADO`, **nenhuma inferência de EPI roda** e nenhum alarme é gerado.
→ `eval/epi.mjs` ("pessoa distante") + `epi-state.test.js`.

**CA-2 — a banda de abstenção é respeitada.** *Given* confiança entre `τ_baixo` e `τ_alto`, *When* o
estado por track atualiza, *Then* o estado é `INDETERMINADO` — **nunca** `NÃO-CONFORME`.
→ `epi-state.test.js` (limiares de painel único, como `precision.js`).

**CA-3 — um evento por violação, com histerese.** *Given* pessoa `NÃO-CONFORME` na zona por
`≥ epiAlertMs`, *When* permanece, *Then* **exatamente um** `alarm-event` `tipo:"epi"`; *and* só
rearma após `offDelayMs(epiAlertMs)=max(5000, epiAlertMs/2)` de ausência.
→ `epi-alert.test.js`, espelhando `presence-alert.test.js`.

**CA-4 — rodada pulada não zera o dwell nem infla `n_eff`.** *Given* o gate pulando rodadas, *When* o
dwell corre, *Then* ele **não** reinicia (paridade com `presence-alert.test.js:41-59`) *and*
`n_eff ≤ rodadas analisadas` vira **assert** (Regra 8).
→ `eval/epi.mjs` sob `motion.gateDecision` real (padrão de `stationary.mjs`).

**CA-5 — nenhum dígito, nenhuma acusação, sobre a imagem.** *Given* track `NÃO-CONFORME`, *When* o
overlay desenha, *Then* nenhum número na caixa *and* `INDETERMINADO` em tom **neutro**.
→ `src/camera/drawTracks.test.ts` + caso novo para o tom.

**CA-6 — nenhuma imagem persistida (ADR-002).** *Given* um evento, *When* persistido e notificado,
*Then* só metadados; nenhum buffer de frame/recorte sai do worker.
→ teste de exatidão de chaves do payload (padrão `fadiga-host.test.js:84-88`) + revisão de diff.

**CA-7 — aderência nunca sem cobertura, `n` e Wilson.** *Given* o painel de EPI, *When* exibe
aderência, *Then* exibe na mesma tela cobertura, `n` e Wilson 95%.
→ teste de componente + `eval/epi.mjs` (o relatório falha se um dos quatro faltar).

**CA-8 — o tipo novo respeita turno e `arming`.** *Given* zona `arming:"dentro-turnos"` e
não-conformidade **fora** do turno, *When* o alarme sairia, *Then* é suprimido pelo `shiftGate`.
→ `server/alarm/shift.test.js` (caso novo — hoje `shift.js:106` deixaria `"epi"` passar).

**CA-10 — (a′) não regride a detecção de pessoa (pré-condição dura).** *Given* um D-FINE fine-tunado
com classes de conformidade, *When* avaliado antes de qualquer adoção, *Then* `eval/gate.mjs`
(`f1_all@0.35`, `recall_all@0.25`, `precision_all@0.35`, `fp_empties@0.50`) e `eval/persons-cftv.mjs`
passam **sem regressão** contra o D-FINE-S atual. *Else* a abordagem (a′) é **reprovada**, por melhor
que seja o número de EPI.
→ sensores **já existentes**, sem código novo.

**CA-9 — a curva, não o ponto.** *Given* o relatório do `eval/epi-size.mjs`, *When* publicado,
*Then* traz a curva precisão × tamanho **inteira**, com `n`/Wilson por bucket e `agreementOnFailure`.
→ `eval/epi-size.mjs` contra `thresholds-epi.json`.

---

## 8. Fora de escopo (DECIDIDO, não esquecido)

| Item | Por quê | Reabre quando |
|---|---|---|
| **Luva** | oclusão + borrão + 1 fps (§1.5/§1.6) — não é problema de modelo | câmera dedicada de passagem, ≥10 fps, visada frontal |
| **Óculos** | 4 cm de lado menor ⇒ 438 px = densidade *Identification* do DORI; frontal-only | nunca, sem decidir §4.3 (a câmera que vê óculos vê rosto) |
| **Auricular** | plugue não tem assinatura visual; concha exige perfil | não previsto |
| **Botina** | tamanho OK, oclusão domina | se o cliente pedir e aceitar cobertura baixa declarada |
| **Pose estimation** | **não por custo de FLOPs** (RTMPose-t = 3,2 ms/pessoa) — cabeça e tronco já saem do bbox; o único ganho real é o **punho**, fora por física | se a mão entrar no escopo **e** o ADR-020 resolver o pré/pós em JS ou Python |
| **Qualquer modelo/dataset AGPL-3.0 ou não-comercial** | Ultralytics (código, pesos **e** o dataset Construction-PPE) · SH17 CC BY-NC-SA · OpenPose | licença enterprise paga — decisão comercial, não técnica |
| **EPI como classe no passe squashed do D-FINE** | **refutado pela aritmética** (§1.4): capacete exigiria pessoa de 363 px | nunca — é aritmética, não opinião |
| **Evidência visual (print)** | viola ADR-002 (§4.1) | **ADR novo** + parecer jurídico |
| **Vínculo pessoa↔identidade (N3)** | viola posicionamento + ADR-015 §4 | dono + jurídico + sindicato |
| **`modo:"epi"` nas Ondas 1–2** | 14 sites + 4 `Record` exaustivos + 3 suítes (§3.1) | Onda 3, se a régua aprovar |
| **Campo `meta` estruturado no alarme** | contrato em 6 arquivos + schema | quando o `text` livre provar insuficiente em operação |
| **GPU / DML / WebGPU** | reprovados e medidos (ADR-009) | novo spike com paridade verde |
| **Decidir o runtime** | é do `ADR-020` (§6) | — |
| **Empilhadeira / EPI de máquina** | outro problema (`PLANO-MVP.md:199`) | — |

---

## 9. Trade-offs declarados

1. **Abstenção × cobertura.** Cada mecanismo do §2.3 que evita alarme-lixo **reduz cobertura**. Não
   há config que maximize os dois. **O piso se escolhe pelo alvo de negócio, e o alvo tem de caber
   sob o teto medido** (Regra 10). Esta spec **não** escolhe o piso — propõe medir a curva.
2. **Região × corpo inteiro.** Região é mais barata e evita atalho de contexto; corpo inteiro é mais
   robusto a bbox ruim. **Escolho região**, aceitando sensibilidade a bbox — e o S1 mede isso.
3. **1 fps × custo.** Preserva o orçamento e basta para capacete/colete (quase estacionários);
   insuficiente para a mão — uma das razões de a mão estar fora.
4. **Reusar `presence-alert.js` × módulo irmão.** Generalizar arrisca regressão numa máquina de
   estado testada e em produção; o irmão duplica ~40 linhas. **Escolho o irmão** (`epi-alert.js`)
   reusando os **puros** — a mesma decisão que a casa tomou entre `worker.js` e `worker-fadiga.js`.
5. **Sem imagem, o loop de melhoria é mais lento** — a única correção é nova campanha de anotação.
   **Custo recorrente, declarado.**
6. **N1 × N2.** N1 preserva o posicionamento e entrega menos valor percebido; N2 entrega o que o dono
   pediu e custa a reescrita de 6 documentos e um parecer.

---

## 10. Riscos residuais

| Risco | Sev. | Mitigação / status |
|---|---|---|
| A premissa de 20/10 px (§1.3) está errada e o escopo real é menor | **alta** | é o 1º entregável do §5 (S1). **Toda a §1 depende dela** |
| O alvo de 0,90 não é alcançável (como o 95% do arco BLE) | alta | Regra 10; a curva do S1 decide; **a spec pode se refutar** |
| Erro correlacionado por sujeito degrada o voto | média-alta | `agreementOnFailure`; o corolário de 2026-07-12 diz que **separar no tempo não conserta** |
| Cobertura baixa vira "0 não-conformidades" ⇒ falso conforto **ou** responsabilidade legal | **alta** | CA-7 + §4.4 item 3 |
| Instalação em sub-stream (§1.7) ⇒ a feature nasce cega e o sintoma é "100% de aderência" | **alta** | requisito ≥1920 por câmera com EPI; item p/ a frente de manual/instalação |
| Custo por pessoa estoura o orçamento de CPU | média | §6.1 — medir antes; teto de 15% declarado |
| `tipo:"epi"` alarma 24/7 por `shift.js:106` | média | CA-8; Onda 2 |
| Visitantes/terceiros (maior risco) são os menos medíveis | média | declarar no relatório; **Regra 11** |
| Dado público mede canteiro de obra, não CD | **alta** | §5.2: público só para a curva; número operacional exige dado do site |
| Concordância entre anotadores baixa = teto invisível | média | §5.4: 2º anotador em 10%, obrigatório |
| **(a′) acopla EPI ao detector de produção**: dúvida de conformidade divide a confiança e derruba a pessoa abaixo do `highScore` 0,35 ⇒ **some da contagem** | **alta** | CA-10 (pré-condição dura em sensores que já existem). Se reprovar, cai para (c) |
| Minha ordenação geométrica "colete é o mais fácil" pode estar errada — o único número público (SH17) põe colete em **4º**, abaixo de capacete e óculos | média | hipótese explícita do S1 (§2.4) |
| Licença de dataset/pesos contamina o produto (SH17 CC BY-NC-SA · Ultralytics AGPL, inclusive no dataset) | **alta** | §2.4: só CC0/CC BY 4.0; registrar URL + data; revisão jurídica dos dados de treino (já prevista em `05-*` §4) |

---

## 11. Perguntas ao dono (o que a engenharia não decide)

1. **N1, N2 ou N3 (§4.3)?** Decide se os 6 documentos de posicionamento são reescritos **no mesmo PR**.
2. **Evidência visual (§4.1):** aceitável como *indicador de aderência* sem print? Ou o caso de uso
   exige prova — e portanto ADR novo reabrindo o ADR-002?
3. **Vale ~25–45 h de anotação humana (§5.4)** só para saber se funciona, antes de qualquer promessa
   ao cliente?
4. **Qual o alvo de negócio de precisão** — e ele cabe sob um teto que ainda não conhecemos?
5. **Existe ponto de passagem obrigatório** (porta, catraca, corredor de entrada) para uma câmera
   dedicada? Se existir, luva volta a ser discutível — **e é o mesmo "portal" que o ADR-015 já pediu
   por outro motivo: um item de instalação, dois problemas.**
6. **Aceita-se arriscar o detector de pessoa em produção** para ganhar EPI de graça (a′), sabendo que
   contagem/ocupação/tripwire/alarme de presença pendem dele? A pré-condição (CA-10) protege — mas
   a decisão de sequer tentar é de apetite a risco, não de engenharia.
7. **Capacete/colete são obrigatórios em zonas fixas do CD, ou a regra varia por função?** Se variar
   por função, a feature precisa de identidade (N3) para ser correta — e isso muda tudo.
