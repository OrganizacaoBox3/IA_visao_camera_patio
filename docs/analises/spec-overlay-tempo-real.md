# Spec — overlay em "tempo real percebido" (marcação senta na pessoa, sem regressão)

> 2026-07-25. Pedido do dono: "a marcação de pessoas e objetos tem que ser em tempo real".
> Reenquadramento honesto (doutrina: separar medição de inferência): **atraso de parede zero é
> fisicamente impossível** — a própria imagem exibida já tem ~100–400ms de idade (captura → ffmpeg →
> relé → decode). O entregável verificável é outro, e é alcançável: **(a)** a caixa senta na pessoa
> **no quadro exibido** (a imagem é soberana — ADR-003) e **(b)** a cadência de updates é a máxima
> que o hardware MEDIDO sustenta, com a curva reportada (nunca o ponto).
>
> Contexto herdado (não repetir o que já foi feito): compensação de `latencyMs` + dead-reckoning
> vx/vy + `maxExtrapMs` 1000 (07-diagnostico-overlay-lag.md), paralelismo da focada via
> `inflight.js` (09-spec-foco-paralelo.md), coasting/C1, gate de movimento nunca-cego.

## Limites físicos declarados (o que NENHUMA onda muda)

- **Entrada em cena / mudança de direção**: previsão não cobre o que nunca foi detectado. O piso é
  `cadência + inferência` (~0,5–1,5s na grade @1fps com D-FINE-S). Só mais updates/segundo (Ondas
  1 e 3) reduzem esse piso.
- **Relógios de máquinas distintas não se comparam** (skew). Toda métrica nova é DURAÇÃO por
  perna (hub mede o trecho dele; cliente mede o dele) — nunca diferença de epoch entre máquinas.
  O trânsito LAN (~5–20ms) fica declarado como estimativa, não medição.

## Given/When/Then (critérios de aceite)

- **CA-1 (Onda 0)** G: câmera aberta com HUD ligado. W: o rAF desenha. T: o HUD exibe idade
  chegada→draw do frame exibido (`vid`), intervalo real entre payloads `analysis-tracks` (`trk`)
  e a latência hub do último payload (`hub`) — todos duração local, sem skew. WebRTC (sem `ts`
  no FrameSource): linha `vid` omitida, sem erro.
- **CA-2 (Onda 1a)** G: os knobs 23–26 do `precision.js` (estado estacionário). W: o engine cria
  o tracker de uma câmera. T: os 4 knobs chegam ao `createByteTracker` (mudar o painel MUDA
  produção — fim da paridade por coincidência). Sensor: teste de fiação + `eval/stationary.mjs`.
- **CA-3 (Onda 1b)** G: pool com 2 workers (host 4-core, o homolog). W: uma câmera é focada.
  T: `maxInflight ≥ 2` (o paralelismo da spec 09 deixa de ser inerte). Env
  `ANALYSIS_FOCUS_INFLIGHT` continua mandando. Custo declarado: com pool=2 a focada pode ocupar
  os 2 workers; as demais degradam graciosamente (último-vence — nenhum frame se acumula).
- **CA-4 (Onda 2 — DEPOIS de medir)** G: offset de exibição medido por transporte (Onda 0).
  W: o interpolador amostra. T: extrapola para `now − offsetDoVídeo` (default 0 = comportamento
  atual; opt-in por knob). Aceite visual: pessoa andando em linha reta, a caixa não lidera nem
  atrasa o corpo NO QUADRO.
- **CA-5 (Onda 3)** G: D-FINE quantizado (INT8) passa o gate do eval no full-set. T: entra no
  catálogo como tier; senão, fica documentado o porquê. Invariante D.10: knob de qualidade só
  muda com `npm run eval` antes/depois.

## Fora de escopo (decidido, não esquecido)

- Modelo N na câmera focada (perde recall — já rejeitado na spec 09).
- Subir `ANALYSIS_FPS` global (custo em todas as câmeras sem ganho onde ninguém olha).
- Sincronização de relógio hub⇄cliente (NTP-like) — durações por perna bastam.
- Prometer "milésimo de segundo": o alvo é alinhamento caixa↔quadro + curva de cadência medida.

## Ondas (cada uma fecha com `verify` verde; contratos SÓ aditivos)

| Onda | O quê | Sensor | Risco |
|---|---|---|---|
| **0** | HUD de latência: `ts` de chegada exposto no `FrameSource` do relé (campo já opcional no tipo; o gate de frame-novo foi desenhado p/ ele) + medidor de cadência puro (`src/camera/cadence.ts`) + 3 linhas novas no `drawTelemetryHud` | `cadence.test.ts`; visual no HUD | ~zero (medição, display-only) |
| **1a** | Fiação dos knobs estacionários no `createByteTracker` (engine) | teste de fiação (`engine.test.js`) + `eval:counting` (inclui stationary) | ~zero (valores idênticos aos defaults internos hoje) |
| **1b** | Piso 2 no `focusInflight` quando `poolSize ≥ 2` | teste puro (`engine.test.js`); em campo: `achievedFps` da focada no `/api/analysis/status` | starvation momentânea das não-focadas em pool=2 (mitigada por último-vence; custo declarado) |
| **1c** | `ANALYSIS_FOCUS_INPUT=512` documentado no deploy example | validado no 07-* (1,0→1,6fps) | opt-in por deploy; recall só da focada |
| **2** | Offset de exibição por transporte no interpolador (extrapolar p/ o instante do QUADRO, não p/ o agora absoluto) — **MECANISMO ENTREGUE 2026-07-25** (`sample(now, videoLagMs)` + knob `overlay.videoLagMs` por transporte, default 0 = inerte); a CALIBRAÇÃO segue pendente de medição em campo (HUD + cronômetro filmado) | HUD da Onda 0 (antes/depois) + aceite visual CA-4 | overshoot em atraso variável — capado por `maxExtrapMs` + snap/easing existentes |
| **3** | INT8 pelo harness — **MEDIDO 2026-07-25 (arm64/M5, ORT 1.27, CPU EP 2 threads): NÃO ENTRA.** `model_quantized.onnx` (uint8 dinâmico, 11,2 MB) PASSA o gate (f1 85,1% · recall 92,6% · prec 80,4% · 0 FP) mas custa **+13–20% de inferMs** (~78 vs ~65–69 ms) — quantização dinâmica no CPU EP ARM paga mais em quantize/dequantize do que ganha; único ganho é −73% de disco. `model_int8.onnx` CRASHA o ORT (SIGABRT no create). **Residual:** repetir o micro-bench no homolog x86 (AVX2/VNNI pode inverter o sinal — é hipótese, não medição); acurácia validada só no fixture 21+8 (default exigiria full-set). **3b (WebRTC default) constatada JÁ ENTREGUE por design em 2026-07-25**: o default de câmera é `transport:"auto"` e `transportOf` resolve WebRTC quando o go2rtc serve o stream (fallback+cooldown automáticos) — faltava só o binário no host (instalado no dev; produção empacota no release) | gate full-set; e2e | ~~INT8 pode reprovar recall~~ → reprovou no CUSTO nesta arquitetura |
| **4** | Consistência: ~~unificar `HUB_TRACKS_STALE_MS` em `types/analysis.ts`~~ (**feito 2026-07-25**); `analysis-fatigue` na room `dashboards` c/ guarda de espectador; F1b fadiga (espelho servido no cliente) | testes existentes de contrato | baixo; F1b espera a validação lado a lado da spec-fadiga (Regra 11) |

## Não-regressão (o contrato desta spec)

- Nenhum evento socket muda shape; campos novos são opcionais. `analysis-tracks`,
  `analysis-status`, `frame` intactos.
- A LÓGICA (contagem/ocupação/alarme) continua lendo tracks EXATOS; toda mudança daqui é
  display-only ou de cadência/custo — exceto 1a, cujos valores são idênticos aos defaults que já
  rodam (a fiação muda QUEM manda, não o comportamento de hoje).
- Vermelho não entra: `npm run verify` por onda; knob de qualidade passa pelo eval (D.10).
