# Custo e capacidade no Fly — set/2026 a 03/10/2026

O app `visao-patio` rodou no Fly (região `gru`) de 28/08/2026 a 03/10/2026 e foi desativado por custo
(ver [`../produto/desativacao-fly-2026-10-03.md`](../produto/desativacao-fly-2026-10-03.md)). Este
documento junta o que foi medido nesse período, para a próxima decisão de infraestrutura não começar
do zero.

> Os números foram medidos na data de cada linha e **não foram medidos de novo** ao escrever este
> documento. A fonte é o registro feito em cada sessão de trabalho, com a métrica Prometheus do Fly e
> `/proc` da máquina. O método está em [`../../deploy/fly/custo-por-camera.sh`](../../deploy/fly/custo-por-camera.sh).

## Linha do tempo

| Data | Medição | O que mudou |
|---|---|---|
| 03/10/2026 | 0,89 de 4 vCPU de média em 14,5 dias (22%), RAM 2,5 de 8 GB; ≈ US$ 200,50/mês | App desativado: a máquina sobrava |
| 19/09/2026 | Depois do PR #37, com todas as câmeras dormindo: 2,24 → 0,81 vCPU, load 4,32 → 0,76, RAM 3,33 → 1,78 GB | Câmera dormindo pelo gate de turno deixa de ser decodificada (`pullTick`) |
| 18/09/2026 | Desligar a análise de 11 câmeras devolveu só 0,9 vCPU; o piso de ~2,2 vCPU eram 15 ffmpeg decodificando para ninguém | Achado: o custo mora no decode, não no ingest |
| 15/09/2026 | `decode 59/137 ms · infer 825/1196 ms`: a inferência era 93% do custo por rodada | PR #31 em produção (vídeo sob demanda + `cost.js`) |
| 15/09/2026 | Gate de turno ligado: pool 191% → 15%, load 6,5 → 1,0, mas 11 de 15 câmeras pararam por não ter turno | Desligado no mesmo dia: 4/5 da "economia" era cegueira |
| 14–15/09/2026 | US$ 237,75/mês com 15 câmeras = US$ 15,85/câmera (CPU 83% · egress 16% · volume+IP 1%); load mediano 10,32 em 4 vCPU, p95 21,78; CPU no teto 44% das horas | Diagnóstico: máquina em déficit, não superdimensionada |
| 14/09/2026 | Painel aberto: load mediano 15,63 contra 8,04 sem ninguém (+94%); aberto 17% das horas | Vídeo da grade passou a ser sob demanda (PR #31) |
| 01–03/09/2026 | No `performance-2x` o quadro era o mesmo em proporção (load 5,07 em 2 vCPU) | Máquina subiu para `performance-4x` |

## Preços usados (fatura de 01–15/09/2026, região `gru`)

| Item | US$/mês |
|---|---|
| `performance-4x` / 8 GB | 197,00 |
| `performance-2x` / 4 GB | 87,00 |
| Volume | 0,15 por GB |
| IPv4 dedicado | 2,00 |
| Egress | 0,0372 por GB (inferido: US$ 17,09 ÷ 459,5 GB) |

## Lições que valem para qualquer servidor

- **O custo é decode + inferência, não ingest.** Receber RTMP é barato. Recusar o publish põe câmera
  push em loop de reconexão, e por isso não é o corte certo.
- **Inferência domina** (93% em 15/09). A maior alavanca é o modelo: `ANALYSIS_MODEL=n` processa
  ~2,2 câmeras por núcleo contra 0,93 do `s`, e é uma env var. Troca precisão por custo e exige `eval/`.
- **Câmera sem turno não processa** (decisão de 15/09/2026). Antes de ligar `ANALYSIS_SHIFT_GATE=1`,
  confira se as zonas têm turno; senão a economia é cegueira. O log separa `dormiu/turno` de
  `PARADA/SEM-TURNO` exatamente para isso.
- **Painel aberto custa caro.** Quem deixava o painel aberto eram os próprios programadores. O vídeo
  sob demanda com timeout de 5 min resolveu.
- **Escalar não é máquina maior.** Em setembro, 40 câmeras pediriam ~21 vCPU, mais que o maior
  `performance` do Fly. O caminho é decodificar em resolução baixa, decodificar só sob evento (ONVIF
  da câmera) ou processar na borda.

## Ficou em aberto em 03/10/2026

- Vazamento de decode no caminho RTMP: o shed usa `analysis.isAnalyzing`, que é global
  (`server/index.js:282`, `engine.js:1036`), e ignora o gate de turno.
- 6 câmeras com "análise parada" havia 84–177 h, com CPU ociosa: `bioflex2/3/4/6/10` e `stick_bom7`.
- Câmera em turno ainda decodifica mais quadros do que a análise usa (o gate de movimento precisa de
  quadros; fica para outro PR).
