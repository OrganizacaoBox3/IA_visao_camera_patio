# Câmeras públicas — Portos, terminais de contêineres, docas e estaleiros

Pesquisa de feeds AO VIVO, públicos por design (institucionais / operadores de webcam
comerciais), para o cenário mais próximo de um Centro de Distribuição: caminhões,
contêineres, guindastes/portêineres, empilhadeiras/reach-stackers, paletes e pessoas em
movimento nos pátios e cais.

- **Data da pesquisa:** 2026-07-01
- **Pipeline alvo do hub:** ingestão contínua via ffmpeg de **RTSP / HLS (.m3u8) / MJPEG (http)**.
- **Nossos modos:** atividade/presença por zona, detecção de objetos (caminhão, empilhadeira,
  contêiner, palete, pessoa), leitura de código, fadiga.

## Nota metodológica sobre "verificado"

As páginas de webcam de porto quase sempre montam o player via JavaScript e entregam o
`.m3u8` com **token dinâmico + trava de Referer** (SkylineWebcams, EarthCam), ou via
**YouTube** (URL HLS que expira). Por isso a maioria das URLs de stream **não pôde ser
capturada diretamente** pelo fetcher (que remove JS) — está marcada como *não verificado
(stream via JS/token)*. Onde o servidor de mídia respondeu de fato, anotei o estado real
(ex.: PTZtv responde, porém com certificado self-signed).

## Exclusões (limites obrigatórios)

- **Insecam / câmeras privadas expostas: EXCLUÍDAS.** São feeds de câmeras IP domésticas/
  empresariais expostas sem intenção do dono (senha default), sem base institucional. Não
  entram, por princípio ético/legal, mesmo que "funcionem".
- Mantidos apenas: portais oficiais de portos, praticagem/pilotagem, operadores de webcam
  comerciais que publicam intencionalmente (EarthCam, PTZtv, SkylineWebcams, livespotting),
  e canais YouTube institucionais/shipspotting oficiais.

---

## Tabela de feeds

| Nome | Local | URL do stream (ou página) | Protocolo real | Consumível direto? | Relevância p/ nossos modos | Verificado? | Termos / observação |
|---|---|---|---|---|---|---|---|
| **Port of LA — Cam 1 (San Pedro / Main Channel)** | Los Angeles, EUA | Página: https://www.earthcam.com/usa/california/losangeles/port/ · Stream: HLS EarthCam (padrão `https://videos-3.earthcam.com/fecnetwork/<id>.flv/playlist.m3u8`) | HLS (token/JS) | **Precisa extração** do `.m3u8` (parser EarthCam / streamlink) antes do ffmpeg | **Alta** — Everport Container Terminal, Terminal Island, guindastes, navios porta-contêiner, caminhões | Não (stream via JS/token) | Parceria oficial Port of LA + EarthCam. Uso: EarthCam ToS (exibição pessoal; não redistribuir). |
| **Port of LA — Cam 2 (Wilmington / East Basin)** | Los Angeles, EUA | https://www.earthcam.com/usa/california/losangeles/port/?cam=portofla2 | HLS (token/JS) | Precisa extração | **Alta** — TraPac / Yusen / WBCT container terminals, bulk líquido, portêineres | Não | Oficial Port of LA + EarthCam. |
| **PTZtv Port Miami** | Miami, EUA | https://www.ptztv.live/port-miami-webcam · endpoint histórico: `https://nyc*/liveedge/*.stream/playlist.m3u8` (portfever.com) | HLS | **Precisa** ffmpeg com verificação TLS desativada (`-tls_verify 0` / `tls_verify=0`): servidor responde mas usa **cert self-signed** | Média/Alta — navios de contêiner + cruzeiros, tugs; menos pátio | Parcial (servidor portfever responde; cert self-signed) | PTZtv — feed público comercial. |
| **PTZtv Port Everglades** | Fort Lauderdale, EUA | https://www.portevergladeswebcam.com/ (→ ptztv.live) | HLS | Precisa (mesma nota TLS PTZtv) | Média — contêineres, tankers, cais | Parcial | PTZtv. |
| **PTZtv New York Harbor** | Nova York, EUA | https://www.nyharborwebcam.com/ · histórico `pnyw.stream/playlist.m3u8` | HLS | Precisa (nota TLS PTZtv) | Média — tráfego portuário, cargas | Parcial | PTZtv. |
| **Praticagem de São Paulo — Porto de Santos "Porto ao Vivo"** | Santos/SP, **Brasil** | YouTube: https://www.youtube.com/watch?v=tMYtrEBNVAU · canal https://www.youtube.com/@santospilotsoficial · página https://www.sppilots.com.br/porto-ao-vivo | YouTube Live → HLS | **Precisa yt-dlp** p/ obter `.m3u8` (**URL EXPIRA** ~poucas horas → re-resolver periodicamente) | **Muito alta** — maior porto da América Latina, contêineres, navios, canal; institucional BR | Não (YouTube) | Institucional (praticagem oficial). Respeitar ToS do YouTube. |
| **Box Cam — Port of Southampton** | Southampton, Reino Unido | YouTube (Solent Ships): https://www.youtube.com/watch?v=OdeqPpGXh9o (4K) / https://www.youtube.com/watch?v=r2JOvc0Hw90 | YouTube Live → HLS | Precisa yt-dlp (URL expira) | **Alta** — container terminal dedicado, portêineres, empilhadeiras de contêiner (reach stackers), caminhões | Não (YouTube) | Canal shipspotting estabelecido. ToS YouTube. |
| **Hamburg Port Live** | Hamburgo, Alemanha | YouTube: https://www.youtube.com/@hamburghafenlive · Skyline: https://www.skylinewebcams.com/en/webcam/deutschland/hamburg/hamburg/hamburg-hafen.html | YouTube Live → HLS / HLS token (Skyline) | Precisa yt-dlp (expira) **ou** extração token+Referer (Skyline) | **Alta** — HHLA Container Terminal, Elbe, guindastes | Não | ToS YouTube / SkylineWebcams. |
| **Live Cam Port of Rotterdam (canal do porto)** | Roterdã, Holanda | https://www.skylinewebcams.com/en/webcam/netherlands/south-holland/rotterdam/port.html | HLS (token + Referer) | **Precisa** extrair `.m3u8` da sessão JS e enviar header `Referer: skylinewebcams.com` no ffmpeg | **Alta** — terminais de contêiner (Amazonehaven), navios porta-contêiner | Não (stream via JS/token) | SkylineWebcams ToS — só exibição, não redistribuição. |
| **SkylineWebcams — categoria portos/marinas** | Global (Helsinki, Baltimore, Boston, Victoria BC, Portland UK, Miami, Santos…) | https://www.skylinewebcams.com/en/live-cams-category/seaport-cams.html | HLS (token + Referer) | Precisa (token dinâmico + Referer header) | Média/Alta (varia por câmera) | Não | Mesma nota Skyline. Bom "catálogo" de fallback. |
| **livespotting.tv — Kiel (eclusa Nord-Ostsee-Kanal)** | Kiel, Alemanha | https://livespotting.tv/deutschland/kiel/f1q161no · mídia em `stream.livespotting.tv/windit-edge/...` | HLS (edge livespotting) / RTMP legado | Precisa extração do `.m3u8` da página; RTMP legado ingerível por ffmpeg direto | Média — eclusa/porto, navios, movimentação | Não (stream via JS) | Operador comercial de webcams; feeds públicos. |
| **livespotting.tv — Bremerhaven / Brunsbüttel** | Alemanha | https://livespotting.tv/deutschland/brunsbuettel/c790nxoz | HLS / RTMP legado | Precisa extração | Média — cidade portuária / canal | Não | idem. |
| **Janelas TV — Saída/Canal do Porto de Santos** | Santos/SP, **Brasil** | https://www.janelas.tv.br/camera-ao-vivo/sp/santos/saida-canal-do-porto/ · https://www.janelas.tv.br/camera-ao-vivo/sp/santos/ponta-da-praia/ | Player próprio (provável HLS) | Precisa inspecionar/extrair `.m3u8` do player | Média/Alta — canal do porto de Santos, navios BR | Não (stream via JS) | Serviço BR de câmeras ao vivo. |
| **Port of Rotterdam — webcams oficiais** | Roterdã, Holanda | https://www.portofrotterdam.com/en/experience-online/webcams | Provável **JPEG-snapshot** / embed | Precisa tratamento (snapshot recorrente → montar em vídeo) OU não é stream contínuo | Média — visão institucional do porto | Não (403 ao fetch; conteúdo institucional) | Autoridade portuária oficial. |
| **Vancouver — Canada Place (cruzeiros/porto)** | Vancouver, Canadá | YouTube: https://www.youtube.com/watch?v=GHEmhcWjiTE | YouTube Live → HLS | Precisa yt-dlp (expira) | Baixa/Média — mais cruzeiro que carga | Não (YouTube) | ToS YouTube. |

---

## Como consumir cada tipo (para a UI "+ Câmera IP" / hub ffmpeg)

- **HLS direto (.m3u8 estável)** → ideal, cola direto no hub. Poucos portos oferecem sem token.
- **HLS EarthCam** → resolver o `.m3u8` via parser (streamlink tem plugin EarthCam; ou ler o
  JSON do player: `html5_streamingdomain` + `html5_streampath`). Depois é HLS normal contínuo.
- **HLS SkylineWebcams / livespotting** → token dinâmico + **trava de Referer**. Extrair a URL
  da sessão e passar `-headers "Referer: https://www.skylinewebcams.com/"` ao ffmpeg. Token
  expira → precisa re-resolver.
- **PTZtv (portfever)** → HLS, mas **certificado self-signed**: no ffmpeg use
  `-tls_verify 0` (ou `tls_verify=0` na URL) senão a conexão falha.
- **YouTube Live** → `yt-dlp -g "<url>"` devolve o `.m3u8`, mas **a URL EXPIRA** (poucas horas);
  agendar re-resolução automática, ou usar `streamlink`/`yt-dlp` como proxy contínuo.
- **JPEG-snapshot (webcams oficiais de autoridade portuária)** → não é vídeo contínuo;
  para nossos modos, montar snapshots recorrentes em pseudo-vídeo (ffmpeg `-loop`/`-r`) ou
  rodar detecção por frame. Baixa taxa de quadros → ruim p/ atividade/fadiga, ok p/ presença.

---

## Melhores apostas p/ demo industrial

1. **Praticagem de São Paulo — Porto de Santos (YouTube `tMYtrEBNVAU`)** — institucional
   **brasileiro**, o maior porto da América Latina: contêineres, navios, canal 24/7. Melhor
   "história" para um público de CD no Brasil. Consumo: `yt-dlp -g` → HLS (re-resolver ao expirar).
2. **Port of Los Angeles + EarthCam (Cam 1 San Pedro / Cam 2 Wilmington)** — parceria oficial,
   enquadramento cheio de **container terminals, portêineres e caminhões** — perfeito p/
   detecção de objetos e presença por zona. Consumo: extrair `.m3u8` EarthCam (streamlink) → HLS contínuo.
3. **Box Cam — Port of Southampton (Solent Ships, YouTube 4K `OdeqPpGXh9o`)** — terminal de
   contêineres dedicado com **reach stackers / empilhadeiras de contêiner, portêineres e
   caminhões** em movimento; excelente densidade de objetos p/ demo. Consumo: `yt-dlp` → HLS (expira).

**Backup consumível com menos atrito:** PTZtv (Port Miami / Everglades / NY Harbor) entrega
HLS "cru" (sem token dinâmico), bastando desativar verificação TLS no ffmpeg por causa do
certificado self-signed — bom para testar o pipeline rápido, ainda que o enquadramento tenha
mais navio/cruzeiro que pátio.

## Observação final

Nenhuma URL `.m3u8` "eterna e sem token" de porto grande foi confirmada aberta nesta pesquisa
— o padrão do setor é token+Referer (Skyline/EarthCam), self-signed (PTZtv) ou YouTube
(expira). Todos os itens acima são **públicos por design**; nenhuma câmera privada/Insecam
foi incluída. Para produção da demo, recomenda-se um pequeno **resolvedor** (streamlink/yt-dlp)
como front-end do hub, convertendo esses feeds em um `.m3u8`/RTSP estável e contínuo.
