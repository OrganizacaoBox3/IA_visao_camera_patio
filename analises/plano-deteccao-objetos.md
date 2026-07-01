# Plano de Melhoria — Detecção de objetos distantes/pequenos

> Problema relatado: câmera no topo de um prédio **não detecta carros passando na rua** (objetos
> pequenos/distantes). Revisão do pipeline real (evidência `arquivo:linha`) + plano priorizado.
> *Nada foi alterado — é análise/plano.*

## Diagnóstico — por que objetos distantes somem (por impacto)

### 1. 🔴 Resolução da fonte baixa demais para longo alcance
- **RTSP ingere a 480px de largura** (`server/rtsp.js:78`, `RTSP_WIDTH` default 480) e 8 fps (`:77`). Webcam envia a **960px** (`config.ts:194`).
- Num enquadramento de rooftop, um carro na rua ocupa ~1–2% da largura → **~5–10 px numa fonte de 480px**. O coco-ssd redimensiona a entrada para **300×300** (arquitetura SSD) → o carro vira ~3–6 px → **abaixo do que o detector consegue reconhecer**. É a causa dominante.

### 2. 🔴 Tiling insuficiente e desligado na grade
- O tiling só liga na câmera **aberta** em tela cheia (`CameraWorkspace.tsx:686` → `tiled = mode === "full"`); **as câmeras da grade rodam single-shot** (frame inteiro → 300×300), o pior caso para objetos pequenos.
- Mesmo aberto, o grid é só **2×2** com `detectTileWidth=512` (`config.ts:22-23`). Com fonte de 480–960px, cada bloco ainda deixa o carro distante com poucos pixels no input 300. **2×2 não resgata cenas de rua vistas de cima.**

### 3. 🟠 coco-ssd é fraco em objetos pequenos por design
- Base `mobilenet_v2` (`config.ts:13`), entrada 300×300. SSD tem recall baixo para objetos que ocupam poucos % do quadro — é limitação conhecida da arquitetura, independente de threshold.

### 4. 🟠 Thresholds filtram detecções distantes (que já pontuam baixo)
- `objectScoreThreshold: 0.5` (`config.ts:16`), `people.scoreThreshold: 0.4` (`:34`), `minScore: 0.25` bruto (`:18`). Objeto distante que **é** detectado sai com score baixo e é cortado.

### 5. 🟠 Movimento distante não conta como atividade
- Motion roda em **procWidth=240** (`config.ts:6`) e exige **1,2% da zona alterada** p/ "ATIVA" (`motionActiveRatio 0.012`) / 0,4% p/ "LENTA" (`:9`). Carro distante muda **bem menos que 0,4%** dos pixels → não registra movimento nem no modo atividade.

> Resumo: a imagem chega pequena, é encolhida de novo para o detector, sem tiling fino, e o pouco que sobra é filtrado por threshold. Todas as camadas conspiram contra o objeto distante.

---

## Plano de melhoria (priorizado, com trade-offs)

> Princípio: **detecção de objeto pequeno custa CPU** (mais pixels × mais tiles × mais inferências). Como acabamos de otimizar performance, a chave é **um perfil opcional por câmera** — liga o custo só onde precisa (rooftop/rua), mantendo as demais leves.

### P0 — Resolução + tiling (a maior alavanca, sem trocar de modelo)
1. **Separar "resolução de exibição" de "resolução de detecção".** Hoje o detector usa o frame como chega. Permitir uma **fonte de maior resolução para detecção** (a mesma ideia que a leitura de código já usa via `capture`): para RTSP, usar **main-stream** ou subir `RTSP_WIDTH` (ex.: 1280) na câmera de longo alcance; para webcam, um `frameWidth` maior no perfil.
2. **Tiling adaptativo (estilo SAHI).** Grade mais fina (**3×3 ou 4×4**) e configurável por câmera; aumentar `detectTileWidth` (ex.: 640) e o `overlap`. Objetos pequenos ficam relativamente maiores em cada bloco.
3. **Ligar tiling também nas câmeras da grade de longo alcance** (hoje só a aberta faz) — ao menos quando o perfil "longo alcance" estiver ativo.
- *Esforço:* médio · *Risco:* baixo/médio (CPU) · *Ganho:* alto. **Faz a maior diferença isolada.**

### P1 — Thresholds e movimento por perfil
4. **Baixar thresholds no perfil longo alcance:** `objectScoreThreshold`≈0.3, `minScore`≈0.15, `people.scoreThreshold`≈0.3 — por câmera/zona (já temos sensibilidade por zona como base).
5. **Movimento distante:** subir `procWidth` (240→ maior) e baixar `motionActiveRatio`/`motionSlowRatio` nesse perfil, para captar micro-movimento. *Trade-off:* mais falso positivo (sombra/luz) → depende da sensibilidade por zona já existente.
- *Esforço:* baixo · *Risco:* médio (mais ruído) · *Ganho:* médio.

### P2 — Modelo melhor para objetos pequenos (evolução)
6. Avaliar trocar/complementar o coco-ssd por um detector mais forte em objetos pequenos rodando no browser: **YOLOv8/v11 via onnxruntime-web** (entrada maior, ex. 640, melhor recall) — o `onnxruntime-web` já vem com o `@huggingface/transformers` (branch de migração). Manter coco-ssd como fallback leve.
- *Esforço:* alto · *Risco:* médio (bundle/perf) · *Ganho:* alto para o caso rooftop. **Spike de pesquisa antes de comprometer.**

### Transversal — "Perfil de câmera: Longo alcance / Panorâmica"
Um toggle por câmera que aplica de uma vez: resolução de detecção maior + tiling fino (3×3/4×4) + thresholds mais baixos + motion mais sensível. Câmeras normais (doca/corredor) ficam no perfil leve. Assim resolvemos o rooftop **sem** regredir a performance geral.

---

## Sequência recomendada
1. **Quick win imediato (config, sem código novo):** na câmera rooftop, usar **main-stream/`RTSP_WIDTH` maior** e abrir a câmera (tiling 2×2) — confirmar se já melhora. Valida a hipótese da resolução.
2. **P0** — resolução de detecção separada + tiling adaptativo 3×3/4×4 + tiling na grade (perfil longo alcance).
3. **P1** — thresholds/motion por perfil.
4. **P2** — spike YOLO/onnxruntime-web; adotar se o ganho justificar o custo.

## Validação (não é testável headless)
O ganho de **recall em objeto distante** só se mede **em runtime com a câmera real** (rooftop/rua). Instrumentar: nº de detecções, score médio, FPS e CPU antes/depois; comparar 2×2 vs 3×3/4×4 e 480px vs 1280px na mesma cena. "Sem evidência não há pronto" — medir, não assumir.

## Trade-off honesto
Detecção de objeto pequeno **conflita** com a otimização de performance recente. Por isso o **perfil por câmera**: paga-se CPU só nas câmeras panorâmicas. Em máquina fraca com muitas câmeras panorâmicas, pode ser preciso reduzir fps de detecção ou nº de câmeras simultâneas — a decidir com os números do passo de validação.
