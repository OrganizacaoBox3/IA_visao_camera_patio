# Desativação do Fly (`visao-patio`) — 03/10/2026

O app `visao-patio` saiu do Fly.io para cortar custo. Quando for preciso, ele volta em servidor
próprio (DigitalOcean), pelo caminho já documentado em [`deploy-digitalocean.md`](deploy-digitalocean.md).

## Por quê

| Item | US$/mês | Fonte |
|---|---|---|
| Máquina `performance-4x` / 8 GB, região `gru`, ligada 24h | 197,00 | fatura de 01–15/09/2026 |
| IPv4 dedicado `213.188.207.159` | 2,00 | tabela da Fly |
| Volume `visao_data` (10 GB) | 1,50 | tabela da Fly |
| Egress | não medido | só há vídeo saindo com o painel aberto |
| **Total** | **≈ 200,50** | |

Uso medido pelo `/proc/stat` acumulado de 14,5 dias (boot em 19/09/2026, depois do PR #37):
**0,89 vCPU de média em 4 (22%)**, 2,5 GB de RAM em 8. A máquina estava superdimensionada, e na
DigitalOcean o mesmo serviço custava bem menos.

## O que estava no ar

- Código: `8572e54` (`fix/camera-dormindo-fantasma`), que é o topo de `origin/dev` em 03/10/2026.
- Release do Fly: v35, de 19/09/2026.
- Câmeras chegando por RTMP push em `213.188.207.159:1935` (26 streams no go2rtc):
  `bioflex2/3/4/6/10`, `casa_do_chapel_c9/c10/c15`, `causei_cam1/cam2`, `dydentro_cam07/cam08`,
  `stick_bom7` e 13 `cam-<hash>`.
- Env não secreta: `PORT=8091`, `HOST=0.0.0.0`, `VISAO_STATE_DIR=/data`, `NODE_ENV=production`
  (o resto está em `fly.toml`).
- Secrets (nomes, sem valor): `AUTH_SECRET`, `CAMERA_TOKEN`, `SUPERADMIN_USER`,
  `SUPERADMIN_PASSWORD`, `WHATSAPP_ENABLED`, `ANALYSIS_MODEL`, `ANALYSIS_FOCUS_INPUT`,
  `ANALYSIS_WORKERS`, `ANALYSIS_SHIFT_GATE`.

## Onde está o estado

O volume `/data` foi copiado inteiro **antes** da desativação. A cópia fica **fora do git**, só na
máquina do Allan:

```
IA_visao_camera_patio/backups/fly-visao-patio-20261003/   (ignorado: /backups/ no .gitignore)
  data.tar.gz          125 MB · gzip íntegro · 320 arquivos = 320 no volume
  machine-config.json  config da máquina no Fly (sem AUTH_SECRET/CAMERA_TOKEN)
  ips.txt              IPs que o app tinha
```

O `data.tar.gz` contém `cameras.json`, `camcfg.json`, `shifts.json`, `alarms.json`, `users.json`,
`recipients.json`, `data-hist.json`, `models/` e `wa-auth/` (sessão do WhatsApp).
**Não vai para o git:** são credenciais e dados pessoais, os mesmos que o `.gitignore` já exclui
(LGPD by design, ADR-002). Para não perder o arquivo, guarde uma cópia em cofre ou armazenamento
privado.

## Como subir de novo (um comando + DNS)

O kit está em [`deploy/servidor/`](../../deploy/servidor/): o mesmo Dockerfile do Fly, com o Caddy na
frente fazendo o HTTPS de `cam.box3.software` (o papel do proxy do Fly).

**Serve para:** droplet (DigitalOcean ou outro) ou máquina física, desde que seja Linux **x86_64**
acessível por SSH. O go2rtc é baixado para `linux-amd64`, então não serve Mac com chip M nem Raspberry Pi.

1. No Mac, de dentro do repositório:
   ```
   deploy/servidor/subir.sh root@<ip-do-servidor>
   ```
   O script:
   - confere a arquitetura e instala o Docker se faltar;
   - copia o código por `git archive` (o servidor não precisa de acesso ao GitHub);
   - restaura o backup e confere a contagem de arquivos;
   - sobe os containers;
   - termina só depois de ver o painel em HTTP 200 e o RTMP aceitando conexão.
2. Na GoDaddy (`box3.software`): registro **A `cam` → IP novo**, e **apagar o AAAA `cam`** (era o
   IPv6 do Fly). O certificado sai sozinho quando o DNS propagar.
3. **Câmeras:** quem publica no domínio volta sozinha. Quem foi configurada com o IP antigo
   `213.188.207.159` precisa ser reapontada para o IP novo, porta 1935, com o mesmo nome e a mesma
   chave de stream. Não dá para saber pelo servidor qual câmera usa qual dos dois.

**Máquina física atrás de roteador:** redirecionar 80, 443 e 1935/TCP para ela. Se o IP público
mudar, `cam.box3.software` precisa de DDNS. As portas 80 e 443 precisam estar abertas para o
Let's Encrypt emitir o certificado.

**Secrets:** os valores não foram copiados do Fly, porque a extração foi bloqueada pela ferramenta do
agente. Sem `visao.env` no backup, o script gera `AUTH_SECRET` e `CAMERA_TOKEN` novos, e todo mundo
faz login de novo. O `CAMERA_TOKEN` só autentica nós dispositivo do socket.io, não as câmeras RTMP.
Para levar os mesmos valores, salve-os em `backups/fly-visao-patio-20261003/visao.env` (`CHAVE=valor`,
`chmod 600`) antes de destruir o app.

**Usuários e WhatsApp:** o `users.json` e o `wa-auth/` do backup restauram as contas e a sessão.
`SUPERADMIN_*` só vale no primeiro boot com estado vazio, e a senha do superadmin de produção estava
perdida em 15/09/2026. Se a sessão do WhatsApp tiver expirado, é preciso parear de novo.

## Pendências que ficam registradas

- **6 câmeras com "análise parada"** havia 84–177 h em 02/10/2026, com a CPU ociosa:
  `bioflex2/3/4/6/10` e `stick_bom7`. Não era falta de CPU.
- **Vazamento de decode no caminho RTMP:** o shed usa `analysisViewer: analysis.isAnalyzing`
  (`server/index.js:282`), que é global (`engine.js:1036`) e ignora o gate de turno. Câmera dormindo
  continuava decodificando a 2 fps.
- **Reconexão das `bioflex*`** a cada ~14 s em 02/10/2026 (parou em 03/10). Hipótese: dois aparelhos
  publicando com o mesmo nome e chave (`server/rtmp-ingest.js:546-555`). Não confirmado.
