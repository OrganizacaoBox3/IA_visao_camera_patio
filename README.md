# Visão de Pátio — POC (central de câmeras)

MVP web de **inteligência operacional por área** (visão computacional industrial). Processamento **100% local**, **sem identificação individual**.

Duas rotas:

- **`/`** — **central (dashboard):** mostra todas as câmeras conectadas (grade) e processa tudo (zonas, movimento, ocupação, contagem de pessoas, permanência anônima, alertas). Clique numa câmera para abrir a visão completa com todas as funções.
- **`/camera`** — **nó de câmera:** apresenta **apenas o feed** (sem controles) e envia frames ao hub.

## Como rodar (3 passos)

```bash
# 1) Hub (servidor socket.io) — relé de frames câmera→dashboard
cd server && npm install && npm run dev        # ouve em :4000

# 2) Frontend
npm install && npm run dev                     # Vite (ex.: :5173), com --host

# 3) Abrir no navegador
#   Central:  http://localhost:5173/
#   Câmera:   http://localhost:5173/camera   (autoriza a webcam)
```

Para conectar **mais câmeras**, abra `/camera` em outra aba, em outro PC, ou no **celular** apontando para o IP do laptop (ex.: `http://192.168.x.y:5173/camera`). O hub (`net.serverUrl` em `src/config.ts`) usa o mesmo host na porta 4000.

## Câmeras IP (RTSP)

O navegador **não reproduz RTSP**. O hub usa o **ffmpeg** para ler o RTSP e produzir frames JPEG, emitidos como uma câmera comum — ganha zonas, análise e histórico automaticamente, sem mudança no front.

1. **Instale o ffmpeg** no host do hub (precisa estar no `PATH`).
2. Configure as fontes — uma das opções:
   - arquivo `server/rtsp.sources.json` (veja `server/rtsp.sources.example.json`):
     ```json
     [
       {
         "label": "Pátio - Expedição",
         "url": "rtsp://user:senha@10.0.0.50:554/Streaming/Channels/101"
       }
     ]
     ```
   - ou variável: `RTSP_SOURCES="Pátio=rtsp://...;Doca=rtsp://..."`
3. Suba o hub (`npm run dev` em `server/`). As câmeras IP aparecem na Central junto das de navegador.

Ajustes (env): `RTSP_FPS` (8), `RTSP_WIDTH` (480), `RTSP_QUALITY` (7, menor = melhor). Reconecta sozinho se o stream cair. `rtsp.sources.json` é gitignored (pode ter credenciais).

> Latência: a ponte ffmpeg→JPEG é simples e suficiente para a análise (não precisa 60fps). Para vídeo fluido de baixa latência em produção, o caminho é **WebRTC** via **go2rtc/mediamtx** (evolução).

## Arquitetura

- **Central processa tudo:** a câmera só transmite o feed (JPEG ~8fps via socket.io); o dashboard roda a IA (coco-ssd) e o pipeline de visão por câmera.
- **Pipeline reutilizável:** `src/CameraView.tsx` (modos `tile` e `full`) roda sobre qualquer fonte de frame; o modelo coco-ssd é carregado uma única vez (`src/vision/model.ts`).
- **Thresholds calibráveis:** `src/config.ts`.

## Privacidade (LGPD by design)

Sem upload persistente, sem reconhecimento facial, sem identificação individual. Pessoas recebem **IDs efêmeros** ("Pessoa N") que somem ao sair e resetam por sessão. Veja `docs/produto/avaliacao-reconhecimento-presenca.md`.

## Estado atual (o que este README acima NÃO cobre)

O texto acima descreve o MVP original (IA 100% no navegador). O produto evoluiu; o mapa curto
do que está no ar hoje — cada item com a doutrina/ADR que o explica:

| Capacidade | Onde roda | Como ligar | Fonte de verdade |
| --- | --- | --- | --- |
| **Motor de análise 24/7** (pessoas, atividade, fluxo) — D-FINE em worker process, independente de navegador aberto | hub | `ANALYSIS_ENABLED=1` (+ `ANALYSIS_MODEL=n\|s\|m`) | `server/analysis/README.md`, ADR-009 |
| **Vídeo por WebRTC** (fallback MJPEG automático) | sidecar go2rtc | automático pela presença de `bin/go2rtc[.exe]` (baixe com `node scripts/fetch-go2rtc.mjs`) | ADR-011 |
| **Ingest RTMP** de DVR/câmera que só faz PUSH (relay próprio na :1935) | hub | automático ao cadastrar câmera com URL `rtsp://127.0.0.1:8554/<canal>`; `RTMP_INGEST=go2rtc` volta ao legado | ADR-019, `docs/analises/rtmp-ingest/` |
| **Modos especializados** (Fadiga/MediaPipe, Leitura/ZXing, Objetos/OWL-ViT) | navegador | por zona, na UI | `docs/arquitetura/03-modos-operacao-processadores.md` |
| **Fadiga no hub** (sem navegador aberto) — YuNet + FaceMesh ONNX | hub | `ANALYSIS_FADIGA=1` (**F1a, em validação — default OFF**) | `docs/analises/spec-fadiga-no-hub.md` |

**Hub:** `npm run hub` (raiz) sobe o servidor na `:4000`. **Assets não versionados** (materializados
por script, nunca commitados): modelos do motor (baixados com sha256 no boot — `server/analysis/model.js`),
WASM+modelos MediaPipe (`npm run dev`/`build` chamam `scripts/fetch-mediapipe.mjs`), binário go2rtc
(`scripts/fetch-go2rtc.mjs`), e o estado de runtime (`server/cameras.json`, `camcfg.json`, `users.json`…).

## Docs

- **`CLAUDE.md`** — doutrina do projeto: invariantes que NÃO se violam (LGPD, contratos socket,
  regras de medição), stack, ciclo de desenvolvimento e o gate de verificação. **Leia antes de codar.**
- **`docs/arquitetura/`** (01–07) — arquitetura por tema, gerada do código. ⚠️ Escrita em jun/2026:
  onde disser "inferência no cliente" para pessoas/atividade/fluxo, vale a ADR-009 (motor no hub);
  não cobre ainda o relay RTMP (ADR-019) nem a fadiga no hub.
- **`docs/analises/decisoes/`** — ADRs (o índice diz quais vivem no repo irmão do BLE).
- **`docs/analises/implementacao-changelog.md`** — o que foi entregue, em ordem, com o porquê.
- **`docs/produto/COMO-USAMOS-IA.md`** — como a IA foi usada no projeto: onde entrou (código,
  testes, planejamento, ADRs, infra/CI-CD, operação, pesquisa, documentação), a divisão de decisão
  entre arquiteto e ferramenta, os portões de verificação, o tratamento de dado sensível, e os 7
  erros de IA capturados antes de causar dano. Versão em inglês:
  **`docs/produto/HOW-WE-USE-AI.md`**.
- **`docs/produto/deploy-atualizacao-2026-08.md`** — runbook da release atual. O caminho normal de
  publicação é o workflow `Deploy Homolog` (acionamento manual); as seções de comando manual são
  fallback.
- `docs/produto/PLANO-MVP.md` · `docs/produto/avaliacao-reconhecimento-presenca.md` (backlog original).
