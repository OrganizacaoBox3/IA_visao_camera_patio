# Fine-tune de pessoa no Colab (frente B) — setup + notebook

> Executa o `05-plano-finetune-vigilancia.md` na GPU grátis do Colab (T4 16GB — a MX450 local não treina).
> Caminho escolhido: **repo raw D-FINE** (`Peterande/D-FINE`, Apache-2.0) — o `export_onnx.py` gera ONNX no
> MESMO shape que `worker.js` já consome (logits+pred_boxes) = **drop-in** (o HF+Optimum é mais fácil mas
> pode mudar o shape → quebra o `postprocess`; T4 do 05-* exige paridade). Meta medida: recall em crowd >
> S@896, no `eval/persons-cftv.mjs`.

## Passo 0 — conta + ambiente (VOCÊ)
1. **Conta Google grátis**: use uma existente ou crie em accounts.google.com (uma dedicada ao projeto é
   mais limpa). Sem cartão.
2. Abra **colab.research.google.com** → `Novo notebook`.
3. **Ligue a GPU**: menu `Ambiente de execução` → `Alterar o tipo de ambiente` → **T4 GPU** → Salvar.
4. Confirme: rode numa célula `!nvidia-smi` → tem que aparecer **Tesla T4 (15GB)**.

> Limites do Colab FREE: sessão ~12h, desconecta se ocioso, T4 compartilhada. Serve pra um fine-tune
> MODESTO/protótipo. Se o treino sério pedir mais, Colab Pro (~US$10/mês) ou cloud alugada — decidimos
> pelo resultado da 1ª rodada.

## Passo 1 — ambiente D-FINE (célula a célula)
```python
# 1. GPU
!nvidia-smi
# 2. repo D-FINE (Apache-2.0)
!git clone https://github.com/Peterande/D-FINE.git
%cd D-FINE
!pip install -r requirements.txt
# 3. checkpoint base p/ FINE-TUNE (S obj2coco — mesma família do nosso dfine_s_obj2coco.onnx)
#    (a URL do .pth do release oficial entra aqui — confirmo no passo)
```

## Passo 2 — dataset person-only em COCO (o que ensina vigilância)
- **MOT20** (temos local, 4 seq): converter `gt.txt` → COCO annotations, classe única `person`. Script de
  conversão eu preparo (MOT→COCO é determinístico).
- **CrowdHuman** (~15k imgs, licença de pesquisa): baixar no Colab (Drive ou link) → COCO person.
- **Split honesto**: treina em MOT20-01/02/05 + CrowdHuman; **avalia held-out MOT20-03** (nunca medir no
  que treinou).
- Levar ~20GB ao Colab: montar Google Drive OU baixar direto no notebook (CrowdHuman tem links públicos).

## Passo 3 — fine-tune (person-only, 1 classe)
```bash
CUDA_VISIBLE_DEVICES=0 torchrun --nproc_per_node=1 train.py \
  -c configs/dfine/custom/dfine_hgnetv2_s_person.yml --seed=0 -t dfine_s_obj365.pth
```
(config `*_person.yml` = cópia do custom com `num_classes=1` + paths do nosso COCO — eu monto.)

## Passo 4 — export ONNX + PARIDADE (o gate)
```bash
python tools/deployment/export_onnx.py --check -c configs/dfine/custom/dfine_hgnetv2_s_person.yml -r best.pth
```
- Baixa o `.onnx` → dropa em `server/models/` → aponta `ANALYSIS_MODEL_PATH`.
- **Antes de confiar:** validar na inferência REAL do `worker.js` (shape/saída) e medir no
  `eval/persons-cftv.mjs` (held-out MOT20-03 + full-set) **vs S@896**. Só é "pronto" com o número.

## Sequência prática
Passo 0 (você agora) → me diz que a T4 respondeu → eu entrego o notebook completo (converter MOT→COCO +
config person + treino + export) célula a célula, e a gente roda por partes (o Colab desconecta; treino
em checkpoints). O veredito sai no NOSSO eval, não no do Colab.
