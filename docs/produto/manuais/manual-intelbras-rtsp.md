# Manual rápido — RTSP em câmeras Intelbras

> Referência de consulta. Vale para câmeras IP e NVR/DVR Intelbras (plataforma Dahua).
> Manual geral de RTSP: `manual-camera-rtsp.md`.

## Padrão de URL
A Intelbras usa o **mesmo padrão da Dahua**:
```
rtsp://USUARIO:SENHA@IP:554/cam/realmonitor?channel=CANAL&subtype=TIPO
```

| Campo | Valor |
|---|---|
| **USUARIO** | normalmente `admin` |
| **SENHA** | a definida na ativação da câmera/gravador |
| **IP** | IP da câmera (direta) ou do **NVR/DVR** |
| **PORTA** | `554` (padrão) |
| **CANAL** | `1` para câmera IP direta · nº do canal (`1`,`2`,`3`…) no NVR/DVR |
| **TIPO (subtype)** | `0` = principal (alta) · **`1` = substream (use este p/ análise)** |

## Exemplos prontos
```bash
# Câmera IP VIP (direta), substream — ideal para o Visão de Pátio:
rtsp://admin:suasenha@10.0.0.50:554/cam/realmonitor?channel=1&subtype=1

# Câmera IP VIP, stream principal (alta resolução):
rtsp://admin:suasenha@10.0.0.50:554/cam/realmonitor?channel=1&subtype=0

# Câmera no canal 3 de um NVR/DVR Intelbras:
rtsp://admin:suasenha@10.0.0.10:554/cam/realmonitor?channel=3&subtype=0
```

## Importante por linha de produto
- ✅ **VIP** (câmeras IP profissionais) e **NVD/MHDX/NVR/DVR** (gravadores) → têm RTSP/ONVIF.
- ⚠️ **Mibo** (Wi-Fi/cloud doméstica) → geralmente **NÃO** expõem RTSP (são feitas para o app). Confira o modelo; pode não integrar.
- Habilite **ONVIF/RTSP** na interface web da câmera/gravador (em geral já vem ligado nas linhas VIP).

## Passo a passo
1. Descubra o **IP** da câmera (interface do roteador, app Intelbras, ou Intelbras IP Utility).
2. Tenha **usuário/senha** (admin) e confirme **porta 554** + RTSP habilitado.
3. **Monte a URL** com o padrão acima (prefira `subtype=1`).
4. **Teste** antes:
   - VLC → *Abrir Fluxo de Rede* → cole a URL; ou
   - `ffmpeg -rtsp_transport tcp -i "rtsp://admin:senha@IP:554/cam/realmonitor?channel=1&subtype=1" -frames:v 1 teste.jpg`
5. **Plugue no sistema:** adicione em `server/rtsp.sources.json`:
   ```json
   [{ "label": "Pátio - Expedição", "url": "rtsp://admin:senha@10.0.0.50:554/cam/realmonitor?channel=1&subtype=1" }]
   ```
6. Suba o hub (`npm run dev` em `server/`). A câmera aparece na Central.

## Problemas comuns
| Sintoma | Causa |
|---|---|
| `401 Unauthorized` | usuário/senha errados |
| Timeout/sem conexão | IP/porta errados, rede diferente, firewall na 554, RTSP desligado |
| Conecta sem imagem | canal/subtype errado — teste `channel=1&subtype=0` |
| Travando/atrasado | use `subtype=1` e baixe `RTSP_FPS`/`RTSP_WIDTH` |

> Dica: para o Visão de Pátio, o **substream** (`subtype=1`) é o ideal — leve e suficiente para detectar ocupação, movimento e área parada.
