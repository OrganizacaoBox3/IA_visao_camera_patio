# Catálogo de fontes de câmera públicas / de demonstração

Projeto: Visão Computacional MVP — Grendene CD Inovação
Data: 2026-06-28
Objetivo: fornecer feeds **intencionalmente públicos** (RTSP/HLS/MJPEG/iframe) para demonstrar os modos da ferramenta
(detecção de atividade por zona, detecção de objetos coco-ssd/OWL-ViT, leitura de códigos de barras/QR ZXing, detecção de fadiga/rostos).

> **Escopo respeitado:** somente streams oficiais de teste, webcams públicas de trânsito/cidades/portos com transmissão aberta,
> dados abertos governamentais e diretórios oficiais de webcams ao vivo. **Não** há varredura de rede, Shodan/Insecam,
> credenciais padrão ou acesso a câmeras privadas. Fontes desse tipo foram explicitamente recusadas (ver "Fontes recusadas").

---

## Como o pipeline consome cada protocolo

- **RTSP** → consumido nativamente por `server/rtsp.js` (ffmpeg lê o RTSP e emite frames JPEG/MJPEG para o dashboard).
  Configurar em `server/rtsp.sources.json` (schema: `[{ "label": "...", "url": "rtsp://..." }]`). É o caminho mais direto e o **único** que entra direto no pipeline atual sem conversão.
- **HLS (.m3u8) / DASH / MP4 / YouTube live** → o `server/rtsp.js` chama ffmpeg, que **também lê HLS/HTTP**. Basta colocar a URL `.m3u8` no campo `url`
  (o ffmpeg aceita `http(s)://...m3u8` no lugar de `rtsp://...`). Para YouTube use `yt-dlp` para extrair a URL `.m3u8` antes (não é link estável).
- **MJPEG** (`.../mjpg/video.cgi`) → idem: ffmpeg lê MJPEG por HTTP; colocar a URL no campo `url`.
- **iframe / página web** → **não** entra no pipeline de inferência (é só visualização no navegador, sem acesso ao stream bruto).
  Marcado apenas como referência de conteúdo; preferir sempre uma variante RTSP/HLS/MJPEG da mesma cena.

> Observação técnica: `server/rtsp.js` monta os args do ffmpeg como `-rtsp_transport tcp -i <url> ...`. Para fontes HLS/MJPEG o argumento
> `-rtsp_transport tcp` é ignorado pelo ffmpeg quando a entrada não é RTSP (não causa erro), então URLs `http(s)` funcionam sem alterar o código.
> Se quiser limpeza, dá para condicionar esse arg ao prefixo `rtsp://`.

---

## 1. Tabela de fontes

| # | Nome | URL / endpoint | Protocolo | Conteúdo / cena | Modo(s) adequado(s) | Estabilidade / observações | Licença / termos |
|---|------|----------------|-----------|-----------------|---------------------|----------------------------|------------------|
| 1 | Wowza RTSP Stream Test (atual 2026) | `rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1` | RTSP | Vídeo em loop estático (cena genérica) | Validar pipeline ffmpeg/RTSP; objetos (limitado) | **Verificado** na página oficial Wowza. URL pode rotacionar — reconferir na página antes da demo | Stream de teste oficial Wowza, uso para testes |
| 2 | Big Buck Bunny via Mux (HLS, ABR) | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | HLS | Animação Big Buck Bunny (VOD em loop) | Validar pipeline HLS→ffmpeg; objetos (personagens) | **Verificado** (listado em test-streams.mux.dev). Muito estável | Conteúdo Creative Commons (Blender), hospedagem de teste Mux |
| 3 | Tears of Steel (HLS + legendas IMSC) | `https://test-streams.mux.dev/tos_ismc/main.m3u8` | HLS | Curta sci-fi com pessoas/rostos (VOD) | Fadiga/rostos (há rostos humanos); objetos | **Verificado** (Mux). Estável | Creative Commons (Blender Foundation) |
| 4 | Sintel (HLS, Akamai/Bitmovin) | `https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8` | HLS | Animação Sintel (VOD) | Validar pipeline; objetos | **Não verificado** (listado em bengarney/list-of-streams; CDN pode variar) | Creative Commons (Blender) |
| 5 | Apple BipBop (HLS de referência) | `https://devimages.apple.com/iphone/samples/bipbop/bipbopall.m3u8` | HLS | Clipe de teste Apple (VOD) | Validar pipeline HLS | **Não verificado** (clássico da Apple; às vezes só HTTPS). Bom fallback | Sample oficial Apple para desenvolvedores |
| 6 | NASA TV Public (HLS, ao vivo) | `https://nasa-i.akamaihd.net/hls/live/253565/NTV-Public1/master.m3u8` | HLS | TV ao vivo da NASA (espaço/estúdio) | Validar pipeline HLS ao vivo; objetos/rostos eventuais | **Não verificado** (endpoint Akamai histórico pode ter mudado). Ver player oficial NASA se falhar | Conteúdo público NASA (domínio público US gov) |
| 7 | Webcam St-Malo (MJPEG, Axis pública) | `http://webcam.st-malo.com/axis-cgi/mjpg/video.cgi?resolution=352x288` | MJPEG | Vista de cidade/porto St-Malo (FR) | Atividade por zona; objetos (pessoas, barcos) | **Não verificado** (webcam pública antiga; pode estar offline). Boa cena de pátio/orla | Webcam pública de turismo |
| 8 | 511NY — Cameras API (snapshots/HLS DOT) | `https://511ny.org/api/getcameras?key=SUA_CHAVE&format=json` | API → JPG/HLS | Milhares de câmeras de trânsito/rodovia NY | Atividade por zona; objetos (veículos, caminhões) | **Não verificado** quanto à chave. Requer cadastro gratuito; limite 10 req/60s. Snapshots `.jpg` e alguns feeds de vídeo | Dados abertos 511NY (uso conforme termos do DOT) |
| 9 | NYC DOT CCTV (snapshots JPG) | `https://webcams.nyctmc.org/api/cameras/` (lista) → imagens por câmera | MJPEG/JPG | Trânsito urbano de NY (ruas, cruzamentos) | Atividade por zona; objetos (veículos/pedestres) | **Não verificado**. Endpoints históricos `207.251.86.238/cctv{ID}.jpg` mudaram; conferir portal atual nyctmc.org | Dados públicos NYC DOT |
| 10 | TrafficLand API (rede de DOTs US) | `https://www.trafficland.com/` (API comercial) | RTSP/HLS | 25.000+ câmeras de trânsito (200+ cidades) | Atividade por zona; objetos (logística rodoviária) | **Não verificado**. Requer credencial/contrato. Mais para piloto que demo rápida | API comercial (termos TrafficLand) |
| 11 | DER/SP — Câmeras Online (rodovias SP) | `http://www.der.sp.gov.br/WebSite/Servicos/ServicosOnline/CamerasOnline.aspx` | iframe/web | Rodovias estaduais de São Paulo | Atividade; objetos (caminhões/veículos) — **logística BR** | **Não verificado** o stream bruto (página pública; provável snapshot/embed, sem RTSP aberto documentado) | Serviço público DER-SP |
| 12 | CET-SP — Câmeras CET (trânsito SP) | `https://www.cetsp.com.br/consultas/cameras-cet.aspx` | iframe/web | Avenidas e marginais de São Paulo | Atividade; objetos (veículos/pedestres) — **trânsito BR** | **Não verificado** stream bruto. Página oficial; geralmente snapshots periódicos | Serviço público CET-SP |
| 13 | DAER-RS — Câmeras em rodovias | `https://www.daer.rs.gov.br/cameras-de-monitoramento` | iframe/web | Rodovias do Rio Grande do Sul (clima/tráfego) | Atividade; objetos (logística rodoviária BR) | **Não verificado** stream bruto. Página oficial pública | Serviço público DAER-RS |
| 14 | CET-Rio — Câmeras ao vivo | `http://www0.rio.rj.gov.br/pcrj/destaques/transito_esp.htm` | iframe/web | 76 câmeras de trânsito no Rio de Janeiro | Atividade; objetos (trânsito BR) | **Não verificado** stream bruto. Portal oficial da prefeitura | Serviço público Prefeitura RJ |
| 15 | SkylineWebcams — Port of Rotterdam | `https://www.skylinewebcams.com/en/webcam/netherlands/south-holland/rotterdam/port.html` | iframe/HLS | Porto de Rotterdam (navios, terminal de contêineres) | Atividade por zona; objetos (navios/contêineres) — **logística portuária** | **Não verificado** URL de stream (HLS embutido protegido). Excelente cena de docas/logística | Termos SkylineWebcams (somente embed) |
| 16 | EarthCam — câmeras ao vivo (rede) | `https://www.earthcam.com/` / `https://www.youtube.com/@earthcam/streams` | iframe/YouTube/HLS | Times Square, cidades, construção, portos | Atividade; objetos; rostos (multidões) | **Não verificado** URLs diretas (HLS protegido). Via YouTube live + yt-dlp é a rota mais viável | Termos EarthCam / YouTube (não redistribuir) |
| 17 | Windy Webcams API | `https://api.windy.com/webcams` (API v3, chave grátis) | API → imagens/timelapse/player | 70.000+ webcams mundiais (portos, ruas, indústria) | Atividade; objetos (depende da cena) | **Não verificado** por chave. Free tier: baixa resolução, URLs de imagem expiram em 10 min. Ótimo para descobrir cenas | API Windy (termos + atribuição) |
| 18 | Helios Cameras API (DOT/HLS) | `https://api.helios.earth/v1/cameras/:id/live/:file` | HLS | Câmeras de trânsito (ex.: VA DOT) | Atividade; objetos (veículos) | **Não verificado**. Requer credencial Helios | API comercial Helios (termos) |

---

## 2. Formato exato para `server/rtsp.sources.json`

O schema é um array de objetos `{ "label", "url" }` (ver `server/rtsp.sources.example.json`).
O ffmpeg invocado em `server/rtsp.js` aceita tanto `rtsp://` quanto `http(s)://...m3u8` / MJPEG no campo `url`.

### Exemplo mínimo — só validação de pipeline (sem feed externo de produção)

```json
[
  { "label": "Teste RTSP - Wowza", "url": "rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1" },
  { "label": "Teste HLS - Big Buck Bunny", "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" }
]
```

### Exemplo de demo (mistura RTSP de teste + HLS + MJPEG)

```json
[
  { "label": "Pipeline RTSP (Wowza)",      "url": "rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1" },
  { "label": "Rostos (Tears of Steel)",    "url": "https://test-streams.mux.dev/tos_ismc/main.m3u8" },
  { "label": "Cena urbana (St-Malo MJPEG)", "url": "http://webcam.st-malo.com/axis-cgi/mjpg/video.cgi?resolution=352x288" }
]
```

### Formato de RTSP com credenciais (apenas para câmeras REAIS do CD — não aplicável aos feeds públicos acima)

```json
[
  { "label": "Pátio - Expedição", "url": "rtsp://usuario:senha@10.0.0.50:554/Streaming/Channels/101" },
  { "label": "Doca - Carga",      "url": "rtsp://usuario:senha@10.0.0.51:554/cam/realmonitor?channel=1&subtype=0" }
]
```

> Dica de teste rápido por env (sem editar o arquivo):
> `RTSP_SOURCES="Teste=rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1"`

---

## 3. Streams de teste RTSP/HLS sempre disponíveis (para validar o pipeline ffmpeg)

Use estes para confirmar que ffmpeg + `server/rtsp.js` estão funcionando, **sem** depender de webcam externa instável:

| Tipo | URL | Status |
|------|-----|--------|
| RTSP | `rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1` | **Verificado** (Wowza, pode rotacionar) |
| HLS (VOD, muito estável) | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | **Verificado** (Mux) |
| HLS (com rostos) | `https://test-streams.mux.dev/tos_ismc/main.m3u8` | **Verificado** (Mux) |
| HLS (referência Apple) | `https://devimages.apple.com/iphone/samples/bipbop/bipbopall.m3u8` | Não verificado (fallback clássico) |
| RTSP legado (fallback) | `rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4` | Não verificado (frequentemente offline) |

Teste de linha de comando (fora do app) antes da demo:

```bash
# RTSP: deve gerar 1 frame JPEG
ffmpeg -rtsp_transport tcp -i "rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1" -frames:v 1 -f image2 teste.jpg

# HLS:
ffmpeg -i "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" -frames:v 1 -f image2 teste_hls.jpg
```

---

## 4. Cenários de demonstração recomendados (por modo da ferramenta)

### A) Detecção de atividade / presença por zona
Cenas com movimento previsível e zonas naturais (faixas, docas, calçadas).
1. **Câmera de trânsito DOT** (511NY snapshots ou NYC DOT) — desenhar zonas em faixas/cruzamento e contar presença de veículos. Análogo direto a "movimento em doca".
2. **Porto de Rotterdam (SkylineWebcams)** — zonas sobre cais/terminal de contêineres; melhor proxy visual para pátio/logística.
3. **Webcam de cidade/orla (St-Malo MJPEG)** — zona de calçada/estacionamento para detectar presença de pessoas/veículos.

### B) Detecção de objetos (coco-ssd / OWL-ViT)
coco-ssd reconhece bem `person`, `car`, `truck`, `bus`, `boat`, `backpack` — todos abundantes em trânsito/porto.
1. **Feeds de trânsito DOT (511NY / NYC DOT)** — `car`/`truck`/`bus`; ótimo para demonstrar contagem de veículos pesados (logística).
2. **Porto de Rotterdam** — `boat`/`truck`/`person`; OWL-ViT com prompt aberto ("container", "forklift") fica convincente para CD.
3. **HLS Big Buck Bunny / Tears of Steel** — objetos/personagens estáveis para validar inferência mesmo offline da internet de campo.

### C) Leitura de códigos de barras / QR (ZXing)
**Importante:** feeds públicos de trânsito/porto **não** contêm códigos legíveis — ZXing precisa de close-up nítido.
Para este modo, a demo convincente é **local**, não por webcam pública:
1. **Webcam local (notebook/USB) apontada para uma etiqueta/caixa real do CD** — caso de uso mais fiel (conferência de expedição).
2. **Vídeo/HLS de teste com QR/De barras em quadro** — gerar um curto MP4 com etiquetas e servir via HLS local (`ffmpeg`/`http`) para repetibilidade.
3. **Folha impressa de códigos** em frente à câmera — bom para mostrar leitura múltipla/contínua.
   (Se precisar de um feed remoto, prefira uma câmera RTSP do próprio CD focada na bancada de etiquetagem.)

### D) Detecção de fadiga / rostos
Precisa de rostos frontais, próximos e bem iluminados — webcams de rua ficam distantes demais.
1. **Webcam local (notebook/USB)** apontada para o operador — caso de uso real (motorista de empilhadeira / posto de conferência). Mais convincente.
2. **HLS "Tears of Steel"** (`tos_ismc/main.m3u8`) — contém rostos humanos próximos; bom para validar o detector sem expor pessoas reais.
3. **EarthCam Times Square (via YouTube)** — multidões com rostos; serve para mostrar detecção de múltiplos rostos (não para fadiga fina, pela distância).

---

## 5. Nota legal / ética

- **Respeitar os termos de uso** de cada fonte. Streams de teste (Wowza, Mux, Apple, Blender CC) são liberados para teste/desenvolvimento.
  Webcams de terceiros (EarthCam, SkylineWebcams, Windy) geralmente permitem **somente visualização/embed** — **não** regravar nem redistribuir o conteúdo.
- **LGPD:** feeds com indivíduos identificáveis envolvem dados pessoais. Para demos, **prefira cenas sem pessoas identificáveis**
  (vídeos de teste, planos abertos de trânsito/porto). Não armazene nem reidentifique frames de pessoas reais; use apenas em tempo real para a demo.
- **Finalidade e minimização:** usar os feeds só para demonstrar capacidade técnica, sem persistir imagens de terceiros além do necessário.
- **Dados abertos governamentais** (DOTs, prefeituras) costumam permitir uso público, mas verifique a licença específica de cada portal.
- **Câmeras do próprio CD** (RTSP interno) são o caminho definitivo para produção; os feeds públicos servem apenas para prototipagem/demonstração.

---

## Fontes recusadas (fora de escopo, por design)

- **Insecam / Shodan e similares** — apareceram nas buscas (ex.: `insecam.org/en/bytype/Axis/`) mas **expõem câmeras privadas sem transmissão pública intencional**, frequentemente via credenciais padrão. **Recusado**: viola privacidade/LGPD e o escopo definido. Não utilizar.
- **Acesso direto por IP a câmeras de terceiros** não documentadas como públicas — recusado pelo mesmo motivo.

---

## Referências (consultadas)

- Wowza RTSP Stream Test — https://www.wowza.com/developer/rtsp-stream-test
- Mux Test HLS Streams — https://test-streams.mux.dev/
- Lista comunitária de streams de teste (HLS/DASH) — https://github.com/bengarney/list-of-streams
- Gist de URLs de protocolo de streaming (RTSP/MJPEG) — https://gist.github.com/g0rdan/bb8c1cd7db1028aa3669608eab1ac39c
- 511NY Developers / Cameras API — https://511ny.org/developers/help
- NYC DOT Real-Time Traffic Cameras — https://www.nyc.gov/html/dot/html/motorist/atis.shtml
- TrafficLand API — https://www.trafficland.com/api.html
- Windy Webcams API — https://api.windy.com/webcams
- Helios Cameras API — https://helios.earth/developers/api/cameras/
- DER/SP Câmeras Online — http://www.der.sp.gov.br/WebSite/Servicos/ServicosOnline/CamerasOnline.aspx
- CET-SP Câmeras — https://www.cetsp.com.br/consultas/cameras-cet.aspx
- DAER-RS Câmeras — https://www.daer.rs.gov.br/cameras-de-monitoramento
- CET-Rio / Prefeitura RJ — http://www0.rio.rj.gov.br/pcrj/destaques/transito_esp.htm
- SkylineWebcams Port of Rotterdam — https://www.skylinewebcams.com/en/webcam/netherlands/south-holland/rotterdam/port.html
- EarthCam — https://www.earthcam.com/ ; https://www.youtube.com/@earthcam/streams
