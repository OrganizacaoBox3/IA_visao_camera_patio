# Frente A — DOTs e agregadores oficiais (feeds públicos CFTV para teste de visão computacional)

> Objetivo: feeds **estáveis** com cara de CFTV de rua/pátio (ângulo alto fixo, pessoas/veículos em
> movimento, diurno no horário BR) para exercitar detecção de PESSOAS/veículos.
> Fronteira ética respeitada: **somente feeds que o proprietário publicou de propósito para o público.**
> Nada de Shodan/Censys/insecam, nada de RTSP com user:pass, nada de "adivinhar" endpoint de device.

## Resumo executivo

- **11 streams HLS validados 2x** (sonda em 2 rodadas, ~65 s de intervalo, no dia 2026-07-06,
  13:43–13:51 PDT ≈ 17:43 BRT — pleno dia). Todos **H.264**, ingestão direta por ffmpeg.
- Fonte única: **Caltrans Commercial Wholesale Web Portal (CWWP)** — `cwwp2.dot.ca.gov`, portal
  oficial da Caltrans que publica os `streamingVideoURL` **para redistribuição pública/comercial**.
  Proveniência limpa: os URLs vêm do JSON oficial da agência, **sem adivinhação e sem token de auth**.
- Amplia os 3 já validados antes (wzmedia D3/D4 + NYSDOT) para **5 distritos Caltrans**:
  **D3 (Sacramento), D4 (Bay Area/SF), D7 (Los Angeles), D8 (Riverside/San Bernardino), D11 (San Diego)**.
- Destaque para **PESSOAS**: `Q` (El Cajon Blvd, San Diego) é uma **interseção de rua** com pedestres na
  faixa + carros + ônibus escolar + semáforos — o cenário "CFTV de rua" ideal.

## Por que HLS token-free (checagem da regra)

O `playlist.m3u8` (master) referencia o media playlist **inline**: `chunklist_w<NNNN>.m3u8`. O `w<NNNN>`
é gerado/servido pela **origem** (não é token de cliente). Não há query param de auth. Confirmado por
`curl`: master → 200, chunklist → 200, segmento `.ts` baixa direto. É o oposto de FL511/GDOT (que exigem
token na query e por isso foram descartados).

## Método de validação (o que foi feito, de verdade)

1. `ffprobe -version` confirmado (8.1.2). `curl`/`ffmpeg` presentes.
2. Puxado o JSON oficial de CCTV de cada distrito (`cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json`);
   extraído `streamingVideoURL` + `currentImageURL` + `locationName` dos câmeras `inService`.
3. **Conteúdo:** baixado o snapshot estático (`currentImageURL`, mesma câmera do stream) e inspecionado
   visualmente — descartados os "Temporarily Unavailable" e os sem veículos/movimento.
4. **Liveness 2x:** para cada candidato, `curl` no `playlist.m3u8` → resolve `chunklist` → baixa o **último
   segmento `.ts`** + lê `#EXT-X-MEDIA-SEQUENCE`. **Repetido ~65 s depois.** Aprovado só quando a sequência
   **avançou** (~16 segmentos/65 s ⇒ segmentos ~4 s, rolando ao vivo) nas duas rodadas.
5. **Prova de ponta a ponta:** extraído frame do `.ts` baixado (não do snapshot) — a cena CFTV aparece no
   vídeo decodificado, com timestamp do horário corrente.

## Streams aprovados (2x) — prontos para ingestão

| # | ID | Local | Stream (HLS `.m3u8`) | Codec/Res | Conteúdo |
|---|----|-------|----------------------|-----------|----------|
| 1 | A | Sacramento, Hwy 80 @ Northgate Blvd (D3) | `https://wzmedia.dot.ca.gov/D3/80_Northgate_Blvd_JWO_SAC80_MD.stream/playlist.m3u8` | h264 720x480@30 | rodovia, carros/caminhões |
| 2 | B | San Francisco, US-101 @ S Van Ness Ave (D4) | `https://wzmedia.dot.ca.gov/D4/S101_at_S_Van_Ness_Av.stream/playlist.m3u8` | h264 352x240 | via elevada urbana, tráfego denso (baixa-res; galhos no topo) |
| 3 | C | San Francisco, US-101 @ Octavia St (D4) | `https://wzmedia.dot.ca.gov/D4/S101_at_Octavia_St.stream/playlist.m3u8` | h264 352x240 | entroncamento urbano, carros (baixa-res) |
| 4 | E | San Francisco, I-80 Bay Bridge SAS Tower (D4) | `https://wzmedia.dot.ca.gov/D4/W80_at_SAS_Tower.stream/playlist.m3u8` | h264 720x480@30 | tabuleiro de ponte, carros (sem pedestres) |
| 5 | F | Los Angeles, US-101 @ Hollywood Blvd (D7) | `https://wzmedia.dot.ca.gov/D7/CCTV-607.stream/playlist.m3u8` | h264 768x432@15 | rodovia c/ passagem inferior, carros |
| 6 | G | Los Angeles, I-110 N/O Exposition Blvd — USC (D7) | `https://wzmedia.dot.ca.gov/D7/CCTV-178.stream/playlist.m3u8` | h264 **1920x1080**@15 | rodovia movimentada + skyline centro (FULL HD) |
| 7 | I | Los Angeles, I-110 @ MLK Blvd (D7) | `https://wzmedia.dot.ca.gov/D7/CCTV-177.stream/playlist.m3u8` | h264 **1280x720**@15 | rodovia cheia, muitos veículos + skyline |
| 8 | L | Riverside, SR-60 @ Main St (D8) | `https://wzmedia.dot.ca.gov/D8/LB-8_60_363.stream/playlist.m3u8` | h264 768x432@30 | rodovia + via marginal, tráfego mais leve |
| 9 | M | Riverside, SR-60 @ Market St (D8) | `https://wzmedia.dot.ca.gov/D8/LB-8_60_362.stream/playlist.m3u8` | h264 768x432@30 | rodovia movimentada c/ caminhões |
| 10 | P | San Diego, I-805 @ Mira Mesa Blvd (D11) | `https://wzmedia.dot.ca.gov/D11/C149_NB_805_at_Mira_Mesa_Blvd.stream/playlist.m3u8` | h264 1280x1024@30 | curva de rodovia, veículos |
| 11 | **Q** | **San Diego, El Cajon Blvd — interseção (D11)** | `https://wzmedia.dot.ca.gov/D11/C291_NB_15_at_El_Cajon_Blvd.stream/playlist.m3u8` | h264 720x480@30 | **interseção de rua: PEDESTRES na faixa + carros + ônibus + semáforos** |

### Lista pura (para colar no app)

```
https://wzmedia.dot.ca.gov/D3/80_Northgate_Blvd_JWO_SAC80_MD.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D4/S101_at_S_Van_Ness_Av.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D4/S101_at_Octavia_St.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D4/W80_at_SAS_Tower.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D7/CCTV-607.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D7/CCTV-178.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D7/CCTV-177.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D8/LB-8_60_363.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D8/LB-8_60_362.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D11/C149_NB_805_at_Mira_Mesa_Blvd.stream/playlist.m3u8
https://wzmedia.dot.ca.gov/D11/C291_NB_15_at_El_Cajon_Blvd.stream/playlist.m3u8
```

Teste rápido de ingestão:
`ffmpeg -i "<url>.m3u8" -frames:v 1 out.jpg` (ou `ffprobe -rtsp_transport tcp` não se aplica; é HLS puro).

## Reprovados / descartados (com motivo)

- **N — San Diego, I-15 @ El Cajon Blvd (C074)**: era uma ótima cena de interseção com pedestres, mas o
  **HLS reprovou nas 2 sondas** — `HTTP 000` (conexão resetada) e depois `HTTP 404`. O snapshot estático
  vive em outro host e continua no ar, mas **o stream de vídeo não está publicado**. Fora.
- **O — San Diego, I-8 @ Morena Blvd (C007)**: idem, HLS `000`/`404` nas 2 rodadas. Fora.
- **D, H, J, K, S, T** (I-580 Oakland; I-10 Lincoln Blvd; I-405 Santa Monica Blvd; US-101 N of I-110;
  I-15 University Ave; SB-5 30th St): snapshot **"Temporarily Unavailable"** — câmera fora do ar. Fora.
- **Ontario 511** (`511on.ca`): API retorna **apenas URLs de snapshot JPEG**, não há stream de vídeo. Fora.
- **Houston TranStar**: **não oferece vídeo público** (feed único cedido só a veículos de imprensa). Fora.
- **TxDOT ITS (Austin)**: o player usa **HLS com token de sessão** (tokens longos embutidos na página SPA),
  não é `playlist.m3u8` público limpo — viola a regra "sem token". Fora.
- **TfL / Transport Scotland (UK)**: (a) UK está ~UTC+1; no horário desta sonda era ~21:40 local = crepúsculo/noite
  em julho → falha "diurno"; (b) TfL JamCams são clipes curtos de snapshot, não HLS contínuo. Fora desta rodada.

## Caveats (honestidade técnica)

1. **PTZ:** câmeras Caltrans são PTZ; operadores podem reapontar. O enquadramento exato (sobretudo a
   interseção do `Q` e a ponte do `E`) pode mudar. O `Q` está num preset dedicado "Traffic Vision Position",
   que tende a ficar fixo — mas não há garantia contratual.
2. **Load balancer flaky:** o `wzmedia.dot.ca.gov` ocasionalmente devolve 403/reset em algum nó (documentado
   pela própria comunidade). Todos os 11 passaram 2 sondas, mas o ffmpeg deve ter retry/reconnect ligado.
3. **Baixa resolução:** `B` e `C` são 352x240 (moles para detecção). Para mais detalhe, prefira
   `G` (1080p), `I` (720p), `P` (1280x1024), e `A`/`E`/`Q` (720x480).
4. **Fuso/diurno:** validados às 13:43–13:51 PDT (Califórnia, UTC-7) = 17:43 BRT. A janela diurna dessas
   câmeras (~07:00–17:00 local) cai em ~11:00–21:00 BRT. Em horário comercial BR (09:00–18:00 BRT =
   05:00–14:00 PDT) estão de dia. Antes das ~10:00 BRT ainda é madrugada/amanhecer lá.
5. **Pessoas:** só o `Q` é interseção de rua com pedestres garantidos; os demais são rodovia (veículos com
   movimento real, pouca ou nenhuma pessoa). Para stress-test de PESSOAS, o `Q` é o principal.

## Evidências (arquivos de trabalho — efêmeros, no scratchpad da sessão)

- Sondas: `probe_r1.txt`, `probe_r2.txt` (2 rodadas, sequência avançando).
- ffprobe por segmento `.ts` baixado.
- Frames extraídos do `.ts` (não do snapshot) confirmando a cena no vídeo decodificado.
