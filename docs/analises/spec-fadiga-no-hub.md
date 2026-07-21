# Spec — Fadiga 24/7 no motor do hub (navegador vira espelho)

> 2026-07-21. Requisito do dono (verbatim): **"o navegador não deve precisar estar aberto pra
> análise funcionar"** — dito ao reportar a máscara de fadiga soltando da pessoa (causas
> estruturais do client-side: rosto fora do crop da zona, perda de tracking, rAF congelado em
> aba background). Remove a exceção da ADR-009 para fadiga (vira ADR-020 quando entregue).

## F0 — Spike do modelo (2026-07-21): PASSOU ✅

Rodado em onnxruntime-node **1.27** (CPU EP, `intraOpNumThreads: 2` — espelho do worker D-FINE)
sobre **8 frames reais** da câmera do operador (rtsp://192.168.136.100:554/live/0, 1920×1080):

| Fato | Valor |
|---|---|
| Modelo landmarks | **FaceMesh V2** (`face_landmarks_detector_1x3x256x256.onnx`, 4,95MB, **Apache-2.0**) — PINTO zoo `410_FaceMeshV2`, tarball `https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/410_FaceMeshV2/resources.tar.gz` |
| Detector de rosto | **YuNet 2023mar** (`face_detection_yunet_2023mar.onnx`, ~230KB, Apache-2.0) — PINTO zoo `387_YuNetV2` (postprocess a implementar: 3 strides 8/16/32, decode de priors — referência OpenCV zoo) |
| IO do mesh | input `input_12` [1,3,256,256] float 0..1 RGB (CHW); outputs `Identity` [1,1,1,1434] = **478 pontos ×3** (x,y,z em px do input 256), `Identity_1` [1,1,1,1] = **score logit** (sigmoid>0.5 = rosto válido), `Identity_2` [1,1] |
| Timing | **7,4 ms/inferência** (2 threads CPU) → a 5fps por câmera ≈ **4% de um core-pair**; irrisório ao lado do D-FINE |
| EAR (índices do cliente, 1:1) | olhos abertos 0,216–0,254 (operador olhando pra baixo); **um frame capturou piscada/fechamento: EAR 0,110** — bem abaixo do limiar 0,21 do cliente → o sinal discrimina em produção |
| MAR | 0,024–0,064 (boca fechada) — consistente |
| Validade do crop | score do mesh despenca com crop ruim (frame com rosto deslocado: logit −21,6) → serve de gate de validade por frame na F1 |

Índices (de `src/config.ts:282-283`, malha 468/478 padrão — portam 1:1):
`LEFT_EYE=[33,160,158,133,153,144]` `RIGHT_EYE=[362,385,387,263,373,380]` `MOUTH_W=[78,308]` `MOUTH_O=[13,14]`.
Spike e artefatos: `scratchpad/spike-fadiga/` (sessão 2026-07-21); sha256 dos .onnx a calcular no fetch da F1.

> **Status F1a (2026-07-21): ENTREGUE atrás de flag.** Worker dedicado validado E2E com frames
> reais: boot 302ms; YuNet full-frame 28ms; com box-hint (tracking) **9ms/inferência**; EAR
> discriminante (0,45 aberto × 0,183 na piscada). **Risco declarado p/ F3:** a ESCALA do EAR
> difere da do cliente (crop YuNet quadrado × alinhamento interno do MediaPipe no browser —
> aberto ~0,45 aqui vs ~0,30 lá); o limiar 0,21 separa bem nestes frames, mas os limiares do
> servidor devem ser CALIBRADOS na validação lado a lado (Regra 11 — precisão do delta), antes
> de ligar default. Pré-processamento medido: YuNet exige **BGR 0..255** (RGB/0..1 não detecta
> NADA); FaceMesh **RGB 0..1**.

## F1 — Motor (em duas entregas, cada uma com verify+CI verdes)

**F1a — pipeline server-side atrás de flag (`ANALYSIS_FADIGA=1`, default OFF):**
1. `server/analysis/model-fadiga.js` — catálogo YuNet+FaceMesh com sha256 + download atômico
   (mesmo padrão de `model.js`; hospedagem: URLs do wasabisys pinadas por sha256).
2. `server/analysis/worker-fadiga.js` — processo DEDICADO (fora do pool D-FINE: evita contention
   no binding serial do ORT e não confunde o autoscale, que mede CPU do pool). YuNet (detect,
   ~1×/s ou quando o mesh perde) → crop quadrado com margem → FaceMesh 256 → 478 pontos + score.
   Tracking barato: reusa o bbox do frame anterior enquanto sigmoid(score) alto (o detector só
   re-roda na perda) — elimina a classe "rosto saiu do crop da ZONA" (o crop segue o rosto, não
   uma zona fixa).
3. `server/analysis/fadiga-risk.js` — PORT da lógica pura do cliente (EAR/MAR + EMA + janelas +
   contadores + risco de `src/processors/fadiga.ts::updateRisk`), com **fixtures compartilhadas
   cliente↔servidor** (gate anti-deriva, mesmo padrão de zones.test).
4. Engine: câmera `modo="fadiga"` deixa de ser EXCLUÍDA (`worker-host.js:125`) e passa a ser
   roteada ao worker de fadiga a ~5fps (gate de movimento reaproveitado). D-FINE continua NÃO
   rodando nela na F1a (celular fica pra F2).
5. Ingest direto: `pgstore.ingest("fad","samples"/"event", …)` (tabelas `fad_buckets`/`fad_events`
   JÁ existem; chave `posto` = label da câmera via `cameraLabelOf`). **Anti-duplicação: enquanto o
   cliente também grava, o server só grava se `ANALYSIS_FADIGA=1` E o front for avisado (item 6)**.
6. Campo aditivo em `analysis-tracks`: `fatigue: { risk, ear, mar, score, box, eyes:[[x,y]…12],
   mouth:[[x,y]…4] }` (subconjunto p/ máscara — 16 pontos, não os 478; efêmero, volatile, nunca
   persistido — postura LGPD inalterada: só agregados em fad_buckets como hoje).

**F1b — espelho + anti-dup (liga default):**
7. `analysis-status` da câmera fadiga anuncia `engine:"hub"` → cliente desliga inferência local
   (FadigaView/zona viram espelho da máscara/risk do hub; interpolador de tracks reusado) e
   `ingestPolicy.HUB_COVERS.fadiga` vira true (cliente para de gravar).
8. Fallback declarado: sem motor no hub (`ANALYSIS_ENABLED=0` ou sem modelo), o pipeline local
   do cliente segue funcionando como hoje.

## F2 — Celular via D-FINE (COCO "cell phone") na câmera de fadiga; remove coco-ssd do cliente p/ esse fim.

## F3 — Validação (Regra 11): mesmo vídeo → risco hub × cliente lado a lado; precisão do DELTA,
CPU real no homolog; então ADR-020 e remoção da exceção na ADR-009/CLAUDE.md.

## Fora de escopo
- Persistir landmarks/EAR cru (biométrico — só agregados, como hoje).
- GPU no servidor (DML/WebGPU reprovados no ORT desta família — CPU only; 7,4ms viabiliza).
- Multi-rosto por câmera de fadiga (contrato atual: 1 operador por posto).
