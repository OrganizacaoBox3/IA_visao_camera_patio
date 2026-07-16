# ADR-019 — Relay RTMP próprio na frente do go2rtc (ingest de DVRs que o go2rtc não decodifica)

Data: 2026-07-16 · Status: aceito

## Contexto

O DVR Intelbras MHDX 1108 (site dydentro) publica RTMP nos canais `dydentro_cam05/07/08` do
homolog. O push chega (producer com `bytes_recv` ~5 MB medido) mas **nunca ganha tracks** —
nenhum vídeo forma. O mesmo push decodifica num receptor ffmpeg (prova de campo do integrador).

Causa, verificada no código-fonte do go2rtc v1.9.14 (a versão mais recente — sem upgrade
possível): `pkg/flv/producer.go::probe()` só cria track de vídeo se receber um **sequence
header formal** (tag legacy `PacketTypeAVCHeader`, ou enhanced-RTMP `SequenceStart` com fourCC
exclusivamente `hvc1`) em **até 5 s**; no timeout retorna **sem erro** e o producer nasce sem
medias, consumindo bytes para sempre. O ffmpeg extrai SPS/PPS inband e aceita eRTMP `avc1` —
por isso decodifica o que o go2rtc descarta. O ingest RTMP do go2rtc é declaradamente testado
só com OBS/Dahua.

Alternativas avaliadas: (a) MediaMTX na frente — binário extra ~25 MB numa VPS com disco a
99%, unit systemd novo em VPS compartilhada, e a tolerância do parser dele ao MHDX também é
incerta; (b) node-media-server no hub — 8 dependências (express, lodash…) para usar 5% da lib,
contra a doutrina da casa; (c) patch/fork do go2rtc — manutenção de fork por tempo indefinido.

## Decisão

Relay RTMP **próprio, zero dependências** (`server/rtmp-ingest.js`, node:net + node:http):

- O relay assume o listener **:1935** (o go2rtc deixa de escutar RTMP). Aceita o publish sem
  interpretar codec, cacheia `onMetaData` + sequence headers, e serve o FLV **verbatim** por
  HTTP em `127.0.0.1:8935/<canal>.flv`.
- Cada canal de ingest no `go2rtc.yaml` ganha a fonte
  `ffmpeg:http://127.0.0.1:8935/<canal>.flv#video=copy#audio=copy` — **o ffmpeg (o parser
  comprovado) faz o parse**, remux puro (`-c copy`, zero re-encode), e entrega RTSP ao go2rtc.
  Do RTSP em diante nada muda (WebRTC/JPEG/análise).
- O evento `publish` do relay alimenta o auto-cadastro **direto** (`rtmp-auto-enroll.onPublish`)
  — sem raspagem de log, e o vídeo forma na mesma sessão do DVR.
- Knob de rollback: `RTMP_INGEST=go2rtc` restaura o comportamento legado na íntegra.
- URLs dos publishers **não mudam** (mesma porta, mesmos nomes — os links da causei seguem
  válidos por contrato).

Prova antes do deploy (E2E local, go2rtc.exe real): push ffmpeg H.264 **e** H.265 →
relay → ffmpeg → go2rtc → `frame.jpeg` válido. Testes de unidade cobrem o protocolo
(handshake, chunking fmt0–3 com continuação, AMF0, substituição de sessão, caps).

## Consequências

- (+) O gargalo (parser RTMP do go2rtc) sai do caminho; qualquer FLV que o ffmpeg leia entra.
- (+) HEVC legacy (codec id 12) e enhanced-RTMP passam a funcionar de graça no caminho
  JPEG/análise (WebRTC H.265 continua limitado pelo browser — transcode é opt-in futuro).
- (+) Auto-cadastro fica determinístico (evento direto, não regex de log).
- (−) Um processo ffmpeg extra por canal ativo (remux; CPU ~zero, medido trivial no E2E).
- (−) O relay implementa um subconjunto do RTMP (publish only, sem acks de janela — o MHDX
  publica sem exigir, comprovado). Encoder exótico que exija acks precisará de ajuste.
- Parser incremental tem invariante anti-desalinhamento (nenhum estado muta antes de o chunk
  inteiro estar no buffer) — comprado com bug real no E2E, coberto por teste de continuação.
- Segurança inalterada: :1935 segue sem auth, gated por firewall por IP (runbook); HTTP-FLV
  amarrado a 127.0.0.1; caps de mensagem/sessões; LGPD (ADR-002) mantida — tudo em memória.
