# Spec — Relay de ingest RTMP próprio (na frente do go2rtc)

> 2026-07-16. Contexto vivo: canais `dydentro_cam05/07/08` (DVR Intelbras MHDX 1108, push RTMP)
> chegam ao go2rtc do homolog com bytes (producer `recv` ~5 MB medido) mas **zero tracks** — nenhum
> vídeo forma. O mesmo push decodifica normalmente num receptor ffmpeg (prova de campo: app de
> teste do integrador em fly.dev exibindo `dydentro_cam03` ao vivo, H.264 704×480).

## 1. Diagnóstico (evidência no código-fonte do go2rtc v1.9.14 — a versão mais recente)

O servidor RTMP do go2rtc converte o publish para FLV e monta o producer em
`pkg/flv/producer.go::probe()`:

- Só cria o track de vídeo se receber um **sequence header formal** — tag legacy com
  `packetType == AVCHeader` (codecID 7/H.264 ou 12/HEVC) **ou** enhanced-RTMP `SequenceStart`
  com fourCC **exclusivamente `hvc1`** (eRTMP `avc1`/H.264 estendido é descartado).
- O probe espera **no máximo 5 s**; no timeout retorna **sem erro** → o producer nasce sem
  medias e `Start()` segue consumindo (e descartando) pacotes para sempre. É exatamente o
  estado observado: `bytes_recv` crescendo, tracks vazios, nenhuma linha de erro no log.
- O ffmpeg, ao contrário, extrai SPS/PPS **de dentro do bitstream** (inband) e aceita eRTMP
  `avc1` — por isso o receptor do integrador funciona com o mesmo push.

Não há knob de config nem upgrade que resolva (1.9.14 é a última versão; ingest RTMP do
go2rtc é declaradamente testado só com OBS/Dahua).

## 2. Solução

Tirar o go2rtc do papel de **listener** RTMP e pôr um relay tolerante do nosso lado, com o
**ffmpeg** (o parser comprovado) fazendo o parse:

```
DVR ──rtmp :1935──▶ server/rtmp-ingest.js (hub, zero-dep)
                        │ (FLV cru, sem parse de codec)
                        ▼
                    HTTP-FLV 127.0.0.1:8935/<canal>.flv
                        │
                        ▼ (go2rtc spawna sob demanda)
                    ffmpeg -i … -c copy -f rtsp (fonte "exec:" do canal — o módulo
                    "ffmpeg:" do go2rtc recusa o ffmpeg 4.4.2 do Ubuntu 22.04)
                        │
                        ▼
                    go2rtc (RTSP/WebRTC/JPEG) ──▶ hub/análise/dashboard (INALTERADOS)
```

- O relay **não interpreta codec** — repassa tags FLV verbatim (H.264, HEVC legacy id 12,
  eRTMP, o que vier). Cacheia apenas `onMetaData` + sequence headers (se existirem) para
  reapresentá-los a consumidores que chegam no meio do stream.
- O ffmpeg (`-c copy`, remux puro, CPU ~zero) converte para RTSP dentro do go2rtc; daí em
  diante o pipeline atual (RTSP loopback → JPEG → relé/análise) não muda uma linha.
- Links dos publishers **não mudam**: mesma porta 1935, mesmos nomes de canal
  (`rtmp://cam.box3.software:1935/causei_camN` continua válido — invariante do cliente).

## 3. Critérios de aceite

- **Dado** um publish RTMP H.264 (com ou sem sequence header formal) num canal cadastrado,
  **quando** o hub está no ar, **então** `GET 127.0.0.1:8935/<canal>.flv` entrega FLV
  decodificável pelo ffmpeg e o stream do go2rtc ganha tracks (vídeo forma no painel).
- **Dado** um publish num canal **não** cadastrado com nome válido (`[A-Za-z0-9_-]{1,32}`),
  **quando** o auto-cadastro está ligado, **então** a câmera nasce sozinha (evento direto
  `publish` → rtmp-auto-enroll, sem raspagem de log) e o vídeo forma **na mesma sessão**
  (sem esperar reconexão do DVR).
- **Dado** um nome de canal fora do contrato, **então** a conexão é derrubada e nada é criado.
- **Dado** um segundo publish no mesmo canal, **então** a sessão antiga é substituída (o DVR
  que re-conecta após queda de rede não fica preso atrás de um socket morto).
- **Dado** `RTMP_INGEST=go2rtc` no ambiente, **então** o comportamento legado volta na íntegra
  (go2rtc escuta :1935, canais vazios no yaml, auto-enroll por log) — rollback sem redeploy de código.
- Caps de segurança ativos: mensagem ≤ 8 MB, ≤ 64 sessões, timeout de socket, HTTP-FLV só em
  127.0.0.1, backpressure derruba consumidor lento. LGPD: tudo em memória, zero disco.

## 4. Fora de escopo

- Autenticação do publish RTMP (defesa segue sendo firewall por IP na 1935 — runbook).
- Playback RTMP (o relay só aceita publish; consumo é HTTP-FLV local).
- Acks de janela RTMP (o MHDX publica sem exigir — comprovado pelos 5 MB recebidos pelo
  go2rtc, que também não envia acks).
- Enhanced-RTMP multitrack/reconexão avançada; gravação; transcode (HEVC segue por `-c copy`;
  se WebRTC H.265 for exigido no futuro, transcode é opt-in por câmera).
