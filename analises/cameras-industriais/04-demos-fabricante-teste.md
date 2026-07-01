# 04 - Câmeras de demonstração de fabricantes + streams de teste sempre-online

**Data:** 2026-07-01
**Escopo:** Fontes PÚBLICAS por design (fabricante/provedor) para validar o pipeline de ingest (ffmpeg) do Hub e demonstrar via UI "+ Câmera IP". Protocolos: RTSP, HLS (.m3u8), MJPEG (http) contínuos.
**Fora de escopo (por design):** Insecam e qualquer câmera privada/exposta sem autorização. Estas NÃO foram incluídas.

---

## Resumo do achado principal

Para **validar a integração de rede + ffmpeg AGORA** com máxima estabilidade, as fontes mais confiáveis são **streams de teste sintéticos** de grandes provedores/CDNs (Apple, Mux, Wowza) — são looping/VOD, não câmeras ao vivo, mas exercitam exatamente o mesmo caminho (RTSP/HLS contínuo -> ffmpeg -> pipeline). São muito mais estáveis do que qualquer "câmera demo" pública.

As **câmeras demo reais de fabricante** (Axis com rua/pátio/estacionamento — boa relevância p/ veículos/pessoas) existem, mas **não são mais publicadas de forma estável e sempre-online**: os hosts públicos rotacionam, muitos exigem login, e o antigo `rtsp.stream` migrou para `octostream.com` exigindo conta. Por isso, para cena real com objetos, o caminho confiável é **auto-hospedar** (MediaMTX/ffmpeg reenviando um vídeo de pátio) em vez de depender de um demo público.

---

## Tabela de fontes

| Fonte | URL (MJPEG/RTSP/HLS direta) | Protocolo | Cena | Estabilidade | Relevância (veículos/pessoas) | Verificado? |
|---|---|---|---|---|---|---|
| Apple BipBop (adv fMP4) | `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8` | HLS | Vídeo de teste (barras/clipe), multi-bitrate | Muito alta (CDN Apple, referência oficial há anos) | Baixa (conteúdo sintético) | Sim - master m3u8 válido confirmado (EXT-X-VERSION:6, variantes 480x270->1920x1080) |
| Mux test-streams (x36xhzz) | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | HLS | Clipe VOD multi-bitrate (240p->1080p) | Muito alta (infra Mux, usada em testes de hls.js) | Baixa (conteúdo de filme) | Sim - master m3u8 válido confirmado (5 variantes) |
| Wowza RTSP Stream Test | `rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1` | RTSP | Vídeo estático em loop | Alta (Wowza Video account, página oficial de teste) | Baixa (conteúdo sintético) | Parcial - URL publicada oficialmente pela Wowza; não testei conexão RTSP daqui |
| Wowza EC2 demo (Big Buck Bunny) | `rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4` | RTSP | Animação VOD em loop | Média (clássico p/ testes; historicamente cai às vezes) | Baixa (animação) | Parcial - URL amplamente citada; disponibilidade intermitente ao longo do tempo |
| Unified Streaming (Tears of Steel) | `https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8` | HLS | Curta VOD (pessoas/ação) | Média-alta (endpoint "stable" oficial) | Média (há pessoas/movimento no conteúdo) | Não - relatos esporádicos de 404; validar antes de demo |
| Akamai live test #2 | `https://moctobpltc-i.akamaihd.net/hls/live/571329/eight/playlist.m3u8` | HLS (live) | Sinal de teste ao vivo | Média (Akamai; links live mudam periodicamente) | Baixa | Não |
| Akamai live test #1 | `https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8` | HLS (live) | Sinal de teste ao vivo | Baixa-média (há relatos de indisponibilidade) | Baixa | Não - possivelmente fora do ar |
| Axis - padrão MJPEG demo | `http://<host-axis>/axis-cgi/mjpg/video.cgi` (ou `http://<host>/mjpg/video.mjpg`) | MJPEG | Rua / pátio / estacionamento | Baixa (hosts públicos rotacionam; muitos exigem login) | **Alta** (cenas com veículos e pessoas) | Não - sem host público estável confirmado; formato de URL confirmado na doc Axis/VAPIX |
| octostream.com (ex-rtsp.stream) | `rtsp://...` (gerado após criar conta) | RTSP | Configurável | Depende do plano | Baixa | Não - `rtsp.stream` agora redireciona p/ octostream; free tier exige conta e limita 1 câmera / 100 MB/dia |
| CamStreamer galeria (Axis M2025-LE) | Player embarcado (HLS via site), sem URL .m3u8/RTSP direta exposta | HLS (embed) | Câmera Axis ao vivo | Média | Média-alta (cena real) | Não - não expõe URL direta colável na UI |

---

## Observações por categoria

- **HLS sintético (Apple/Mux):** melhor custo-benefício de estabilidade. Ideal para o teste "o Hub consegue ingerir HLS contínuo via ffmpeg?". São VOD/looping, então servem para validar rede + decode, não para demonstrar detecção de veículos.
- **RTSP sintético (Wowza):** valida o caminho RTSP/TCP 554/1935. O `wowzaec2demo.streamlock.net` é o mais famoso mas menos confiável; o novo endpoint `entrypoint.cloud.wowza.com` é o oficial atual.
- **Câmeras Axis demo (cena real, veículos/pessoas):** alta relevância para o MVP, porém sem endpoint público estável e sempre-online garantido. Recomenda-se tratar como "demo oportunista" (testar na hora) ou substituir por auto-hospedagem.
- **Restrição respeitada:** nenhuma fonte do Insecam ou de câmera privada foi incluída.

---

## Kit mínimo p/ validar a integração AGORA

Use estes 3 (2 HLS de CDN grande + 1 RTSP oficial). Cole exatamente como abaixo no campo de URL da UI "+ Câmera IP":

1. **HLS (mais confiável) - Apple BipBop**
   - Protocolo: `HLS`
   - URL: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8`

2. **RTSP (oficial Wowza)**
   - Protocolo: `RTSP`
   - URL: `rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1`

3. **HLS (backup) - Mux**
   - Protocolo: `HLS`
   - URL: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`

> Se a UI pedir `tipo/protocolo` separado do endereço, selecione HLS para os itens 1 e 3 e RTSP para o item 2, e cole a URL sem alterações.

### Para MJPEG contínuo e/ou cena real com veículos/pessoas (recomendado auto-hospedar)

Não há MJPEG público sempre-online confiável dentro das restrições. O caminho estável:

- Rodar **MediaMTX** (open-source, RTSP/HLS/MJPEG) ou **ffmpeg** reenviando um vídeo de pátio/estacionamento em loop:
  - `ffmpeg -re -stream_loop -1 -i patio.mp4 -f rtsp rtsp://localhost:8554/patio`
  - Ingerir na UI como `rtsp://<ip-da-maquina>:8554/patio`
- Isso dá cena real com veículos/pessoas + 100% de disponibilidade sob seu controle, ideal para demonstrar detecção.

---

## Fontes

- Axis VAPIX / video streaming: https://developer.axis.com/vapix/network-video/video-streaming/
- Axis embed MJPEG (discussão oficial): https://github.com/orgs/AxisCommunications/discussions/718
- Wowza RTSP Stream Test: https://www.wowza.com/developer/rtsp-stream-test
- rtsp.stream -> octostream: https://www.octostream.com/
- HLS test URLs (OTTVerse): https://ottverse.com/free-hls-m3u8-test-urls/
- Mux test streams: https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
- Wowza EC2 demo (Big Buck Bunny): https://gist.github.com/g0rdan/bb8c1cd7db1028aa3669608eab1ac39c
- MediaMTX (auto-hospedagem RTSP/HLS/MJPEG): https://github.com/bluenviron/mediamtx
- CamStreamer galeria Axis ao vivo: https://camstreamer.com/live/stream/4069-live-camera-axis-m2025-le
