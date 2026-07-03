# Benchmark — modelos alternativos de detecção (para testes futuros)

> Pesquisa online (jul/2026, 4 frentes paralelas) de alternativas ao **D-FINE-N** (motor atual,
> ADR-009). Objetivo: ter um leque avaliado para testes futuros — **não** é troca imediata.
> **Critério ELIMINATÓRIO:** licença que permita REVENDA/uso comercial fechado — **Apache-2.0/MIT
> em CÓDIGO, PESOS e DATASET de treino** (dataset non-commercial contamina os pesos → fora).
> Régua de teste: qualquer ONNX candidato passa pelo harness `eval/` (COCO ground truth) +
> medição de CPU no onnxruntime-node antes de qualquer decisão. Âncora: D-FINE-N ~132ms/frame
> (medido) na máquina de dev; ~0,2 core/câmera @1fps.

## Contexto do gargalo (medido, não suposto)
Recall em pedestre médio/pequeno 8–40% (harness COCO + campo Gorizia); contagem real de linha
deu **0%** porque o recall intermitente quebra a continuidade dos tracks (não é bug do counter).
Pessoa <25px é limite de amostragem a 640 — **nenhum** modelo desta lista resolve a 640.

## 1. Família DETR real-time (upgrade do mesmo pipeline)

| Modelo | Licença cód/pesos | AP | AP-small | GFLOPs | CPU est. | ONNX pronto | Nota |
|---|---|---|---|---|---|---|---|
| D-FINE-N (atual) | Apache/Apache | 42.8 | n/p | 7 | 132ms (medido) | ✅ onnx-community | baseline |
| **D-FINE-S obj2coco** ⭐ | Apache/**Apache (verif. 2×)** | **50.7** | **32.7** | 25 | ~475ms | ✅ dfine_s_obj2coco-ONNX | **melhor AP-small/GFLOP; drop-in absoluto** |
| **D-FINE-M obj2coco** | Apache/Apache | **55.1** | **37.9** | 57 | ~1,07s | ✅ dfine_m_obj2coco-ONNX | teto de robustez; só em máquina de hub forte |
| DEIMv2-N | Apache/sem-tag-HF | 43.0 | n/p | 6.9 | ~130ms | ❌ export manual | +0,2 AP custo-neutro; ramo a observar |
| RF-DETR-S/M | Apache (N–L) | 53.0/54.7 | 32.0/36.1 | 60/79 | ~1,1–1,5s | ⚠️ .export() | backbone ViT hostil a CPU; só com GPU |
| RT-DETRv2-S | Apache/Apache | 48.1 | n/p | 60 | ~1,13s | ✅ | dominado pelo D-FINE-S |
| **Eliminados (pesos):** RF-DETR XL/2XL (PML revogável), DEIMv2-L/X + RT-DETRv4 (backbone DINOv3 = licença Meta restritiva), RT-DETRv3 (Paddle-only, repo morto). |

## 2. CNNs/YOLO permissivos (CPU-friendly)
Evidência oficial de que **CNN > DETR em CPU**: [D-FINE issue #301] mede D-FINE-N 77ms vs YOLOv8n 29ms na mesma CPU.

| Modelo | Licença cód/pesos | AP | GFLOPs | ONNX/pós-proc | Nota |
|---|---|---|---|---|---|
| **RTMDet-tiny/s** ⭐ | Apache (mmdetection; **NÃO usar mmyolo=GPL**) | 41.1/44.6 | 8.1/14.8 | mmdeploy, NMS no grafo | melhor mAP/FLOP; conv pura (ORT otimiza) |
| **PP-YOLOE+_s** ⭐ | Apache (PaddleDetection) | 43.7 | 17.4 | paddle2onnx | **pré-treino Objects365 → melhor pessoa out-of-the-box** |
| YOLOX-s | Apache/Apache | 40.5 | 26.8 | demo ORT oficial + NMS externo | menor atrito hoje (ByteTrack nasceu nele) |
| **Eliminados (licença):** YOLOv5/8/11/12/26 (AGPL), YOLOv9 (GPL), YOLOv10 (AGPL), Gold-YOLO (GPL), YOLO-NAS (pesos restritos). **Armadilha:** pesos YOLOX do zoo ByteTrack são treinados em CrowdHuman/MOT (NC) — usar só pesos COCO oficiais. |

## 3. Especialistas em pessoa/multidão — ⚠️ ARMADILHA DE LICENÇA
**Achado central:** o que torna um especialista bom (CrowdHuman, CityPersons/Cityscapes, SCUT-HEAD,
ShanghaiTech, AIC, EuroCity) é **non-commercial** e **contamina os pesos**. Os únicos pesos limpos
são COCO/O365 — a mesma origem do nosso baseline. **Nenhum especialista permissivo de prateleira
supera o D-FINE genérico no nosso caso.**

| Candidato | Situação |
|---|---|
| Detector de pedestre dedicado (CityPersons/EuroCity) | sem versão permissiva-em-pesos pronta — todos passam por dataset NC |
| **Detector de CABEÇA** (ideal p/ pé-direito alto — cabeça oclui menos) | conceito certo, MAS CrowdHuman+SCUT-HEAD são NC e os prontos são YOLOv8 (AGPL) → só via fine-tune próprio |
| **RTMO-s/m** (pose one-stage) ⭐ | **único especialista-flavor limpo**: Apache cód+pesos (variante **COCO-only**, não body7/AIC), ONNX via rtmlib, keypoint de tornozelo = âncora-no-pé natural p/ a linha. Custo CPU sobe com nº de pessoas |
| ViTPose | Apache mas backbone ViT **inviável em CPU** |
| MoveNet MultiPose | Apache/limpo mas **teto de 6 pessoas** → mata contagem |
| Crowd-counting (P2PNet/DM-Count/PET) | P2PNet/PET NC; DM-Count código MIT mas **pesos NC** → só serve **retreinando em dado limpo**; e densidade **não gera tracks/cruzamento** — serve só p/ presença/ocupação por zona |

## 4. Open-vocabulary (modo Objetos: caixa/palete/empilhadeira/paleteira)

| Modelo | Licença | Nota |
|---|---|---|
| **OWLv2** ⭐ | Apache cód+pesos | **drop-in do OWL-ViT** (1 string no transformers.js); ganho em classes raras ("paleteira") |
| LLMDet-tiny/base | Apache | melhor precisão open-vocab permissiva (p/ hub, F4) |
| OmDet-Turbo | Apache | melhor velocidade permissiva (p/ hub, F4) |
| Florence-2 | MIT | licença ótima, mas detecção fraca/lenta p/ vídeo |
| **Eliminados:** YOLO-World (GPL), YOLOE (AGPL), GroundingDINO 1.5-Edge (pesos só via API paga), T-Rex2 (não-comercial). |
| **Rota vencedora — DESTILAÇÃO:** classes são FIXAS → open-vocab em runtime é overhead permanente. Auto-rotular com OWLv2/LLMDet (autodistill, Apache) → treinar detector fixo (D-FINE/RTMDet, 10-40MB). Dataset **LOCO** (39k img de logística: paletes/empilhadeiras/paleteiras) serve de bootstrap (verificar licença antes de treinar comercial). |

## Ranking para o NOSSO caso (pessoa média/pequena · CPU · revenda)
1. **D-FINE-S obj2coco** — drop-in, AP-small 32.7, ~4 câmeras/core. Ataca o gargalo direto.
2. **Fine-tune do D-FINE nas NOSSAS cenas** — o conserto REAL do recall (o problema é domain gap: ângulo alto/escala pequena; capacidade genérica só alivia). Auto-rótulo (professor OWL-ViT/D-FINE-X Apache) + revisão. Custo: dias de rótulo + horas de GPU. **Maior retorno.**
3. **RTMDet-tiny / PP-YOLOE+_s** — se CPU for o limite (CNN 2-3× mais rápida); PP-YOLOE+ tem viés de pessoa (O365).
4. **RTMO-s COCO-only** — viés diferente (pose, robusto a oclusão, âncora-no-pé); teste se estabiliza os tracks.

## Top candidatos prontos p/ o harness `eval/` (próximo passo de teste)
| # | Modelo | Esforço de integração |
|---|---|---|
| 1 | **D-FINE-S e M obj2coco** | quase zero — mesmo pré/pós do motor, troca do .onnx |
| 2 | **RTMDet-tiny (ONNX COCO)** | baixo — NMS no grafo; adaptar leitura de saída |
| 3 | **PP-YOLOE+_s** | médio — paddle2onnx + decode |
| 4 | **RTMO-s (rtmlib→ONNX)** | médio — pós-proc de keypoints; person via bbox dos keypoints |

## Veredito honesto
Trocar por outro modelo permissivo **de prateleira** só devolve outro modelo COCO genérico —
o que muda o recall na NOSSA distribuição é (a) mais capacidade (D-FINE-S/M, drop-in) e, de
verdade, (b) **fine-tune nas nossas câmeras**. O harness `eval/` está pronto para medir os
candidatos da tabela acima antes de qualquer troca. Crowd-counting fica como camada futura de
presença/ocupação (retreino em dado limpo), não para a linha.
