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

Sem upload persistente, sem reconhecimento facial, sem identificação individual. Pessoas recebem **IDs efêmeros** ("Pessoa N") que somem ao sair e resetam por sessão. Veja `docs/avaliacao-reconhecimento-presenca.md`.

## Docs

`docs/PLANO-MVP.md` · `docs/avaliacao-reconhecimento-presenca.md`.
