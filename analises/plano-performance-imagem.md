# Plano de Performance — pipeline de imagem (nó → hub → dashboard)

> Problema: vídeo lento/travando e **qualidade péssima**. Revisão do pipeline real (evidência
> `arquivo:linha`) + plano pragmático **sem overengineering**. *Análise/plano — nada alterado.*

## O que JÁ está correto (não mexer)
- **Transporte binário**, não base64: `CameraPage.tsx:104-113` envia `{buf}` de `canvas.toBlob("image/jpeg")` (não `toDataURL`). ✅
- **Decode fora da main thread + só o último frame**: `DashboardPage.tsx:184` `createImageBitmap(new Blob([buf]))`, descarta atrasados, `.close()` nos antigos (`:190`), **só decodifica feeds da página ativa** (`:237`). ✅
- **Gate de "frame novo"** e **desenho desacoplado da inferência**: no rAF do `CameraWorkspace`, `requestInference(...)` é **fire-and-forget** (scheduler, coalescido) e `drawScene` roda **todo frame** (`:686` vs `:852`) — o vídeo NÃO espera a IA. ✅
- **Paginação** já processa só a página visível. ✅

## Diagnóstico dos gargalos reais

### 1. 🔴 Qualidade sacrificada por uma economia de banda que NÃO é o gargalo
- **RTSP** sai a **480px, `-q:v 7`, 8 fps** (`rtsp.js:77-79,173-176`) → "péssima" para câmera IP.
- **Webcam** a **960px, q0.75** (`config.ts:194`), e o evento `capture`/`set-capture` (`index.js:178-181`) pode **baixar ainda mais**. Re-encode JPEG (a webcam já é comprimida) a q0.75 gera artefato.
- Em **LAN/localhost a banda é abundante**; o gargalo é **CPU/main-thread** (abaixo). Ou seja: pagamos qualidade por uma economia que quase não importa aqui.

### 2. 🔴 A grade roda o PIPELINE COMPLETO por tile (contende a main thread)
- Cada tile é um `CameraWorkspace` inteiro: por frame faz **motion** (getImageData+luma), **draw**, e agenda **inferência**; câmeras de **fadiga/objetos** rodam **coco/MediaPipe na MAIN THREAD** (não no worker) → jank. Mesmo com throttle de tile (`objectIntervalMsTile 1200`) e paginação (6 tiles), 6 pipelines simultâneos + worker coco compartilhado (serializado) + coco main-thread da fadiga saturam a CPU → **"travando"**.

### 3. 🟠 Câmera aberta em "Longo alcance" = 4×4 = 16 inferências/frame
- O perfil panorâmico (recém-criado) faz **16 tiles** no worker — ótimo p/ recall, pesado p/ CPU. Se ligado, some com o resto da capacidade.

### 4. 🟠 Encode do nó na main thread
- `CameraPage` faz `drawImage`+`toBlob` (encode JPEG) na **main thread do nó** a cada frame (`:101-120`). Trava a aba do nó se a máquina for fraca (menos crítico que o dash, mas real).

## Plano de melhoria (priorizado, sem overengineering)

### P0 — Separar EXIBIÇÃO de ANÁLISE na grade (maior ganho de fluidez)
- **Grade = vídeo fluido + análise leve/baixa cadência; inferência pesada só na câmera ABERTA.**
- Concretamente: nos tiles (mode ≠ full), **desligar/rebaixar drasticamente** a inferência pesada (coco/OWL-ViT/fadiga) e manter só o essencial (motion/estado por zona numa cadência baixa). A câmera aberta roda o pipeline completo. Reaproveita o `mode === "full"` que já existe.
- *Esforço:* baixo/médio · *Risco:* baixo · *Ganho:* **alto** (libera a main thread → vídeo suave).

### P1 — Reverter a super-compressão (qualidade), já que o gargalo não é banda
- **RTSP:** subir defaults p/ ~**640–960px, `-q:v 4–5`, 10 fps** (`rtsp.js`), e deixar claro que qualidade vem da câmera (usar sub-stream melhor/main-stream por câmera via os campos já existentes).
- **Webcam:** subir `jpegQuality` p/ ~**0.85** e `frameWidth` conforme CPU; revisar o profile do `set-capture` p/ não derrubar demais.
- *Esforço:* baixo (config) · *Risco:* baixo (mais decode, mas cabe) · *Ganho:* **alto** (qualidade).

### P2 — Fadiga/Objetos fora da main thread nos tiles
- Já que P0 tira o pesado da grade, garantir que **fadiga/objetos** só rodem na câmera aberta (ou em worker). Elimina a maior fonte de jank.
- *Esforço:* baixo (cai junto do P0) · *Ganho:* médio/alto.

### P3 — Encode do nó fora da main thread (se o nó travar)
- Mover o encode do `CameraPage` para **OffscreenCanvas + `convertToBlob` num worker** (ou `ImageCapture`/`MediaStreamTrackProcessor`). Só se o profiling apontar o nó como gargalo.
- *Esforço:* médio · *Ganho:* médio (só no nó).

### P4 — Desenhar no tamanho de exibição (micro)
- `drawScene` desenha o frame nativo; casar o tamanho do canvas com o tamanho de EXIBIÇÃO do tile reduz pixels desenhados. Ganho pequeno.

## O que NÃO fazer agora (evitar overengineering)
- **Trocar MJPEG por WebRTC/WebCodecs/H.264** (go2rtc/mediamtx): é a solução "definitiva" (compressão inter-frame, baixa latência, menos CPU de decode), mas é **mudança grande de arquitetura** — deixar como evolução, só se P0–P2 não bastarem.
- Cache/CDN, filas, workers múltiplos de inferência: desnecessário para a escala atual.

## Sequência sugerida
1. **P0 + P1 juntos** (fluidez + qualidade — são os dois sintomas do usuário) — em paralelo (P0 no CameraWorkspace, P1 em config/rtsp).
2. **P2** cai junto do P0.
3. Medir; só então P3/P4 se necessário.

## Validação (não é headless)
FPS de exibição, tempo de decode, uso de CPU e latência (frame→tela) **medidos em runtime** com N câmeras, antes×depois. "Sem evidência não há pronto." O trade-off qualidade×CPU se afina com esses números.
