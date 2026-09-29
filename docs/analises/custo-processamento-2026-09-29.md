# Custo de processamento — antes × depois das otimizações (2026-09-22 → 2026-09-29)

**O que foi medido:** o CPU do worker de inferência (o processo que roda o modelo — ~90% do
custo de uma câmera analisada) com e sem cada otimização entregue nesta semana.

**Como:** motor real (`server/analysis/engine.js` + worker forkado + ONNX Runtime CPU), 1 worker,
1 câmera sintética recebendo **sempre o mesmo frame** a 1 fps (o cenário "câmera ociosa":
depósito à noite, corredor vazio, manequim parado). O número é `engine.status().worker.cpuPct`
— a telemetria de produção (`process.cpuUsage()` do worker), média do regime permanente
(descartados os 15 s de boot). Máquina: notebook de desenvolvimento, Windows 11. Script em
`scratchpad/bench-motion-gate.cjs` (fora do repo — ferramenta de medição, não produto).

> **Leia os absolutos com cautela.** O mesmo cenário deu 82% numa sessão e 104% noutra (estado
> térmico e carga de fundo da máquina). O achado estável é a **razão** entre as configurações
> medidas na MESMA sessão, não o número bruto. Em produção (4 vCPU, várias câmeras) os absolutos
> serão outros; as razões são o que se espera transferir.

## Resultados

| Configuração (1 câmera ociosa, 1 fps) | CPU do worker (% de 1 núcleo) | Rodadas |
|---|---|---|
| Modelo **S** (padrão), sem gates | 113 · 163 · 163 | 3 |
| Modelo **N** (leve), sem gates | 82 · 104 · 104 | 3 |
| Modelo N + **gate de movimento** | 14 | 1 |
| Modelo N + **gate de turno** (câmera fora do turno) | **0** | 1 |
| Auto-máscara desligada × ligada (mesma sessão, 2026-09-24) | 144,5 × 148,1 | 1 cada |

## O que cada otimização compra (Regra 11 — o delta de CADA mecanismo, isolado)

| Otimização | Economia medida | Onde vale |
|---|---|---|
| **Tier N por câmera** (em vez do S) | **28–37%** do CPU da câmera (N custa 0,63–0,72× do S nas 3 rodadas pareadas) | câmeras de passagem/portaria, onde o recall extra do S não muda a decisão |
| **Gate de movimento** (já default) | **~85%** numa cena parada (14% vs 82–104%) | toda câmera sem movimento — a maioria à noite |
| **Gate de turno** | **100%** da inferência da câmera enquanto fora do turno | câmeras com turno cadastrado; a correção de 22/09 tirou o alarme falso que impedia ligá-lo |
| **Auto-máscara + "Está correto / É falso positivo"** | **~0%** de CPU (diferença dentro do ruído) | não é otimização de custo: corta **alarme falso**, não inferência |

## O que isto NÃO mede (residual declarado)

- **Cena com movimento real.** Com gente andando o gate de movimento deixa passar quase tudo; a
  economia dele vai a ~0 nesse período. O ganho do tier N continua valendo.
- **Várias câmeras disputando o pool.** Com o pool saturado, o autoscale e a cadência ociosa
  mudam o quadro; esta medição é de 1 câmera, sem disputa.
- **Custo do hub** (ingest/relé/decode de thumbnail): ficou em 0,5–2% de 1 núcleo aqui, mas em
  produção o ingest de ~15 streams custa independente da análise (medido em 15/09: 2,5 vCPU com
  4 câmeras analisando). Nenhuma destas otimizações mexe nele — a que mexe é **não receber** o
  stream (câmera desativada/removida), daí o diagnóstico de câmeras inúteis desta entrega.
- **Precisão do tier N.** Mais barato, enxerga menos longe. A troca é por câmera, de propósito;
  a curva de recall por tier está em `docs/analises/acuracia-modelos.md`.

## Recomendação

1. **Confirmar o gate de turno em produção** (`ANALYSIS_SHIFT_GATE=1`) — é a maior economia (100%
   fora do turno). Não está no `fly.toml`; a medição noturna do PR #37 (19/09, "todas dormindo")
   indica que já está ligado via secret — `flyctl secrets list --app visao-patio` confirma. E
   **dar turno a toda câmera que precisa vigiar**: sem turno ela dorme o dia inteiro.
2. **Fixar tier N** nas câmeras de passagem (portaria, corredor) — 28–37% cada uma.
3. **Desativar ou remover as câmeras "inúteis"** que a tela de Câmeras agora aponta (offline,
   congelada, sem área) — é o único item que reduz o custo do INGEST, que o resto não toca.
