# Plano de retrofit de PERFORMANCE — de "nota 1" a vídeo fluido + detecção confiável

> Origem: o dono do produto reporta experiência **1/10** — câmeras travam, fantasmas, e pessoas
> reais não reconhecidas. Pediu reavaliação de TODAS as decisões e um retrofit de performance com
> métricas e etapas. Base: 3 auditorias críticas paralelas (transporte/render, detecção, mercado),
> jul/2026. Doutrina (`../agentes/`): sem evidência não há pronto; medir antes de afirmar; entregas
> pequenas e reversíveis; **a simplicidade é o sidecar provado, não a pilha de micro-otimizações**.

## 0. Escopo (inegociável)

O retrofit vale para **TODA E QUALQUER câmera de rede** — não para as câmeras públicas de teste
(Pula/Gorizia/Mošćenička são só streams HLS convenientes enquanto não há câmeras do CD). Tudo aqui é
**agnóstico de câmera**: Fase 0 (pausar tiles/motion-gate/HUD) vale para qualquer feed; o motor
D-FINE-S roda em toda câmera relaiada; e o go2rtc (Fase 1) é um **ingestor universal** (RTSP/ONVIF/
RTMP/HLS/USB). **A câmera RTSP real do CD é o caso NATIVO e MELHOR** (codec-copy = passthrough, 0
re-encode, decode por HW) — performa melhor que os HLS de teste, não pior. O único fator que varia por
câmera é o que ela e a rede entregam (resolução/fps/codec/banda); o retrofit remove os gargalos
**sistêmicos** (decode MJPEG na main-thread, CPU do relé) para todas de uma vez.

## 1. Diagnóstico — por que está 1/10 (com evidência)

A causa **não é uma** — são camadas somadas. Separando o que **não está ativo** (config/deploy) do
**teto arquitetural** (não morre com otimização incremental):

### Detecção (fantasmas + misses ao mesmo tempo)
1. **Há DOIS pipelines de detecção; tudo que melhoramos vive só num.** Navegador = **coco-ssd de
   2017** (`src/config.ts`); hub = D-FINE-S (nossas melhorias). Default por câmera = **`"local"`**
   (`DashboardPage.tsx`). **Provável que o dono nunca tenha visto o D-FINE rodar** — viu o coco (e,
   sem WebGL, em CPU = 0–1 detecção/60s). Nossas ondas de acurácia **nem rodaram** para ele.
2. **Overlay a 1fps sobre vídeo a 10fps = detecção correta que PARECE erro.** A caixa congela onde a
   pessoa estava (TTL ~3,5s) → caixa no vazio (**fantasma**) + pessoa 1s à frente sem caixa
   (**miss**), de ZERO erros reais. A interpolação foi adiada (F3) — erro.
3. **Máscara de Exclusão nunca foi desenhada** — 47–86% dos fantasmas são objetos fixos, elimináveis
   sem custar recall, mas exige pintura manual por câmera que ninguém fez.
4. **Fantasma-fixo e pessoa-distante são inseparáveis por um só threshold** — é problema
   espacial/temporal (o fixo não anda; a pessoa sim), não de score.

### Vídeo (travando)
5. **Contenção de CPU numa máquina só**: se o hub (relé + worker D-FINE-S + ffmpeg 24/7) roda no PC
   do operador junto do navegador, tudo starva → congela. Causa provável do "trava **sempre**".
6. **Pipeline local ainda ligado no modo hub** (desperdício): readback de motion não é desligado;
   OWL-ViT/MediaPipe/ZXing na main thread → picos de 100–300ms.
7. **Abrir uma câmera não pausa a grade**: os outros 5 tiles seguem processando atrás; a aberta é
   full-res + cine-loop faz 2º decode/frame. Pior caso exatamente quando o operador foca.
8. **TETO: MJPEG sobre socket.io.** Cada frame é um JPEG inteiro (sem compressão inter-frame),
   **parseado e desenhado na main thread** antes do "último-vence". Sob carga o cliente **dropa
   frames** → trava-e-pula. O próprio `rtsp.js:5` já anotava: *"produção de baixa latência: WebRTC"*.

## 2. Reavaliação honesta das nossas decisões

| Decisão | Veredito |
|---|---|
| **MJPEG sobre socket.io** como transporte de vídeo | **Erro estrutural, teto desde o início.** É o formato que Frigate/Ubiquiti/Milestone/Blue Iris/Shinobi/Viseron rotulam como *fallback de baixa qualidade*. Intra-frame puro → custo de decode/banda por-frame inerente. |
| **Adiar WebRTC 3× como "overengineering"** | **O erro estratégico.** KISS mal aplicado: a solução mais simples E robusta é o sidecar provado (go2rtc), não a pilha de escova-bit. Ironia: `rtsp.js` reimplementa — pior — reconexão/health-check/transporte-flex que go2rtc dá de graça. |
| **Ondas incrementais (escova-bit)** | Corrigiram bugs reais de escala (volatile, rooms, matar inferência-por-espectador — valeram), mas **nenhuma removeu o teto**. Moveram o número, não a percepção. |
| **Motor D-FINE no hub (ADR-009)** | **Certo — metade "confiabilidade".** Manter. Falta ser o ÚNICO pipeline e estar ATIVO no que o usuário vê. |
| **Dualidade browser+hub** | Certa mas **transitória**: F3 já aposenta o coco do cliente. Terminar a transição. |
| **LGPD (ADR-002) bloqueia WebRTC?** | **Não.** WebRTC relaya/remuxa e **não persiste** — frames seguem efêmeros. A LGPD nunca foi o bloqueio; o rótulo "overengineering" foi. |

**A revolução tem 3 pernas:** **transporte (WebRTC/go2rtc) → FLUIDEZ** · **D-FINE no hub → CONFIABILIDADE**
· **overlay com interpolação → SINCRONIA**. Construímos 2 e paramos antes da 3ª — a que move o
patamar percebido.

## 3. Métricas e objetivos (a régua — medir ANTES e DEPOIS de cada fase)

| Dimensão | Métrica | Hoje (estimado) | Objetivo |
|---|---|---|---|
| **Fluidez** | FPS exibido por tile | trava/pula (buracos) | **≥24 fps estável** |
| | Frames dropados sob carga | alto (último-vence) | **<5%** |
| | ms na main-thread/frame (câmera aberta) | estoura 16ms com 6 tiles | **<8 ms** |
| | Latência glass-to-glass | segundos sob carga | **<500 ms** |
| **CPU** | Cliente com 6 tiles | satura | **<50% de 1 core** |
| | Hub separado do cliente | mesmo host (contenção) | **host dedicado / dimensionado** |
| **Detecção** | Recall pessoa média/pequena | 8–41% (coco) | **≥70%** (D-FINE-S ativo) |
| | FP/hora em cena vazia | alto (fantasma fixo) | **<2/h** (com máscara) |
| | Sincronia overlay (lag caixa×pessoa) | até 3,5 s (congela) | **<200 ms** (interpolado) |
| | Acurácia da contagem de linha | 0% | **>70%** |
| **Percepção** | Nota subjetiva do dono | **1/10** | **≥7/10** |

## 4. Etapas (fases pequenas e reversíveis; cada uma com gate de métrica)

### Fase 0 — Medir + estancar (barato, reversível, SEM trocar arquitetura) → grade 1 → ~6-7
- **0.1 Instrumentar** um HUD de telemetria por câmera: FPS real exibido, ms/frame na main-thread,
  frames dropados, **pipeline ativo (hub/local)**, latência. *Sem medir a sessão real, o resto é chute.*
- **0.2 Pausar o rAF dos tiles de fundo** quando uma câmera está aberta (`DashboardPage`/`CameraTile`).
- **0.3 Desligar o readback de motion no modo hub** (gate por `hubActive`; o hub já tem os frames).
- **0.4 Baixar custo do decode dos tiles** (largura/fps) e garantir `ImageBitmap.close()` (anti-GC).
- **0.5 Deploy: tirar hub+worker+ffmpeg da máquina do operador** (ou `ANALYSIS_MODEL=n`, menos
  câmeras/core) — mata a contenção de CPU, causa provável do "trava sempre".
- **0.6 Garantir o pipeline certo ATIVO por default** (D-FINE do hub) no que o usuário vê; deixar
  explícito na telemetria (0.1).
- **Gate:** grade não "trava" em uso normal; ms/frame <8; pipeline ativo = hub. Se a percepção subir
  para ~6-7, valida a hipótese e segue para o teto.

### Fase 1 — Transporte WebRTC via go2rtc (a revolução da fluidez)
- Subir **go2rtc** como sidecar (Apache-2.0, 1 binário Go, **codec-copy = 0 re-encode**).
- `go2rtc.yaml` com as câmeras RTSP; trocar os tiles MJPEG-canvas por **`<video-stream>` nativo**
  (WebRTC→MSE→MJPEG auto-negociado; decode por HW **fora da main thread**). **Feature flag**;
  rollback = tile antigo. CSP: liberar `connect-src` do host go2rtc (JS servido local, sem CDN).
- **Gate:** ≥24 fps estável, latência <500 ms, CPU cliente <50%, câmera aberta fluida.

### Fase 2 — Overlay sincronizado (interpolação) → mata "fantasma+miss de detecção correta"
- Canvas transparente **sobre** o `<video>`, alimentado pelos `tracks` do hub (socket = plano de
  controle), com **interpolação linear de bbox entre payloads + offset de timestamp**.
- **Gate:** lag caixa×pessoa <200 ms; some a caixa congelada no vazio.

### Fase 3 — Unificar num pipeline só (aposentar coco local + máquina MJPEG)
- Hub D-FINE como **única** fonte de detecção; navegador = **viewer fino**. O worker de análise passa
  a puxar frames do **go2rtc (RTSP/snapshot)**, não do relé socket.io.
- Aposentar a maquinaria ffmpeg→MJPEG do `rtsp.js`; **ADR novo** ("transporte de vídeo: WebRTC via
  go2rtc; MJPEG só fallback"); atualizar CLAUDE.md §1.
- **Gate:** um só caminho de detecção; `rtsp.js` MJPEG removido sem regressão.

### Fase 4 — Detecção ativa + defesas (o "confiável")
- Motor **ligado por default** no que o usuário vê; **máscara de Exclusão AUTOMÁTICA** (aprende
  hotspots fixos em N min — sem exigir pintura manual); **`ANALYSIS_FPS` 2–4** nas câmeras de linha.
- **Slider de confiança funcional no modo hub** (propagar o score real do motor — hoje é forçado a 1).
- **Gate:** FP/hora <2 sem perder recall; contagem de linha >70%.

### Fase 5 (se a medição pedir) — nós webcam via WHIP + limpeza final
- Webcam do navegador → go2rtc via **WHIP** (`getUserMedia`+RTCPeerConnection). Maior mudança; só
  depois de Fase 0–3 provarem o ganho.

## 5. Invariantes preservados / riscos declarados
- **ADR-002 (LGPD):** WebRTC relaya/remuxa, **não persiste** — frames seguem efêmeros; cine-loop
  continua buffer em memória no cliente (canvas/MediaRecorder do `<video>`). **Intacto.**
- **ADR-009 (motor no hub):** mantido e reforçado (vira o único pipeline).
- **Contratos socket aditivos:** socket vira **plano de controle** (cameras/status/tracks/camcfg) e
  **deixa de transportar vídeo** — mudança grande; fazer sob feature-flag, sem quebrar eventos.
- **ADR-007 (casca fullscreen):** o vídeo vira `<video>` nativo e o `<canvas>` passa a ser só overlay
  — na verdade **simplifica** a remontagem, mas o composite precisa ser validado contra o trap de
  foco manual e o editor de zonas antes de generalizar.
- **Risco operacional:** +1 processo sidecar (go2rtc) para deployar/supervisionar — troca por ~−500
  linhas de ffmpeg-management frágil (líquido: mais simples e robusto). Safari exige H.264 (câmera
  H.265 → transcode pontual no go2rtc). Webcam→WHIP é a parte não-trivial (por isso é Fase 5).

## 6. Ordem recomendada e por quê
**Fase 0 primeiro** (dias, barato, reversível): estanca o "trava sempre" e — crucial — **mede** para
confirmar as hipóteses antes de gastar na mudança estrutural. Se 0 levar a grade a ~6-7, ótimo; o
teto (Fase 1) é o que leva a 8-9 numa parede de câmeras. **Fase 1+2 juntas** entregam a "revolução"
percebida (fluidez + sincronia). Fase 3+4 consolidam (um pipeline, detecção confiável). Fase 5 é
opcional/medida.

## 7. Fora de escopo (registrado)
Fine-tune do D-FINE nas câmeras internas do CD (o teto REAL de recall — quando essas câmeras
existirem; o harness `eval/` já está pronto); GPU no hub; re-ID/oclusão densa; troca de modelo
(D-FINE-S já é o teto de prateleira — ver `benchmark-modelos-alternativos.md`).
