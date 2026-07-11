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
import { computeHomography, worldToPixel } from "../vision/homography";
import type { Matrix3, Vec2 } from "../vision/homography";
import type { DrawTrack, RawReading } from "./frame";

/** Um tick de 500 ms: o que a câmera+estação ENTREGAM + a verdade de quem está sob cada trackId. */
export type SimTick = {
  ts: number;
  tracks: DrawTrack[];
  readings: RawReading[];
  truthTagByTrack: Record<number, string | null>;
};
/** Tag-âncora FIXA (v4): MAC + posição-mundo VERDADEIRA (metros) — o "gabarito" de calibração. */
export type SimAnchor = { mac: string; world: Vec2 };
export type SimFusionScenario = {
  ticks: SimTick[];
  H: Matrix3 | null;
  stationPx: Vec2;
  /** ADITIVO (v4): posições-verdade das tags-âncora — presente só com SimOpts.anchors. */
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
  /** true (v4) = emite 4 tags-âncora ESTÁTICAS nos cantos de um retângulo 2,5×1,2 m ao redor da
   *  estação (espelha o campo real do dono — span ESTREITO de distâncias, regime anchors-offset
   *  do fitPathLoss), com o MESMO modelo log-distância + mesmo ruído das tags de pessoa. */
  anchors?: boolean;
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
   *  variância (rssiNoiseDb) só adicionando correlação temporal. FONTE: mineração das 6h reais
   *  (`docs/cientifica/relatorio-consolidado-2026-07-10.md` §9.5) mediu autocorrelação de 0,49-0,94
   *  em lag de 2s — invertendo ρ(Δt)=exp(-Δt/τ) pros dois extremos dá τ≈2,8s a τ≈32s (faixa LARGA,
   *  não um número limpo — a mineração cobriu regimes de obstrução bem diferentes por âncora).
   *  Nenhum default aqui: quem usa este knob escolhe o τ explicitamente dentro da faixa medida
   *  (ou fora dela, documentando por quê) — não escondemos a incerteza atrás de uma média. Só
   *  aplica ao RSSI de PESSOA; âncoras seguem IID (limitação declarada, não medida ainda pra elas). */
  rssiNoiseTauS?: number;
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

  // Calibração pela matemática REAL (solver DLT da produção). Falha aqui = geometria fixa quebrada
  // → erro explícito, nunca NaN mudo.
  const calib = computeHomography(FLOOR_PAIRS);
  if (!calib.ok) throw new Error(`simulador: homografia degenerada (${calib.error})`);
  const H = calib.H;
  const stationPx = worldToPixel(H, STATION_WORLD);
  if (!stationPx || stationPx.x < 0 || stationPx.x > 1 || stationPx.y < 0 || stationPx.y > 1)
    throw new Error("simulador: estação projeta fora da imagem — geometria fixa inválida");

  const rng = lcg(seed);
  const movers = createMovers(walk, people, rng);
  // Origem física do RSSI: estação do canto (default) ou junto da câmera (caminho C do frame.ts).
  const rssiOrigin = opts.stationAtCamera ? CAMERA_WORLD : STATION_WORLD;

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

  // Tracker: trackId = índice da pessoa, até um id-switch trocar (e a troca vale dali em diante).
  const trackIdOfPerson: number[] = [];
  for (let p = 0; p < people; p++) trackIdOfPerson.push(p);
  // Sorteio de id-switch por PAR: armado → pode sortear na próxima aproximação (<0,7 m); o sorteio
  // consome a arma; re-arma quando o par se afasta >1,5 m (no máx. 1 sorteio por evento).
  const armed = new Map<string, boolean>();

  const lastRssi: number[] = new Array<number>(tagged).fill(0);
  // Estado do ruído AR(1) por tag de pessoa (ver SimOpts.rssiNoiseTauS) — 0 até a 1ª atualização,
  // igual a um ε~N(0,1) já teria média 0. Só usado quando o knob está presente; ausente = cada
  // "atualização" reatribui `eps` puro (IID), byte-idêntico ao `randn(rng)` inline de sempre.
  const rssiNoiseAr1 = new Array<number>(tagged).fill(0);
  const rssiUpdateDtS = (rssiPeriodTicks * TICK_MS) / 1000;
  const rssiAr1Rho =
    opts.rssiNoiseTauS !== undefined ? Math.exp(-rssiUpdateDtS / opts.rssiNoiseTauS) : null;
  const ticks: SimTick[] = [];

  for (let i = 0; i < steps; i++) {
    const positions = movers.current();

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
        // `randn(rng) * rssiNoiseDb` de sempre. rho!=null → correlaciona com o valor anterior,
        // preservando a MESMA variância (rssiNoiseDb) — só a mineração das 6h reais mostrou que o
        // ruído de campo não é IID amostra-a-amostra, e este é o desvio calibrado por isso.
        const eps = randn(rng);
        rssiNoiseAr1[p] =
          rssiAr1Rho === null
            ? eps
            : rssiAr1Rho * rssiNoiseAr1[p] + Math.sqrt(1 - rssiAr1Rho * rssiAr1Rho) * eps;
        const rssi =
          RSSI_1M_DBM -
          10 * channelN * Math.log10(Math.max(d, MIN_DIST_M)) +
          personRssiBiasDb +
          rssiNoiseAr1[p] * rssiNoiseDb;
        lastRssi[p] = Math.round(rssi);
      }
      readings.push({ mac: MACS[p], rotulo: null, rssi: lastRssi[p] });
    }
    // Âncoras (v4): MESMO canal (channelN), mesmo ruído, mesma cadência das tags de pessoa —
    // distância FIXA à origem (elas não se movem) e SEM o viés corporal (ferragem fixa não tem
    // corpo na frente — é exatamente essa assimetria que o fit não enxerga). Entram como
    // leituras normais: a produção também as vê nas leituras BLE.
    if (anchors) {
      for (let k = 0; k < anchors.length; k++) {
        if (i % rssiPeriodTicks === 0) {
          const d = Math.hypot(anchors[k].world.x - rssiOrigin.x, anchors[k].world.y - rssiOrigin.y);
          const rssi =
            RSSI_1M_DBM -
            10 * channelN * Math.log10(Math.max(d, MIN_DIST_M)) +
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
  if (anchors) out.anchors = anchors; // campo ADITIVO — ausente quando o cenário não tem âncoras
  return out;
}
