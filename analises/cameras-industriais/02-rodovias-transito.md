# Câmeras de trânsito/rodovias governamentais + OpenALPR — avaliação de consumo no pipeline

Projeto: Visão Computacional MVP — Grendene CD Inovação
Data: 2026-07-01
Tema: fontes **oficiais/públicas** de câmeras de trânsito e rodovias (BR / EUA / Europa) e a **lista de câmeras do OpenALPR**, avaliadas quanto à relevância industrial (fluxo de veículos/caminhões) e, principalmente, quanto a **serem consumíveis direto** pelo hub (ffmpeg → RTSP / HLS `.m3u8` / MJPEG contínuo).

> Escopo respeitado: **somente fontes oficiais/públicas** (órgãos de trânsito, DOTs, 511, dados abertos). **Nada** de Insecam, Shodan, varredura de rede ou câmera privada.

---

## Critério técnico central (o que o hub aceita)

O hub ingere via ffmpeg um fluxo **contínuo**: `rtsp://…`, HLS `…/playlist.m3u8` (ffmpeg lê HTTP), ou MJPEG contínuo (`…/mjpg/video.cgi`). Esses entram **direto**.

**JPEG-snapshot** (uma imagem `.jpg` que é reescrita/atualizada a cada N segundos — 20 s a 5 min) **NÃO** é um fluxo: é um arquivo estático que muda. O ffmpeg lendo essa URL captura **1 frame e encerra**. Para virar "vídeo" precisa de um **poller** (baixar a JPG a cada N s e remontar em frames) — que **não existe** no pipeline atual.

**Conclusão adiantada:** a **maioria absoluta** dos órgãos de trânsito (sobretudo no Brasil) serve **JPEG-snapshot** — NÃO consumível direto. A exceção valiosa são os sistemas **511 dos EUA baseados na plataforma Iteris/IBI** (ex.: 511NY, 511GA, FL511), que expõem **HLS `.m3u8` real** por câmera — esses **entram direto**.

---

## 1. Tabela de fontes

| Órgão / Fonte | Região | Tipo real | Consumível direto? | Como obter a URL do stream | Relevância industrial | Verificado? |
|---|---|---|---|---|---|---|
| **511NY** (NY State DOT) | EUA-NY | **HLS `.m3u8`** (campo `VideoUrl` por câmera) | **SIM** (ffmpeg lê HLS) | API `https://511ny.org/api/v2/get/cameras?key=CHAVE&format=json` → cada câmera tem `Views[].VideoUrl` = `…/playlist.m3u8`. Chave grátis (cadastro). | Alta — rodovias/interstates, fluxo de veículos e **caminhões** | **Parcial**: doc oficial confirma `VideoUrl` HLS; chave/stream não testados daqui |
| **511GA** (Georgia DOT) | EUA-GA | **HLS `.m3u8`** (servidor `vss1live.dot.ga.gov`) | **SIM** (ffmpeg lê HLS) | API `https://511ga.org/api/v2/get/cameras?key=CHAVE` → `VideoUrl` p/ ex. `https://vss1live.dot.ga.gov/lo/<cam>.stream/playlist.m3u8`. Chave grátis. | Alta — I-75/I-85, corredores de carga | **Parcial**: URL m3u8 documentada; **não** respondeu no teste daqui (cam específica offline ou egress bloqueado) |
| **FL511 / FDOT** (SunGuide) | EUA-FL | **HLS streaming** (upgrade oficial "streaming capabilities") | **SIM** (esperado, mesma família) | Portal `https://fl511.com/cctv`; FDOT anunciou streaming ao vivo em muitas câmeras. Padrão de URL não publicado abertamente → inspecionar requests da página ou API 511. | Alta — I-95/I-4/Turnpike, muito caminhão | **Não verificado** (streaming confirmado por SunGuide; URL exata não obtida) |
| **Outros "511" Iteris/IBI** (ex.: 511VA, 511PA, 511WI, iState variantes) | EUA (vários) | Geralmente **HLS `.m3u8`** via mesma plataforma | **Provável SIM** | Mesmo padrão de API `…/api/v2/get/cameras?key=` com `VideoUrl`. Confirmar por estado. | Alta | **Não verificado** por estado |
| **WSDOT** (Washington DOT) | EUA-WA | **JPEG-snapshot** (refresh ~5 min) | **NÃO** (precisa poller) | API `https://wsdot.wa.gov/traffic/api/` (classe `Camera`) → campo `ImageURL` = `.jpg` estático | Alta (rodovias) mas snapshot lento | **Verificado** (doc oficial: "only supports snapshots") |
| **Caltrans / QuickMap** (Califórnia DOT) | EUA-CA | **JPEG-snapshot** (CWWP2, refresh ~3 min; alguns distritos com vídeo piloto) | **NÃO** (majoritariamente) | API CWWP2 (SOAP-like, por distrito) → URLs de imagem `.jpg` | Alta (fluxo pesado) mas snapshot | **Verificado** (doc/FAQ Caltrans: snapshots) |
| **NYC DOT / nyctmc** | EUA-NYC | **JPEG-snapshot** (urbano) | **NÃO** | Portal `webcams.nyctmc.org` → imagens `.jpg` por câmera | Média (urbano, menos caminhão) | **Não verificado** (endpoints históricos mudaram) |
| **DER-SP — Câmeras Online** | BR-SP | **JPEG-snapshot** / embed web | **NÃO** | `der.sp.gov.br/.../CamerasOnline.aspx` → imagem que atualiza em intervalo | Alta (rodovias estaduais SP, caminhão) | **Não verificado** stream bruto (padrão = snapshot) |
| **ARTESP — CCM** (concessionárias SP) | BR-SP | **JPEG-snapshot ~20 s** (algumas "live") | **NÃO** (regra); talvez poucas live | `ccm.artesp.sp.gov.br` — 1.770 câmeras das concessionárias; imagens atualizam ~20 s | **Muito alta** (rodovias de carga SP: Anhanguera, Bandeirantes, Dutra via concessões) | **Parcial**: fonte indica "atualiza a cada 20 s" (snapshot) |
| **DER-PR / DAER-RS / DNIT** | BR-PR/RS/nac. | **embed web / JPEG-snapshot** | **NÃO** | Portais `der.pr.gov.br`, `daer.rs.gov.br`; DNIT via concessionárias | Alta (rodovias federais/estaduais, caminhão) | **Não verificado**; sem RTSP/HLS aberto documentado |
| **CET-SP / CET-Rio** | BR-SP/RJ | **JPEG-snapshot / iframe** (urbano) | **NÃO** | Portais oficiais; snapshots periódicos | Média (trânsito urbano) | **Não verificado** stream bruto |
| **Concessionárias (EcoRodovias/CCR etc.)** | BR | embed web (CCO) | **NÃO** | Páginas de "monitoramento 24h"; sem stream aberto | Alta (pátios/praças de pedágio, caminhão) | **Não verificado**; normalmente fechado |
| **OpenALPR `cameras.yaml`** | — (repo) | **NÃO é lista de câmeras** — só **templates de config** | **NÃO** (não há URL real) | `github.com/openalpr/openalpr/.../runtime_data/cameras.yaml` = padrões de URL por fabricante (Axis/Hikvision/Dahua) com placeholders `[username]/[ip_address]` | Nenhuma como fonte (é doc de integração de câmera própria) | **Verificado**: contém só placeholders, zero câmera pública |
| **Europa (ex.: TfL/Highways England "JamCams", Trafikverket)** | UE/UK | Majoritariamente **JPEG-snapshot** (TfL JamCams ~ imagem; alguns MP4 curtos) | **NÃO** (em geral) | APIs abertas (TfL Unified API) → imagens/clipes curtos, não stream contínuo | Média/alta | **Não verificado** neste ciclo |

---

## 2. O que dá pra usar HOJE sem poller (só MJPEG/HLS/RTSP contínuo)

Apenas os sistemas **511 dos EUA na plataforma Iteris/IBI**, que expõem **HLS `.m3u8` por câmera** — ffmpeg lê direto, sem código novo:

1. **511NY** — melhor documentado. Fluxo: pegar chave grátis em 511ny.org → chamar `https://511ny.org/api/v2/get/cameras?key=CHAVE&format=json` → usar `Views[].VideoUrl` (ex.: `…/playlist.m3u8`) no campo `url` do `server/rtsp.sources.json`.
2. **511GA** — mesmo padrão; streams no servidor `vss1live.dot.ga.gov` (`…/<cam>.stream/playlist.m3u8`).
3. **FL511 / FDOT** — FDOT ativou "streaming capabilities" (HLS) em muitas câmeras; URL exata a extrair da página/API 511. **Altíssima relevância de caminhão** (I-95, Turnpike).
4. **Outros 511 Iteris/IBI** (VA, PA, WI, etc.) — provável mesmo esquema `VideoUrl` m3u8; confirmar por estado antes de usar.

> Observação: são cenas de **rodovia** (fluxo de veículos/caminhões) — exatamente o alvo dos modos "objetos (veículo/caminhão)" e "fluxo". É a fonte governamental **mais legítima e mais consumível** encontrada.
>
> Ressalva de verificação: no teste local a URL `.m3u8` de exemplo do GA **não retornou conteúdo** (câmera específica pode estar offline, ou egress do ambiente bloqueado). Validar 1–2 URLs reais com `ffmpeg -i <m3u8>` antes da demo. E os `VideoUrl` podem **rotacionar** — sempre re-buscar via API na hora.

---

## 3. O que é JPEG-snapshot (NÃO entra direto) — e por quê

A **maioria** das fontes governamentais — e **quase todas as brasileiras** (DER-SP, DER-PR, DAER-RS, DNIT, CET-SP/Rio, ARTESP/concessionárias) além de **WSDOT** e **Caltrans** nos EUA — serve **JPEG-snapshot** (imagem `.jpg` reescrita a cada 20 s–5 min) ou apenas **embed de página**. Motivo declarado pelos DOTs: **custo de banda/comunicação**. Isso **não** é fluxo contínuo:

- ffmpeg apontado à `.jpg` pega **1 frame e sai** → não vira vídeo.
- Modos de "fluxo" e "atividade por zona" ficam prejudicados (cadência de 20 s+ é baixa demais p/ contagem confiável de fluxo; ainda serve p/ presença/ocupação grosseira).

### Recomendação de evolução (NÃO implementar agora)
Um **mini-poller de snapshot** como módulo opcional: baixa a `.jpg` a cada N s (respeitando rate limit do órgão), remonta em MJPEG/frames e injeta no mesmo pipeline. Isso **destrava BR inteiro** (ARTESP 20 s é o melhor candidato: 1.770 câmeras de rodovia de carga) + WSDOT/Caltrans/NYC. Baixo esforço, alto ganho de cobertura — mas fica como backlog, fora do MVP.

### OpenALPR — veredito
A "lista de câmeras" do OpenALPR (`cameras.yaml`) **não é uma lista de câmeras públicas**: é um arquivo de **templates de configuração** por fabricante (padrões de URL RTSP/MJPEG com placeholders para IP/usuário/senha da sua própria câmera). **Não expõe nenhum stream público** e **não serve** como fonte para o "+ Câmera IP". Útil só como referência de formatos de URL por fabricante.

---

## 4. Resumo executivo

- **Consumíveis direto (HLS/RTSP/MJPEG contínuo):** os **511 Iteris/IBI dos EUA** — **511NY** (mais confiável, `VideoUrl` m3u8 documentado), **511GA** (`vss1live.dot.ga.gov/*.m3u8`), **FL511/FDOT** (streaming ativado). Requerem **chave grátis** e re-busca da URL via API.
- **JPEG-snapshot (precisa poller):** praticamente **todo o Brasil** (DER-SP, DER-PR, DAER-RS, DNIT, CET, **ARTESP ~20 s**) + **WSDOT (~5 min)**, **Caltrans (~3 min)**, NYC, maioria da Europa.
- **OpenALPR:** **não usar** como fonte — é só template de config, sem câmera pública.
- **Recomendação:** para a demo, plugar 1–3 câmeras **511NY** (rodovia/caminhão, entra direto). Para cobertura BR de verdade (ARTESP/DER), planejar **mini-poller de snapshot** como evolução pós-MVP.

---

## Fontes

- [OpenALPR cameras.yaml (repo)](https://github.com/openalpr/openalpr/blob/master/runtime_data/cameras.yaml) · [OpenALPR API docs](http://doc.openalpr.com/api.html)
- [511NY Cameras API (endpoint doc)](https://511ny.org/help/endpoint/cameras) · [511NY CCTV](https://511ny.org/cctv)
- [511GA Cameras API (endpoint doc)](https://511ga.org/help/endpoint/cameras) · [511GA CCTV](https://511ga.org/cctv)
- [FL511 CCTV](https://fl511.com/cctv) · [SunGuide: 511 cameras now have streaming capabilities](https://sunguide.info/511-cameras-now-have-streaming-capabilities/)
- [WSDOT Traveler Information API — Camera class](https://wsdot.wa.gov/traffic/api/Documentation/class_camera.html) · [WSDOT API](https://wsdot.wa.gov/traffic/api/)
- [Caltrans Traffic Camera FAQ](https://dot.ca.gov/caltrans-near-me/district-2/d2-popular-links/d2-traffic-camera-faq)
- [ARTESP CCM — Centro de Controle Multimodal](https://ccm.artesp.sp.gov.br/) · [DER-SP Câmeras Online](http://www.der.sp.gov.br/WebSite/Servicos/ServicosOnline/CamerasOnline.aspx) · [DER-PR](https://www.der.pr.gov.br/)
- [DOT Cameras vs Webcams (formatos)](https://trafficvision.live/blog/dot-cameras-vs-webcams-vs-security-cameras) · [road511: normalizando 30 APIs 511](https://dev.to/road511/how-i-normalized-30-different-511-traffic-apis-into-one-rest-endpoint-3cl9)
