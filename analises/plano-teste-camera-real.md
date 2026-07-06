# Plano de teste com câmera REAL — fontes confiáveis, validadas

> Motivação: as câmeras públicas whatsupcams (HLS Croácia) são flaky demais para julgar
> fluidez/detecção — os timeouts de pull/broken-pipe eram da FONTE, não do motor (o pool
> estava ~90% ocioso). Este plano substitui o achismo por fontes **validadas**: streams
> sondados 2× com ffprobe/curl desta máquina, MediaMTX testado localmente, apps conferidos
> em fontes 2025/2026. Pesquisa: workflow 4-agentes (jul/2026).

## O que validar em cada teste (checklist das otimizações recentes)

- [ ] **Vídeo fluido** no painel (WebRTC via go2rtc — tile e tela cheia; sem trava-e-pula).
- [ ] **Overlay deslizando** (dead-reckoning vx/vy): caixas acompanham a pessoa, sem teleporte.
- [ ] **Gate de movimento** cortando: cena parada → `(N pulos/gate)` no log/`status().motionGate`;
      pessoa entra → detecção em ≤1 rodada (piso de probe 6s / 2s focada).
- [ ] **Boost de foco**: abrir a câmera → `targetFps: 6` no `status()` (e o overlay mais vivo).
- [ ] **CPU do pool** (`[analysis] pool N/N cpu~…`) dentro do orçamento.
- [ ] Indicadores acumulando no Relatório (motor 24/7, sem espectador).

---

## Tier 0 — celular no `/camera` (2 min, R$0) — smoke test
No celular (mesma LAN): `http://IP-DO-PC:5173/camera` → permitir câmera. Vira nó de câmera
via WebRTC. **Não** exercita o pipeline RTSP/go2rtc — use só como sanidade de detecção.

## Tier 1 — celular como câmera RTSP (10-15 min, R$0) ⭐ RECOMENDADO AGORA
A simulação mais fiel de câmera de segurança sem comprar nada: sensor real, movimento real,
**H.264 + RTSP reais** — exercita o pipeline completo (ffmpeg→D-FINE **e** go2rtc codec-copy→WebRTC).

**Android — app "IP Webcam"** (Pavel Khlebovich, gratuito, mantido em 2025):
1. Instalar → Video preferences: **1280×720, FPS 30** (travar).
2. (Opcional) Login/senha em *Local broadcasting*.
3. **Start server** → o app mostra o IP (ex.: `192.168.68.55:8080`).
4. Validar no VLC: `rtsp://192.168.68.55:8080/h264_ulaw.sdp` (variantes: `h264_pcm.sdp`, `h264_opus.sdp`).
5. Colar a URL em **/cameras** do app. Pronto — WebRTC + análise.
6. Estabilidade: carregador plugado, bateria "sem restrição" p/ o app, IP fixo (reserva DHCP).

**iOS — "IP Camera Lite"**: RTSP na porta 8554, user/senha `admin/admin` (URL exata na tela
do app); Lite tem marca-d'água (inócua p/ o teste). Auto-Lock = Nunca durante o teste.

> Só na LAN do DEV (a VPS de homolog não alcança sua casa — p/ homolog use o Tier 2).

## Tier 2 — loop CFTV local com MediaMTX (15 min, R$0) — o benchmark A/B determinístico
Mesma cena sempre → dá pra comparar otimizações com números. **Validado localmente** (funciona).

1. Baixar [MediaMTX v1.19.2 win64](https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_windows_amd64.zip) → `C:\bench\`.
2. Conteúdo CFTV real (validado): **CAVIAR** — corredor de shopping, câmera fixa, pessoas:
   [WalkByShop1cor.mpg](https://homepages.inf.ed.ac.uk/rbf/CAVIARDATA2/WalkByShop1cor/WalkByShop1cor.mpg) (13,6MB, 94s).
   Transcodar: `ffmpeg -i WalkByShop1cor.mpg -vf scale=1280:-2 -r 25 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -g 50 -an C:\bench\clipe.mp4`
   (Mais “CD-like”, pesado: VIRAT viratdata.org — estacionamento/doca.)
3. `C:\bench\mediamtx-bench.yml` (porta **8556** — a 8554 é do go2rtc!):
   ```yaml
   rtspAddress: :8556
   rtmp: no
   hls: no
   webrtc: no
   srt: no
   api: no
   rtspTransports: [tcp]
   paths:
     bench:
       runOnInit: ffmpeg -re -stream_loop -1 -i C:\bench\clipe.mp4 -c copy -f rtsp rtsp://localhost:8556/bench
       runOnInitRestart: yes
   ```
4. `cd C:\bench; .\mediamtx.exe mediamtx-bench.yml` → cadastrar `rtsp://127.0.0.1:8556/bench` em /cameras.

**No HOMOLOG (VPS)**: mesmo setup (`mediamtx_linux_amd64.tar.gz` + `apt install ffmpeg`,
systemd/tmux) e cadastrar `rtsp://127.0.0.1:8556/bench` — a "câmera" mora na própria VPS
(resolve a VPS não alcançar sua LAN). **Não** abrir a 8556 no firewall (loop interno).

## Tier 3 — streams públicos VALIDADOS (sondados 2×, jul/2026) — substitutos das whatsupcams
| URL | O quê | Nota |
|---|---|---|
| `http://158.58.130.148/mjpg/video.mjpg` | **Indoor** — lobby (Axis, MJPEG 640×480) | O mais parecido com CD; latência ~0. **1 consumidor só** (limite de viewers). |
| `https://wzmedia.dot.ca.gov/D3/5_Pocket_Rd_OC_SAC5_SB.stream/playlist.m3u8` | I-5 Sacramento (H.264 640×480@15) | Melhor p/ detecção de veículos; estável (203 frames/15s sem drop). Fuso UTC-7. |
| `https://wzmedia.dot.ca.gov/D4/S238_NOF_Ashland_UC.stream/playlist.m3u8` | SR-238 obras (H.264 655×480) | Objetos grandes/perto. Estável 2×. |
| `https://s58.nysdot.skyvdn.com/rtplive/TA_168/playlist.m3u8` | Ponte I-87 NY (H.264 512×288) | Visual CCTV clássico; dia no horário BR. Latência HLS ~15-20s. |

Mortos/não-viáveis (não perder tempo): demo Wowza, Skyline (token), FL511/GDOT (token),
CET-SP (só snapshot), e os MJPEG clássicos de aquário/piano (timeout/limite).

## Tier 4 — câmera de verdade (~R$290, essa semana) — o ensaio do CD
**Recomendada: Intelbras VIP 1230 B G4** (bullet PoE 2MP, ~R$240 + injetor PoE ~R$50) —
**é a marca/formato de URL que o CD da Grendene provavelmente já usa** (NVRs Intelbras):
```
rtsp://admin:SENHA@IP:554/cam/realmonitor?channel=1&subtype=0
```
Setup: cabo + PoE → IP Utility/DHCP → trocar codec p/ **H.264** (H.265 quebra WebRTC em
parte dos browsers) → colar a URL em /cameras.

- **Plano B (mais barato, Wi-Fi):** TP-Link Tapo C200 (~R$180) — criar "Conta da Câmera"
  no app Tapo (habilita RTSP) → `rtsp://user:pass@IP:554/stream1`. Comprar V2+ (V1 já quebrou RTSP).
- **Hikvision DS-2CD1023G0E-I** (~R$240): 2º formato mais provável em CD
  (`rtsp://admin:SENHA@IP:554/Streaming/Channels/101`); trocar H.265+→H.264.
- **NÃO comprar**: genéricas Yoosee/ONVIF de marketplace (instáveis — o mesmo problema
  que motivou este plano) e Mibo iM3/iM4 (RTSP não-oficial, linha consumer).

**Formatos de URL p/ quando conectarem as câmeras REAIS do CD (via NVR):**
- Intelbras: `rtsp://user:pass@NVR:554/cam/realmonitor?channel=N&subtype=0` (`subtype=1` = sub-stream)
- Hikvision: `rtsp://user:pass@NVR:554/Streaming/Channels/N01` (N=canal; N02=sub-stream)

> **Recomendação MEDIDA (perf round 3, frente 1 — `analises/perf-round3/frente1-ingest-relay.md`):**
> quando a câmera/NVR oferece sub-stream, use-o como URL de **ingest** — corta **−60% do CPU do
> ffmpeg por câmera** (0,208→0,083 cores; decode 3-5× menor), zero código; em câmera real o ganho
> tende a ser maior. **Pré-requisito honesto:** o frame do ingest é o que o MOTOR vê — configure o
> sub-stream para **≥ ~720p** (o default de fábrica costuma ser 640×360, abaixo do piso do D-FINE
> p/ pessoa distante) e **valide o recall** main vs sub antes de generalizar (a precisão do
> sub-stream não foi medida na rodada 3). Se o recall cair, volte a câmera pro main-stream.

---

## Ordem sugerida
1. **Hoje**: Tier 1 (celular RTSP) — julga a fluidez de verdade em 15 min.
2. **Hoje**: Tier 3 — trocar as 3 whatsupcams pelas validadas (fim dos timeouts de pull).
3. **Esta semana**: Tier 2 no DEV e no HOMOLOG (benchmark determinístico das otimizações).
4. **Quando puder**: Tier 4 (Intelbras VIP) — o ensaio final antes das câmeras do CD.
