# Manual — conectar uma câmera IP (RTSP) no Visão de Pátio

## 1. Só o IP basta? Não.
O sistema precisa da **URL RTSP completa**:
```
rtsp://USUARIO:SENHA@IP:PORTA/CAMINHO
```
O IP é só uma parte. Você também precisa de **usuário/senha**, **porta** (geralmente 554) e o **caminho do stream** (muda por fabricante).

## 2. O que reunir antes
- **IP** da câmera (ex.: `10.0.0.50`) — precisa estar **na mesma rede** do hub (ou roteável via VPN).
- **Usuário e senha** (login de admin da câmera).
- **Porta RTSP** — padrão **554**.
- **Caminho do stream** — depende do fabricante (ver abaixo).
- **RTSP habilitado** na câmera — algumas vêm com RTSP desligado; ligue na interface web da câmera.
- **ffmpeg** instalado no computador que roda o **hub** (`server/`).

## 3. Padrões de URL por fabricante (mais comuns)
| Fabricante | URL típica |
|---|---|
| **Hikvision** | `rtsp://user:senha@IP:554/Streaming/Channels/101` (101 = canal 1 principal · **102 = substream**) |
| **Dahua / Intelbras** | `rtsp://user:senha@IP:554/cam/realmonitor?channel=1&subtype=0` (**subtype=1 = substream**) |
| **Axis** | `rtsp://user:senha@IP:554/axis-media/media.amp` |
| **Genérica / ONVIF** | varia — descubra com ONVIF Device Manager ou no manual |

> **Dica:** use o **substream** (resolução menor) para a análise — é leve e mais que suficiente para detectar movimento/ocupação/parada.

### Intelbras (câmeras de segurança) — detalhe
A Intelbras é construída sobre a **plataforma Dahua**, então usa **o mesmo padrão**:
```
rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=CANAL&subtype=TIPO
```
- **CANAL**: `1` para uma **câmera IP** ligada direto. Num **NVR/DVR** (gravador), é o número do canal da câmera (`1`, `2`, `3`…).
- **TIPO**: `0` = stream principal (alta resolução) · **`1` = substream** (recomendado para a análise).
- **Porta**: `554` (padrão).
- **Usuário**: normalmente `admin`; a **senha** é a que você definiu na ativação da câmera/gravador.
- Habilite **ONVIF/RTSP** na interface web (geralmente já vem ligado nas linhas **VIP**).

**Exemplos Intelbras:**
```
# Câmera IP VIP, direta, substream (ideal p/ análise):
rtsp://admin:suasenha@10.0.0.50:554/cam/realmonitor?channel=1&subtype=1

# Câmera no canal 3 de um NVR Intelbras, stream principal:
rtsp://admin:suasenha@10.0.0.10:554/cam/realmonitor?channel=3&subtype=0
```
⚠️ **Linhas Mibo (Wi-Fi/cloud doméstica)** muitas vezes **não expõem RTSP** — são feitas para o app. Se for Mibo, confira o modelo; pode não dar. As linhas profissionais (**VIP**, NVRs) têm RTSP.

## 4. Como descobrir a URL exata da sua câmera
- **Manual** do fabricante (ou etiqueta/QR na câmera).
- **Interface web** da câmera (seção de Rede / RTSP / Streams).
- **ONVIF Device Manager** (Windows, grátis) — lista perfis e URLs RTSP.
- Buscar na internet: `rtsp url <marca> <modelo>`.

## 5. Teste a URL ANTES de configurar
Confirme que a URL funciona fora do sistema:
- **VLC:** Mídia → *Abrir Fluxo de Rede* → cole a URL. Se o vídeo aparecer, está correta.
- **ffmpeg (1 frame de teste):**
  ```bash
  ffmpeg -rtsp_transport tcp -i "rtsp://user:senha@IP:554/..." -frames:v 1 teste.jpg
  ```
- **ffplay (ao vivo):** `ffplay -rtsp_transport tcp "rtsp://user:senha@IP:554/..."`

## 6. Conectar no Visão de Pátio
1. ffmpeg instalado no host do hub.
2. Crie/edite `server/rtsp.sources.json` (modelo em `server/rtsp.sources.example.json`):
   ```json
   [
     { "label": "Pátio - Expedição", "url": "rtsp://user:senha@10.0.0.50:554/Streaming/Channels/102" }
   ]
   ```
   *(ou via variável: `RTSP_SOURCES="Pátio=rtsp://...;Doca=rtsp://..."`)*
3. Suba o hub: em `server/`, `npm run dev`.
4. Abra a **Central** — a câmera IP aparece como qualquer outra (desenhe zonas, veja estados, histórico). Reconecta sozinha se o stream cair.

Ajustes opcionais (variáveis de ambiente): `RTSP_FPS` (8), `RTSP_WIDTH` (480), `RTSP_QUALITY` (7 — menor = melhor qualidade).

## 7. Não tem câmera ainda? Simule uma RTSP local
Para testar o fluxo ponta a ponta sem câmera física, suba um servidor RTSP local com o **mediamtx** (binário único, grátis) e publique um vídeo/padrão com ffmpeg:

```bash
# 1) baixe e rode o mediamtx (ouve em rtsp://localhost:8554)
./mediamtx

# 2) publique um PADRÃO DE TESTE em movimento:
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=15 -c:v libx264 -f rtsp rtsp://localhost:8554/teste

#    OU publique um VÍDEO de pátio em loop:
ffmpeg -re -stream_loop -1 -i patio.mp4 -c:v libx264 -f rtsp rtsp://localhost:8554/teste
```
Depois configure a fonte como `rtsp://localhost:8554/teste`. Isso entrega um RTSP **real** para validar tudo.

## 8. Problemas comuns
| Sintoma | Causa provável |
|---|---|
| `401 Unauthorized` | usuário/senha errados |
| Conexão expira / timeout | IP/porta errados, câmera em outra rede, firewall bloqueando 554 |
| Conecta mas sem imagem / "codec" | caminho do stream errado (teste outro padrão do fabricante) |
| Travando / atrasado | use o **substream**, baixe `RTSP_FPS`/`RTSP_WIDTH` |
| "ffmpeg não encontrado" no log do hub | instale o ffmpeg e garanta que está no `PATH` |

## 9. Rede e segurança
- Câmera e hub na **mesma LAN** (ou VPN/rota). Libere a porta **554** no firewall se preciso.
- Muitos canais = mais CPU (um ffmpeg por câmera). Comece com poucas.
- As credenciais ficam em `server/rtsp.sources.json` (**gitignored** — não vai para o repositório).
- Produção de baixa latência: caminho é **WebRTC** (go2rtc/mediamtx) — evolução futura.
