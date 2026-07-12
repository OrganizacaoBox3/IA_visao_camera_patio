// Simulador indoor do harness de associação tag BLE ↔ pessoa (Frente A do plano de fusão).
// Gera cenários SINTÉTICOS com a matemática REAL do sistema (homografia DLT de src/vision/) e o
// GROUND TRUTH por tick (truthTagByTrack), sem hardware: pessoas caminham num chão 8×6 m, uma
// câmera virtual em perspectiva projeta o pé (com ruído de pixel, dropout e id-switch do tracker)
// e uma estação BLE mede RSSI por log-distância (quantizado a inteiro e atualizado no período real
// do bt-readings). Permite desenvolver e barrar regressão da fusão ANTES do hardware.
// A altura da caixa (bh) é função da distância à CÂMERA com ruído multiplicativo σ=5% — detector
// real nunca entrega bh exato; sem isso o proxy 1/bh do modo não-calibrado mediria sinal perfeito.
//
// Onde fica a estação BLE (SimOpts.stationAtCamera) — dois modos de instalação:
// - false (default): estação no CANTO do chão (0,0), ~4,5 m da câmera (4,-2). Representa a
//   instalação em que o operador calibra H E marca o stationPx (o call-site fullscreen da produção).
//   NÃO casa com o proxy 1/bh, que mede distância à câmera.
// - true: estação fisicamente JUNTO da câmera (4,-2) — a premissa do caminho C do frame.ts
//   ("estação junto da câmera"). É a config recomendada para operar SEM calibração: o proxy 1/bh
//   e o RSSI medem a distância ao MESMO ponto.
// 100% determinístico — LCG(seed) + Box–Muller; zero Math.random/Date.now (replay-safe, doutrina).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ‼ ARMADILHA — O DEFAULT `rssiPeriodTicks=2` É OTIMISTA vs O CAMPO. LEIA ANTES DE MEDIR. ‼
//
//   default rssiPeriodTicks = 2  ⇒  Δt = 2 × 500 ms =  1,0 s  (1 Hz)   ← O SIMULADOR
//   TAG REAL medida em campo     ⇒  Δt ≈           ~2,5 s  (0,4 Hz)  ← A FÍSICA
//
// O simulador emite RSSI FRESCO 2,5× MAIS RÁPIDO do que a tag real anuncia. Toda métrica que conta
// EVIDÊNCIA INDEPENDENTE (n_eff, cobertura por visita, significância de Fisher) fica INFLADA ~2,5×
// se medida com o default. Foi exatamente esse o bug que inflou o n_eff máx a 39 e a cobertura por
// visita a 45,2% no laudo de 2026-07-12 (n_eff=39 exigiria um episódio de ~97 s com a tag real —
// nenhuma aproximação a uma mesa dura isso). Ver "A LEI COMPLETA DO n_eff" em visit-metrics.ts.
//
// O DEFAULT NÃO MUDA (de propósito): os FUSION_SCENARIOS estão PINADOS bit-a-bit contra ele, e
// rssiPeriodTicks altera o consumo de RNG (o ε do RSSI é sorteado em mais/menos ticks) — mudá-lo
// re-sortearia todas as trajetórias e invalidaria os pinos. Para medir com a FÍSICA REAL, passe
// explicitamente `rssiPeriodTicks: REAL_TAG_PERIOD_TICKS`.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { computeHomography, worldToPixel } from "../vision/homography";
import type { Matrix3, Vec2 } from "../vision/homography";
import type { DrawTrack, RawReading } from "./frame";
import { pointInPolygon } from "./floor-polygon";
import type { Polygon } from "./floor-polygon";

/** Um tick de 500 ms: o que a câmera+estação ENTREGAM + a verdade de quem está sob cada trackId. */
export type SimTick = {
  ts: number;
  tracks: DrawTrack[];
  readings: RawReading[];
  truthTagByTrack: Record<number, string | null>;
};
/** Tag-âncora FIXA (v4): MAC + posição-mundo CADASTRADA (metros) — o que o operador informa e o
 *  fit consome como "gabarito". Igual à posição REAL, exceto com SimOpts.anchorPosErrorM (erro de
 *  instalação/cadastro: posAssumed ≠ posReal — a física do RSSI segue usando a real). */
export type SimAnchor = { mac: string; world: Vec2 };
export type SimFusionScenario = {
  ticks: SimTick[];
  H: Matrix3 | null;
  stationPx: Vec2;
  /** ADITIVO (v4): posições CADASTRADAS das tags-âncora — presente só com SimOpts.anchors
   *  (= posições reais, salvo erro de instalação via SimOpts.anchorPosErrorM). */
  anchors?: SimAnchor[];
};
export type SimWalk = "waypoint" | "parado" | "bloco" | "cruzamento";
export type SimOpts = {
  steps?: number;
  people?: number;
  tagged?: number;
  rssiNoiseDb?: number;
  rssiPeriodTicks?: number;
  pxJitter?: number;
  dropoutP?: number;
  walk?: SimWalk;
  idSwitchOnCross?: boolean;
  uncalibrated?: boolean;
  /** true = estação BLE instalada junto da câmera (premissa do caminho C do frame.ts); ver cabeçalho. */
  stationAtCamera?: boolean;
  /** ONDA 1 do ADR-014 — posição da ESTAÇÃO/receptor em coords de MUNDO (metros). Quando PRESENTE:
   *  (a) vira a `rssiOrigin` (a origem física do log-distância do RSSI — tem PRECEDÊNCIA sobre
   *      `stationAtCamera`), e (b) o `stationPx` EXPORTADO passa a ser `worldToPixel(H, override)`,
   *  de modo que o `dist` da correlação em frame.ts (pé→stationWorld) meça pessoa→override. É o knob
   *  do experimento INDICATIVO "mover o receptor para o DESTINO da caminhada fabrica span radial
   *  suficiente para a significância honesta passar a DECIDIR?" (complemento CIRCULAR do experimento
   *  geométrico puro de receiver-geometry.ts). Default undefined ⇒ comportamento ATUAL 100%
   *  preservado. NÃO consome RNG (só troca a POSIÇÃO usada no log10 e na projeção — nenhum sorteio
   *  novo, ordem do stream intacta, pinos bit-a-bit dos FUSION_SCENARIOS preservados). Se o ponto
   *  projetar FORA da imagem [0,1]², a mesma guarda da estação do canto lança erro explícito (nunca
   *  NaN mudo) — override deve cair sobre o chão calibrado (área útil do sim está bem dentro dele). */
  stationWorldOverride?: Vec2;
  /** true (v4) = emite 4 tags-âncora ESTÁTICAS nos cantos de um retângulo 2,5×1,2 m ao redor da
   *  estação (espelha o campo real do dono — span ESTREITO de distâncias, regime anchors-offset
   *  do fitPathLoss), com o MESMO modelo log-distância + mesmo ruído das tags de pessoa. */
  anchors?: boolean;
  /** ERRO DE INSTALAÇÃO/CADASTRO das âncoras (Fase 3 — eixo da curva "quão bem preciso instalar?"
   *  do §8 de docs/cientifica/simulador.md; modela o posAssumed ≠ posReal do §3 do escopo: o
   *  operador mediu/cadastrou a posição da âncora ERRADO). Desloca APENAS as posições EXPORTADAS
   *  em `SimFusionScenario.anchors[].world` — as que o replay/fitPathLoss consomem como "posição
   *  conhecida" — por um vetor determinístico de magnitude `anchorPosErrorM` (metros) por âncora,
   *  em direções FIXAS alternadas por índice (+x, +y, −x, −y — SEM consumir RNG; ausente/0 =
   *  byte-compat total). A física de GERAÇÃO do RSSI continua usando a posição REAL da ferragem —
   *  o erro existe só no que o operador "cadastrou". É o knob da previsão falseável (c) do §8:
   *  erro de cadastro deve mover auditoria/anéis, NUNCA a precisão de identidade.
   *  MARGEM ESTREITA (varredura adversarial de 2026-07-11): no eixo 0..2 m, o span de log10 das
   *  distâncias cadastro→estação chega a 0,3802 década (pico em e≈1,39 m) — a 5% do limiar de
   *  0,4 década que faz o fitPathLoss trocar de regime (anchors-offset ↔ fit completo). Se
   *  ANCHOR_HALF_W/H aqui ou o SPAN_MIN_DECADES do fit mudarem, o regime pode flipar no MEIO da
   *  curva silenciosamente; há um teste-guarda em sim.test.ts selando span < 0,4 no eixo todo. */
  anchorPosErrorM?: number;
  /** SENTINELA DE VIÉS (revisão adversarial de 2026-07-10): offset constante em dB aplicado SÓ
   *  ao RSSI das tags de PESSOA — a atenuação corporal que o campo real tem e o modelo do fit
   *  não vê (foi este knob, a −6 dB, que provou a circularidade sim↔fit e derrubou gate/blend
   *  dos defaults). Não consome RNG: default 0 ⇒ cenário byte-idêntico ao sem o knob. */
  personRssiBiasDb?: number;
  /** SENTINELA DE VIÉS 2: expoente de path-loss do CANAL (o mundo), default 2,2. Um canal com
   *  n ≠ 2,2 descasa do n que o fit assume no regime anchors-offset (span estreito). Afeta
   *  pessoas E âncoras — o canal é um só. Não consome RNG (byte-compat com default). */
  channelN?: number;
  /** SENTINELA DE PERSISTÊNCIA (docs/cientifica/escopo-persistencia-rotulo.md, Mordida 2): força
   *  uma troca DETERMINÍSTICA de trackId entre duas pessoas num tick exato — sem sorteio, sem RNG
   *  consumido (byte-compat: ausente = comportamento intacto). Diferente de `idSwitchOnCross`
   *  (probabilístico, disparado por proximidade física): aqui o CHAMADOR escolhe o instante exato
   *  (ex.: o tick em que uma política de memória confirmou a crença) — o mecanismo de injeção
   *  cirúrgica que o escopo da persistência e o §3 de docs/cientifica/simulador.md (campo `inject`)
   *  pedem. Não valida proximidade física: é responsabilidade do chamador escolher um `tickIndex`
   *  onde as duas pessoas estejam próximas (senão a troca gera um salto físico detectável, que é
   *  um cenário de sentinela DIFERENTE, não o "sem salto" da Mordida 2). */
  forceSwitchAt?: { tickIndex: number; personA: number; personB: number };
  /** FÍSICA MEDIDA (Fase 2 da bancada, docs/cientifica/simulador.md) — constante de tempo (s) da
   *  autocorrelação do ruído de RSSI, via AR(1): ausente (default) = ruído IID a cada atualização,
   *  o comportamento de sempre (byte-compat — pinos antigos intactos, mesmo consumo de RNG).
   *  Presente = `noise[t] = ρ·noise[t-1] + √(1-ρ²)·ε[t]` (ε~N(0,1) iid, ρ=exp(-Δt/τ) — Δt é o
   *  período real entre atualizações de RSSI, `rssiPeriodTicks`×500ms), preservando a MESMA
   *  variância (rssiNoiseDb) só adicionando correlação temporal — verdadeiro desde o 1º sample:
   *  a 1ª atualização de cada tag semeia o estado estacionário (`noise = ε` puro, var 1) em vez
   *  de recursar a partir de 0, que deixaria o transitório sub-ruidoso (correção da revisão
   *  adversarial de 2026-07-11; mesmo consumo de RNG). FONTE: mineração das 6h reais
   *  (`docs/cientifica/relatorio-consolidado-2026-07-10.md` §9.5) mediu autocorrelação de 0,49-0,94
   *  em lag de 2s — invertendo ρ(Δt)=exp(-Δt/τ) pros dois extremos dá τ≈2,8s a τ≈32s (faixa LARGA,
   *  não um número limpo — a mineração cobriu regimes de obstrução bem diferentes por âncora).
   *  Nenhum default aqui: quem usa este knob escolhe o τ explicitamente dentro da faixa medida
   *  (ou fora dela, documentando por quê) — não escondemos a incerteza atrás de uma média. Só
   *  aplica ao RSSI de PESSOA; âncoras seguem IID (limitação declarada, não medida ainda pra elas). */
  rssiNoiseTauS?: number;
  /** FÍSICA MEDIDA (Fase 2) — offsets REGIONAIS de verdade (polígonos de mundo, metros), não um
   *  offset achatado por emissor: dentro de um polígono, o `offsetDb` daquela região soma ao RSSI
   *  (pessoas E âncoras — ferragem fixa também está num lugar físico do prédio). Regiões
   *  sobrepostas SOMAM (múltiplos efeitos ambientais se acumulam; não escolhemos "o primeiro que
   *  bater" pra não esconder a sobreposição). Reusa `pointInPolygon` de `floor-polygon.ts` — MESMO
   *  primitivo do recorte do anel ∩navegável, sem duplicar geometria. Ausente/vazio = 0 offset em
   *  toda parte, byte-compat total (nenhum consumo de RNG aqui — é geometria pura, determinística).
   *  FONTE: `rssi0` implícito variou 16dB entre as 4 âncoras da calibração real (mineração das 6h,
   *  `relatorio-consolidado-2026-07-10.md` §4) — evidência de que um modelo único de propagação pro
   *  espaço inteiro é um ajuste pobre; cada região tem condição de rádio própria. Os POLÍGONOS e
   *  DELTAS específicos ficam a cargo de quem monta o cenário (não cravamos uma família aqui —
   *  isso é Fase 3, famílias/curvas) — o que entra agora é o MECANISMO, testado e correto. */
  rssiRegions?: { poly: Polygon; offsetDb: number }[];
  /** FÍSICA MEDIDA (Fase 2) — viés corporal DIRECIONAL: em vez do offset achatado
   *  (`personRssiBiasDb`, a sentinela do v4), a atenuação depende do ÂNGULO entre a direção em que
   *  a pessoa anda (proxy da orientação do corpo — "parado" não tem heading real, ver
   *  implementação) e a linha tag→estação, mais de que LADO do corpo a tag está
   *  (`tagPlacement`). Modelo: pior caso (`peakDb`) quando o corpo está diretamente ENTRE a tag e
   *  a estação (a tag "de costas" pra estação, na direção da colocação); melhor caso (`meanDb`,
   *  o piso — o corpo SEMPRE atenua alguma coisa, mesmo com linha de visão livre) quando a tag
   *  encara a estação. `angWidthDeg` é a largura angular da zona de sombra (graus) ao redor do
   *  pior ângulo — fora dela, cai rápido pro piso. FONTE: `meanDb`/`peakDb` cruzam literatura
   *  (4-10dB médio corporal, pico ~20dB) com a profundidade medida nas quedas transientes das 6h
   *  reais (~12dB médio) — ver `relatorio-consolidado-2026-07-10.md` §9.5; `angWidthDeg` não tem
   *  medição própria ainda, é `[chute marcado]` até o teste de campo calibrar. Ausente = sem viés
   *  direcional (só `personRssiBiasDb`, se presente); não consome RNG (byte-compat). */
  bodyBias?: { meanDb: number; peakDb: number; angWidthDeg: number };
  /** Lado do corpo onde a tag fica, por ÍNDICE de pessoa (0-based) — só relevante com `bodyBias`.
   *  Ausente por pessoa = "peito" (default neutro: tag na frente do corpo, na direção do heading). */
  tagPlacement?: Record<number, "peito" | "bolso-esq" | "bolso-dir">;
  /** FÍSICA MEDIDA (Fase 2, último incremento) — obstáculos como polígonos de mundo (metros):
   *  `occludesVision` bloqueia a CÂMERA (dropout ESTRUTURADO — o segmento pessoa→câmera cruza o
   *  polígono, então o tracker simplesmente não vê, o mesmo efeito de `dropoutP` mas determinístico
   *  pela geometria em vez de sorteio) e/ou `rfAttenDb` atenua o RF (somado ao RSSI quando o
   *  segmento pessoa→estação cruza o polígono). Os dois papéis são INDEPENDENTES por obstáculo (uma
   *  parede pode bloquear visão sem atenuar RF de verdade, ou vice-versa — depende do material;
   *  quem monta o cenário decide). Múltiplos obstáculos cruzados SOMAM a atenuação de RF (mesma
   *  convenção de `rssiRegions`). Não consome RNG (geometria pura) — byte-compat quando ausente.
   *  SEMÂNTICA DE "DENTRO" (decisão de modelagem declarada, não corrigida): o teste é cruzamento
   *  de ARESTA — um segmento inteiramente DENTRO do polígono não cruza aresta nenhuma, então
   *  pessoa dentro do obstáculo com câmera/estação TAMBÉM dentro = obstáculo transparente
   *  (false/0); pessoa dentro com estação fora = o segmento cruza a borda uma vez = atenuação
   *  CHEIA. E os walkers IGNORAM obstáculos — pessoas atravessam máquinas (obstáculo não é
   *  barreira de movimento); obstáculo que contenha a estação deve ser modelado como rssiRegions.
   *  FORA DE ESCOPO v1 (documentado, não escondido): o acoplamento "id-switch elevado na SAÍDA da
   *  oclusão" que `docs/cientifica/simulador.md` §4 propõe fica pra uma rodada futura — exige
   *  estado extra (há quanto tempo a pessoa estava oculta) que este incremento não adiciona;
   *  `idSwitchOnCross` (proximidade física) segue sendo o único mecanismo de id-switch disponível
   *  hoje, independente deste knob. */
  obstacles?: { poly: Polygon; occludesVision?: boolean; rfAttenDb?: number }[];
};

// ——— PRNG determinístico (mesmo padrão de src/localizacao/simulate.ts) ———

type Rng = () => number;

/** LCG (Numerical Recipes) — PRNG determinístico e barato. */
function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Normal padrão via Box–Muller, a partir do LCG. */
function randn(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ——— Geometria fixa do cenário ———

// Chão 8×6 m visto em perspectiva (lado distante menor) — as 4 correspondências que o operador
// marcaria na calibração real. A H sai do MESMO solver DLT da produção (computeHomography).
const FLOOR_PAIRS = [
  { px: { x: 0.15, y: 0.92 }, world: { x: 0, y: 0 } },
  { px: { x: 0.85, y: 0.92 }, world: { x: 8, y: 0 } },
  { px: { x: 0.68, y: 0.3 }, world: { x: 8, y: 6 } },
  { px: { x: 0.32, y: 0.3 }, world: { x: 0, y: 6 } },
];
const STATION_WORLD: Vec2 = { x: 0, y: 0 }; // estação BLE no canto do chão (modo default)
const CAMERA_WORLD: Vec2 = { x: 4, y: -2 }; // câmera atrás do lado próximo (dita o tamanho da caixa)
const BH_NOISE_SIGMA = 0.05; // ruído multiplicativo da altura da caixa (σ 5% — detector real)
const BH_MIN = 0.02; // clamp inferior da bh ruidosa (caixa nunca degenera/negativa)

const TICK_MS = 500;

/**
 * CADÊNCIA DE ADVERTISING DA TAG REAL, em ticks do simulador — a FÍSICA, não o default.
 *
 * PROVENIÊNCIA: intervalo de advertising MEDIDO em campo, ~2,5 s entre leituras FRESCAS (é o mesmo
 * dado que revelou o sample-and-hold do snapshot; ver residual-autocorr.ts/.test.ts, gravação
 * server/bt/fusion-session-2026-07-11_20). 2,5 s ÷ 500 ms/tick = 5 ticks.
 *
 * USE ISTO em toda medição que conte EVIDÊNCIA INDEPENDENTE (n_eff, cobertura por visita,
 * significância). O default `rssiPeriodTicks=2` (1 Hz) é 2,5× OTIMISTA — ver o aviso no cabeçalho.
 * NÃO vire o default: os pinos bit-a-bit dos FUSION_SCENARIOS dependem dele (rssiPeriodTicks muda o
 * consumo de RNG).
 */
export const REAL_TAG_PERIOD_TICKS = 5;
/** Δt de advertising da tag REAL, em segundos (= REAL_TAG_PERIOD_TICKS × 500 ms). O Δt_tag da lei
 *  n_eff ≤ min(T/Δt_tag, T/2τ) — o teto FÍSICO de leituras distintas por episódio. */
export const REAL_TAG_PERIOD_S = (REAL_TAG_PERIOD_TICKS * TICK_MS) / 1000;

const SPEED_M_PER_TICK = 1.2 * (TICK_MS / 1000); // 1,2 m/s → 0,6 m por tick
const ARRIVE_M = 0.3; // raio de "cheguei ao waypoint"
const AREA = { minX: 0.5, maxX: 7.5, minY: 0.5, maxY: 5.5 }; // onde as pessoas andam (margem do chão)
const BLOCO_OFFSET_M = 0.8; // ombro-a-ombro do caso ambíguo
const CROSS_Y0 = 3.0; // faixa da pessoa 0 no cruzamento
const CROSS_Y1 = 3.2; // faixa da pessoa 1 (opostas → cruzam a cada passada)

// id-switch do tracker: aproximação <0.7 m arma UM sorteio (p=0.5); re-arma ao afastar >1.5 m.
const SWITCH_NEAR_M = 0.7;
const SWITCH_REARM_M = 1.5;
const SWITCH_P = 0.5;

// BLE log-distância: RSSI = -45 − 10·2,2·log10(max(d, 0,3)) + ruído; quantizado a inteiro (real).
const RSSI_1M_DBM = -45;
const PATH_LOSS_N = 2.2;
const MIN_DIST_M = 0.3;

/** MACs das tags, atribuídas às pessoas 0..tagged-1 nesta ordem. */
const MACS = ["AA:AA", "BB:BB", "CC:CC", "DD:DD", "EE:EE", "FF:FF"];

// Tags-âncora (v4): 4 emissoras FIXAS nos cantos de um retângulo 2,5×1,2 m centrado na ORIGEM do
// RSSI (a estação) — espelha o campo real do dono. Consequência deliberada: as 4 ficam à MESMA
// distância (≈1,39 m) da estação → span de log10(d) ~0 → fitPathLoss cai no regime
// "anchors-offset" (só o rssi0 é calibrável), exatamente como no campo real de span estreito.
const ANCHOR_MACS = ["FX:01", "FX:02", "FX:03", "FX:04"];
const ANCHOR_HALF_W = 1.25; // metade dos 2,5 m
const ANCHOR_HALF_H = 0.6; // metade dos 1,2 m
// Direções FIXAS do erro de cadastro (SimOpts.anchorPosErrorM), alternadas por índice de âncora —
// determinísticas por construção (sem RNG): o erro de instalação não é sorteio, é um deslocamento
// sistemático que o eixo da curva controla em magnitude.
const ANCHOR_ERR_DIRS: Vec2[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

// ——— Caminhadas (posição-verdade de cada pessoa por tick) ———

type Walker = { pos: Vec2; target: Vec2 };

/** Sorteia um ponto dentro da área útil. */
function drawPoint(rng: Rng): Vec2 {
  return {
    x: AREA.minX + (AREA.maxX - AREA.minX) * rng(),
    y: AREA.minY + (AREA.maxY - AREA.minY) * rng(),
  };
}

function makeWalker(rng: Rng): Walker {
  return { pos: drawPoint(rng), target: drawPoint(rng) };
}

/** Anda 1 tick (0,6 m) rumo ao alvo; chegou (<0,3 m) → sorteia novo alvo. */
function stepWalker(w: Walker, rng: Rng): void {
  const dx = w.target.x - w.pos.x;
  const dy = w.target.y - w.pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= SPEED_M_PER_TICK) {
    w.pos = { x: w.target.x, y: w.target.y };
  } else {
    w.pos = { x: w.pos.x + (SPEED_M_PER_TICK * dx) / d, y: w.pos.y + (SPEED_M_PER_TICK * dy) / d };
  }
  if (Math.hypot(w.target.x - w.pos.x, w.target.y - w.pos.y) < ARRIVE_M) w.target = drawPoint(rng);
}

/** Fonte de posições-verdade: current() dá as posições do tick corrente; advance() move p/ o próximo. */
type Movers = { current(): Vec2[]; advance(): void };

function createMovers(walk: SimWalk, people: number, rng: Rng): Movers {
  if (walk === "parado") {
    // Posições fixas espalhadas (grade determinística dentro da área útil); ninguém se move.
    const fixed: Vec2[] = [];
    for (let p = 0; p < people; p++)
      fixed.push({ x: 1 + (p % 4) * 2, y: 1.5 + Math.floor(p / 4) * 1.8 });
    return { current: () => fixed.map((v) => ({ ...v })), advance: () => {} };
  }

  if (walk === "bloco") {
    // Pessoas 0 e 1 LADO A LADO: mesma trajetória waypoint, offset perpendicular fixo de 0,8 m.
    // É o caso fisicamente ambíguo (mesma distância à estação o tempo todo). Demais: independentes.
    const leader = makeWalker(rng);
    const others: Walker[] = [];
    for (let p = 2; p < people; p++) others.push(makeWalker(rng));
    let perp: Vec2 = { x: 0, y: 1 }; // perpendicular corrente ao rumo do líder (guarda a última válida)
    return {
      current: () => {
        const dx = leader.target.x - leader.pos.x;
        const dy = leader.target.y - leader.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-9) perp = { x: -dy / d, y: dx / d };
        const out: Vec2[] = [{ ...leader.pos }];
        if (people >= 2)
          out.push({
            x: leader.pos.x + BLOCO_OFFSET_M * perp.x,
            y: leader.pos.y + BLOCO_OFFSET_M * perp.y,
          });
        for (const w of others) out.push({ ...w.pos });
        return out;
      },
      advance: () => {
        stepWalker(leader, rng);
        for (const w of others) stepWalker(w, rng);
      },
    };
  }

  if (walk === "cruzamento") {
    // Pessoas 0 e 1 em vaivém OPOSTO em faixas y vizinhas — cruzam-se a cada passada (gatilho do
    // id-switch). Demais: waypoint independente.
    const ping = [
      { x: AREA.minX, y: CROSS_Y0, dir: 1 },
      { x: AREA.maxX, y: CROSS_Y1, dir: -1 },
    ];
    const nPing = Math.min(2, people);
    const others: Walker[] = [];
    for (let p = 2; p < people; p++) others.push(makeWalker(rng));
    return {
      current: () => {
        const out: Vec2[] = [];
        for (let p = 0; p < nPing; p++) out.push({ x: ping[p].x, y: ping[p].y });
        for (const w of others) out.push({ ...w.pos });
        return out;
      },
      advance: () => {
        for (let p = 0; p < nPing; p++) {
          const s = ping[p];
          s.x += s.dir * SPEED_M_PER_TICK;
          if (s.x > AREA.maxX) {
            s.x = 2 * AREA.maxX - s.x; // reflete na borda direita
            s.dir = -1;
          } else if (s.x < AREA.minX) {
            s.x = 2 * AREA.minX - s.x; // reflete na borda esquerda
            s.dir = 1;
          }
        }
        for (const w of others) stepWalker(w, rng);
      },
    };
  }

  // "waypoint" (default): todo mundo sorteia alvos independentes.
  const walkers: Walker[] = [];
  for (let p = 0; p < people; p++) walkers.push(makeWalker(rng));
  return {
    current: () => walkers.map((w) => ({ ...w.pos })),
    advance: () => {
      for (const w of walkers) stepWalker(w, rng);
    },
  };
}

// ——— Física medida (Fase 2): offset regional + viés corporal direcional — funções PURAS,
// determinísticas, sem RNG (ver docstrings de SimOpts.rssiRegions/bodyBias). ———

/** Soma os offsets de TODAS as regiões que contêm `pos` (sobreposição soma, ver docstring).
 *  Exportada (testável isolada) — mesmo padrão de fitPathLoss/distFromRssi em floor-plot.ts. */
export function regionOffsetAt(
  pos: Vec2,
  regions: readonly { poly: Polygon; offsetDb: number }[],
): number {
  let total = 0;
  for (const r of regions) if (pointInPolygon(pos, r.poly)) total += r.offsetDb;
  return total;
}

/** Ângulo entre dois vetores 2D, em graus, sempre em [0,180] (não-orientado — shadowing é
 *  simétrico: não importa se o desvio é horário ou anti-horário). Vetor de magnitude ~0 (pessoa
 *  parada, ou tag exatamente na estação) → 0° (neutro: sem informação de ângulo, sem penalizar). */
function angleBetweenDeg(a: Vec2, b: Vec2): number {
  const magA = Math.hypot(a.x, a.y);
  const magB = Math.hypot(b.x, b.y);
  if (magA < 1e-9 || magB < 1e-9) return 0;
  const cos = Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y) / (magA * magB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Rotaciona um vetor 2D por `deg` graus (anti-horário, y pra cima). */
function rotateDeg(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Deslocamento angular da direção "de frente pra tag" em relação ao heading do corpo — peito
 *  encara o heading (0°); bolsos ficam ~90° pro lado (convenção: esquerda/direita da PESSOA, não
 *  da tela — mas como o mundo aqui não tem "esquerda absoluta" sem mais contexto, ambos os bolsos
 *  usam a MESMA magnitude, só o sinal difere, o que é suficiente pro modelo de sombra simétrico). */
const PLACEMENT_OFFSET_DEG: Record<"peito" | "bolso-esq" | "bolso-dir", number> = {
  peito: 0,
  "bolso-esq": 90,
  "bolso-dir": -90,
};

/**
 * Viés corporal direcional (dB) — ver docstring de SimOpts.bodyBias. `heading` é a direção de
 * movimento (proxy da orientação do corpo); {x:0,y:0} (pessoa sem heading conhecido — "parado", ou
 * 1º tick) é tratado à parte: devolve só `meanDb` (o piso), a simplificação honesta de v1 para o
 * caso sem heading real (não inventamos uma orientação que não existe). A guarda existe por
 * CLAREZA/robustez — contrato explícito "sem heading → piso" —, NÃO porque o caminho geral
 * erraria: sem ela, `angleBetweenDeg` devolveria 0° (theta=0 → diffFromWorst=180 → shadow≈0,0015
 * com angWidthDeg=60) e o resultado já seria ≈meanDb por coincidência numérica; preferimos o
 * contrato dito a depender dela. (Docstring corrigida na revisão adversarial de 2026-07-11 — a
 * versão original afirmava, errado, que o caminho geral cairia no pior caso/shadow=1.)
 * Exportada (testável isolada) — mesmo padrão de fitPathLoss/distFromRssi em floor-plot.ts.
 */
export function bodyBiasDb(
  heading: Vec2,
  dirToStation: Vec2,
  placement: "peito" | "bolso-esq" | "bolso-dir",
  bias: { meanDb: number; peakDb: number; angWidthDeg: number },
): number {
  if (Math.hypot(heading.x, heading.y) < 1e-9) return bias.meanDb; // sem heading real — só o piso
  const fTag = rotateDeg(heading, PLACEMENT_OFFSET_DEG[placement]);
  const theta = angleBetweenDeg(fTag, dirToStation); // [0,180]; 180° = tag de costas pra estação
  const diffFromWorst = 180 - theta; // 0 no pior caso
  const sigma = Math.max(1e-6, bias.angWidthDeg / 2);
  const shadow = Math.exp(-(diffFromWorst * diffFromWorst) / (2 * sigma * sigma));
  return bias.meanDb + (bias.peakDb - bias.meanDb) * shadow;
}

/** Orientação de 3 pontos (sinal da área do triângulo ×2) — 0 = colineares. Primitivo clássico de
 *  interseção de segmentos, sem dependência externa. */
function orient(p: Vec2, q: Vec2, r: Vec2): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/** `q` está dentro da caixa-envoltória de `p`-`r` — só chamado quando `p`,`q`,`r` já são colineares
 *  (orient=0), pra decidir se o ponto colinear cai DENTRO do segmento ou fora do prolongamento. */
function onSegment(p: Vec2, q: Vec2, r: Vec2): boolean {
  return (
    Math.min(p.x, r.x) <= q.x &&
    q.x <= Math.max(p.x, r.x) &&
    Math.min(p.y, r.y) <= q.y &&
    q.y <= Math.max(p.y, r.y)
  );
}

/** Os segmentos `p1-p2` e `p3-p4` se cruzam — caso geral (orientações opostas dos dois pares) +
 *  casos degenerados colineares (raros com coordenadas de ponto flutuante, mas tratados pra nunca
 *  dar falso-negativo numa aresta exatamente alinhada). Algoritmo clássico (CLRS), sem novidade. */
function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0)
    return true;
  if (o1 === 0 && onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment(p3, p2, p4)) return true;
  return false;
}

/** O segmento `a`-`b` cruza ALGUMA aresta do polígono — usado pra "linha de visão bloqueada" e
 *  "linha RF atravessa obstáculo" (oclusão estruturada, ver SimOpts.obstacles). Exportada
 *  (testável isolada) — mesmo padrão de fitPathLoss/distFromRssi em floor-plot.ts. */
export function segmentIntersectsPolygon(a: Vec2, b: Vec2, poly: Polygon): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % n])) return true;
  }
  return false;
}

/** true se o segmento pessoa→câmera cruza ALGUM obstáculo com `occludesVision` (dropout
 *  estruturado, ver SimOpts.obstacles). */
function visionOccludedBy(
  personWorld: Vec2,
  cameraWorld: Vec2,
  obstacles: readonly { poly: Polygon; occludesVision?: boolean; rfAttenDb?: number }[],
): boolean {
  for (const o of obstacles) {
    if (o.occludesVision && segmentIntersectsPolygon(personWorld, cameraWorld, o.poly)) return true;
  }
  return false;
}

/** Soma o `rfAttenDb` de TODO obstáculo cujo polígono o segmento pessoa/âncora→estação cruza
 *  (sobreposição soma — mesma convenção de `regionOffsetAt`). */
function rfAttenuationDb(
  emitterWorld: Vec2,
  stationWorld: Vec2,
  obstacles: readonly { poly: Polygon; occludesVision?: boolean; rfAttenDb?: number }[],
): number {
  let total = 0;
  for (const o of obstacles) {
    if (o.rfAttenDb && segmentIntersectsPolygon(emitterWorld, stationWorld, o.poly)) total += o.rfAttenDb;
  }
  return total;
}

// ——— O simulador ———

/**
 * Gera um cenário determinístico de fusão: ticks de 500 ms com tracks (câmera), readings (BLE) e o
 * ground truth trackId→tag. `uncalibrated` exporta H:null (harness exercita o proxy de caixa), mas a
 * GEOMETRIA de projeção usa sempre a H calibrada — a câmera física existe; falta só a calibração.
 * `stationPx` é SEMPRE a projeção da estação do canto (0,0): com stationAtCamera ele NÃO representa
 * a física do RSSI (a câmera em (4,-2) está fora da imagem) — esse modo é para cenários que não
 * consomem stationPx (não-calibrados, onde o frame.ts usa o proxy de caixa).
 */
export function simulateFusionScenario(opts: SimOpts, seed: number): SimFusionScenario {
  const steps = opts.steps ?? 120;
  const people = opts.people ?? 3;
  const tagged = Math.min(opts.tagged ?? 2, people, MACS.length);
  const rssiNoiseDb = opts.rssiNoiseDb ?? 4;
  const rssiPeriodTicks = opts.rssiPeriodTicks ?? 2;
  const pxJitter = opts.pxJitter ?? 0.004;
  const dropoutP = opts.dropoutP ?? 0.05;
  const walk = opts.walk ?? "waypoint";
  // Sentinelas de viés (ver SimOpts): offsets/expoentes DETERMINÍSTICOS — nenhum consumo de RNG,
  // então cenários sem os knobs preservam o stream byte-a-byte (pinos antigos intactos).
  const personRssiBiasDb = opts.personRssiBiasDb ?? 0;
  const channelN = opts.channelN ?? PATH_LOSS_N;
  const rssiRegions = opts.rssiRegions ?? [];
  const bodyBias = opts.bodyBias;
  const tagPlacement = opts.tagPlacement ?? {};
  const obstacles = opts.obstacles ?? [];

  // Calibração pela matemática REAL (solver DLT da produção). Falha aqui = geometria fixa quebrada
  // → erro explícito, nunca NaN mudo.
  const calib = computeHomography(FLOOR_PAIRS);
  if (!calib.ok) throw new Error(`simulador: homografia degenerada (${calib.error})`);
  const H = calib.H;
  // Ponto EXPORTADO como estação: o canto (0,0) por padrão, ou o override de mundo (Onda 1) quando
  // presente — o `dist` da correlação (frame.ts) mede pessoa→este ponto. Guarda de projeção mantida
  // (vale pro override também: ponto fora da imagem = erro explícito, nunca NaN mudo). Sem override,
  // é worldToPixel(H, STATION_WORLD) — byte-idêntico ao anterior.
  const stationExportWorld = opts.stationWorldOverride ?? STATION_WORLD;
  const stationPx = worldToPixel(H, stationExportWorld);
  if (!stationPx || stationPx.x < 0 || stationPx.x > 1 || stationPx.y < 0 || stationPx.y > 1)
    throw new Error("simulador: estação projeta fora da imagem — geometria fixa inválida");

  const rng = lcg(seed);
  const movers = createMovers(walk, people, rng);
  // Origem física do RSSI: override de mundo (Onda 1, tem precedência) → estação do canto (default)
  // → junto da câmera (caminho C do frame.ts). Só troca a POSIÇÃO do log-distância; não consome RNG.
  const rssiOrigin = opts.stationWorldOverride ?? (opts.stationAtCamera ? CAMERA_WORLD : STATION_WORLD);

  // Tags-âncora (v4): retângulo 2,5×1,2 m centrado na origem do RSSI. São só emissoras BLE —
  // NÃO viram tracks de câmera (âncora é ferragem fixa, não pessoa) e NÃO entram na verdade
  // (nenhuma pessoa as carrega). Os sorteios de ruído delas vêm DEPOIS dos das pessoas em cada
  // tick — cenários sem anchors preservam o stream de RNG byte-a-byte (pinos antigos intactos).
  const anchors: SimAnchor[] | null = opts.anchors
    ? [
        { x: -ANCHOR_HALF_W, y: -ANCHOR_HALF_H },
        { x: ANCHOR_HALF_W, y: -ANCHOR_HALF_H },
        { x: ANCHOR_HALF_W, y: ANCHOR_HALF_H },
        { x: -ANCHOR_HALF_W, y: ANCHOR_HALF_H },
      ].map((off, k) => ({
        mac: ANCHOR_MACS[k],
        world: { x: rssiOrigin.x + off.x, y: rssiOrigin.y + off.y },
      }))
    : null;
  const lastAnchorRssi = new Array<number>(anchors ? anchors.length : 0).fill(0);
  // Posições EXPORTADAS das âncoras (o "cadastro" do operador, SimOpts.anchorPosErrorM): reais +
  // erro de instalação determinístico por índice. A física do RSSI abaixo usa SEMPRE `anchors`
  // (posição REAL da ferragem) — o erro existe só no que o replay/fit consome como verdade.
  // Sem o knob (ou 0), exporta os MESMOS objetos — byte-compat total.
  const anchorPosErrorM = opts.anchorPosErrorM ?? 0;
  const anchorsExported: SimAnchor[] | null =
    anchors && anchorPosErrorM !== 0
      ? anchors.map((a, k) => {
          const dir = ANCHOR_ERR_DIRS[k % ANCHOR_ERR_DIRS.length];
          return {
            mac: a.mac,
            world: {
              x: a.world.x + anchorPosErrorM * dir.x,
              y: a.world.y + anchorPosErrorM * dir.y,
            },
          };
        })
      : anchors;

  // Tracker: trackId = índice da pessoa, até um id-switch trocar (e a troca vale dali em diante).
  const trackIdOfPerson: number[] = [];
  for (let p = 0; p < people; p++) trackIdOfPerson.push(p);
  // Sorteio de id-switch por PAR: armado → pode sortear na próxima aproximação (<0,7 m); o sorteio
  // consome a arma; re-arma quando o par se afasta >1,5 m (no máx. 1 sorteio por evento).
  const armed = new Map<string, boolean>();

  const lastRssi: number[] = new Array<number>(tagged).fill(0);
  // Estado do ruído AR(1) por tag de pessoa (ver SimOpts.rssiNoiseTauS). A 1ª atualização de cada
  // tag semeia o estado ESTACIONÁRIO (`noise = ε` puro, var 1) — sem isso, partir de 0 e recursar
  // `ρ·prev + √(1-ρ²)·ε` deixaria o transitório SUB-ruidoso (var[k] = 1-ρ^2k; com τ=32s, var=0,45
  // aos 8s). Corrigido na revisão adversarial de 2026-07-11; mesmo consumo de RNG (o ε da 1ª
  // atualização já era sorteado). Só usado quando o knob está presente; ausente = cada
  // "atualização" reatribui `eps` puro (IID), byte-idêntico ao `randn(rng)` inline de sempre.
  const rssiNoiseAr1 = new Array<number>(tagged).fill(0);
  const rssiAr1Seeded = new Array<boolean>(tagged).fill(false);
  const rssiUpdateDtS = (rssiPeriodTicks * TICK_MS) / 1000;
  const rssiAr1Rho =
    opts.rssiNoiseTauS !== undefined ? Math.exp(-rssiUpdateDtS / opts.rssiNoiseTauS) : null;
  // Heading (proxy de orientação do corpo, ver SimOpts.bodyBias): {0,0} até a 1ª movimentação real
  // — pessoa parada ou 1º tick não tem heading conhecido (bodyBiasDb trata isso à parte).
  const lastPos: (Vec2 | null)[] = new Array(people).fill(null);
  const lastHeading: Vec2[] = Array.from({ length: people }, () => ({ x: 0, y: 0 }));
  const ticks: SimTick[] = [];

  for (let i = 0; i < steps; i++) {
    const positions = movers.current();

    // Heading = deslocamento desde o tick anterior; só atualiza com movimento REAL (>1e-6 m) —
    // pessoa parada mantém o último heading conhecido (não gira em torno de si mesma por ruído
    // numérico). Não consome RNG — determinístico, puro cálculo sobre posições já sorteadas.
    for (let p = 0; p < people; p++) {
      const prev = lastPos[p];
      if (prev) {
        const dx = positions[p].x - prev.x;
        const dy = positions[p].y - prev.y;
        if (Math.hypot(dx, dy) > 1e-6) lastHeading[p] = { x: dx, y: dy };
      }
      lastPos[p] = { x: positions[p].x, y: positions[p].y };
    }

    // Sentinela de persistência (Mordida 2): troca FORÇADA e determinística, sem RNG — aplicada
    // ANTES da leitura de trackIdOfPerson[p] desta tick, mesmo ponto onde idSwitchOnCross aplicaria
    // a troca probabilística (consistência: os dois mecanismos alteram o MESMO estado, na MESMA
    // fase do tick). `personA`/`personB` são índices de PESSOA (0-based), não trackId.
    const fs = opts.forceSwitchAt;
    if (fs && fs.tickIndex === i) {
      const t = trackIdOfPerson[fs.personA];
      trackIdOfPerson[fs.personA] = trackIdOfPerson[fs.personB];
      trackIdOfPerson[fs.personB] = t;
    }

    if (opts.idSwitchOnCross) {
      for (let a = 0; a < people; a++) {
        for (let b = a + 1; b < people; b++) {
          const key = `${a}-${b}`;
          const d = Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y);
          const isArmed = armed.get(key) ?? true;
          if (isArmed && d < SWITCH_NEAR_M) {
            armed.set(key, false);
            if (rng() < SWITCH_P) {
              const t = trackIdOfPerson[a];
              trackIdOfPerson[a] = trackIdOfPerson[b];
              trackIdOfPerson[b] = t;
            }
          } else if (!isArmed && d > SWITCH_REARM_M) {
            armed.set(key, true);
          }
        }
      }
    }

    // Câmera/tracker: pé = projeção do pé-verdade pela H calibrada + ruído gaussiano de pixel.
    // Dropout (frame perdido) e pé fora de [0,1]² (fora do FOV) derrubam a detecção da pessoa.
    // ORDEM FIXA de consumo do RNG por pessoa (determinismo byte-a-byte dado o seed):
    //   1) uniforme do dropout (SEMPRE consumido);
    //   2) se detectada: randn(fx), randn(fy) (consumidos mesmo com pxJitter=0);
    //   3) se o pé caiu dentro do FOV: randn(bh) — consumido APENAS quando a caixa é emitida
    //      (o desvio pelo FOV também é determinístico, então a ordem global se preserva).
    const tracks: DrawTrack[] = [];
    for (let p = 0; p < people; p++) {
      if (rng() < dropoutP) continue;
      // Oclusão ESTRUTURADA (ver SimOpts.obstacles): segmento pessoa→câmera cruza um obstáculo
      // occludesVision → dropout determinístico (mesmo efeito de dropoutP, mas pela geometria, não
      // sorteio). Sem obstáculos, `obstacles.length===0` pula o teste — custo zero, byte-compat.
      if (obstacles.length && visionOccludedBy(positions[p], CAMERA_WORLD, obstacles)) continue;
      const px = worldToPixel(H, positions[p]);
      if (!px) continue; // horizonte — não acontece na área útil, mas nunca NaN mudo
      const fx = px.x + randn(rng) * pxJitter;
      const fy = px.y + randn(rng) * pxJitter;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      const distCam = Math.hypot(positions[p].x - CAMERA_WORLD.x, positions[p].y - CAMERA_WORLD.y);
      // Mais longe da câmera → caixa menor; ruído multiplicativo σ=5% (detector real não entrega
      // bh exata) clampado a ≥0,02. O pé (bottom-center) NÃO muda — o ruído só suja o proxy 1/bh.
      const bh = Math.max(BH_MIN, (0.5 / (1 + 0.35 * distCam)) * (1 + BH_NOISE_SIGMA * randn(rng)));
      const bw = 0.4 * bh;
      tracks.push({ id: trackIdOfPerson[p], bbox: [fx - bw / 2, fy - bh, bw, bh] });
    }

    // BLE: RSSI recalculado a cada rssiPeriodTicks (default 1 Hz); entre atualizações o tick REPETE
    // o último valor — fiel ao snapshot bt-readings da produção. Todas as tags emitem sempre.
    // A origem do RSSI é a estação (0,0) ou a CÂMERA (4,-2) quando stationAtCamera (ver cabeçalho).
    // Viés corporal (personRssiBiasDb) entra SÓ aqui — tag de pessoa é atenuada pelo corpo.
    const readings: RawReading[] = [];
    for (let p = 0; p < tagged; p++) {
      if (i % rssiPeriodTicks === 0) {
        const d = Math.hypot(positions[p].x - rssiOrigin.x, positions[p].y - rssiOrigin.y);
        // AR(1) (ver SimOpts.rssiNoiseTauS): rho=null → eps puro, IID, byte-idêntico ao
        // `randn(rng) * rssiNoiseDb` de sempre. rho!=null → 1ª atualização semeia o estado
        // ESTACIONÁRIO (eps puro, var 1 desde o 1º sample — ver comentário em rssiNoiseAr1);
        // depois correlaciona com o valor anterior, preservando a MESMA variância (rssiNoiseDb) —
        // só a mineração das 6h reais mostrou que o ruído de campo não é IID amostra-a-amostra,
        // e este é o desvio calibrado por isso.
        const eps = randn(rng);
        rssiNoiseAr1[p] =
          rssiAr1Rho === null || !rssiAr1Seeded[p]
            ? eps
            : rssiAr1Rho * rssiNoiseAr1[p] + Math.sqrt(1 - rssiAr1Rho * rssiAr1Rho) * eps;
        rssiAr1Seeded[p] = true;
        // Offset regional (Fase 2, ver SimOpts.rssiRegions) — 0 sem regiões cadastradas, sem custo.
        const regionDb = rssiRegions.length ? regionOffsetAt(positions[p], rssiRegions) : 0;
        // Viés corporal direcional (Fase 2, ver SimOpts.bodyBias) — 0 sem o knob. Coexiste com
        // personRssiBiasDb (a sentinela achatada do v4) só se o chamador ligar os dois de
        // propósito; nenhum dos dois desliga o outro automaticamente (decisão do chamador).
        // bodyBiasDb devolve dB POSITIVOS de ATENUAÇÃO → SUBTRAI do RSSI (mesma convenção do
        // obstacleDb abaixo). Corrigido na revisão adversarial de 2026-07-11: o original SOMAVA
        // (sinal invertido — corpo na frente deixava o sinal MAIS forte).
        const bodyDb = bodyBias
          ? bodyBiasDb(
              lastHeading[p],
              { x: rssiOrigin.x - positions[p].x, y: rssiOrigin.y - positions[p].y },
              tagPlacement[p] ?? "peito",
              bodyBias,
            )
          : 0;
        // Oclusão ESTRUTURADA — atenuação de RF (ver SimOpts.obstacles): soma o rfAttenDb de todo
        // obstáculo cujo segmento pessoa→estação cruza. Independente do bloqueio de visão acima
        // (uma parede pode existir sem atenuar RF de verdade, ou vice-versa).
        const obstacleDb = obstacles.length ? rfAttenuationDb(positions[p], rssiOrigin, obstacles) : 0;
        const rssi =
          RSSI_1M_DBM -
          10 * channelN * Math.log10(Math.max(d, MIN_DIST_M)) +
          personRssiBiasDb +
          regionDb -
          bodyDb -
          obstacleDb +
          rssiNoiseAr1[p] * rssiNoiseDb;
        lastRssi[p] = Math.round(rssi);
      }
      readings.push({ mac: MACS[p], rotulo: null, rssi: lastRssi[p] });
    }
    // Âncoras (v4): MESMO canal (channelN), mesmo ruído, mesma cadência das tags de pessoa —
    // distância FIXA à origem (elas não se movem) e SEM o viés corporal (ferragem fixa não tem
    // corpo na frente — é exatamente essa assimetria que o fit não enxerga). Entram como
    // leituras normais: a produção também as vê nas leituras BLE. Offset REGIONAL e atenuação de
    // OBSTÁCULO se aplicam (a âncora também está fisicamente num lugar do prédio, sujeita à mesma
    // condição de rádio local e a paredes entre ela e a estação).
    if (anchors) {
      for (let k = 0; k < anchors.length; k++) {
        if (i % rssiPeriodTicks === 0) {
          const d = Math.hypot(anchors[k].world.x - rssiOrigin.x, anchors[k].world.y - rssiOrigin.y);
          const regionDb = rssiRegions.length ? regionOffsetAt(anchors[k].world, rssiRegions) : 0;
          const obstacleDb = obstacles.length
            ? rfAttenuationDb(anchors[k].world, rssiOrigin, obstacles)
            : 0;
          const rssi =
            RSSI_1M_DBM -
            10 * channelN * Math.log10(Math.max(d, MIN_DIST_M)) -
            obstacleDb +
            regionDb +
            randn(rng) * rssiNoiseDb;
          lastAnchorRssi[k] = Math.round(rssi);
        }
        readings.push({ mac: anchors[k].mac, rotulo: null, rssi: lastAnchorRssi[k] });
      }
    }

    // Ground truth do tick: qual PESSOA (logo, qual tag) está sob cada trackId agora.
    const truthTagByTrack: Record<number, string | null> = {};
    for (let p = 0; p < people; p++) truthTagByTrack[trackIdOfPerson[p]] = p < tagged ? MACS[p] : null;

    ticks.push({ ts: i * TICK_MS, tracks, readings, truthTagByTrack });
    movers.advance();
  }

  const out: SimFusionScenario = { ticks, H: opts.uncalibrated ? null : H, stationPx };
  // Campo ADITIVO — ausente quando o cenário não tem âncoras. Exporta o CADASTRO (com erro de
  // instalação, se anchorPosErrorM), nunca necessariamente a posição real (ver docstring do knob).
  if (anchorsExported) out.anchors = anchorsExported;
  return out;
}
