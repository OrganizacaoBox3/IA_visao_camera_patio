# Registro de Decisões de Arquitetura (ADRs)

Decisões técnicas relevantes tomadas durante a evolução do MVP. Formato leve:
Contexto → Decisão → Consequências. Status: aceito salvo indicação.

| ADR | Decisão | Status |
|-----|---------|--------|
| [001](ADR-001-paralelizacao-por-arquivo.md) | Paralelização de agentes por propriedade exclusiva de arquivo | aceito |
| [002](ADR-002-lgpd-imagens-efemeras.md) | LGPD: imagens efêmeras no cliente, persistir só metadados | aceito |
| [003](ADR-003-going-gray.md) | "Going gray": disciplina de cor por estado | aceito |
| [004](ADR-004-politica-alarme-isa18.md) | Política de alarme (ISA-18.2/EEMUA 191) antes de mais alertas | aceito |
| [005](ADR-005-persistencia-json-postgres.md) | Persistência: cache + Postgres com fallback JSON | aceito |
| [006](ADR-006-live-sync-last-write-wins.md) | Sincronização ao vivo last-write-wins via socket | aceito |
| [007](ADR-007-adocao-radix-ui.md) | Adoção de Radix como camada de UI (exceção: canvas fullscreen) | aceito |
| [008](ADR-008-adocao-tailwind.md) | Adoção de Tailwind (tokens `--state-*`/`--cam-*`/`--sp-*`) | aceito |
| [009](ADR-009-analise-server-side.md) | Análise de visão server-side (motor D-FINE no hub) | aceito |
| [010](ADR-010-conector-de-site-edge-gateway.md) | Conector de site (edge gateway) p/ câmeras de clientes remotos | proposto |
| [011](ADR-011-video-webrtc-go2rtc.md) | Vídeo por WebRTC via go2rtc empacotado (ativação por presença, fallback MJPEG) | aceito |
| 012 | Abordagem científica (fusão BLE+visão): viabilidade + trilha de adoção — **vive no repo irmão** `../mvp_trilateracao_BLE/docs/analises/decisoes/` (ADR-018) | aceito (lá) |
| 013, 014, 017 | Arco BLE (motor universal, observação de processo, localização sem encaixe) — **vivem no repo irmão** `../mvp_trilateracao_BLE/` (ADR-018) | aceito (lá) |
| [015](ADR-015-reid-visual-pilar-de-identidade.md) | ReID visual como pilar de identidade (mantido aqui: a identidade por visão é do domínio da câmera) | aceito |
| [016](ADR-016-faxina-pesquisa-fora-do-main.md) | Faxina: código de pesquisa fora do main (tag `research-fusion-arc-2026-07-12`) | aceito |
| [018](ADR-018-separacao-dominios-ble.md) | Separação de domínios: BLE sai para `mvp_trilateracao_BLE` (visão pura aqui) | aceito |
| [019](ADR-019-relay-rtmp-proprio.md) | Relay RTMP próprio na frente do go2rtc (ingest de DVRs que ele não decodifica) | aceito |

> Convenção: novas decisões de peso ganham um ADR aqui. Mudanças que revertem um ADR
> criam um novo ADR com status "substitui ADR-XXX".

> **Numeração compartilhada:** os ADRs 001–018 nasceram no repo original (pré-separação, ADR-018).
> Os do arco BLE (012, 013, 014, 017) vivem no repo irmão `../mvp_trilateracao_BLE/`; a numeração é
> única entre os dois repositórios — não reutilizar números.
