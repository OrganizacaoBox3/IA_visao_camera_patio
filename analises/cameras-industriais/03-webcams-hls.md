# 03 — Webcams públicas ao vivo com HLS (foco industrial/operacional)

> Tema: plataformas de webcams públicas ao vivo (SkylineWebcams, EarthCam, Windy Webcams, YouTube Live)
> filtradas para cenas ÚTEIS ao MVP de visão computacional em logística/CD: obras/construção, pátios,
> portos, aeroportos/ground-ops e trânsito urbano com veículos. **Turismo/paisagem foi descartado.**
>
> Data da pesquisa: 2026-07-01 · Verificação: por design (leitura de docs/ToS/páginas), **playback ao vivo NÃO testado in loco** salvo indicação.
> Ingestão do Hub: ffmpeg (RTSP / HLS .m3u8 / MJPEG http contínuos). Cadastro via UI "+ Câmera IP".

---

## Sumário executivo (leia isto primeiro)

- **Fontes com HLS realmente estável e industrial** tendem a NÃO ser as grandes plataformas de webcam
  (SkylineWebcams/EarthCam), e sim **operadores/CDNs menores que expõem `.m3u8` fixo**: `livespotting.tv`
  (portos alemães: Kiel, Bremerhaven, eclusas), `whatsupcams` e feeds de operador (Port of LA / PTZtv).
- **SkylineWebcams e EarthCam são hostis por Termos de Uso** (proíbem download/extração/redistribuição).
  Tecnicamente há HLS por trás do player, mas o uso choca com o ToS — tratar como **não recomendado**.
- **Windy Webcams** é agregador: a API v3 entrega majoritariamente **snapshots + link de player/embed**,
  raramente `.m3u8` direto. Serve para descobrir câmeras, não como fonte de stream direta.
- **YouTube Live** tem ótimas cenas industriais reais (portos 24/7), mas a URL HLS obtida via `yt-dlp -g`
  **EXPIRA (token assinado, ~6h)** — bom só para **teste pontual**, não para cadastro fixo.

---

## Tabela geral

| Plataforma / Cena | URL HLS ou página | Consumível direto (ffmpeg)? | Expira? | Relevância industrial | Verificado? | Termos de uso |
|---|---|---|---|---|---|---|
| **livespotting.tv** — Porto de Kiel, Bremerhaven, eclusas Kiel/Brunsbüttel | Página: livespotting.tv (player HLS; `.m3u8` visível no Network tab) | **Sim** (HLS nativo; padrões antigos RTMP migraram p/ HLS) | Não (URL de CDN estável) | **Alta** — portos, eclusas, tráfego de navios/carga | Parcial (arquitetura HLS confirmada; testar URL atual) | Uso/exibição; confirmar antes de re-stream |
| **whatsupcams** — marinas/portos europeus (ex. Portorož) | `https://cdn-...whatsupcams.com/.../<id>/playlist.m3u8` (extrair via Network) | **Sim** (HLS) | Não (CDN estável) | Média — marinas/orla portuária | Parcial | Exibição; verificar re-stream |
| **Feed operador — Port of Los Angeles** (San Pedro / Wilmington: terminais de contêiner TraPac/Yusen/WBCT) | portoflosangeles.org/news/livestream (player EarthCam) + espelho YouTube `iaDgpTnagy4` | Página = embed EarthCam (não direto); YouTube via yt-dlp (expira) | Depende (YouTube: sim) | **Alta** — terminais de contêiner, canal principal | Verificado (fonte oficial) | EarthCam-powered → ToS EarthCam restritivo |
| **PTZtv** — New York Harbor, Juneau, Bermuda (tráfego portuário) | nyharborwebcam.com etc.; padrão antigo `http://.../pnyw.stream/playlist.m3u8` | Às vezes (HLS direto quando exposto) | Não (mas URLs legadas podem estar quebradas) | Média/Alta — tráfego de navios/porto | Não verificado (URLs legadas) | Produção comercial; verificar |
| **YouTube Live — Southampton "Box Cam"** (navios porta-contêiner + terminal) | `youtube.com/watch?v=tZwbyBVbBQs` → `yt-dlp -g` | Via yt-dlp → HLS googlevideo | **Sim (~6h, token)** | **Alta** — terminal de contêiner, movimentação | Verificado (stream 24/7 ativo) | ToS YouTube; sem re-stream |
| **YouTube Live** (genérico: portos/obras/trânsito 24/7) | URL da live → `yt-dlp -g <url>` | Via yt-dlp → HLS | **Sim (expira)** | Alta (depende da cena) | Caso a caso | ToS YouTube |
| **EarthCam** — construção, Port of LA, obras urbanas | earthcam.com/... (player/embed próprio) | **Não** (iframe/embed; sem `.m3u8` oficial) | — | **Alta** (muitas obras/portos) | Verificado (embed-only) | **Restritivo**: proíbe redistribuir/embed fora das ferramentas deles |
| **SkylineWebcams** — algumas cenas de porto/orla/trânsito | skylinewebcams.com/... (HLS `livee...m3u8` por trás do player) | Tecnicamente sim, mas **ToS proíbe** | Não | Baixa/Média (majoritariamente turismo) | Verificado (ToS) | **Hostil**: proíbe download/extração até p/ uso pessoal |
| **Windy Webcams** (agregador, API v3) | api.windy.com/webcams (requer API key) | **Não** (snapshots + link player/embed; `.m3u8` raro) | Tokens de imagem expiram (10 min free / 24h pro) | Descoberta (aponta p/ fontes) | Verificado (docs) | Requer API key + atribuição |

---

## Apostas HLS estáveis (candidatas a cadastro fixo)

Estas expõem (ou muito provavelmente expõem) `.m3u8` de CDN **sem token de expiração curto** — ou seja,
compatíveis com o cadastro "+ Câmera IP" e ingestão contínua via ffmpeg.

1. **livespotting.tv — portos e eclusas alemãs (MELHOR APOSTA industrial).**
   Cenas: Porto de Kiel, Bremerhaven (Sail City), eclusas de Kiel e Brunsbüttel — tráfego de navios/carga,
   operação de eclusa, orla portuária. Infra migrou de RTMP para **HLS nativo**.
   Como obter a URL: abrir a página da câmera → DevTools (F12) → aba Network → filtro `m3u8` → copiar o
   `.m3u8` (playlist/variant). Testar no Hub com `ffmpeg -i <m3u8>`.
   *Ação: confirmar a URL atual e reter para cadastro.*

2. **whatsupcams — marinas/portos europeus.**
   Padrão de CDN HLS `.../playlist.m3u8` estável. Menos "industrial pesado" (mais marina), mas útil para
   detecção de embarcações/movimentação em orla. Mesma extração via Network tab.

3. **Feed de operador oficial — Port of Los Angeles (terminais de contêiner).**
   Excelente cena industrial (TraPac, Yusen, WBCT, canal principal). Porém o player oficial é **EarthCam
   (embed)** — não há `.m3u8` público limpo, e o ToS EarthCam é restritivo. Para teste, usar o espelho
   YouTube (expira). *Não é aposta "fixa" limpa por causa do EarthCam.*

4. **PTZtv (NY Harbor / Juneau / Bermuda).**
   Historicamente expunham `.m3u8`/`.stream/playlist.m3u8`; várias URLs legadas listadas na comunidade
   estão quebradas. Verificar a URL atual antes de confiar. Produção comercial → checar ToS.

> Observação de ToS: para as apostas 1–2, o uso pretendido do MVP é **visualização/análise local** (sem
> re-stream público). Documentar isso; se houver intenção de redistribuir, pedir permissão ao operador.

---

## Só para teste pontual (YouTube / expira)

O YouTube Live é a **melhor fonte de cenas industriais reais e variadas** (portos, obras, trânsito 24/7),
mas **não serve como cadastro fixo** porque a URL HLS é assinada e temporária.

**Fluxo `yt-dlp -g`:**
```bash
# 1) Obter a URL HLS "ao vivo" da live (retorna a googlevideo .m3u8 assinada)
yt-dlp -g "https://www.youtube.com/watch?v=tZwbyBVbBQs"

# 2) Consumir no ffmpeg (ex.: teste de ingestão no Hub)
ffmpeg -i "<url_m3u8_retornada>" -c copy -f mpegts udp://... 
#   ou para live longa, deixar o próprio yt-dlp baixar via ffmpeg:
yt-dlp --downloader ffmpeg --hls-use-mpegts "https://www.youtube.com/watch?v=tZwbyBVbBQs"
```

**CAVEAT (crítico):** a URL retornada por `yt-dlp -g` aponta para `*.googlevideo.com` e contém parâmetros
`expire`/`signature`. Ela **EXPIRA (tipicamente em torno de ~6h, às vezes minutos)**. Depois disso o ffmpeg
recebe HTTP 403 e o stream cai. Consequências para o MVP:

- **Não colar essa URL no cadastro "+ Câmera IP"** como fonte permanente — vai quebrar.
- Para uso contínuo seria preciso um **serviço que re-executa `yt-dlp -g` e renova a URL** periodicamente
  (fora do escopo do cadastro simples). Flags de reconexão do ffmpeg (`-reconnect 1 -reconnect_at_eof 1
  -reconnect_streamed 1 -reconnect_delay_max 2 -multiple_requests 1`) ajudam a suavizar cortes, mas **não
  resolvem** a expiração do token.
- **Uso recomendado:** validação pontual do pipeline (detecção/tracking) com uma cena industrial real,
  gerando um clipe ou sessão curta.

**Cenas industriais YouTube Live úteis para teste:**
- Southampton "Box Cam" — navios porta-contêiner + terminal (`v=tZwbyBVbBQs`).
- Port of Los Angeles — espelho da live oficial (`v=iaDgpTnagy4`).
- Buscar por: `live port container terminal cam`, `live construction site cam`, `live traffic intersection cam`.

**ToS:** os Termos do YouTube proíbem acessar/baixar conteúdo fora da interface e re-stream. Uso local de
teste/análise costuma ser tolerado; **re-transmissão pública não**.

---

## Marcações e ressalvas transversais

- **Excluídos por design:** Insecam e câmeras privadas expostas por engano (fora do escopo — só feeds
  públicos intencionais).
- **iframe/embed-only (NÃO consumível direto por ffmpeg):** EarthCam, boa parte do Windy (agregador),
  e páginas que embutem player JS sem `.m3u8` acessível.
- **Extração de `.m3u8`:** para plataformas que embutem HLS, o método padrão é DevTools → Network →
  filtrar `m3u8`. Isso funciona tecnicamente para SkylineWebcams/EarthCam, **mas o ToS proíbe** — não usar.
- **Protocolos:** priorizar HLS (`.m3u8`) de CDN sem token curto = cadastro fixo. RTMP legado (livespotting
  antigo) deve ser evitado; preferir o HLS equivalente.
- **Verificado × não verificado:** neste documento "verificado" = ToS/docs/página conferidos por design;
  a **playabilidade ao vivo de cada `.m3u8` deve ser testada no Hub** antes de promover a produção.

---

## Fontes

- SkylineWebcams — Terms of use: https://www.skylinewebcams.com/terms-of-use.html
- SkylineWebcams (site): https://www.skylinewebcams.com/
- yt-dlp issue (Skyline extract falha): https://github.com/yt-dlp/yt-dlp/issues/7115
- EarthCamTV — Terms of Service: https://www.earthcamtv.com/terms-of-service.php
- EarthCam — Construction camera tech: https://www.earthcam.net/technology/
- EarthCam — Port of LA cam: https://www.earthcam.com/usa/california/losangeles/port/
- Port of Los Angeles — Livestream (oficial): https://portoflosangeles.org/news/livestream
- Port of LA — espelho YouTube: https://www.youtube.com/watch?v=iaDgpTnagy4
- Southampton Box Cam (YouTube Live): https://www.youtube.com/watch?v=tZwbyBVbBQs
- Windy Webcams API v3 docs: https://api.windy.com/webcams/api/v3/docs
- Windy Webcams (docs): https://api.windy.com/webcams/docs
- yt-dlp (repo/flags HLS live): https://github.com/yt-dlp/yt-dlp
- YouTube live HLS expira (~6h): https://github.com/yt-dlp/yt-dlp/issues/1998
- Streamlink — stream acaba após 6h: https://github.com/streamlink/streamlink/issues/3995
- Recuperar URL HLS real de YouTube Live: https://www.w3tutorials.net/blog/how-can-i-get-the-actual-video-url-of-a-youtube-live-stream/
- Lista comunitária de webcams m3u8 (livespotting/whatsupcams/earthcam legados): https://github.com/Crazycook/Working/blob/master/Webcams.txt
