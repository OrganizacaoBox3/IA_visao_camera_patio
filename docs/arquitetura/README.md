# Documentação Técnica — MVP de Visão Computacional

Documentação regenerada a partir da leitura direta do código-fonte (junho/2026).
Cada documento foi produzido por um agente dedicado a um tema, cobrindo todos os
aspectos do sistema. A pasta `docs/produto/` original foi preservada sem alterações.

## Visão de 1 minuto

SPA React/Vite (central/dashboard) + **hub Node.js** que atua como relé de frames
(Socket.IO), **motor de análise de indicadores** (`server/analysis/` — D-FINE em
worker process, 24/7, independente de espectador; ADR-009), persistência (Postgres
com fallback JSON) e notificações (WhatsApp via Baileys, webhook Andon). O navegador
é **espelho** — exibe vídeo + overlays servidos (`analysis-tracks`) — e roda no
cliente apenas os **modos especializados** (Objetos/OWL-ViT via transformers.js,
Fadiga/MediaPipe, Leitura/ZXing). Nós de câmera (`/camera`) capturam e enviam JPEGs;
a central exibe, agrega e dispara alertas.

> **Atualização (jul/2026, ADR-009):** os documentos 01–07 foram gerados quando a IA
> rodava 100% no navegador. O doc 01 já reflete o motor no hub; nos demais, onde se
> ler "inferência no cliente" para pessoas/atividade/fluxo, vale a arquitetura da
> ADR-009 e o `server/analysis/README.md`.

## Índice

| # | Documento | Tema |
|---|-----------|------|
| 01 | [01-visao-geral-arquitetura.md](01-visao-geral-arquitetura.md) | Visão geral, arquitetura macro, stack, diretórios, build/dev |
| 02 | [02-nucleo-visao-camera-deteccao.md](02-nucleo-visao-camera-deteccao.md) | Captura de câmera, motor de detecção, zonas e máscaras |
| 03 | [03-modos-operacao-processadores.md](03-modos-operacao-processadores.md) | Modos: Atividade, Fadiga, Leitura, Objetos |
| 04 | [04-frontend-ui-telas.md](04-frontend-ui-telas.md) | Telas, rotas, design system Radix, relatórios |
| 05 | [05-backend-servidor-banco.md](05-backend-servidor-banco.md) | Servidor hub, endpoints/socket.io, schema Postgres |
| 06 | [06-alertas-whatsapp-rtsp.md](06-alertas-whatsapp-rtsp.md) | Alertas/Andon, WhatsApp/Baileys, ingestão RTSP |
| 07 | [07-deploy-infra-testes.md](07-deploy-infra-testes.md) | Deploy (nginx/systemd/DigitalOcean), env vars, E2E Playwright |

## Pontos de atenção levantados durante a documentação

Achados que valem revisão (detalhados nos documentos, marcados como "a confirmar"):

- **Segurança:** `deploy/visao-hub.service` contém credenciais Postgres aparentemente
  reais em texto plano — recomenda-se rotacionar e mover para variáveis de ambiente
  fora do versionamento. (docs 01, 07)
- **Credenciais de sessão:** `server/wa-auth/` guarda estado/credenciais do WhatsApp
  (Baileys) — não deve ser versionado nem exposto. (doc 06)
- **Divergências de configuração:** docs antigos citam Caddy/`PANEL_PASSWORD`, mas o
  stack real usa nginx e `AUTH_SECRET` + `SUPERADMIN_*`. (doc 07)
- **Modelo de detecção:** divergência entre `loadDetector` (lite_mobilenet_v2) e
  `APP_CONFIG.detection.base` (mobilenet_v2). (docs 02, 03)
- **Pasta órfã:** existe `visao_computacional_mvp/` na raiz contendo apenas um
  `package-lock.json` solto. (doc 01)
