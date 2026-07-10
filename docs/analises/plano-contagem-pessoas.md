# Plano — Contagem de pessoas de nível de mercado (jul/2026)

> Base: auditoria da cadeia completa (arquivo:linha) + pesquisa de estado da arte in-browser
> 2025-26 (fontes no relatório da pesquisa). Sintoma: contagem 0 mesmo com pessoas visíveis;
> in/out de tripwire "somem". Este plano ataca as DUAS coisas: nascer o número certo e
> nunca mais perdê-lo.

## O que a auditoria provou

### Onde a contagem SE PERDE (persistência — achado central)
- **Os in/out de tripwire NÃO persistem em lugar nenhum**: vivem em `counterRef`/estado React;
  fechar/reabrir a câmera (instância React nova), reload ou troca de página **zera tudo**.
  Não viram evento, não têm tabela, não chegam ao relatório.
- O relatório NÃO tem nenhuma fonte de fluxo de pessoas: só `people_peak` (pico horário
  instantâneo); "passagens" é de LEITURA de caixas, não gente.
- Pico/permanência de presença: refs de sessão, zeram ao reabrir.

### Onde o ZERO nasce (detecção/tracking)
1. **Backend CPU** do tfjs (comprovado): sem WebGL, coco-ssd é ~10× mais lento e o pipeline
   inteiro recebe zero. Badge já expõe.
2. **Quebra de identidade**: cruzamento exige o MESMO track atravessar; com rodada lenta
   (LR full = 16 tiles seriais, ~0,5-1,3s+) o deslocamento > `trackMaxDist 0.12` → ID novo
   de cada lado da linha → nunca cruza. Presença pode marcar 1-3 e a linha ficar 0 p/ sempre.
3. **Teto físico do modelo**: coco-ssd mobilenet_v2 (2017, mAP ~22) reamostra TUDO p/ 300×300 —
   pessoa <~25px no input é indetectável; tiling/upscale são paliativos que não mudam o teto.
4. Detecções de score 0,2-0,4 (pessoa pequena) morrem no corte 0.4/0.3 — o mercado USA essas
   detecções baixas para associação (ByteTrack), nós jogamos fora.
5. LR opt-in OFF por default; grade pausada por design.

## O que o mercado faz (pesquisa, fontes no relatório)
- **Modelos**: família DETR real-time é o novo padrão comercial (Apache 2.0 código+pesos;
  Ultralytics YOLOv8/11 é AGPL — fora). **D-FINE-N: 42,8 mAP com 14 MB, input 640 nativo** —
  ~2× o mAP do coco-ssd, NMS-free. Runtime: onnxruntime-web (WebGPU; fallback wasm-simd).
- **Tracker**: ByteTrack (2 passadas por IoU, recupera com detecções de score baixo) — 
  implementável em TS puro (~300 LOC), testável em Vitest.
- **Contagem por linha** (supervision/Ultralytics): âncora no **pé do bbox** (não centróide),
  **histerese multi-frame** (lado novo sustentado N frames), e **evento persistido por
  cruzamento** ({ts, câmera, linha, direção} — só metadados, LGPD-ok); contadores viram
  agregação de eventos, não estado.

## Plano de execução (entregas pequenas, cada uma com valor próprio)

### Onda 1 — NUNCA MAIS PERDER a contagem (persistência + precisão com o modelo atual)
| # | Ação | Esf. |
|---|---|---|
| 1.1 | **Evento por cruzamento persistido**: kind novo `flow` no ingest (aditivo) → bucket hora×câmera×linha×direção (PG + fallback JSON já existente) + evento cru c/ ts. Front: cada CrossEvent → `recordFlow()` | M |
| 1.2 | **Contadores = agregação**: HUD/painel somam sessão (como hoje) MAS o acumulado do dia vem do servidor (GET) — sobrevive reload/reabertura. "Zerar" vira marco visual, não apaga histórico | S |
| 1.3 | **Relatório de fluxo**: painel Atividade ganha in/out por linha/hora (a série temporal nasce de graça dos buckets) | S |
| 1.4 | **Âncora no pé do bbox** no counter (câmera em ângulo: centróide cruza "no ar") + **histerese multi-frame** (lado sustentado ≥2 rodadas) — complementa o debounce | S |

### Onda 2 — Tracker de mercado (ByteTrack-lite TS)
| # | Ação | Esf. |
|---|---|---|
| 2.1 | ByteTrack-lite puro em TS: associação em 2 passadas por IoU (alta ≥0.4; baixa 0.15-0.4 recupera tracks perdidos — hoje jogadas fora), predição linear simples p/ cruzar a linha "no meio do caminho" entre rodadas lentas; substitui o greedy por distância | M |
| 2.2 | Unit tests Vitest (lógica pura): oclusão, rodada lenta, score oscilante, troca de identidade | S |

### Onda 3 — Motor novo (a maior alavanca de recall)
| # | Ação | Esf. |
|---|---|---|
| 3.1 | **D-FINE-N (Apache) via onnxruntime-web** num worker, atrás de flag por câmera (como o perfil LR): tenta WebGPU → fallback wasm-simd; telemetria de backend já existe. Modelo 14MB + runtime ~5MB servidos pelo hub (cache). Tile 640 nativo = o tiling atual vira SAHI de verdade. CSP ok (`wasm-unsafe-eval` já presente); ⚠️ multithread wasm exige COOP/COEP no hub — validar convivência com socket.io antes de ligar | G (3-5d) |
| 3.2 | Alternativa de menor risco (se quisermos degrau): MediaPipe ObjectDetector EfficientDet-Lite2 (runtime já usado na fadiga; 7MB; ~34 mAP) — ganho incremental | M (1-2d) |
| 3.3 | Coco-ssd permanece como fallback/motor default até o D-FINE ser validado em campo | — |

### Validação (cada onda)
`verify` + e2e verdes; unit tests novos; **re-diagnóstico de runtime** (câmera de Pula, mesmo
método) comparando: pessoas visíveis × contadas, in/out após travessias, contadores após
reload. Na máquina do usuário: badge de backend + teste com GPU. Sem evidência não há pronto.

## Riscos declarados
- Onda 3 em máquina SEM GPU: wasm 640 ≈ 100-300ms/inferência — cabe na cadência atual (350ms+),
  mas medir na máquina real de operação antes de tornar default.
- Evento de cruzamento é metadado puro (sem imagem) — LGPD/ADR-002 preservados.
- ByteTrack sem re-ID: troca de identidade em cruzamento denso ainda possível (declarado;
  re-ID in-browser tem custo/benefício ruim na nossa cadência).
