# Plano (endgame) — fine-tune de detector de PESSOA em domínio de vigilância

> O muro medido (`04-*`): o D-FINE COCO genérico **satura em 26-65% de recall** em multidão — nenhum knob
> (input/modelo/tiling) fecha. O único caminho de **superar a Intelbras** (que usa detector de vigilância
> dedicado) é **especializar o detector no domínio**: fine-tune num modelo person-only treinado em CFTV.
> O servidor roda o que o SoC da câmera dela não roda — é a nossa vantagem estrutural. Spec→plan→tasks.

## 1. Objetivo e critério de sucesso (MEDIDO)
- **Recall de pessoa em CENA DENSA maior que o S@896** (o melhor config-only: ~30-65% conforme densidade),
  precisão mantida, medido no MESMO sensor (`eval/persons-cftv.mjs`, MOT20 GT). Alvo: **fechar boa parte do
  gap** (ex.: crowd realista de CD ~50/fr: 65% → 80%+).
- **Roda em CPU EP** (produção; DML/WebGPU reprovados) OU justifica GPU com spike de paridade.
- **Licença limpa** (critério eliminatório, lição 03.3): base Apache/MIT (D-FINE é Apache; dados com licença de uso).

## 2. Dados (o que ensina "pessoa em vigilância")
- **MOT20 train** (temos, 4 seq, ~1,1M caixas) — multidão, ângulo de vigilância. **CrowdHuman** (~15k imgs,
  ~470k pessoas, oclusão densa, licença de pesquisa — confirmar uso) — o padrão de detecção de pessoa densa.
- **Eventualmente frames rotulados do CD** (o ângulo/luz reais) — o que de fato adapta ao alvo final. Sem
  câmera agora → começa com MOT20+CrowdHuman (proxy de vigilância) e adiciona CD depois.
- **Split honesto:** treinar em MOT20-01/02/05 + CrowdHuman; **avaliar em MOT20-03** (held-out) — nunca medir
  no que treinou (senão o número mente, lição 02.3).

## 3. Abordagem
1. Base **D-FINE** (mesma família → drop-in ONNX no worker, zero mudança de contrato) — ou variante
   person-focused. Fine-tune **person-only** (1 classe) no dataset de vigilância.
2. Treino em **GPU** (fine-tune de DETR-like exige GPU; local se houver, senão cloud efêmera barata).
3. **Export ONNX** (mesmo shape de saída que o worker.js já consome: logits+pred_boxes) → drop no
   `server/models/`, aponta `ANALYSIS_MODEL_PATH`.
4. **Medir no eval** contra o baseline S@896 (held-out MOT20-03 + o full-set) → veredito Δrecall × custo.
5. Se ganhar E rodar em CPU EP dentro do orçamento → candidato a novo default (com o recalc de capacidade).

## 4. Riscos e mitigações
- **GPU/infra de treino** (não temos localmente confirmado). → Cloud efêmera (custo declarado) ou GPU local;
  decidir antes de começar. É o maior pré-requisito.
- **Overfit ao MOT20** (poucas cenas). → CrowdHuman dá variedade; held-out MOT20-03; e o CD real depois.
- **Export ONNX + paridade CPU EP** (a família já roda em CPU EP no worker — risco baixo, mas validar o
  .onnx fine-tunado na MESMA inferência do worker antes de confiar).
- **Licença dos dados** (CrowdHuman/MOT20 são de PESQUISA) — uso comercial no CD precisa de revisão jurídica
  (mesma coleira da política de IA). Fine-tune p/ produto pode exigir dados próprios (frames do CD).
- **Tempo/esforço** — é um projeto, não um knob. Entregável só "pronto" com o número no eval (sem evidência,
  não há pronto).

## 5. Tarefas
- **[S] T1** Decidir a infra de treino (GPU local × cloud efêmera) + orçamento — pré-requisito.
- **[S] T2** Montar o dataset person-only (MOT20 train + CrowdHuman) no formato do framework de treino;
  split treino/held-out declarado.
- **[S] T3** Pipeline de fine-tune do D-FINE person-only (repo oficial / framework); treinar.
- **[S] T4** Export ONNX (shape compatível com worker.js) + validar paridade na inferência do worker.
- **[S] T5** Rodar `eval/persons-cftv.mjs` (held-out + full-set) contra S@896; veredito Δrecall × custo × CPU/GPU.
- **[P] T6** Se ganhar: recalcular capacidade + decidir default/adaptivo; se rodar só em GPU, spike de paridade CUDA.

## 6. Pré-requisito bloqueante (a decidir antes de T2)
**Infra de treino (GPU).** Fine-tune não roda em CPU em tempo hábil. Precisamos de: GPU local (qual?) OU
aprovação de uma instância cloud com GPU (custo declarado, dados de pesquisa — sem PII/segredo, ok pela
política). Sem isso, T1 trava — como o MOT20 travou no motchallenge. Decidir a infra é o passo 1 real.
