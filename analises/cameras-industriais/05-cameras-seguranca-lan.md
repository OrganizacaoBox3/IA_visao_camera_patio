# Guia prático — Câmeras de segurança (CFTV/IP) na LAN via RTSP

> **Uso real do MVP:** câmeras IP de segurança (CFTV) na **mesma rede local (LAN)** do
> servidor hub. O usuário cadastra pela UI **"+ Câmera IP"** colando a **URL RTSP completa**.
> O hub (`server/rtsp.js`) ingere via **ffmpeg** (RTSP/RTSPS/HLS/MJPEG) com transporte
> selecionável (tcp/udp/http/auto).
>
> Complementa: `docs/manuais/manual-camera-rtsp.md`, `docs/manuais/manual-intelbras-rtsp.md`,
> `analises/contrato-multicamera.md`. Foco aqui: **conectar as câmeras REAIS do CD**.

---

## TL;DR — o que fazer

1. Descubra o **IP** da câmera (lista de DHCP do roteador ou ferramenta do fabricante).
2. Monte a **URL RTSP** pela tabela abaixo — **prefira o sub-stream**.
3. Na UI "+ Câmera IP": cole a URL, escolha **transport = tcp**, teste.
4. Status `online` = pronto. `error 401` = senha; timeout = rede/firewall; sem imagem = caminho errado.

A URL sempre tem esta forma:
```
rtsp://USUARIO:SENHA@IP:554/CAMINHO
         └── credenciais ──┘ └porta┘ └── muda por fabricante ──┘
```
Só o IP **não basta**: precisa de usuário/senha + porta (554) + caminho do stream.

---

## 1. Tabela de receitas RTSP por fabricante

> Copie, troque `USUARIO`, `SENHA` e `IP`. **Porta padrão RTSP = 554.**
> **Regra de ouro para o nosso pipeline: use o SUB-STREAM** (segunda coluna) — resolução
> menor, menos CPU no ffmpeg e menos banda, e sobra para detectar ocupação/movimento/parada.

| Fabricante | Main-stream (alta) | Sub-stream (use este ✅) |
|---|---|---|
| **Hikvision** | `rtsp://USUARIO:SENHA@IP:554/Streaming/Channels/101` | `rtsp://USUARIO:SENHA@IP:554/Streaming/Channels/102` |
| **Dahua** | `rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=1&subtype=0` | `rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=1&subtype=1` |
| **Intelbras** (linha VIP / NVR — base Dahua) | `rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=1&subtype=0` | `rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=1&subtype=1` |
| **Axis** | `rtsp://USUARIO:SENHA@IP:554/axis-media/media.amp` | `rtsp://USUARIO:SENHA@IP:554/axis-media/media.amp?resolution=640x480` |
| **Genérico / ONVIF** | descoberta dinâmica (não há caminho fixo) ⚠️ | idem — ver seção 1.5 |

### Notas de leitura das receitas (confirmadas na web)

- **Hikvision** — o `<id>` do caminho é `(canal × 100) + tipo`, onde tipo **1 = main, 2 = sub, 3 = terceiro stream**. Logo: canal 1 → `101`/`102`; **canal 3 → `301`/`302`**. Alguns firmwares novos também aceitam o prefixo `/ISAPI/Streaming/channels/<id>`.
- **Dahua** — `channel` começa em **1**; `subtype=0` main, `subtype=1` sub. Em **NVR/DVR** o `channel` é o número do canal da câmera no gravador (1, 2, 3…). Pode aparecer `&unicast=true` no fim (opcional).
- **Intelbras** — é **plataforma Dahua**, então **mesmo caminho `/cam/realmonitor`**. Confirmado em manual/fórum oficiais. Vale para linhas **VIP** (câmeras IP profissionais) e gravadores **NVD/MHDX/NVR/DVR**.
  - ⚠️ **Linhas Mibo (Wi-Fi/cloud doméstica)** normalmente **NÃO expõem RTSP** — são feitas para o app. Confira o modelo antes.
  - Intelbras também fala **ONVIF**, mas via ONVIF "só o stream de vídeo" é garantido (nem todas as funções). Para o nosso caso (só queremos o vídeo), ONVIF serve.
- **Axis** — caminho fixo `/axis-media/media.amp`. Não usa "canal/subtype"; o sub-stream sai por **parâmetro de query**: `?resolution=640x480` (e opcionalmente `&fps=15`, `&videocodec=h264`, `&streamprofile=Mobile`). Sem parâmetros, entrega o perfil default (geralmente main).

### 1.5 Genérico / ONVIF — quando não sei o fabricante ⚠️

Não existe **um** caminho RTSP universal — cada fabricante tem o seu. Estratégias:

1. **Descoberta ONVIF** (recomendado): a câmera responde `GetStreamUri` e **entrega a URL RTSP pronta**. Use o **ONVIF Device Manager** (Windows, grátis) — ele lista perfis e as URLs RTSP de cada um. Copie a do perfil de menor resolução.
2. **Manual / etiqueta / QR** da câmera, ou busca `rtsp url <marca> <modelo>`.
3. **Interface web** da câmera (seção Rede → RTSP / Streams).
4. Muitas OEM chinesas seguem um destes dois formatos "de fato":
   - estilo Hikvision: `/Streaming/Channels/102`
   - estilo genérico: `/live/ch01_1`, `/live/ch00_1`, `/h264/ch1/sub/av_stream`, `/11`, `/stream2` ⚠️ (variam muito — teste)

> **Sempre teste a URL fora do app primeiro** (VLC ou ffmpeg) antes de cadastrar — isola
> problema de URL de problema de app.

---

## 2. Como descobrir a câmera na rede (LAN)

Objetivo: achar o **IP** de cada câmera. Ordem prática do mais fácil ao mais técnico:

1. **Lista de DHCP do roteador/switch** — entre na interface do roteador (ex.: `192.168.0.1`),
   veja *Clientes DHCP / Dispositivos conectados*. Câmeras costumam aparecer com hostname do
   fabricante (Hikvision, Dahua, Axis…). **Mais simples e sem instalar nada.**
2. **Ferramenta do fabricante** (varre a LAN e lista IP/modelo, permite até ajustar IP):
   - **Intelbras** → *Intelbras IP Utility*
   - **Hikvision** → *SADP* (Search Active Devices Protocol)
   - **Dahua** → *ConfigTool*
   - **Axis** → *AXIS IP Utility* / *AXIS Device Manager*
3. **ONVIF discovery** (multi-fabricante): **ONVIF Device Manager** encontra qualquer câmera
   ONVIF na sub-rede e já mostra as **URLs RTSP** — mata descoberta + URL de uma vez.
4. **Varredura de portas** (uso legítimo **na sua própria rede**) — útil quando as ferramentas
   acima não acham (VLAN, fabricante desconhecido):
   ```bash
   nmap -p 554,80,8000 192.168.1.0/24
   ```
   - **554** = RTSP (a porta que nos interessa) · **80** = interface web · **8000** = porta de serviço Hikvision.
   - Ajuste `192.168.1.0/24` para a sua faixa. IPs com **554 aberta** são candidatos a câmera.

> Se a câmera **não aparece** em nenhum método: provavelmente está em **outra sub-rede/VLAN**
> ou o hub não a "enxerga". Ver seção 3.

---

## 3. Boas práticas para o nosso pipeline (`server/rtsp.js`)

- **Use o sub-stream** (`/102`, `subtype=1`, `?resolution=640x480`). Cada câmera = **um processo
  ffmpeg**; main-stream 1080p/H.265 gasta CPU à toa. O modelo de visão não precisa de 4K.
- **Transporte = TCP** na UI (campo `transport`). É o **default e o mais estável** — evita perda
  de pacotes/artefatos do UDP em rede congestionada. Use `udp` só se a câmera não fechar por TCP;
  `auto` deixa o ffmpeg decidir; `http` para tunelar RTSP sobre HTTP.
- **Usuário dedicado só-leitura** na câmera (não use o `admin`). Se vazar, não permite reconfigurar
  a câmera; e some do risco de trocar a senha do admin.
- **Câmera e hub têm que se enxergar na LAN**: mesma sub-rede/VLAN (ou rota entre elas) e
  **firewall liberando a 554** (e a porta HTTP se for MJPEG/HLS). Teste com `ping IP` e
  `nmap -p554 IP` a partir do host do hub.
- **Comece com poucas câmeras** e vá somando — assim você mede o custo de CPU real por stream.
- Ajuste fino por câmera (contrato multicamera): `fps` (default 8), `width` (480), `quality`
  (7, menor = melhor). Baixar `fps`/`width` alivia CPU se travar.

---

## 4. Passo a passo na UI "+ Câmera IP"

1. **Monte a URL** pela tabela da seção 1 (prefira o sub-stream). Ex. Hikvision:
   `rtsp://leitor:senha@192.168.1.50:554/Streaming/Channels/102`
2. **(recomendado) Teste fora do app** antes de cadastrar:
   - **VLC:** Mídia → *Abrir Fluxo de Rede* → cole a URL. Apareceu vídeo? URL OK.
   - **ffmpeg (1 frame):**
     ```bash
     ffmpeg -rtsp_transport tcp -i "rtsp://leitor:senha@192.168.1.50:554/Streaming/Channels/102" -frames:v 1 teste.jpg
     ```
3. Na UI, clique **"+ Câmera IP"**, cole a URL, dê um **rótulo** (ex.: "Doca 3 - Expedição").
4. Escolha **transport = tcp**. Salve.
5. **Interprete o status** (evento `camera-status`, ver `analises/contrato-multicamera.md`):

| Status | O que significa | O que fazer |
|---|---|---|
| `connecting` | ffmpeg subindo / reconectando (ainda sem frames) | aguarde alguns segundos |
| `online` | recebendo frames — **funcionando** | desenhe zonas, use normalmente |
| `error` | erro persistente (URL, credencial, rede, congelado, ffmpeg ausente) | veja `lastError` e o checklist abaixo |
| `stopped` | câmera desabilitada/removida | reabilite se necessário |

---

## 5. Checklist de troubleshooting

| Sintoma / erro | Causa provável | Correção |
|---|---|---|
| **`401 Unauthorized`** | usuário/senha errados na URL | confira credenciais; cuidado com caracteres especiais na senha (`@ : / ?` precisam de URL-encode) |
| **Conecta mas sem imagem / "codec"** | **caminho do stream errado** | teste outro padrão do fabricante (main↔sub, `channel`/`subtype`, canal certo no NVR) |
| **Timeout / não conecta** | IP/porta errados, **sub-rede/VLAN diferente**, **firewall bloqueando 554**, RTSP desligado na câmera | `ping IP` e `nmap -p554 IP` do host do hub; habilite RTSP na web da câmera; libere a 554 |
| **`404`/`Method Not Allowed`** | caminho inexistente naquele firmware | use ONVIF Device Manager p/ pegar a URL exata |
| **Trava / atrasa / artefatos** | main-stream pesado, ou UDP em rede ruim | troque para **sub-stream**, `transport=tcp`, baixe `fps`/`width` |
| **CPU alta no hub** | muitos main-streams / H.265 | sub-stream em todas; menos câmeras simultâneas; H.264 se possível |
| **H.265 (HEVC) pesado** | ffmpeg **lê** H.265, mas decodifica mais caro que H.264 | prefira perfil H.264 na câmera (ex.: Axis `videocodec=h264`), ou sub-stream H.264 |
| **`ffmpeg não encontrado`** | ffmpeg fora do PATH no host do hub | instale o ffmpeg e garanta que está no `PATH` |
| **Câmera não aparece na rede** | outra VLAN, ou não é ONVIF/RTSP (ex.: Intelbras Mibo) | ver seções 2 e 3; se for Mibo/doméstica, pode não ter RTSP ⚠️ |

---

## 6. Segurança / LGPD

- **Credenciais ficam embutidas na URL** (`rtsp://user:senha@...`) — dado **sensível**.
  - A UI/app **mascara** a URL na exibição; nos logs do servidor a URL é **redacted**.
  - **Nunca versione** `server/cameras.json` nem `server/rtsp.sources.json` (contêm URLs com
    senha) — devem estar no `.gitignore`.
- **Usuário só-leitura** por câmera (seção 3) reduz o impacto de um vazamento.
- **Rede de CFTV isolada** (VLAN/sub-rede dedicada, só com rota até o hub) é o recomendado —
  limita quem alcança as câmeras e o tráfego de vídeo. Prefira **RTSPS** (RTSP sobre TLS) se a
  câmera suportar e o tráfego sair da LAN.
- **LGPD**: imagem de pessoas é dado pessoal. Restrinja acesso ao painel, sinalize as áreas
  monitoradas e guarde só o necessário (o pipeline trabalha a baixa resolução, o que já ajuda).

---

## Fontes

- Hikvision RTSP (fórmula canal×100+tipo; 101 main / 102 sub): [SecurityCamCenter](https://securitycamcenter.com/rtsp-url-address-format-hikvision/), [Hikvision Support USA](https://supportusa.hikvision.com/support/solutions/articles/17000129064-how-do-i-get-my-rtsp-stream-), [Hikvision ISAPI doc](http://enpinfo.hikvision.com/unzip/20201110210551_77443_doc/GUID-515FF2B5-5E01-4F03-8B81-4CA5BD621965.html)
- Dahua RTSP (`/cam/realmonitor?channel=&subtype=`): [SecurityCamCenter](https://securitycamcenter.com/rtsp-url-address-format-dahua/), [Dahua Wiki - RTSP via VLC](https://dahuawiki.com/Remote_Access/RTSP_via_VLC), [Visiotech](https://support.visiotechsecurity.com/hc/en-us/articles/360010878380-RTSP-stream-in-X-Security-Dahua)
- Intelbras RTSP (base Dahua, `/cam/realmonitor`, ONVIF): [Fórum Intelbras](https://forum.intelbras.com.br/viewtopic.php?t=56068), [Manual VIP G4 (PDF)](https://backend.intelbras.com/sites/default/files/2022-09/manual-do-usuario-vip-1130-b-g4-vip-1130-d-g4-ip-1230-b-g4-vip-1230-d-g4-vip-1230-b-black-g4-vip-1230-d-black-g4-vip-1220-b-full-color-g4%20-vip-1220-d-full-color-g4-pt.pdf)
- Axis RTSP (`/axis-media/media.amp`, parâmetros de resolução/codec): [Axis developer docs](https://developer.axis.com/vapix/network-video/video-streaming/), [SecurityCamCenter](https://securitycamcenter.com/rtsp-commands-axis-cameras/)
