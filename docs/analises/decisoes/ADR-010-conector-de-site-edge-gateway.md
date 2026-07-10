# ADR-010 — Conector de site (edge gateway) para câmeras de clientes remotos

**Status:** proposto (aguardando "siga" do dono do produto) · **Data:** 2026-07-06

## Contexto

Novo cenário de negócio: processar câmeras de um cliente (ex.: fábrica) num **servidor remoto**
(o modelo do homolog), **sem visita presencial**. As câmeras IP são RTSP numa **LAN privada
atrás de NAT/CGNAT** — inalcançáveis da internet. Abrir porta no roteador do cliente é inseguro
e, sob CGNAT de operadora, muitas vezes impossível. Logo: não se conecta cada câmera à internet;
precisa-se de **UMA peça no site** que faça a ponte por uma **conexão de SAÍDA** (o oposto do
RTSP, que exige entrada).

**PoC validado (2026-07-06):** celular (app IP Webcam expondo RTSP) + **Tailscale** (túnel de
saída) → o homolog **puxou e analisou** o stream. Provou o padrão **edge gateway** de ponta a
ponta. Ver `docs/analises/plano-teste-camera-real.md` e o piloto detalhado em
`docs/analises/plano-conector-edge-fino.md`.

**Análise de código (workflow 3 agentes, 2026-07-06):**
- O papel `camera` + `CAMERA_TOKEN` (`server/index.js:154-163`, `server/sockets/camera.js:27`) já
  é um canal **outbound autenticado**, MAS transporta **MJPEG re-encodado** (`rtsp.js` `-f mjpeg`,
  ~2-6 Mbps **com perda**) — o oposto de "sem perda". **Descartado** para este fim.
- O **go2rtc que já empacotamos** (`server/go2rtc.js`) **faz codec-copy** de verdade (H.264 sem
  re-encode), mas hoje é configurado como **servidor local** (listen `:8554/:1984/:8555`), nunca
  como publicador outbound.
- `rtsp.js`/`go2rtc.js` do hub **puxam qualquer URL alcançável** (`server/index.js:258`): com um
  túnel, **só o VALOR da URL da câmera muda** — o código central de ingest fica intacto.
- **Banda é o teto real:** a análise amostra **~1fps** (`engine.js:44`) mas o ingest bruto é
  10-30fps ⇒ ~90% dos frames não têm consumidor no remoto. N câmeras × bitrate vs **uplink do
  site** decide quantas câmeras cabem.

## Decisão

Adotar o **conector de site em DOIS NÍVEIS**, escolhidos por cenário — não uma resposta única:

**Nível 1 — Edge FINO (piloto / poucos clientes, 1-6 câmeras):** no site, um pacote =
**cliente de túnel WireGuard/Tailscale (subnet router)** + (opcional, p/ endurecer) **go2rtc
codec-copy**. O **hub remoto continua PUXANDO** o RTSP; muda-se **só o valor da URL** da câmera
para o endereço do túnel, usando o **sub-stream** (codec-copy, sem perda). **Zero mudança no
código central.** Custo aceito e declarado: vídeo + credenciais cruzam a WAN (túnel cifrado,
**single-tenant**), limitado pelo uplink do site.

**Nível 2 — Edge GROSSO (produto SaaS multi-cliente, escala):** empacotar o **hub atual** como
**appliance-conector no site** — ele já roda motor D-FINE + ffmpeg + go2rtc e foi desenhado para
câmeras na LAN (ADR-009). Só **metadados/alarmes/thumbnails** cruzam para um control-plane remoto
(~0,3 Mbps/10 câmeras); vídeo ao vivo só **sob demanda** pelo túnel. **LGPD-limpo** (imagem nunca
sai da LAN). **Não contradiz o ADR-009** — em produção o hub JÁ é on-site; edge grosso é a mesma
arquitetura, apenas empacotada como conector.

**Regras:** (1) **medir o uplink real do cliente** antes de prometer nº de câmeras — Fino até
saturar, Grosso quando escala/LGPD pedirem. (2) **"Sem perda" = SEMPRE go2rtc codec-copy no
sub-stream** — NUNCA o relay MJPEG do papel `camera`.

## Consequências

- **+** Piloto remoto sem visita, reusando o PoC já provado; **zero código central** no Fino.
- **+** Qualidade preservada: codec-copy H.264 no sub-stream (~0,3-2 Mbps) vs MJPEG (~2-6 Mbps com
  perda) — o caminho certo é **melhor E mais barato**.
- **+** LGPD/ADR-002: frames seguem efêmeros nos dois níveis; o túnel cifra em trânsito. O Grosso
  mantém a imagem na LAN do cliente.
- **+** Evolução Fino→Grosso **sem retrabalho do central** (o hub é o mesmo; muda onde ele roda).
- **−** Nova dependência operacional: um **cliente de túnel provisionado por site** (o "instalar
  UMA coisa" do dono) — não existe no nosso código hoje.
- **−** Fino: vídeo + credenciais **saem do site** (limitado por uplink, ~4-6 câmeras); servidor
  remoto **fora do Brasil** = transferência internacional de dados (avaliar LGPD).
- **−** A construir: pacote/instalador edge; provisionamento por site; **endurecimento** (go2rtc
  faz listen em TODAS as interfaces — `go2rtc.js:110,117,119` — precisa bind na interface do túnel
  + firewall); **credencial por site** (o `CAMERA_TOKEN` é global — segredo único, fraco p/
  multi-cliente); e, no Grosso, o **forwarder de metadados** (estender o padrão do
  `ALERT_WEBHOOK_URL`).
- **Risco declarado:** o "push outbound nativo" do go2rtc (WHIP/RTSP push a um go2rtc central)
  **NÃO foi validado** — o Fino usa **túnel + pull** (comprovado no PoC), não push. A reconexão
  RTSP **sobre WAN** (latência/quedas) não foi medida; o `STALE_MS`/backoff atual foi calibrado
  para LAN.
