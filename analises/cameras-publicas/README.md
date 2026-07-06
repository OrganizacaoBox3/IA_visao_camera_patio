# Câmeras públicas para teste do MVP de visão computacional

> Objetivo: feeds ESTÁVEIS, que **parecem CFTV de pátio** (ângulo alto fixo), com **pessoas e/ou
> veículos** em movimento real, **diurnos no horário BR (UTC-3)**, para exercitar o detector
> (D-FINE) de PESSOAS/veículos. Ingestão via ffmpeg: RTSP / HLS (.m3u8) / MJPEG.
>
> Data da sondagem: **2026-07-06**, ~17:44–18:00 BRT (20:44–21:00 UTC). Ferramentas: `ffprobe/ffmpeg
> 8.1.2`, `curl 7.81`. Sondagem feita **a partir desta máquina, no Brasil** — que é exatamente o
> teste de alcance que importa (o hub roda no Brasil).

## Fronteira ética aplicada

Só entram feeds que o **proprietário publicou de propósito para o público**: DOT / trânsito, turismo
oficial, portais de órgão. **Nada** de Shodan/Censys/insecam, nada de RTSP com `user:pass`, nada de
"adivinhar endpoint de device". Todos os aprovados abaixo saem de um **portal público oficial**
(511la.org — Louisiana DOTD) e usam **.m3u8 sem token**, URL colável e estável.

## Método de validação (por que confiar)

Cada candidato foi sondado **2x com intervalo real** (a flaky reprova na 2ª — foi assim que as
whatsupcams caíram). Para HLS a sonda foi de ponta a ponta:

1. `curl` no `playlist.m3u8` (master) → confirma HTTP 200 e lê a `RESOLUTION`.
2. `curl` no `chunklist` → lê `#EXT-X-MEDIA-SEQUENCE`.
3. `curl` baixa **1 segmento .ts** real → confirma bytes > 0.
4. `ffprobe` no .ts → confirma `codec_name/width/height/fps`.
5. **Prova de "ao vivo"**: repetir e verificar que a `MEDIA-SEQUENCE` **avançou** entre rodadas.
6. `ffmpeg -frames:v 1` → 1 quadro JPEG inspecionado visualmente (ângulo, conteúdo, diurno).

## Aprovados (VIVOS) — Louisiana DOTD (511la.org), .m3u8 sem token

Publicador único oficial: **Louisiana DOTD**, catálogo público em `https://511la.org/cctv`
(336 câmeras, 3 hosts: `ITSStreamingBR`, `ITSStreamingBR2`, `ITSStreamingNO` — todos alcançáveis do
Brasil). Codec **H.264, 15 fps**. Timestamp on-screen confirma diurno ao vivo.

| # | URL (.m3u8) | Local / cena | Res | Conteúdo |
|---|-------------|--------------|-----|----------|
| 1 | `https://ITSStreamingNO.dotd.la.gov/public/hou-cam-003.streams/playlist.m3u8` | LA-24 × LA-182, Houma | 480x270 | **Interseção urbana movimentada** — carros/picapes/caminhão, faixas de pedestre, semáforos, comércio. Melhor "pessoas + veículos". |
| 2 | `https://ITSStreamingNO.dotd.la.gov/public/hou-cam-008.streams/playlist.m3u8` | LA-3040 × St. Charles, Houma | 352x240 | Interseção urbana, tráfego + faixas de pedestre. |
| 3 | `https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-010.streams/playlist.m3u8` | I-20 × Common St., Shreveport | 352x240 | Rodovia + alças urbanas, fluxo denso de veículos. |
| 4 | `https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-001.streams/playlist.m3u8` | I-20 × I-226 HUB, Shreveport | 352x240 | Rodovia reta, veículos, ângulo alto fixo. |
| 5 | `https://ITSStreamingBR2.dotd.la.gov/public/shr-cam-030.streams/playlist.m3u8` | I-20 × I-220 Off Ramp, Shreveport | 352x240 | Interchange, veículos. |
| 6 | `https://ITSStreamingNO.dotd.la.gov/public/nor-cam-104.streams/playlist.m3u8` | I-610 perto do City Park, New Orleans | 352x240 | Rodovia urbana, veículos. |

Para mais câmeras do mesmo catálogo (mesmo padrão de URL), a lista completa sai de:

```
curl -s -H "Content-Type: application/json" -X POST "https://511la.org/List/GetData/Cameras" \
  --data '{"columns":[],"order":[],"start":0,"length":400,"search":{"value":"","regex":false}}'
```

Cada item traz `images[0].videoUrl` (o `.m3u8`), `location`, `roadway`, `direction`, `latLng`.
As "hou-cam-*" (Houma) e algumas "nor-cam-*" são arteriais urbanas (mais pedestres); as "shr-cam-*",
"ns-cam-*" e a maioria das "nor-cam-*" são rodovia (veículos).

## Reprovados / descartados (MORTOS) — e por quê (honestidade técnica)

| Fonte | Motivo do descarte |
|-------|--------------------|
| **Georgia 511** (`vss1live.dot.ga.gov`) | Conexão recusada/timeout **do Brasil** (geobloqueio p/ fora dos EUA). |
| **Caltrans** (`wzmedia.dot.ca.gov`) | `http=000` do Brasil (geobloqueio). |
| **HDOnTap** (`live.hdontap.com`) | `.m3u8` com **token dinâmico** (`?t=…&e=` expira em ~13 h); sem token → 403. URL não estável. |
| **Skyline / Windy** | Token dinâmico embutido; URL não colável/estável (regra do projeto). |
| **webcamsdemexico** (`.net/<cam>/live.jpg`) | JPEG **único e estático** (Last-Modified 2024), **não** é multipart MJPEG; streams "ao vivo" são embed de YouTube. Não ingerível. |
| **Jackson Hole Town Square** (SeeJH) | Só YouTube — não ingerível direto por ffmpeg. |
| **Ocean City / Myrtle / Atlantic City boardwalks** | Vimeo / EarthCam / player JS; sem `.m3u8` colável. |
| **Portais municipais BR** (Barueri, Niterói/Nittrans, São Caetano, camerasRJ, CET) | SPAs JS; sem `.m3u8` extraível do HTML; player proprietário/tokenizado. |

## Caveats (declarar risco residual)

- **Publicador único.** Todos os aprovados são LADOTD. Se o órgão cair, caem juntos. Diversificar
  publicador ficou **inviável** hoje: as fontes ricas em *pessoas* (calçadão/praça/porto) estão quase
  todas em agregadores tokenizados (EarthCam/Skyline/HDOnTap) ou YouTube/Vimeo — reprovadas pela
  fronteira ética/estabilidade — e os DOTs de vídeo dos EUA em geral **geobloqueiam o Brasil**
  (GA, CA confirmados). Louisiana DOTD é a exceção que serve `.m3u8` limpo e alcançável.
- **Pessoas x veículos.** DOT estadual cobre rodovia/arterial → **muito veículo, pouco pedestre**.
  As interseções urbanas de Houma (hou-cam-003/008) são as que mais pegam pedestres (faixas).
- **Resolução baixa** (352x240; Houma 480x270). Ótimo p/ *presença* de veículo; para pessoas
  pequenas/distantes o recall cai — considerar `ANALYSIS_MODEL=s|m` (ADR-009) nesses feeds.
- **Fuso/diurno.** LADOTD (CDT, UTC-5) fica ~2 h "atrás" do BR: quando escurece no BR, ainda há luz
  lá — cobre bem a **tarde/noite BR**; de manhã BR também está claro. Bom para 24/7 no horário BR.
- **LGPD:** nenhum frame é persistido pelo hub (só metadados/indicadores) — os JPEGs desta sondagem
  são efêmeros em `scratchpad`, não no servidor. Feeds são de terceiros públicos.

## Prova de "ao vivo" (MEDIA-SEQUENCE avançou entre rodadas)

Round-2 @ 20:55:36Z e Round-3 @ 20:57:46Z UTC (gap ~2min10s). Segmento ~12 s → +~11 esperado.

| Câmera | R2 seq | R3 seq | Δ | Veredito |
|--------|--------|--------|---|----------|
| hou-cam-003 (Houma) | 6362 | 6373 | +11 | vivo |
| hou-cam-008 (Houma) | 6374 | 6385 | +11 | vivo |
| nor-cam-104 (NOLA)  | 6364 | 6379 | +15 | vivo |
| shr-cam-001 (Shrev) | 20474 | 20486 | +12 | vivo |
| shr-cam-010 (Shrev) | 20475 | 20486 | +11 | vivo |
| shr-cam-030 (Shrev) | 20473 | 20486 | +13 | vivo |

Todos HTTP 200 nas 2 rodadas + segmento .ts baixado + `ffprobe` OK (H.264/15fps) + MEDIA-SEQUENCE
avançando. **Aprovado 2x** — reproduz o critério que reprovou as whatsupcams.

## Teste rápido de ingestão (ffmpeg)

```
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate \
  -of default=noprint_wrappers=1 \
  "https://ITSStreamingNO.dotd.la.gov/public/hou-cam-003.streams/playlist.m3u8"

ffmpeg -user_agent "Mozilla/5.0" \
  -i "https://ITSStreamingNO.dotd.la.gov/public/hou-cam-003.streams/playlist.m3u8" \
  -frames:v 1 -q:v 3 -y quadro.jpg
```
