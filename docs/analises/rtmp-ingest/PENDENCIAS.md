# Pendências — Ingest RTMP (câmera empurra pro hub)

> **Doc vivo.** Diretriz do usuário: manter pendências registradas.
> Última atualização: 2026-07-09 (ingest assado no hub; restam as pendências de infra do homolog).

## Contexto (validado em campo)

Câmera IP **Intelbras** (`192.168.1.28`) que **empurra** o vídeo via **RTMP push** (não RTSP pull).
Descoberto em campo: o firmware Intelbras/Dahua **força o app/stream `live`** (ignora o caminho digitado
na URL) — o push chega em `rtmp://<host>:1935/live`. Provado ponta a ponta: câmera → go2rtc (listener
RTMP `:1935` + stream `live` vazio que aceita publish) → republish RTSP 1080p20 + áudio AAC → snapshot
JPEG real capturado. A rede: PC e câmera no mesmo `/24` (`192.168.1.0/24`), push direto sem isolamento.

## Feito

- **Listener RTMP assado no hub** (`server/go2rtc.js`, `generateYaml`). Design implementado:
  uma câmera cadastrada com URL **self-referente** `rtsp://127.0.0.1:8554/<nome>` (apontando pro
  PRÓPRIO republish do go2rtc do hub) **declara** que `<nome>` é canal de ingest — o go2rtc então
  (a) abre o listener RTMP `:1935` e (b) cria um stream **vazio** `<nome>` que **aceita** o publish.
  A câmera empurra `rtmp://<host>:1935/<nome>`. **Zero env/config no servidor** — a própria URL do
  cadastro (estado de runtime) liga o ingest; o listener só abre quando existe canal de ingest.
  (Porta muda por `GO2RTC_RTMP_PORT` se um dia for preciso; default 1935.)
- Isso dispensou o "modelo de câmera RTMP-in" no CRUD: a câmera rtmp-in é um **cadastro comum**
  em `/cameras` com a URL self-referente — análise/MJPEG (rtsp.js) fazem pull dela normalmente.
- **Validado em campo (jul/08) no go2rtc LATERAL de validação** (scratchpad, NÃO o do hub):
  Intelbras `192.168.1.28` empurrou (firmware forçou o app `live`), go2rtc recebeu, republish RTSP
  1080p + áudio AAC, tile no painel via cadastro `rtsp://127.0.0.1:8560/live`; snapshot real capturado.
- **VALIDADO NO HOMOLOG (jul/09)** — commit `3251a7c`, deploy Actions success. Câmera Intelbras real
  empurrou pra `rtmp://cam.box3.software:1935/causei_cam1` → go2rtc DO HUB recebeu (h264 1080p20 +
  AAC); confirmado **da rede** por playback RTMP (`ffprobe rtmp://cam.box3.software:1935/causei_cam1`)
  e frame ao vivo capturado remotamente. **Esta câmera RESPEITOU o path `causei_cam1`** (não forçou
  `live`) — o padrão `causei_camN` funciona pra ela.
- Teste unit do `generateYaml` (URL self-referente → `rtmp: listen:` + stream vazio): FEITO.
- Runbook de homolog escrito: [`deploy-homolog-rtmp.md`](deploy-homolog-rtmp.md).
- Infra homolog LIGADA: DNS `cam.box3.software` → 137.184.183.179, dashboard https 200 (nginx+TLS já
  serviam o domínio), porta 1935 acende com o cadastro da câmera.

## Pendente

1. **Endurecer o firewall da 1935** (P1 de segurança): hoje a 1935 aceitou conexão do mundo
   (RTMP publish do go2rtc é **SEM auth** → qualquer um que saiba o nome do canal pode empurrar).
   Restringir a porta ao(s) **IP(s) público(s) de origem das câmeras** (ufw / firewall do DO).
2. **Cadastrar cam2..6** conforme forem sendo apontadas: `rtsp://127.0.0.1:8554/causei_camN` no painel
   + push da câmera pro mesmo `causei_camN` (confirmar caso a caso se o firmware respeita o path ou força `live`).
3. **Contrato device**: Intelbras/Dahua força app `live` (documentado aqui e no runbook). Falta conferir
   se outros modelos usam chave configurável (aí cada câmera poderia ter seu `causei_camN`).

## Nota de rede/segurança

- Push exige **logar na câmera 1×** p/ configurar o destino RTMP (mesmo com "sem senha" aparente — o
  RTSP deu 401; o app guarda a credencial).
- Câmera e hub precisam se alcançar (mesmo `/24` resolve; remoto/NAT é o caso do [[conector-de-site-edge-gateway]]).
