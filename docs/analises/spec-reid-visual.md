# Spec — ReID visual (re-identificação por aparência): auditoria, mercado e plano de medição

> Doc de auditoria + pesquisa (read-only, sem código). Deriva do ADR-015 (ReID como pilar de
> identidade) e da task #43. Regra-mãe da casa: **sem evidência, não há pronto** — este doc NÃO
> promete que ReID resolve; propõe **como MEDIR se resolve** no nosso cenário (uniforme, edge,
> D-FINE já ocupando CPU). Toda proporção sai com n + Wilson quando virar número medido.

## Por que ReID entra na conversa (o que o rádio não paga)

A fusão por tag BLE falha para pessoa **parada** — 94,6% do silêncio medido (laudo 2026-07-13).
Distância absoluta e 2ª antena foram **refutadas** para esse caso. O ADR-015 concluiu: a identidade
é estabelecida 2-4× por turno (caminhada longa de entrada) e precisa ser **mantida por horas** —
uma pergunta que rádio (âncora de baixa vazão) e track visual (geometria frágil) não respondem.
ReID é identidade por **aparência** (embedding visual): não depende de movimento nem de rádio, e
**sobrevive à morte do track**. Esta spec audita o que temos e mede se ele aguenta o nosso caso.

---

## PARTE 1 — o que o código JÁ TEM (auditoria read-only)

### 1.1 Tracker: só geometria, zero aparência
`src/vision/bytetrack.ts` e o par de hub `server/analysis/bytetrack.js` são ByteTrack-lite: id
mantido por **IoU + predição linear de movimento**, com 2º estágio de re-associação por
**distância do centro** (`reassocDist`) e guarda de nascimento por **IoU/tamanho**. Nenhum sinal
de aparência entra. Os dois arquivos declaram a lacuna no cabeçalho:
> "LIMITAÇÃO DECLARADA (sem re-ID por aparência): em cruzamento denso, ids podem trocar de pessoa —
> o tracker segue GEOMETRIA (IoU), não aparência." (`bytetrack.ts:60-63`)

O que existiria de plugar: promover ByteTrack→**BoT-SORT/DeepSORT** (associação IoU **+** cosine de
embedding). É extensão conhecida, não reescrita.

### 1.2 Motor do hub: D-FINE é detector puro
`server/analysis/worker.js` roda D-FINE-S ONNX na CPU EP e emite só `{class, score, bbox}`
(`postprocess`, `worker.js:130-158`); o contrato IPC (`worker.js:19-30`) não tem embedding. **O
D-FINE NÃO dá features reutilizáveis** — o head é de detecção (`logits`+`pred_boxes`). ReID exige um
**segundo modelo** (ex.: OSNet) rodando por crop de pessoa. Não há atalho "aproveitar a feature do
detector".

### 1.3 Persistência de rótulo: saiu do main
`label-memory` foi **removido do main na faxina ADR-016** (`ADR-016:14`) — vive só na tag
`research-fusion-arc-2026-07-12`. O desenho (máquina candidata→confirmada→memória, timeout ~12s,
sentinela dupla de id-switch) está em `docs/cientifica/escopo-persistencia-rotulo.md`. **Não existe
galeria id→embedding no produto vivo.** Precisaria nascer: (a) extrator de embedding por crop,
(b) galeria efêmera id→embedding médio (escopo de turno, LGPD abaixo), (c) matching por cosine.

### 1.4 Onde plugaria: crop já é primitiva resolvida
- **Hub:** `sharp` já recorta região — `worker.js:219-261` (`detectTiled`) usa
  `.extract({left,top,width,height})` por tile. Crop-por-pessoa é o mesmo mecanismo; o embedding
  seria calculado no worker, ao lado da detecção, reusando o JPEG já decodificado.
- **Cliente:** `src/processors/leitura.ts` recorta ROI via canvas; `src/objects/detector.ts` roda
  OWL-ViT via `@huggingface/transformers`. Há precedente de 2º modelo no cliente.
- **Infra de inferência já instalada:** `@huggingface/transformers ~3.7.6` (cliente),
  `onnxruntime-node ^1.27.0` + `sharp ^0.35.3` (hub). Rodar um OSNet ONNX é drop-in de infra —
  **o custo é CPU, não integração** (ADR-015 item 5: "a única peça que NÃO é grátis").

### 1.5 LGPD — invariante travada (ADR-015 item 4)
Embedding de aparência é **adjacente a biométrico**. Portanto, por desenho e não por remendo:
efêmero em memória (escopo de turno), **nunca persistido**, **sem galeria entre dias**, nunca sai do
hub, nunca entra em log. Consequência de projeto: ReID **não reidentifica quem sai e volta** — toda
reentrada exige re-ancoragem pelo portal. Isto é requisito, não efeito colateral.

---

## PARTE 2 — o mercado + o risco do uniforme (com número e fonte)

### 2.1 Modelos e o número de vitrine
| Modelo | Market-1501 rank-1 | mAP | Nota |
|---|---|---|---|
| OSNet (omni-scale, leve) | 94,8% | 84,9% | baseline edge-friendly, ~2,2M params |
| FastReID (toolbox JDAI) | 96,3% | 90,3% | SOTA de toolbox de produção |
| TransReID (ViT) | ~95% (Market) / +5,5% mAP em MSMT17 | — | pesado, transformer |

Market-1501 é o benchmark canônico (Zheng et al., ICCV 2015). **OSNet é o candidato natural para
edge**: menor nº de params, projetado para ReID. Ressalva de custo (ver 2.3).

### 2.2 O RISCO DO UNIFORME — o número que mata a vitrine
**O rank-1 de 94-96% é medido onde a ROUPA VARIA entre identidades e é a pista dominante.** Operador
de CD com uniforme **remove exatamente essa pista** — todos vestem igual, a cor/textura deixa de
discriminar. O análogo direto na literatura é o **cloth-changing ReID** (mesma pessoa, roupa
diferente): tira-se a pista de roupa e mede-se o que sobra (corpo, altura, marcha, cabelo). Os
números do colapso:

- **PRCC** — same-clothes rank-1 **99,9%** → cross-clothes (sem pista de roupa) **70,4%** no MELHOR
  método recente; queda de ~29,5 p.p. Métodos mais antigos: **88,2% → 35,2%** rank-1.
- **LTCC** — setting geral rank-1 **75,3%** → cloth-changing **42,9%**.

**Leitura para o nosso caso:** uniforme ≈ o piso do cross-clothes. A expectativa honesta **não** é
94%; é a **faixa 35-70% de rank-1**, dependendo de quanto sinal residual (silhueta, altura, marcha)
o modelo captura e da resolução do crop. Isto é hipótese a **medir no nosso vídeo**, não a assumir.

### 2.3 Custo em edge (o D-FINE já ocupa a CPU)
- OSNet no Google Coral TPU: **~49-58 ms por inferência** — mais lento que MobileNetV2 (26-32 ms) e
  ResNet-18 (40-50 ms), apesar do baixo nº de params (estrutura densa em operações). No **nosso hub
  é CPU EP** (sem TPU), rodando D-FINE-S por câmera — o embedding é **N× por rodada** (N = pessoas em
  quadro), somado ao detector. É a peça que custa CPU (ADR-015 item 5).
- **INT8:** ~4× redução de tamanho/memória, mas **1-5% de degradação de acurácia sem calibração
  cuidadosa** — e essa degradação incide sobre um rank-1 que o uniforme já derrubou (o erro compõe).

### 2.4 Gap benchmark → CFTV real
Além do uniforme, há o **domain gap**: modelos treinados num benchmark caem forte em domínio não
visto (viewpoint, iluminação, resolução, oclusão, pose). A literatura de domain-generalization
documenta quedas grandes de rank-1 cross-dataset. **O número de produção do nosso ângulo de CD é
desconhecido e só a medição no nosso vídeo o revela** — nunca o rank-1 do paper.

### 2.5 Riscos consolidados
1. **Uniforme derruba a pista dominante** → rank-1 esperado 35-70%, não 94%.
2. **Custo CPU N× por rodada** sobre um hub que já roda D-FINE-S.
3. **Id-switch envenena duas vezes** (exibe errado + rouba a âncora certa) — herança do
   `escopo-persistencia-rotulo.md` (sentinela dupla obrigatória).
4. **Domain gap** de ângulo/resolução do CD.
5. **LGPD**: embedding é adjacente a biométrico — disciplina efêmera é invariante, não opção.

---

## PARTE 3 — o plano honesto (fases com gate de medição a priori)

Doutrina da casa: **a casa não constrói ML sem eval** (CLAUDE.md §6). Nenhuma fase de produção
começa antes do gate da fase anterior passar. O molde existe: `eval/gate.mjs`, `eval/counting.mjs`,
`eval/stationary.mjs`.

### Fase 0 — o eval que decide se vale construir (SÓ medição, zero produção)
- **Dataset de validação:** (a) a **caminhada anotada #4** gravada no corredor de entrada
  (`protocolo-teste-campo-indoor.md`) — **com operadores de uniforme real**, que é o teste-que-mata;
  (b) reforço público de cloth-changing (**PRCC/LTCC**) como piso de referência da literatura, já que
  MOT20 está bloqueado no ambiente e não tem o eixo de roupa
  (`docs/analises/reconhecimento-pessoas/01-plano-eval-cftv-mot20.md`).
- **Harness:** `eval/reid.mjs` (novo, plugável ao molde do `gate.mjs`): crop D-FINE → OSNet ONNX →
  embedding → galeria por identidade → matching cosine. Reusa `worker.js`/`sharp` (paridade de
  produção).
- **A MÉTRICA-QUE-MATA:** **rank-1 sob uniforme** na caminhada anotada — não o rank-1 limpo. Reportar
  com **n + Wilson 95%** (13/13 ≠ 100%). Reportar também **rank-1 mesma-roupa vs uniforme** na MESMA
  gravação (Regra 11: medir o delta que o mecanismo compra, isolado — não o agregado inflado por
  casos fáceis).
- **Custo medido junto:** ms de embedding por pessoa por rodada na CPU do hub, FP32 e INT8, com o
  D-FINE-S rodando em paralelo (a conta de CPU real, não a do paper).

### PONTO DE NÃO-IR (gate a priori, escrito ANTES de medir)
- **Piso da métrica-que-mata:** se o **rank-1 sob uniforme < ~50%** na caminhada anotada (faixa
  inferior do cross-clothes da literatura), **ReID de aparência NÃO resolve** o nosso caso — o
  uniforme matou a pista que carrega o benchmark, e o caminho é outro (marcha/silhueta,
  cloth-agnostic ReID, portal por crachá do ADR-015, ou aceitar identidade só no portal).
- **Piso de custo:** se o embedding N× estourar o orçamento de CPU do hub (empurra o fps do D-FINE
  abaixo do gate de contagem), ReID não roda como default — no máximo sob amostragem/rodada rara.
- **O piso é ESCOLHA DE PRODUTO** (Regra 10), mas tem de caber sob o teto medido. O alvo de rank-1
  se fixa pela métrica-de-negócio (âncora confiável por entrada, ADR-015 item 6), não por constante
  da natureza.

### Fase 1 — SÓ SE a Fase 0 passar: manutenção de identidade intra-turno
BoT-SORT-lite (IoU + cosine) no tracker + galeria efêmera id→embedding médio (escopo de turno,
LGPD). Gate: erro-segundos ≤ baseline sem ReID + as **duas sentinelas de id-switch**
(confirmação e memória) do `escopo-persistencia-rotulo.md`.

### Fase 2 — SÓ SE Fase 1 passar: fusão âncora-portal + ReID
ReID carrega a identidade entre as 2-4 ancoragens de rádio/crachá por turno (ADR-015 itens 2-3).
Gate: precisão do delta que o ReID compra, isolada (Regra 11), com n + Wilson.

### O que NÃO se promete
Que ReID resolve o silêncio da pessoa parada. Promete-se **medir**, na Fase 0, se ele resolve sob
uniforme, edge e D-FINE — e ter um **ponto de não-ir escrito antes do número**, para o resultado não
ser interpretado depois do fato.

---

## Fontes (URLs)

- OSNet (Market-1501 94,8% rank-1): https://arxiv.org/abs/1905.00953 · https://www.emergentmind.com/papers/1905.00953
- FastReID (96,3% rank-1): https://arxiv.org/abs/2006.02631 · https://github.com/JDAI-CV/fast-reid
- TransReID (ViT): https://openaccess.thecvf.com/content/ICCV2021/papers/He_TransReID_Transformer-Based_Object_Re-Identification_ICCV_2021_paper.pdf · https://arxiv.org/abs/2102.04378
- Cloth-changing PRCC 99,9%→70,4% / LTCC 75,3%→42,9% (DIFFER): https://arxiv.org/html/2503.22912
- MPN-tuple PRCC 88,2%→35,2%: https://arxiv.org/pdf/2006.04991
- Cloth-changing survey/skeleton (roupa não é pista confiável): https://arxiv.org/abs/2503.10759
- Feature decorrelation cloth-changing: https://arxiv.org/html/2410.05536v2
- Edge ReID Coral (OSNet 49-58 ms; human parsing): https://arxiv.org/pdf/2209.11024
- Domain-generalization ReID (gap benchmark→real): https://arxiv.org/html/2506.12413v1 · https://www.sciencedirect.com/science/article/abs/pii/S0031320323003709
- ReID 2025 (o que funciona, supervised vs self-supervised): https://arxiv.org/html/2601.20598v1
