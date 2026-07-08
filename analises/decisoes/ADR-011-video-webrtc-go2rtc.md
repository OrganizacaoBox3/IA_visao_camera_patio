# ADR-011 — Vídeo por WebRTC via go2rtc empacotado (ativação por presença, fallback MJPEG)

**Status:** aceito · **Data:** 2026-07-08 (ADR escrito retroativamente — decisão implementada na "Onda 2 go2rtc",
~jun/2026; ver `analises/plano-fase1-go2rtc.md`).

## Contexto

O relé de vídeo original era **MJPEG sobre Socket.IO**: o hub decodifica os frames e reenvia como JPEG ao
navegador. Funciona e é o que sustenta o fallback, mas é **caro e limitado** — re-encode por quadro (~2-6 Mbps/
câmera **com perda**) e fluidez baixa (12 fps). Para vídeo fluido de câmera RTSP **H.264**, o certo é **codec-copy**
(repassar o stream sem re-encode). Além disso o motor de análise (ADR-009) já roda no hub e precisa de frames
independentemente de quem assiste — o transporte de **vídeo** (para o olho) e o de **frames** (para o motor) são
problemas distintos que não devem se acoplar.

## Decisão

Adotar **go2rtc** (gateway de streaming; binário único multiplataforma) como sidecar de vídeo do hub:

- **Empacotado no release:** o binário vai em `bin/go2rtc[.exe]` — **gitignored** (artefato de deploy, não de
  código; baixado por `scripts/fetch-go2rtc.mjs`, subido no CD/WinSCP).
- **Ativação por PRESENÇA, não por flag:** o hub liga o sidecar **sozinho** ao encontrar `bin/go2rtc` (`server/
  go2rtc.js`). "Recurso liga pela presença do artefato empacotado" (lição 05.1) — sem flag a esquecer. Escape hatch
  único: `GO2RTC_ENABLED=0`.
- **Vídeo por WebRTC codec-copy** quando o gateway está no ar; **FALLBACK MJPEG automático POR CÂMERA** quando o
  WebRTC não estabelece (rede/candidato ICE). Degradação graciosa, nunca-cego.
- **Overlays desacoplados do vídeo:** as caixas/indicadores NÃO são queimados no vídeo — vão à parte via o contrato
  socket `analysis-tracks` (aditivo). O cliente compõe overlay sobre o vídeo.
- **Frames para o motor via pull:** com o go2rtc ativo, o motor puxa `GET /api/frame.jpeg?src=<id>` (~1 fps) para o
  mesmo `st.latest` (`server/analysis/go2rtc-source.js`); anti-dobra: só puxa câmera cujo relé parou.

## Consequências

- **+** Vídeo fluido H.264 **sem re-encode** — fim do custo de CPU do relé MJPEG e da perda de qualidade; o mesmo
  codec-copy é a base do conector de site (ADR-010).
- **+** Ativação **zero-config** (presença do binário) e degradação por câmera (MJPEG) — nunca-cego no transporte.
- **+** Vídeo e metadados **desacoplados** (contrato `analysis-tracks` aditivo) — cada um evolui sem quebrar o outro.
- **−** +1 processo sidecar gerido pelo hub (start/stop/swap atômico no deploy — trata `ETXTBSY`) e +1 binário no
  release (não versionado). go2rtc faz **listen em todas as interfaces** por padrão → **endurecer** (bind na interface
  do túnel + firewall) em edge/site de cliente (ADR-010).
- **−** WebRTC **pela internet pública** exige portas de mídia (8555 TCP+UDP) roteáveis **ou**
  `GO2RTC_WEBRTC_CANDIDATES` com IP público — **não fecha por padrão fora da LAN** (medido no cenário do celular; ver
  `docs/deploy-atualizacao-2026-07.md`). Na LAN do CD é direto.
- **Risco declarado:** a **licença do go2rtc** é critério eliminatório para redistribuição a clientes (lição 03.3) —
  **confirmar antes** de empacotar em produto comercial. Como é sidecar (processo separado, sem linkagem de código),
  o risco é menor que o de uma dependência linkada, mas a confirmação é pendência.
