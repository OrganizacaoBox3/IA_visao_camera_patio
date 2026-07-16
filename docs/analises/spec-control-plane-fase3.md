# SPEC/Design — Control-plane Fase 3: vídeo sob demanda por túnel

> Deriva de `spec-control-plane.md` (Fase 3) e do ADR-010. Insumo: design read-only (o que o stack já
> dá · comparação dos caminhos de túnel). **Decisão de arquitetura pesada — design ANTES de código.**

## 0. A boa notícia: o stack já entrega ~80%
- **go2rtc faz WebRTC codec-copy H.264** (sem re-encode), auto-ligado pela presença do binário
  (`server/go2rtc.js`). STUN no cliente; **sem TURN** (NAT simétrico/CGNAT não fecha sem relay).
- **O hub já faz reverse-proxy same-origin de `/go2rtc/*`** (HTTP + upgrade WS da sinalização) →
  `127.0.0.1:1984`. O plane pode replicar ESSE mesmo proxy apontando ao túnel.
- **O front (`<video-stream>` vendorizado) já negocia WebRTC→MSE→MJPEG** com fallback por câmera; o
  portal reusa o mesmo custom element, só troca a baseURL.
- **O forwarder já disca out** (SITE_ID/SITE_KEY, HMAC, fail-soft) — a base do canal de sinalização.

## 1. O GAP nº1, bloqueante E valioso já: o S1 (go2rtc sem auth)
`/go2rtc/*` é proxiado **ANTES** do `requireAuth` (`server/index.js`) — hoje contido só pela LAN. Quem
alcança o hub pega `GET /api/streams` + o vídeo ao vivo de TODAS as câmeras **sem token**. É **imagem sem
auth** = o pior sob LGPD. A Fase 3 (expor remotamente) **obriga** a fechar. Conserto (vale para QUALQUER
caminho de túnel, e conserta uma vulnerabilidade real HOJE):
- Gate de auth no proxy `/go2rtc/*` (ticket HMAC, reusa o token de `users.js`/`SITE_KEY`).
- Checar que o `src=<cameraId>` ∈ escopo do usuário (`canAccess`/câmera permitida).
- go2rtc com `api: username/password` no YAML + bind local (já é 127.0.0.1).
**Este é o primeiro tijolo de código da Fase 3 — independe da escolha de túnel e fecha o #66.**

## 2. A recomendação: DOIS PASSOS (padrão do ADR-010)
- **Passo 1 — PILOTO: VPN gerenciada (Tailscale).** Único caminho **já provado** ponta a ponta (PoC do
  ADR-010: Tailscale + pull, stream real atrás de NAT). O plane entra no tailnet e faz o mesmo
  reverse-proxy `/sites/<id>/go2rtc/*` → IP-de-mesh do hub. Front cai para MSE (browser fora do mesh).
  **Zero código central novo**; frame efêmero na memória do plane (ADR-002 permite; nunca em disco).
- **Passo 2 — ALVO DE PRODUTO: WebRTC + TURN (coturn), sinalização pelo canal que o HUB DISCA.**
  Desenho **nativo** do WebRTC para NAT e o **mais forte em LGPD**: a mídia flui browser↔TURN↔go2rtc como
  **SRTP opaco** — o plane NUNCA decodifica pixel, só relaya bytes cifrados. Reusa o WebRTC do go2rtc (só
  ganha `ice_servers` no YAML — o env `GO2RTC_WEBRTC_CANDIDATES` já existe) + o `<video-stream>` do front.
  A sinalização (SDP/ICE, poucos KB) desce pelo canal outbound (evolução do forwarder: WS persistente).
- **REJEITADO como caminho de MÍDIA:** túnel reverso próprio multiplexando o vídeo — reconstrói um
  ngrok/frp e põe o plane no caminho do pixel sem vantagem sobre o TURN. Mas o canal outbound do hub é a
  **peça certa para a SINALIZAÇÃO** do Passo 2 (leve, barato, reusa o HMAC).

## 3. A decisão que é do DONO (comprar × construir)
Troca dinheiro/vendor por código/operação — não há resposta técnica única:
- **COMPRAR (Tailscale):** pilota em dias reusando o PoC; NAT/sinalização "desaparecem". Custo: vendor +
  coordination-server SaaS no caminho crítico de vídeo (fere "sem dep supérflua"), preço por site ao
  escalar, um cliente-de-túnel a instalar por site. (Mitiga o vendor com Headscale self-host, mas aí some
  o "gerenciado".)
- **CONSTRUIR (túnel reverso p/ signaling + coturn p/ mídia):** zero vendor, tudo no idioma da casa.
  Custo: mais código (mux/reconexão/backpressure sobre WAN — o ADR-010 avisa que o backoff é de LAN) +
  um coturn a operar/endurecer.
**Recomendação:** Tailscale para o **PILOTO** (reversível, provado), com o **alvo** sendo o in-house
WebRTC+TURN — a migração é **sem retrabalho do central** (front e proxy são os mesmos). O "quando/se
trocar buy→build" é chamada de negócio (custo Tailscale ao escalar × operar coturn).

## 4. MVP + critério de aceite
UM site atrás de NAT + o plane em IP público + UM operador abrindo UMA câmera pelo portal.
- **Given** hub NAT'd no tailnet e operador com escopo do site, **When** abre a câmera, **Then** vídeo em
  < ~7s (o `WEBRTC_FAIL_MS` já existe) e o frame nunca toca o disco do plane.
- **Given** usuário SEM escopo do site, **When** tenta `/sites/<id>/go2rtc/api/frame.jpeg`, **Then** 401/403.
- **Given** o plane reiniciado, **Then** nenhum frame em disco.

## 5. PONTO CEGO declarado (só valida com deploy REAL)
Tudo em LAN passa VERDE e **prova ZERO** sobre: (a) ICE/candidatos por CGNAT de operadora real;
(b) se o TURN é de fato forçado e quanta banda carrega; (c) reconexão RTSP sobre WAN com perda/quedas
(o backoff/STALE_MS foi calibrado para LAN); (d) se o browser do operador alcança o TURN. Estes números
só existem medindo na topologia real — **não** no `npm run verify`.

## 6. Ordem de construção proposta
1. **Fechar o S1** (auth no proxy `/go2rtc/` + src∈escopo + credencial go2rtc) — valioso já, independe do
   túnel. **[o primeiro tijolo, construível e testável sem deploy real]**
2. Decisão do dono: túnel do piloto (Tailscale/Headscale).
3. Plane ganha o proxy `/sites/<id>/go2rtc/*` atrás do `canAccess`, apontando ao túnel do piloto.
4. Portal monta o `<video-stream>` reusado. Validar na topologia real (o ponto cego).
5. (Produto) coturn + `ice_servers` no go2rtc + sinalização pelo canal outbound.
