# Guia de Câmeras para Integração — Produção (LAN) + Demo remoto

> Consolida a pesquisa (`01`–`05` nesta pasta). **Foco real: câmeras de segurança na mesma rede local do hub.**
> Feeds públicos entram só como **demo/validação remota**. Todas as opções aqui são consumíveis pelo hub
> (RTSP/HLS/MJPEG contínuo) e o cadastro é pela UI **"+ Câmera IP"** (superadmin). *Câmeras padrão já removidas
> (`rtsp.sources.json` vazio) — nada auto-carrega.*
>
> ⚠️ **Ético/legal:** só feeds públicos por design / suas próprias câmeras. **Insecam e câmeras privadas expostas sem
> intenção foram excluídas** por princípio.

---

## A) PRODUÇÃO — câmeras de segurança (CFTV) na LAN  ← o dia a dia
A câmera IP e o **hub precisam estar na mesma rede** (mesma sub-rede/VLAN; firewall liberando a porta **554**).
Cadastre a URL RTSP na UI "+ Câmera IP" com **transport = tcp**.

### Receitas de URL RTSP por fabricante (porta 554; use o **sub-stream** p/ poupar CPU/banda)
| Fabricante | Main-stream | Sub-stream | Observação |
|---|---|---|---|
| **Hikvision** | `rtsp://user:senha@IP:554/Streaming/Channels/101` | `.../102` | id = canal×100 + tipo (1=main,2=sub); canal 3 → `301`/`302` |
| **Dahua** | `rtsp://user:senha@IP:554/cam/realmonitor?channel=1&subtype=0` | `subtype=1` | — |
| **Intelbras (VIP/NVR)** | `rtsp://user:senha@IP:554/cam/realmonitor?channel=1&subtype=0` | `subtype=1` | mesma plataforma da Dahua. ⚠️ linha **Mibo** doméstica normalmente **não** expõe RTSP |
| **Axis** | `rtsp://user:senha@IP:554/axis-media/media.amp` | `.../media.amp?resolution=640x480` | sem canal/subtype |
| **Genérico/ONVIF** | ⚠️ sem caminho fixo | — | descobrir via ONVIF `GetStreamUri` |

### Como descobrir a câmera na rede (ordem recomendada)
1. **ONVIF Device Manager** (recomendado) — acha a câmera **e já entrega a URL RTSP pronta**.
2. Lista de **DHCP do roteador** (achar o IP).
3. Ferramenta do fabricante: Hikvision **SADP** · Dahua/Intelbras **ConfigTool** · Intelbras **IP Utility** · **AXIS IP Utility**.
4. Varredura na própria rede: `nmap -p 554,80,8000 192.168.x.0/24`.

### Boas práticas p/ o nosso pipeline
- **Sub-stream** (menor resolução) → menos CPU do ffmpeg e banda; a detecção já roda em resolução reduzida.
- **transport = tcp** na UI (mais estável que udp).
- **Usuário só-leitura** dedicado na câmera (não o admin).
- H.265/HEVC funciona (ffmpeg lê), mas é mais pesado que H.264 — prefira H.264 no sub-stream.
- Detalhes e troubleshooting completos: `05-cameras-seguranca-lan.md` e `docs/produto/manuais/manual-camera-rtsp.md` / `manual-intelbras-rtsp.md`.

### Passo a passo (UI)
1. Login superadmin → Central → **"+ Câmera IP"**.
2. Cole a URL RTSP (main ou sub), escolha **transport tcp**, dê um label → **Adicionar**.
3. Acompanhe o status do tile: `connecting → online` (ok) · `error` (ver troubleshooting).

### Troubleshooting rápido
- **401** → usuário/senha errados (ou usuário sem permissão de stream).
- **error/timeout** → caminho RTSP errado, sub-rede/VLAN diferente, ou firewall bloqueando 554.
- **sem imagem / trava** → tente o sub-stream; confirme codec (H.265 pesa mais).
- **"ffmpeg não encontrado"** → resolvido no hub (auto-detecção); se persistir, defina `FFMPEG_PATH`.

---

## B) DEMO / validação remota (quando não há câmera de LAN à mão)
Poucas opções realmente **consumíveis direto e estáveis**. Cole na "+ Câmera IP" igual a uma câmera real.

### B.1 Validar o pipeline AGORA (sempre-online, mas cena sintética/sem veículos)
- **Apple BipBop (HLS, verificado):** `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8`
- **Mux BBB (HLS, verificado):** `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- **Wowza (RTSP, looping):** `rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1` (⚠️ pode rotacionar)

### B.2 Cena industrial real (portos/logística) — mais frágil
- **PTZtv** (Port Miami / Everglades / NY Harbor): entrega **HLS sem token**, mas com **cert self-signed** (o ffmpeg precisa de TLS-verify-off; **não** cadastra direto sem esse ajuste). Cena real: navios/caminhões.
- **livespotting.tv** (portos alemães — Kiel/Bremerhaven/eclusas): **HLS nativo estável**; extrair o `.m3u8` via DevTools → Network (filtro `m3u8`) e testar no hub.
- **YouTube Live** (excelentes cenas: Porto de **Santos** `tMYtrEBNVAU`, **Southampton Box Cam**, **Port of LA**): HLS via `yt-dlp -g <url>`, porém a URL **EXPIRA** (minutos–6h) → só **teste pontual**, não cadastro fixo.

### O que NÃO serve direto (documentado nos relatórios)
- **EarthCam / SkylineWebcams:** termos de uso **proíbem extração/redistribuição** (e EarthCam é iframe-only). ❌
- **Trânsito BR (DER-SP/PR, DAER-RS, DNIT, ARTESP, CET) e muitos DOTs (WSDOT/Caltrans):** **JPEG-snapshot** (atualiza a cada N s), **não** é stream — exigiria um **mini-poller de snapshot** (evolução futura, não implementada). ❌ direto.
- **US 511 (NY/GA/FL):** têm HLS, mas exigem **chave grátis** e a URL **rotaciona** (re-buscar via API). 🟡
- **OpenALPR:** o `cameras.yaml` é só **template de config por fabricante**, **não** uma lista de câmeras públicas. ❌

---

## Recomendação
1. **Produção:** conecte as **próprias câmeras de segurança do CD** pela seção A (ONVIF Device Manager → URL RTSP → "+ Câmera IP", sub-stream + tcp). É o caminho robusto e sob seu controle.
2. **Validar a integração de rede sem sair da mesa:** use o **kit B.1** (Apple/Mux HLS + Wowza RTSP).
3. **Demo com cena industrial real:** um **YouTube de porto** (via `yt-dlp -g`, teste pontual) ou **PTZtv** (se aceitarmos o ajuste de TLS self-signed).

## Evoluções candidatas (não implementadas — sinalizadas para decisão)
- **Mini-poller de snapshot** (JPEG→frames) para habilitar a enorme base de câmeras de trânsito BR (ARTESP/DER/DNIT).
- **Suporte a TLS self-signed** no ingest (habilita PTZtv e câmeras com cert próprio).
- **Re-resolvedor de HLS do YouTube** (renova a URL que expira) — só se houver caso de uso recorrente.
