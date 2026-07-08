# Estado + próximos passos — reconhecimento de pessoas (não perder o fio)

> Consolidação pra retomar sem re-descobrir. Índice: `00` diagnóstico · `01` plano eval · `02` resultado
> CAVIAR+MOT20 · `03` spike input · `04` full-set+capacidade · `05` plano fine-tune · este `06` estado.

## Onde chegamos (medido)
- **Sensor pronto:** `eval/persons-cftv.mjs` (detector+tracker reais vs GT; MOT20 + CAVIAR; varre fps).
- **Gargalo do "perde na multidão" = DETECTOR** (recall 57%→26% conforme densidade), NÃO cadência (refutada).
- **Alavanca config-only:** input 640→**896 = +5-8pp recall** (full-set confirmado), precisão intacta, **1,87× CPU**
  (~metade das câmeras/core). Registrado como escape-hatch em `precision.js §5` (default fica 640; opt-in).
- **Tiling REFUTADO** (piora precisão). **M** = retorno decrescente.
- **Teto do COCO:** mesmo o máximo perde 34-74% em crowd → só **fine-tune de vigilância** quebra (frente B).

## GPU local (identificada 2026-07-08)
- **NVIDIA GeForce MX450 · 2 GB VRAM** · driver 581.95 · CUDA 13.0 (+ Intel Iris Xe 2GB integrada).
- **NÃO treina** fine-tune DETR/D-FINE (precisa ~12-24 GB; 2 GB = OOM). Serve, no máx, inferência pequena.
- **Implicação p/ B:** treino precisa de **GPU externa** (Colab T4 grátis = menor atrito, ou cloud alugada
  16-24GB por horas). O modelo treinado sai **ONNX e roda em CPU** na produção (inferência não precisa da GPU).

## ⚠️ NOVA PISTA (2026-07-08) — pode reordenar TUDO
**Experiência real do dono com o DVR HOJE: a câmera já tinha dificuldade de marcar pessoa com só 1-2 em
cena.** Isso **CONTRADIZ o eval**: em cena esparsa (CAVIAR, ~5/frame) o detector teve **88% de recall** —
ou seja, **o detector NÃO é ruim com poucas pessoas** em frame decente. Logo, o problema live com 1-2
pessoas provavelmente **não é o recall do detector** (o que o fine-tune resolveria), e sim algo no
**PIPELINE AO VIVO**. Hipótese do dono: "pode ser só a renderização?" — **plausível.** Suspeitos:
1. **Renderização/overlay:** o motor DETECTA mas a caixa não desenha / coordenada errada / atrasa (a 1fps +
   dead-reckoning, o overlay fica atrás da pessoa → parece "não marca").
2. **O frame que o MOTOR vê ≠ o que você vê:** DVR estava em **H.265** no main; o vídeo do painel cai no
   **fallback MJPEG**; se o overlay é desenhado sobre um frame de resolução/tempo diferente do analisado,
   desalinha. Ou registramos o stream errado (sub 704×480 vs main 1080p).
3. **Cena:** pessoa distante/de costas/contraluz no ângulo real do DVR (o CAVIAR é próximo-frontal).
4. **Decode:** ffmpeg decodificando H.265 do DVR com artefato/cor errada → o detector vê lixo.

## Próximos passos (REORDENADOS pela nova pista)
1. **[fazer PRIMEIRO] Diagnóstico do live DVR — separar DETECTAR de MOSTRAR.** Pegar um frame REAL do DVR
   (ffmpeg no RTSP) e rodar o detector nele (single-frame, como o eval): **acha as 1-2 pessoas?**
   - Se **SIM** → o detector funciona no seu frame → o problema é **render/overlay/cadência/stream** (não o
     modelo). Aí o fine-tune NÃO é a prioridade; consertar o pipeline live é. Investigar overlay/coords/
     cadência e qual stream está cadastrado.
   - Se **NÃO** → é detecção no SEU cenário (ângulo/luz/decode). Aí sim recall do detector — e o 896/fine-tune
     entram. (Precisa a máquina na rede do DVR — 192.168.0.200.)
2. **896** disponível pra ligar onde o HW afona (`ANALYSIS_INPUT=896`, +7pp).
3. **Fine-tune (B)** — só se o diagnóstico (1) confirmar que é recall do detector no cenário real. Precisa
   GPU externa (Colab/cloud). Plano em `05-*`.

## O aprendizado (honesto)
O eval mede o DETECTOR isolado (frames limpos). A experiência do dono mede o **sistema inteiro ao vivo**
(ingest→decode→análise→overlay→tela). Um pode estar bom e o outro ruim. **Antes de investir no fine-tune
(caro), diagnosticar QUAL estágio falha no live** — senão a gente conserta o que não está quebrado.
