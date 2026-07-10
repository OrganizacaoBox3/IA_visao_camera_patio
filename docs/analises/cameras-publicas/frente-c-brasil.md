# Frente C — Câmeras públicas oficiais BRASIL (feeds de vídeo estáveis)

> Objetivo: achar feeds ESTÁVEIS, que "parecem CFTV de pátio" (ângulo alto fixo, rua/calçada/estacionamento
> com PESSOAS e VEÍCULOS em movimento real), publicados **de propósito para o público** por proprietário
> legítimo (prefeitura/turismo/porto/órgão). Ingestão do app: RTSP / HLS (.m3u8) / MJPEG via ffmpeg.
>
> Data da sondagem: **2026-07-06**, ~17:40–17:55 **BRT (UTC-3)**. Ferramentas: `ffprobe/ffmpeg 8.1.2`, `curl 7.81`.
> Método por candidato: baixar a `.m3u8`, resolver o chunklist, **baixar 1 segmento `.ts`**, rodar `ffprobe`,
> e **repetir a sonda ~1min depois** (detecta os flaky). Só entra no "VIVOS" o que passou **2x**.

---

## VIVOS — passaram na sonda 2x (recomendados)

### 1. Ipanema — "Orla Rio" (RECOMENDADO / estrela) ✅
- **URL (HLS, ingestão direta por ffmpeg, SEM header extra):**
  `https://live-p2p-252-f7117c097.monuv.com.br:443/p2p/95785.stream/playlist.m3u8?m_hash=c6AMgHjFry-HhpdemFIgtblz-oPrnzk_7xeA2UYOKe8=`
- **Codec/Resolução:** H.264 (avc1.4d001f) **1280x720 @ 25fps** + AAC (áudio). `application/vnd.apple.mpegurl`.
- **Conteúdo (é exatamente o alvo):** ângulo alto fixo sobre o **calçadão de Ipanema** (mosaico português) e a
  **Av. Vieira Souto** — PEDESTRES caminhando + VEÍCULOS reais (táxi, carros, moto), quiosque, faixas de trânsito.
  Ver `evidencia-ipanema-orla-rio-1753.jpg` (frame ao vivo 17:53). Bem iluminada à noite (poste + quiosque),
  então **útil 24/7**; diurno rende ainda mais.
- **Proveniência ética:** publicada oficialmente pela **Orla Rio** (concessionária do calçadão/quiosques do Rio)
  em `orlario.com.br` (matéria "Surf View") e no `surfview.com.br/api/embed/ipanemaOrlaRio`. Feed público intencional.
- **Sondas:** inicial OK; **Round A (17:51) OK**; **Round B (17:52, +92s) OK**. Segmentos 465–487 KB, ffprobe rc=0.
  `ffmpeg -i <url> -frames:v 1` puxou frame ao vivo **direto, sem Referer**.

### 2. Arpoador — "Orla Rio" (stream sólido, conteúdo hoje FRACO) ⚠️
- **URL (HLS):**
  `https://live-p2p-252-f7117c097.monuv.com.br:443/p2p/95792.stream/playlist.m3u8?m_hash=fOH4zZbZOllma_Hgtc9GSddHPoORqPsQ6AmbCopexSM=`
- **Codec/Resolução:** H.264 **1280x720 @ 15fps** (sem áudio).
- **Conteúdo:** a câmera é um **PTZ Hikvision `DS-2DE4225IW-DE`** (overlay revela o modelo) atualmente apontado
  **para baixo, na areia** — quadro só de areia + cerca, **sem pessoas/veículos úteis agora**. Stream estável, mas
  conteúdo ruim para detecção enquanto o PTZ estiver nesse enquadramento. Ver `evidencia-arpoador-orla-rio-sand.jpg`.
  (Obs.: relógio da câmera desconfigurado, marca "04:51".)
- **Proveniência:** idem Ipanema (Orla Rio / SurfView, `surfview.com.br/api/embed/arpoadorOrlaRio`).
- **Sondas:** Round A e Round B OK (segmentos 193–206 KB). Incluída pela estabilidade; usar só se reenquadrar.
- **BÔNUS respondido:** é uma **Hikvision de câmera de órgão/concessão com feed oficialmente aberto** — atende
  o pedido de "Intelbras/Hikvision de órgão público com feed oficial". A de Ipanema também é do mesmo parque.

**Nota-chave de operação (token `m_hash`):** as URLs monuv são **assinadas** por `m_hash`. Nos testes o token
ficou **estável por ~20 min** (reusado em 3 rodadas sem expirar) — bom para ingestão. Se um dia der **HTTP 404**,
**re-obtenha um token fresco** com um GET em `https://surfview.com.br/api/embed/ipanemaOrlaRio`
(ou `...arpoadorOrlaRio`) e leia a nova `...playlist.m3u8?m_hash=...`. Não requer login/segredo; é o embed público.

---

## SNAPSHOT-ONLY oficial (NÃO é stream — anotado separado, como pedido)

### Praia Grande / SP — Prefeitura (oficial `.gov.br`, mas SNAPSHOT)
- Portal: `https://cameras.praiagrande.sp.gov.br/aovivo/` (Prefeitura da Estância Balneária de Praia Grande, SEAD).
- Lista de câmeras (API pública): `https://cameras.praiagrande.sp.gov.br/aovivo/api` — dezenas de postes de praia
  e avenidas ("POSTE PRAIA 004 - Forte", "Av. Marcos Freire", etc.), com lat/long. Conteúdo seria ótimo (orla+rua).
- **Porém é SNAPSHOT JPEG por polling**, não vídeo: o `main.js` faz `get-snapshot/slideshow/<cam>` via XHR e
  recarrega a imagem num `setTimeout` (blob → `URL.createObjectURL`). Não há `.m3u8`/MJPEG contínuo, e o endpoint
  de snapshot depende do fluxo XHR do app (GET simples retornou vazio). **Não serve** ao requisito de stream contínuo.
  Registrado como referência de fonte oficial caso um modo "snapshot a cada N s" seja aceitável no futuro.

---

## MORTOS / reprovados nesta janela (não recomendar)

- **Copacabana "Orla Rio"** (`.../p2p/95784.stream/playlist.m3u8?m_hash=70Xx...`): **playlist HTTP 404 nas 3 sondas**
  (inicial + Round A + Round B). Stream fora do ar agora. Reavaliar depois — o embed existe, só o vídeo caiu.
- **Torres Ao Vivo** (`torresaovivo.com.br`, turismo, 40+ cams incl. centro/aeroporto): SPA que monta
  `https://video02.logicahost.com.br/{slug}/{slug}/playlist.m3u8` a partir de uma tabela Supabase `cameras` —
  a tabela está com **RLS (permission denied p/ anon)**; sem os slugs não dá URL. Extrair exigiria engenharia
  reversa além do público limpo. Descartada nesta rodada (não por flaky, por falta de URL pública direta).
- **Praia da Barra** (`praiabarra.com.br`, turismo 24h): player `jmvstream.com/ipcam/...` retornou **HTTP 400**;
  não expôs `.m3u8` sem adivinhar endpoint. Descartada.
- **O Povo "Fortaleza Ao Vivo"** (`www20.opovo.com.br/fortaleza/aovivo/`, 19 cams de trânsito): **HTTP 000**
  (inacessível deste ambiente — provável bloqueio geo/anti-bot). Não sondável aqui.
- **Portal oficial Fortaleza** (`mapas.fortaleza.ce.gov.br/mapa/531/...`): **HTTP 000** (inacessível daqui).
- **SurfView (rede genérica, 318 cams de praia)**: as não-"OrlaRio" carregam o player client-side
  (`/praia/{ref}` sem `.m3u8` no HTML) — não extraível estaticamente sem reverse-engineering. Só as parceiras
  "OrlaRio" têm embed público limpo (`/api/embed/{ref}OrlaRio`).

---

## Leitura honesta (o que a Frente C mostrou)

1. **Confirmado o aviso do briefing:** a maioria das fontes públicas BR "oficiais de prefeitura" é **SNAPSHOT JPEG**
   (ex.: Praia Grande `.gov.br`), não stream contínuo. Portais de trânsito de prefeitura (Fortaleza, COR-Rio) tendem
   ao mesmo padrão (imagem que recarrega), quando não estão atrás de app/geo-bloqueio.
2. **Vídeo real, estável e limpo veio do turismo/concessão** (Orla Rio via SurfView/monuv) — HLS 720p ingestável
   direto por ffmpeg, sem header. **Ipanema é a recomendação forte** (conteúdo pessoas+veículos, ângulo CFTV, 24/7).
3. **Bônus atendido:** as câmeras Orla Rio são **Hikvision** (`DS-2DE4225IW-DE`) de feed oficialmente aberto.
4. **Janela de sondagem foi ao anoitecer (17:40–17:55 BRT, julho):** BR quase todo já no crepúsculo — por isso a
   validação priorizou **estabilidade** (sonda 2x) e caracterizou o conteúdo pela orla iluminada. Diurno rende mais.

## Evidências (frames extraídos e conferidos)
- `evidencia-ipanema-orla-rio-1753.jpg` — pull ao vivo por ffmpeg (pessoas no calçadão + veículos na Av. Vieira Souto).
- `evidencia-arpoador-orla-rio-sand.jpg` — mostra o PTZ Hikvision apontado só para a areia (conteúdo fraco hoje).
