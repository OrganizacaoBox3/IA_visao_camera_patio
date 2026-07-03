# Spike — Detecção de pessoas NO HUB: onnxruntime-node + D-FINE-N (2026-07-03)

> Spike de 1 dia previsto no encaminhamento de `backlog-analise-continua.md` (§3) e na Onda 3 de
> `plano-contagem-pessoas.md`: medir, **sem comprometer arquitetura**, se a análise contínua pode
> rodar no hub Node (opção B da ADR pendente). Código do spike vive INTEIRO fora do repo
> (scratchpad da sessão); só este relatório entra. Nada em `src/`, `server/` ou `package.json` foi tocado.

## Veredito: **GO** (com condições — ver §8)

D-FINE-N (Apache-2.0, 14,5 MB) roda no Node desta máquina (ultrabook 4C/8T, sem GPU utilizável)
a **~120-135 ms/inferência (CPU EP)**, detecta pessoas numa cena real onde o baseline
coco-ssd/browser documentou **0**, e cabe folgado na cadência de 1-2 fps/câmera que contagem e
atividade exigem. O gargalo mapeado não é o modelo — é o **binding do onnxruntime-node, que
serializa inferências dentro de um processo** (§6): escala para N câmeras = worker processes.

## 1. Setup

| Item | Valor |
|---|---|
| Máquina | 11th Gen Intel i7-11390H @ 3.40GHz (4C/8T), Windows 11, Node v24.15.0 |
| Runtime | `onnxruntime-node` 1.x (npm, instalado local no scratchpad) + `sharp` (decode JPEG + resize) |
| ffmpeg | binário winget (mesmo que `server/rtsp.js` resolve) — HLS → mjpeg pipe, split SOI/EOI igual ao hub |
| Streams reais | Pula `hr_pula01.m3u8` (mesma câmera dos diagnósticos) e Gorizia `it_gorizia06.m3u8`, 1280×720 @2fps |
| Código do spike | `...\scratchpad\spike-dfine\` (`infer.mjs`, `bench.mjs`, `annotate.mjs`, `worker-proc.mjs`, `package.json` próprio) |

## 2. Modelo escolhido

**`onnx-community/dfine_n_coco-ONNX`** (export ONNX oficial da comunidade transformers.js),
base **`ustc-community/dfine-nano-coco` — licença Apache-2.0 confirmada na model card**.
D-FINE-N: 42,8 mAP COCO, input 640×640 nativo, NMS-free (DETR-family) — exatamente o recomendado
na pesquisa de mercado do `plano-contagem-pessoas.md`. Existia pronto; não foi preciso exportar.

- Arquivo: `onnx/model.onnx` fp32, **14,55 MB**. Input `pixel_values [1,3,640,640]`; outputs `logits [1,300,80]` + `pred_boxes [1,300,4]` (cxcywh normalizado).
- Pré-processamento conforme `preprocessor_config.json` do próprio modelo (RTDetrImageProcessor): **resize 640×640 SEM pad** (squash, não letterbox), rescale 1/255, **sem mean/std**. Pós: sigmoid + threshold; classe 0 = person.
- **Variante int8 descartada por medição**: `model_int8.onnx` (4,3 MB) deu as MESMAS detecções porém **p50 1005 ms — 7× mais lento** que fp32 nesta CPU (QDQ sem caminho VNNI vantajoso neste build). fp32 é o ponto de operação.

## 3. Números (o produto do spike)

Todas as inferências em **CPU EP**; latências incluem só `session.run` (decode sharp reportado à parte).

| Cenário | frames | infer p50 | infer p95 | decode p50 | fps processado | CPU (máquina, 8 lógicos) | RSS |
|---|---|---|---|---|---|---|---|
| **Live 1 stream** (Pula @2fps, 120 s) | 118 | **132 ms** | 297 ms | 24 ms | 0,98 | **8,7%** (0,70 core) | 225 MB |
| **Live 2 streams** (Pula+Gorizia, 120 s) | 88+80 | 178 / 245 ms | 450 / 620 ms | 33-37 ms | 1,4 agregado | **14,2%** (1,14 core) | 238 MB |
| **Throughput serial** (back-to-back, 60 s) | 395 | 120 ms | 181 ms | 23 ms | **6,58** | 46,5% (3,7 cores) | 190 MB |
| **4 sessões 1-thread, 1 processo** (30 s) | 129 | 942 ms* | 1105 ms* | — | 4,19 | **11,8%** ← serialização | — |
| **4 processos × 1 thread** (20 s) | — | — | — | — | **9,93 agregado** (4× 2,48) | ~4 cores | ~190 MB/proc |

\* latência inflada por fila: as 4 chamadas concorrentes serializam dentro do processo (§6).

Threads intra-op (p50 serial): default(≈todos) **120-135 ms** · 2 threads **178 ms** · 1 thread **211 ms**.
1 thread gasta ~0,21 core·s/frame vs ~0,57 core·s/frame no default — **~2,7× mais eficiente por frame**;
o default só compensa quando se quer latência mínima de UM stream.

## 4. Pessoas por frame — comparação com o baseline browser

Baseline documentado (`diagnostico-runtime-2026-07.md`, mesma câmera de Pula, coco-ssd/tfjs em CPU):
**0 pessoas em t0-t60s com 2-4 pedestres visíveis**; primeira contagem só após ~60 s, intermitente.

D-FINE-N no hub, nas MESMAS condições de cena (frames 1280px reais):

| Cena | score ≥ 0.4 | score ≥ 0.3 (com NMS leve) |
|---|---|---|
| Pula, pedestres médios no passeio (frames 001/004) | **1-2 pessoas** (0,43-0,50) | 2-6 únicas |
| Pula, só pessoas minúsculas/sombra no mercado distante (frames 005-012) | 0 | **0** (miss honesto — pessoa <~25 px após squash) |
| Pula live 120 s (janela com pouco pedestre visível — PTZ tapada pelo toldo) | média 0,07/frame, pico 4, 3 frames com pessoa | — |
| Gorizia (café + pedestres a média distância) | média 0,45/frame, pico 3, 27/80 frames com pessoa | **6-9 pessoas únicas/frame, consistente** |

Leituras honestas:
1. **Onde o coco-ssd dava 0 por um minuto, o D-FINE-N acerta na primeira inferência** (pedestre médio: score 0,43-0,54). O ganho existe e é imediato.
2. Em cena de rua com gente PEQUENA/distante, o ponto de operação real é **score ~0,3 + NMS**, não 0,4 — os scores da variante nano ficam em 0,30-0,50 nessa faixa de tamanho. É exatamente a faixa que o ByteTrack da Onda 2 usa para associação (0,15-0,4), então o pipeline planejado já aproveita.
3. **A D-FINE-N emite queries duplicadas na mesma pessoa** nessa faixa de score (é NMS-free "de direito", não de fato na nano) — contagem precisa de um NMS leve por IoU (~15 linhas, incluído no spike).
4. Pessoa <~25 px continua indetectável — o teto físico melhora vs coco-ssd (640 nativo vs 300), não desaparece. Para o CD (câmeras internas, pessoas maiores no frame), é o caso FÁCIL comparado a estas webcams panorâmicas.

**Evidência visual** (PNGs com bbox desenhadas, no scratchpad da sessão `...\scratchpad\spike-dfine\evidencias\`):
`pula_001_thr04.png` (1 pessoa @0,4 onde baseline=0) · `pula_004_thr04.png` (idem, 0,49) ·
`gor_006_thr03.png` (6 únicas @0,3: mesas de café) · `gor_007_thr03.png` (9 únicas @0,3).
Frames crus em `...\spike-dfine\frames\` e `...\frames_gorizia\`. (Scratchpad é efêmero — evidências
são do spike, não do produto; LGPD: frames de webcam pública, nada persistido no projeto.)

## 5. Execution providers nesta máquina

| EP | Disponível? | Resultado |
|---|---|---|
| **cpu** | sim (default) | **Correto e estável — ponto de operação do spike** |
| **dml** (DirectML, iGPU Iris Xe) | **sim, carrega** | ~25% mais rápido (p50 84 vs 111 ms) **porém saída ERRADA: 0 detecções** no mesmo tensor (op do decoder caindo em fallback silencioso). NÃO usar sem validação de paridade |
| **webgpu** | sim, carrega | **Crash em runtime**: `MatMul /model/decoder/integral/MatMul` (shape inválido) |
| **cuda** | não | backend ausente no build node (esperado; sem NVIDIA aqui) |

Lição p/ ADR: GPU EP não é atalho grátis para DETR-family no Node hoje — **planejar CPU-only** e
tratar qualquer EP acelerado como otimização futura COM teste de paridade de detecções.

## 6. Achado de arquitetura: o binding serializa inferências por processo

`session.run()` concorrentes (mesma sessão OU sessões separadas, mesmo com `UV_THREADPOOL_SIZE`
elevado) executam **em fila** dentro de um processo Node: 4 sessões 1-thread concorrentes usaram
~1 core e renderam 4,2 fps — igual a 1 sessão sozinha. **4 processos** renderam 9,9 fps agregado.
Consequência direta p/ o design da opção B: N câmeras não escalam num único processo do hub;
o motor de análise deve ser **worker process(es) separado(s)** (bônus: isola o hub/relé de
qualquer crash nativo do ORT — o hub continua sendo relé + persistência).

## 7. Extrapolação para N câmeras do CD

Cadência necessária p/ contagem/atividade: **1-2 fps/câmera** (não 12 fps — o tracker da Onda 2 já
foi desenhado p/ rodadas lentas). Custo medido por frame 1280→640: ~0,15-0,21 core·s (worker
1-thread) incluindo decode.

| Configuração (ESTA máquina, ultrabook 4C/8T) | Capacidade @1 fps/câmera | @2 fps/câmera |
|---|---|---|
| 1 worker process (latência mínima, default threads) | ~6 câmeras | ~3 |
| 3-4 worker processes × 1-2 threads (~80% CPU teto) | **~8-10 câmeras** | ~4-5 |

Regra de bolso p/ dimensionar o hub real: **~0,2 core por câmera @1 fps** (+ ~190-240 MB RSS por
worker, modelo carregado). Um desktop 8C/16T de escritório comporta ~16-24 câmeras @1 fps com
folga p/ o relé/ffmpeg. Medir na máquina de operação antes de fixar números na ADR (§8).

## 8. Recomendação para a ADR (análise contínua) — GO, opção B, com condições

**GO**: motor D-FINE (onnxruntime-node, CPU EP) em worker process no hub. O spike prova que
(a) o modelo recomendado existe pronto, Apache-2.0, 14,5 MB; (b) roda a 120-180 ms/frame em CPU
modesta — 3-8× o orçamento necessário p/ 1-2 fps; (c) detecta pessoas onde o baseline browser
documentou zero; (d) o custo por câmera é pequeno e previsível.

Condições/riscos a carregar para a ADR e a implementação:

1. **Worker process, não in-process** (§6) — inferência serializa por processo; isolar também protege o relé.
2. **Ponto de operação de detecção**: score 0,3 + NMS leve por IoU p/ contagem; 0,15-0,4 alimenta a associação do ByteTrack (Onda 2) — não repetir o erro do corte 0,4 apontado na auditoria.
3. **CPU EP only** por ora; DML/WebGPU reprovados em paridade nesta máquina (§5).
4. **fp32, não int8** (7× mais lento aqui — re-medir só se o hub de produção tiver VNNI comprovado).
5. Pessoa <~25 px segue fora do alcance — posicionamento de câmera continua importando; upgrade de recall = D-FINE-S (~2× compute, mAP 48+, mesma licença/pipeline) — trocar é trocar um arquivo.
6. Validar na **máquina real de operação** (este spike foi num ultrabook — números são piso, não teto).
7. LGPD/ADR-002 preservados: frames já transitam pelo hub em memória; o motor só emite metadados (dets/tracks/eventos). Nada novo é persistido.
8. Quebra da invariante "IA 100% no navegador" → a ADR deve redefinir: **hub = fonte dos indicadores; navegador = visualização/overlays** (como já esboçado no backlog).

## 9. Reprodutibilidade

Spike completo em `%LOCALAPPDATA%\Temp\claude\...\scratchpad\spike-dfine\` (sessão de 2026-07-03):
`npm install` local; `node infer.mjs frames\pula_001.jpg` (1 frame); `node bench.mjs live|dual|throughput <s>`
(medições); `node annotate.mjs <in.jpg> <out.png> <thr>` (evidências). Modelo:
`https://huggingface.co/onnx-community/dfine_n_coco-ONNX` (`onnx/model.onnx`). Scratchpad é efêmero —
se o spike precisar ser re-rodado, os 4 arquivos .mjs somam ~300 linhas e este relatório documenta tudo.
