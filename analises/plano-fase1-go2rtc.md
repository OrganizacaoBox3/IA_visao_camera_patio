# Plano Fase 1 — Transporte de vídeo via go2rtc/WebRTC (substituir MJPEG-canvas)

> Executa a **Fase 1** de `plano-retrofit-performance.md`: trocar o transporte de vídeo do
> MJPEG-sobre-socket.io por **WebRTC servido por go2rtc** (sidecar). Objetivo do gate:
> **≥24 fps estável, latência <500 ms, CPU cliente <50% de 1 core, câmera aberta fluida.**
> Princípio: **KISS = sidecar provado**, feature-flag, rollback = tile MJPEG antigo. **Nada aqui
> altera o comportamento default** até o flag ser ligado por câmera.
>
> **Este documento é plano + POC. Não implementa produção.** Aprovação do dono antes de codar.

## 0. Por que go2rtc (recap de 1 linha)

O `rtsp.js` reimplementa — pior — reconexão/backoff/health-check/resolução-de-binário/transporte-flex
que o **go2rtc** (Apache-2.0, 1 binário Go) entrega de graça, e ainda faz **codec-copy** (0 re-encode)
com saída **WebRTC/MSE/HLS/MJPEG auto-negociada** e decode por HW **fora da main-thread**. Trocamos
~500 linhas de gestão de ffmpeg frágil por 1 processo + 1 arquivo YAML. Fontes no rodapé.

---

## 1. Setup do sidecar

### 1.1 Portas (não colidem com o que já usamos)

| Serviço | Porta | Colide? |
|---|---|---|
| Hub Node (dev) | 4000 | — |
| Hub Node (prod, atrás do nginx) | 8091 | — |
| Vite dev | 5173 | — |
| **go2rtc API/UI/WebSocket-sinalização** | **1984** | não |
| **go2rtc RTSP restream** | **8554** | não |
| **go2rtc WebRTC (media, TCP+UDP)** | **8555** | não |

Defaults do go2rtc: API `:1984`, RTSP `:8554`, WebRTC `:8555` (TCP+UDP). Nenhuma colide.

### 1.2 `go2rtc.yaml` — câmeras do CD, codec-copy

```yaml
api:    { listen: ":1984" }   # UI + HTTP API + /api/ws (sinalização WebRTC)
rtsp:   { listen: ":8554" }   # restream RTSP (worker de análise lê daqui na Fase 3)
webrtc:
  listen: ":8555"             # media WebRTC. Em LAN, direto. Externo: abrir no firewall/candidates.
  # candidates:               # necessário só p/ acesso FORA da LAN do CD:
  #   - 10.0.0.20:8555        # IP do host go2rtc na LAN
  #   - stun:8555             # descobre IP público via STUN

streams:
  # Câmeras IP RTSP → codec-copy (0 re-encode): passe a URL crua, sem filtros.
  doca-carga:
    - rtsp://usuario:senha@10.0.0.50:554/Streaming/Channels/101   # Hikvision main-stream
  expedicao:
    - rtsp://usuario:senha@10.0.0.51:554/cam/realmonitor?channel=1&subtype=0  # Dahua/Intelbras

  # Câmeras HLS públicas (Gorizia/Pula/Mošćenička são .m3u8) — go2rtc lê HLS nativo:
  gorizia:
    - https://.../gorizia/playlist.m3u8

  # H.265/HEVC (Safari não toca HEVC em WebRTC) → transcode pontual só desta câmera:
  # cam-hevc:
  #   - rtsp://usuario:senha@10.0.0.52:554/cam/realmonitor?channel=1&subtype=0
  #   - ffmpeg:cam-hevc#video=h264
```

**Codec-copy** é o default: uma fonte RTSP crua não re-encoda. O `ffmpeg:NAME#video=h264` é opt-in
**por câmera** e só entra quando o codec da câmera não é aceito pelo browser (HEVC/H.265 em Safari).
Requer ffmpeg no host — que já temos (o `rtsp.js` resolve o binário; reaproveitar `FFMPEG_PATH`).

**Mapeamento das fontes atuais → go2rtc:** hoje as URLs vivem em `cameras.json` (dinâmicas) e
`rtsp.sources.json`/`RTSP_SOURCES` (legado). Um pequeno gerador (script de deploy, **fora do
caminho de produção**) lê essas fontes e emite o bloco `streams:` do YAML — o `id` da câmera vira
o nome do stream (chave), preservando o contrato de `id` que o front já usa.

### 1.3 Rodar como serviço

**Homolog Ubuntu 22.04 (systemd):**

```ini
# /etc/systemd/system/go2rtc.service
[Unit]
Description=go2rtc (gateway de vídeo WebRTC)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=go2rtc
ExecStart=/opt/go2rtc/go2rtc -config /opt/go2rtc/go2rtc.yaml
Restart=always
RestartSec=3
# Environment=FFMPEG_PATH=/usr/bin/ffmpeg   # se ffmpeg não estiver no PATH do serviço

[Install]
WantedBy=multi-user.target
```

```bash
# Instalação (binário único, sem deps):
sudo mkdir -p /opt/go2rtc && cd /opt/go2rtc
sudo curl -L -o go2rtc https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_amd64
sudo chmod +x go2rtc
# criar go2rtc.yaml (§1.2), usuário 'go2rtc', então:
sudo systemctl daemon-reload && sudo systemctl enable --now go2rtc
sudo systemctl status go2rtc
```

**Local Windows (dev):** baixar `go2rtc_win64.zip` do release, extrair, e rodar
`go2rtc.exe -config go2rtc.yaml`. Abre a UI em `http://localhost:1984/` para testar cada stream
(clicar no stream → aba `webrtc`). Sem systemd; para dev basta o processo no terminal (ou uma tarefa
agendada / `nssm` se quiser serviço). ffmpeg já resolvido pela máquina de dev (o `rtsp.js` acha).

---

## 2. Integração no front (feature-flag, rollback = tile antigo)

### 2.1 O web component `<video-stream>` (self-host, sem CDN)

go2rtc traz um custom element pronto no `www/`:

- **`video-rtc.js`** — classe base `VideoRTC` (nego­ciação WebRTC/MSE/HLS/MJPEG, WebSocket de sinal).
- **`video-stream.js`** — registra `customElements.define('video-stream', VideoStream)` e importa o base.

**Self-host (respeita `script-src 'self'`):** copiar esses 2 arquivos do release do go2rtc para o
repo (ex.: `src/vendor/go2rtc/`, com nota de versão/licença Apache-2.0) e importar como módulo — **sem
CDN**. Uso mínimo:

```html
<video-stream
  src="/go2rtc/api/ws?src=doca-carga"   <!-- WebSocket de sinalização; o setter http→ws sozinho -->
  mode="webrtc,mse,hls,mjpeg"           <!-- ordem de fallback (default do componente) -->
  background="false">                    <!-- pausa o stream fora de foco/aba -->
</video-stream>
```

Propriedades relevantes do `VideoRTC` (do `video-rtc.js`): `src` (aceita `/rel`, `http(s)://` ou
`ws(s)://` — converte para `ws` sozinho), `mode` (`"webrtc,mse,hls,mjpeg"`, ordem de prioridade),
`media` (`"video,audio"`), `background` (`false` = pausa invisível), `visibilityCheck`/`visibilityThreshold`
(pausa quando fora da viewport — casa com nossa paginação de 6 tiles: os fora da página não puxam vídeo).

### 2.2 Onde entra no MVP

`CameraTile.tsx` renderiza hoje `CameraWorkspace`/`FadigaView` que desenham o MJPEG num `<canvas>`
alimentado pelo `getFrame()` (frames do socket, decodificados em `ImageBitmap` no `DashboardPage`).
A Fase 1 introduz um **caminho alternativo de EXIBIÇÃO** no tile:

- **Flag OFF (default)** → tile atual (canvas + `getFrame`), **byte-a-byte inalterado**. Rollback.
- **Flag ON** → o tile monta `<video-stream src="/go2rtc/api/ws?src=<cameraId>">`. O `<canvas>` de
  overlay (caixas/zonas) fica **por cima**, transparente (Fase 2). Sem inferência local de vídeo.

Ponto de corte proposto (respeitando propriedade de arquivo — **NÃO implementado aqui**):
`CameraTile` escolhe entre `<CameraWorkspace>` (hoje) e um novo `<Go2rtcTile>` conforme o flag. O
`DashboardPage` já sabe o `cameraId` e a paginação — o `<video-stream>` reaproveita o mesmo conjunto
ativo (só monta os 6 da página; `visibilityCheck` reforça).

### 2.3 Feature-flag (por câmera **e** global) com rollback

- **Fonte do flag:** `cameraConfig`/`camcfg.json` já é per-câmera e sincroniza via `camcfg-updated`
  (ADR-006). Adicionar campo aditivo `transport?: "mjpeg" | "webrtc"` (default `"mjpeg"`). Um flag
  **global** (env `VITE_VIDEO_TRANSPORT=webrtc` ou toggle de superadmin) serve de override para
  ligar tudo de uma vez em homolog.
- **Rollback instantâneo:** virar o flag para `mjpeg` (por câmera ou global) remonta o tile antigo —
  o pipeline MJPEG/`rtsp.js` **continua vivo em paralelo** durante toda a Fase 1 (não removemos nada
  antes da Fase 3). Isto é o que torna a fase reversível.

### 2.4 CSP — o que liberar

Estratégia recomendada: **reverse-proxy do go2rtc sob a MESMA origem** (como já fazemos com
`/socket.io/` e `/api/`), ex.: `location /go2rtc/ → 127.0.0.1:1984` no nginx, com `Upgrade`/`Connection`
para o WebSocket. Efeito no CSP (prod, `deploy/nginx-visao.conf`):

- **Sinalização** (`/go2rtc/api/ws`, WebSocket): coberta por `connect-src` — o CSP atual **já tem
  `wss:` e `'self'`**, então same-origin proxied **não exige mudança**. Se optar por porta direta
  (`ws://host:1984`), aí sim adicionar `connect-src http://HOST:1984 ws://HOST:1984` (dev) /
  `wss://HOST:1984` (prod).
- **MSE (fallback):** usa `MediaSource` + `blob:` no `<video>` — `media-src blob:` **já liberado**.
- **MJPEG (fallback):** o componente puxa via a mesma WebSocket → `connect-src`; nada novo.
- **HLS (fallback):** `fetch` de `.m3u8/.ts` → coberto por `connect-src 'self'` (same-origin proxy).
- **Media WebRTC (SRTP/ICE na 8555):** **não é diretiva de fetch do CSP** (ICE/DTLS/SRTP) → CSP não
  interfere. Só precisa de rota de rede até a 8555 (LAN direta, ou `candidates`/proxy para externo).

Conclusão: **com reverse-proxy same-origin, o CSP praticamente não muda** — o `wss:`/`blob:`/`self`
que já existem cobrem tudo. Em **dev** (Vite `vite.config.ts`), o `connect-src` já tem `http: ws: wss:`,
então o `ws://localhost:1984` da POC funciona sem editar CSP.

### 2.5 Como o overlay (Fase 2) compõe — preview

`<video>` (dentro do `<video-stream>`) na base + `<canvas>` transparente por cima, mesma caixa,
`position:absolute; inset:0; pointer-events:none`. O canvas é alimentado pelos `analysis-tracks` do
hub (socket = **plano de controle**), com interpolação de bbox (Fase 2). O `<video-stream>` expõe o
`<video>` interno; o overlay não precisa do frame — só de geometria normalizada 0..1 (que os tracks
do hub já entregam). Isto **desacopla** a taxa de vídeo (24+ fps por HW) da taxa de detecção (1–2 fps
do hub), matando o "fantasma+miss" que era só dessincronização (§1.2 do plano-retrofit).

---

## 3. Worker de análise puxando do go2rtc (preview da Fase 3)

Hoje o worker de análise (ADR-009) consome os frames do **relé socket.io**. Na Fase 3 ele passa a ler
direto do go2rtc, que já tem o stream decodado e restreamado — **sem depender do relé**:

- **Opção A (snapshot pull @1–2 fps):** `GET http://127.0.0.1:1984/api/frame.jpeg?src=<cameraId>` no
  ritmo da análise (`ANALYSIS_FPS`). Simples, casa com o D-FINE que já roda a 1–2 fps; zero mudança no
  formato (continua JPEG, como hoje). **Recomendada** para começar.
- **Opção B (RTSP restream):** o worker abre `rtsp://127.0.0.1:8554/<cameraId>` via ffmpeg/decoder e
  amostra frames. Mais throughput, mais complexidade. Só se a Opção A não bastar.

Ganho: o hub deixa de ser o gargalo de frames; **go2rtc vira a fonte única** de pixels (front + worker),
e o relé socket.io fica **só para plano de controle** (cameras/status/tracks/camcfg). Frames seguem
efêmeros (pull em memória, sem persistir). Esboço apenas — detalhar na Fase 3.

---

## 4. Impacto no deploy

- **+1 processo** (`go2rtc.service`) por host de ingestão. Supervisão: `systemctl status go2rtc`,
  `Restart=always`, e healthcheck via `GET /api/streams` (lista status por stream — substitui nosso
  `camera-status` de RTSP na origem).
- **Runbook (atualizar `docs/deploy-atualizacao-2026-07.md` / `docs-regenerada/07`):** instalar binário,
  criar `go2rtc.yaml` (gerado das fontes atuais), abrir 8555 TCP+UDP no firewall da LAN do CD,
  adicionar `location /go2rtc/` no nginx (reverse-proxy same-origin), subir o serviço.
- **A APOSENTAR na Fase 3 (não agora):** a maquinaria `ffmpeg→MJPEG` do `server/rtsp.js`
  (reconnect/backoff/health-check/resolução-de-binário/drainFrames) e o relé de `frame` no
  `server/index.js`. Só depois de o WebRTC provar o gate e a Fase 3 mover o worker para o go2rtc.
  **Ordem:** flag ON em homolog → medir → default WebRTC → remover MJPEG (ADR novo). Líquido: **−~500
  linhas** de gestão frágil de ffmpeg, +1 YAML + 1 unit.
- **Dimensionamento:** codec-copy é barato (sem decode/encode no caminho de exibição). Transcode
  (`ffmpeg:...#video=h264`) só nas câmeras HEVC → orçar CPU só para essas.

---

## 5. Invariantes preservados / riscos

- **ADR-002 (LGPD / frames efêmeros):** go2rtc **relaya/remuxa, não persiste** — sem `record:`/
  gravação em disco configurados. Frames seguem efêmeros em memória. Cine-loop continua **buffer em
  memória no cliente** — agora capturado do `<video>` (canvas/`MediaRecorder`), ainda download local
  manual, nunca ao servidor. **Intacto.** (Garantir: **não** configurar módulo de gravação no YAML.)
- **ADR-007 (casca fullscreen NÃO vira Radix Dialog):** com WebRTC o vídeo passa a ser `<video>`
  nativo e o `<canvas>` vira **só overlay** — a remontagem **simplifica** (o `<video>` mantém o stream
  entre re-layouts; não há rAF de decode a preservar). O trap de foco manual e o editor de zonas
  **precisam ser revalidados** contra o novo composite `<video>`+`<canvas>` antes de generalizar (a
  casca continua sem Portal/scroll-lock).
- **Contratos socket aditivos:** socket **deixa de transportar `frame`** quando o flag está ON, mas
  **continua** como plano de controle (`cameras`, `camera-status`, `analysis-tracks`, `camcfg-updated`,
  etc.). Nenhum evento é removido/quebrado — o `frame` só deixa de ser **assinado** (via `watch`) pelo
  tile WebRTC. Hub antigo/flag OFF → tudo idêntico ao atual.
- **Riscos declarados:**
  - **Safari + H.265/HEVC:** Safari não decoda HEVC em WebRTC → transcode pontual por câmera
    (`ffmpeg:NAME#video=h264`), custo de CPU só nessas. Câmeras H.264 (maioria) = copy puro.
  - **Firewall/NAT:** WebRTC precisa da 8555 (TCP+UDP) alcançável. Em LAN do CD, direto. Externo exige
    `candidates`/STUN — fora do escopo da Fase 1 (operação é intra-LAN).
  - **Webcam do navegador → go2rtc:** os nós webcam (`/camera`) continuam no caminho socket.io na
    Fase 1 (não são RTSP). Migrá-los para **WHIP** (`getUserMedia`+`RTCPeerConnection` → go2rtc) é a
    **Fase 5**, a parte não-trivial — deliberadamente adiada.
  - **Dependência nativa:** go2rtc é binário Go estático (sem deps de runtime); ffmpeg só é exigido se
    houver transcode — e já está no host.

---

## 6. POC mínima de 1 câmera (~30 min, o dono vê a fluidez)

Arquivos prontos em `scratchpad/poc/` (`go2rtc.yaml` + `index.html` + os 2 `.js` do go2rtc). **Nada
toca o MVP.**

1. **Baixar o binário** (Windows dev): pegar `go2rtc_win64.zip` do
   `github.com/AlexxIT/go2rtc/releases/latest`, extrair `go2rtc.exe`.
2. **Editar `scratchpad/poc/go2rtc.yaml`**: em `streams: cam-teste:` pôr a URL RTSP real de **uma**
   câmera (ou, sem câmera do CD, usar `demo-hls` com uma URL `.m3u8` pública).
3. **Subir o go2rtc:** `go2rtc.exe -config go2rtc.yaml`. Abrir `http://localhost:1984/`, clicar no
   stream, aba **`webrtc`** — deve aparecer vídeo fluido (é a prova nº 1, sem front nenhum).
4. **Copiar os 2 web components** para `scratchpad/poc/`:
   `curl -L -o video-stream.js https://raw.githubusercontent.com/AlexxIT/go2rtc/master/www/video-stream.js`
   e idem `video-rtc.js`.
5. **Servir a página POC:** na pasta, `python -m http.server 9000` → abrir `http://localhost:9000/`.
   O `<video-stream>` negocia WebRTC sozinho e mostra o vídeo em tela cheia.
6. **Medir (o gate):** DevTools → `chrome://webrtc-internals` (fps de decode, framesDropped, jitter);
   Task Manager para CPU do browser. Comparar lado-a-lado com o tile MJPEG atual do MVP.
   **Sucesso = ≥24 fps, latência sub-segundo, CPU baixa, sem "trava-e-pula".**

---

## Fontes

- go2rtc — repositório e README (config `streams`, codec-copy, ports, deploy): https://github.com/AlexxIT/go2rtc
- go2rtc — Configuration (Wiki): https://github.com/AlexxIT/go2rtc/wiki/Configuration
- go2rtc — WebRTC internals (porta 8555 TCP+UDP, `candidates`, STUN/TURN, WHEP): https://go2rtc.org/internal/webrtc/
- go2rtc — HTTP API (`/api/frame.jpeg`, `/api/stream.mjpeg`, `/api/webrtc` WHEP, `/api/ws`, RTSP `:8554`): https://go2rtc.org/internal/api/
- go2rtc — web components `video-stream.js` / `video-rtc.js` (www/): https://github.com/AlexxIT/go2rtc/tree/master/www
- Frigate — Configuring go2rtc (codec-copy vs `ffmpeg:NAME#video=h264#hardware`): https://docs.frigate.video/guides/configuring_go2rtc/
- Tutorial go2rtc (portas 1984/8554/8555, WebUI): https://webrtc.link/en/articles/go2rtc-ultimate-streaming-solution/
