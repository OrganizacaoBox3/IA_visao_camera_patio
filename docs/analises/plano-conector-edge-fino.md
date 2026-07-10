# Plano — Pacote do piloto: Conector de Site (Edge Fino)

> Spec do pacote que o **cliente instala no site** para que suas câmeras IP (LAN privada atrás de
> NAT/CGNAT) sejam redistribuídas **com segurança e sem perda de qualidade** ao **hub remoto**, que
> processa/alarma/analisa. Implementa o **Nível 1** do [ADR-010](decisoes/ADR-010-conector-de-site-edge-gateway.md).
> Generaliza o PoC validado (celular IP Webcam + Tailscale → homolog puxou e analisou, 2026-07-06).

## 1. Objetivo

Um cliente leigo, **sem visita presencial**, roda **um instalador** e as câmeras da LAN dele passam
a ser analisadas no servidor remoto — vídeo **codec-copy H.264 (sem transcode)**, canal **cifrado de
saída** (sem abrir porta no roteador), **zero mudança no código central** do hub.

**Princípio (ADR-010):** o hub remoto **continua PUXANDO** o RTSP; muda-se **só o valor da URL** da
câmera para o endereço alcançável pelo túnel. Reusa `rtsp.js`/`go2rtc.js` como estão.

## 2. Escopo × fora de escopo

**No escopo (Edge Fino / piloto, 1-6 câmeras):**
- Túnel de saída (subnet router) que torna a LAN de câmeras alcançável pelo hub remoto.
- Enrolment zero-toque (chave pré-autorizada) — o cliente não faz login interativo.
- Uso do **sub-stream** (codec-copy, ~0,3-2 Mbps/câmera) para caber no uplink.
- Endurecimento: ACL do túnel restringindo o hub às câmeras; TLS/WSS no hub; segredo por site.

**Fora de escopo (fica para o Edge Grosso / produto — ADR-010 Nível 2):**
- Rodar o **motor no site** e mandar só metadados/alarmes (o appliance-conector).
- Forwarder de indicadores para um control-plane multi-cliente.
- Auto-descoberta de câmeras (ONVIF), portal de auto-onboarding, billing.
- Sistema de rotação/revogação de credencial por site em escala (aqui: só o mínimo por site).

## 3. Arquitetura

```
[ SITE DO CLIENTE — LAN privada atrás de CGNAT ]        [ SEU SERVIDOR REMOTO (homolog/prod) ]
                                                
  câmera IP ─┐                                            hub (Node)
  câmera IP ─┼─RTSP sub-stream─►  EDGE:                     ├─ rtsp.js  ── ffmpeg ──► motor D-FINE
  câmera IP ─┘   (H.264)         • cliente de túnel  ══════ túnel WireGuard cifrado ══════►  puxa
                                  • (opc.) go2rtc      (conexão de SAÍDA do site;               rtsp://<tunel>/<cam>
                                    codec-copy          nenhuma porta aberta no roteador)       (só a URL muda)
                                  • enrolment                                            └─ go2rtc central ─► WebRTC p/ dashboard
        └──── "a UMA coisa que o cliente instala" ────┘
```

**Duas variantes** (a segunda endurece a primeira):
- **(A) Só subnet router (MVP, mais rápido de validar):** o túnel anuncia a sub-rede de câmeras; o
  hub puxa `rtsp://<ip-lan-da-camera>:554/...subtype=1` direto pelo túnel. **Nenhum software no
  edge além do cliente de túnel.** É o PoC de hoje, com câmera real no lugar do celular.
- **(B) + go2rtc no edge (endurecido, formato "produto"):** o go2rtc do edge puxa as câmeras locais
  (codec-copy) e expõe **um** endpoint RTSP **só na interface do túnel**; o hub puxa dele. Vantagem:
  a superfície exposta ao hub é **só o go2rtc** (não a sub-rede inteira), consolida N câmeras e
  reaproveita `generateYaml` (`server/go2rtc.js:104-143`).

## 4. Componentes do pacote

| Componente | O que é | Reuso |
|---|---|---|
| **Cliente de túnel** | Tailscale (piloto) com **subnet router** + **auth key pré-autorizada**. Produto: avaliar **Headscale**/WireGuard puro (sem dependência de terceiro). | — (novo) |
| **go2rtc** (variante B) | Binário multiplataforma, config codec-copy, listen **só no túnel**. | `scripts/fetch-go2rtc.mjs`, `server/go2rtc.js` generateYaml |
| **Gerador de config** | Recebe a lista de câmeras (URL+cred+sub-stream) do site → gera `go2rtc.yaml` e/ou a lista de URLs a cadastrar no hub. | `server/go2rtc.js:104-143` |
| **Enrolment / instalador** | 1 script (win/linux) que instala o túnel, sobe com a auth key, aponta a sub-rede/câmeras. Config por site: `HUB`, câmeras, chave. | — (novo) |

## 5. Provisionamento (o fluxo "sem visita")

1. **Você** (operador) gera no painel do túnel uma **auth key pré-autorizada** (efêmera, 1 uso) e a
   **tag do site** (ex.: `tag:site-fabricaX`) com ACL single-tenant.
2. **Cliente** roda o instalador com: a auth key, a **sub-rede das câmeras** (ex.: `192.168.1.0/24`)
   e a **lista de câmeras** (IP + usuário/senha + caminho do sub-stream). Zero login interativo.
3. O edge entra na sua rede privada anunciando a rota; **você aprova a rota** no painel (1 clique).
4. **Você** cadastra as câmeras no hub com a URL do túnel (sub-stream) — ou o gerador entrega a
   lista pronta. O motor começa a analisar 24/7; o dashboard mostra WebRTC codec-copy.

## 6. Segurança e endurecimento (obrigatório antes de cliente real)

- **Isolamento single-tenant:** ACL do túnel permite ao **nó do hub** alcançar **só os IPs das
  câmeras nas portas 554 (+ go2rtc na variante B)** — e nada mais da LAN do cliente; o edge do
  cliente **não** enxerga outros sites nem o resto do seu tailnet (tags + ACL). Um tailnet por
  cliente é o corte mais seguro no piloto.
- **Sub-stream sempre** (banda + codec-copy). Nunca o relay MJPEG do papel `camera` (com perda).
- **go2rtc (variante B) bind na interface do túnel + firewall** — hoje ele faz listen em TODAS as
  interfaces (`server/go2rtc.js:110,117,119`); no site isso exporia `:8554/:1984` na LAN do cliente.
- **Hub público em HTTPS/WSS** (já é o caso no homolog — `src/config.ts:248-257`).
- **Segredo por site** (mínimo): não reusar o `CAMERA_TOKEN` global (`server/index.js:157`) entre
  clientes; o Fino nem usa o papel camera, mas o hub público precisa de identidade por site — trilhar.
- **Credenciais RTSP** das câmeras ficam na config do edge/hub — declarar o repositório e proteger
  em repouso (gap conhecido).

## 7. Critérios de aceite (Given/When/Then)

- **G/W/T — a ponte:** *Dado* um site com 2 câmeras IP em LAN privada atrás de CGNAT, *Quando* o
  cliente roda o instalador com a auth key + sub-rede, *Então* o hub remoto faz `ffprobe` de
  `rtsp://<cam>:554/...sub` **pelo túnel** em ≤ alguns min, **sem** port-forward no roteador.
- **G/W/T — qualidade sem perda:** *Dado* a câmera cadastrada, *Quando* aberta no dashboard,
  *Então* o vídeo é **H.264 codec-copy** (WebRTC via go2rtc), e o `ffprobe` mostra o codec nativo
  da câmera (nenhum re-encode).
- **G/W/T — análise 24/7:** *Dado* nenhum espectador, *Então* o motor acumula indicadores/alarmes
  da câmera do site (motor server-side, ADR-009).
- **G/W/T — isolamento:** *Dado* a ACL do túnel, *Quando* o hub tenta alcançar um host não-câmera
  da LAN do cliente, *Então* é **negado**.
- **G/W/T — dimensionamento honesto:** *Dado* o uplink medido em U Mbps, *Então* o nº máximo de
  câmeras = `floor(U_margem / bitrate_sub)` **documentado antes** do onboarding.
- **G/W/T — resiliência WAN:** *Dado* o túnel cai, *Quando* reconecta, *Então* o ingest RTSP do hub
  se recupera dentro do backoff (**medir** — hoje calibrado p/ LAN).

## 8. Tarefas

- **[S]** Escolher o túnel do piloto (**Tailscale + auth key pré-autorizada**) e montar tailnet com
  **tags/ACL single-tenant**. (Produto: PoC de Headscale self-host para tirar a dependência.)
- **[P]** Empacotar o **instalador edge** (win/linux): instala o cliente de túnel, `up
  --advertise-routes --authkey`, e (variante B) baixa go2rtc + gera `go2rtc.yaml` da lista de
  câmeras. Reusar `scripts/fetch-go2rtc.mjs` + `generateYaml`.
- **[P]** **Runbook do operador**: gerar auth key, aprovar rota, cadastrar câmera (URL do túnel,
  sub-stream), checklist de aceite.
- **[P]** **Endurecimento**: ACL (hub → só IP:554 das câmeras), bind do go2rtc no túnel, confirmar WSS.
- **[S]** **Script de medição de uplink** do site + tabela câmeras × bitrate (sub ~1 Mbps).
- **[P]** **Medir reconexão RTSP sobre WAN** (latência/quedas) e ajustar `STALE_MS`/backoff se preciso.
- **[P]** (gap) trilhar **credencial/identidade por site** (aposentar o `CAMERA_TOKEN` global).
- **[S]** **Validação de aceite** — ver §9.

## 9. Validação — já temos meia estrada andada

O ambiente do piloto **já está montado**: o homolog é "o servidor", a tailnet existe e a análise de
uma câmera **pelo túnel** foi provada hoje (com o celular). Para fechar a spec com **câmera real**:
1. Conectar uma **Intelbras VIP / Hikvision** (Tier 4 de `docs/analises/plano-teste-camera-real.md`) na
   LAN do dev — ela vira "a câmera do cliente".
2. Subir o **subnet router** (variante A) apontando a sub-rede dessa câmera.
3. Cadastrar no homolog a URL **sub-stream** pelo túnel; rodar os critérios da §7 (ponte, codec-copy,
   24/7, isolamento, reconexão).
4. Medir o uplink e preencher a tabela de dimensionamento.

## 10. Riscos (declarados)

- **Uplink é o teto:** N × ~1 Mbps 24/7 satura rápido em plano assimétrico/CGNAT — **medir antes**
  de prometer nº de câmeras.
- **Vídeo + credenciais saem do site** (túnel cifrado, single-tenant) — servidor **fora do BR** =
  transferência internacional (avaliar LGPD/contrato de tratamento).
- **Reconexão RTSP sobre WAN** não foi medida (backoff calibrado p/ LAN).
- **Dependência de terceiro** (Tailscale) no piloto — mitigar no produto com Headscale/WireGuard.
- **go2rtc listen amplo** (variante B) — endurecer bind/firewall antes de cliente real.
- Quando o Edge Fino saturar (uplink/nº de câmeras/LGPD), **migrar para o Edge Grosso** (ADR-010
  Nível 2) — sem retrabalho do central.
