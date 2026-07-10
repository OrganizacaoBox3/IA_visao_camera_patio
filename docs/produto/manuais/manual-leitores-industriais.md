# Manual — leitores industriais (Sick / Cognex) na rede

> Referência de consulta. Estes dispositivos são **diferentes** de câmeras de CCTV (ver `manual-camera-rtsp.md`).

## 1. O que são (e o que NÃO são)
**Cognex** (DataMan, In‑Sight) e **Sick** (Lector, InspectorP) são **leitores de código / câmeras de visão industrial** — feitos para **ler etiqueta/código e dizer "OK/NOK + o que leu"**, não para transmitir vídeo de vigilância.

➡️ **Eles geralmente NÃO expõem RTSP.** Não tente integrá‑los como uma câmera IP de pátio.

## 2. Como eles entregam dados na rede
O valor deles é o **resultado da leitura** (string do código + status + timestamp), publicado por protocolos industriais — varia por modelo/firmware:

| Fabricante | Saída de dados típica | Imagem ao vivo |
|---|---|---|
| **Cognex** (DataMan / In‑Sight) | **TCP/IP socket** (string ASCII), **EtherNet/IP**, **PROFINET**, **FTP** (envia imagem), Telnet; firmwares novos: **MQTT / REST** | via **In‑Sight Explorer / DataMan Setup Tool**; alguns têm **HMI web (MJPEG)** |
| **Sick** (Lector / InspectorP) | **TCP/IP (CoLa/ASCII)**, **EtherNet/IP**, **PROFINET**, **OPC UA**, **MQTT** | via **SOPAS ET**; alguns expõem **stream MJPEG/HTTP** |

> Confirme sempre no **manual do modelo** o que está habilitado.

## 3. Dois caminhos de integração

### Caminho A — como vídeo (limitado)
Só funciona **se o modelo expõe um stream MJPEG por HTTP** (alguns In‑Sight/InspectorP têm HMI web). Nesse caso o **ffmpeg também lê MJPEG**:
```bash
ffmpeg -i "http://IP/caminho/mjpg" -vf fps=8,scale=480:-2 -f mjpeg -q:v 7 pipe:1
```
Poderíamos adaptar o ingestor do hub para uma URL HTTP/MJPEG. **RTSP é improvável** nesses aparelhos. Para visualização "de verdade", o normal é usar o software do fabricante.

### Caminho B — como EVENTO / indicador (recomendado) ⭐
O encaixe certo no Visão de Pátio: consumir o **resultado das leituras** e transformar em **indicador operacional**:
- **throughput** (leituras por minuto/hora por estação);
- **tempo sem leitura** → "estação parada há X min" (mesma lógica de área parada → **alerta**);
- **taxa de NOK / falhas de leitura**.

Como ligaria na nossa arquitetura: um **conector no hub** (Node) abre um **socket TCP** (ou assina **MQTT** / consome **REST**) do leitor, e **emite indicadores** — reusando o painel/relatório que já lida com "tempo sem atividade" e alertas. Não passa pelo pipeline de visão (coco‑ssd); é uma fonte de dados própria.

## 4. Como descobrir o que seu modelo suporta
1. Manual do modelo (seção *Communication / Protocols / Network*).
2. Software do fabricante: **Cognex** In‑Sight Explorer / DataMan Setup Tool · **Sick** SOPAS ET — mostram protocolos, portas e se há HMI web.
3. Verifique a **porta** do socket de dados (Cognex DataMan costuma usar TCP **23**/Telnet ou porta configurável; Sick CoLa em portas próprias).
4. Teste o socket TCP com `telnet IP PORTA` ou `nc IP PORTA` e dispare uma leitura para ver a string chegando.

## 5. Recomendação
- **Não force RTSP** em Sick/Cognex.
- Se o objetivo é **monitorar a estação de leitura** (produtividade / parada / falhas), use o **Caminho B** (evento/indicador) — é mais valioso e fiel ao conceito de "inteligência operacional".
- Se precisa **ver a imagem** no painel e o modelo tem **MJPEG por HTTP**, dá para usar o **Caminho A** (adaptar o ingestor para URL HTTP/MJPEG).
- Para **vigilância de área/pátio**, continue usando **câmeras CCTV/IP (RTSP)** — Sick/Cognex não são para isso.

> Status: **conceitual** — ainda não há conector de leitor implementado no hub. Dá para implementar o Caminho B (TCP/MQTT → indicadores) se houver um leitor desses no escopo.
