// ─────────────────────────────────────────────────────────────────────────────
// eval/gate-recall.mjs — SENSOR DO RECALL QUE O GATE DE MOVIMENTO CUSTA (CA-9 da
// spec-marcacao-tempo-real-v2.md §3, Onda 2). O buraco que fecha, textual:
//
//   • precision.js §gate: "o gate NÃO tem sensor direto de recall do pulo — a defesa
//     é o desenho nunca-cego … Lacuna honesta";
//   • eval/persons-cftv.mjs (cabeçalho): "O eval NÃO roda o gate de movimento";
//   • eval/stationary.mjs: roda o gate REAL, mas mede pessoa PARADA.
//
//   ⇒ PESSOA PEQUENA **ANDANDO** SOB O GATE NÃO TINHA SENSOR NENHUM. É exatamente o
//     sintoma que o dono relatou ("falha em reconhecer pessoas se movimentando").
//
// O QUE ESTE ARQUIVO MEDE (e o que NÃO mede — leia antes de citar qualquer número):
//   MEDE a FUNÇÃO DE DECISÃO do gate — `motion.motionRatio` + `motion.gateDecision`
//   IMPORTADOS de produção, com os knobs REAIS de `precision.js` (motionRatio 0.005,
//   pixelDelta 22, probeMs 6000/2000) e o laço fiel ao `engine.gateAndDispatch`
//   (prevLuma atualiza em TODA rodada gateada, inclusive na pulada; lastInferAt só
//   no despacho; 1ª rodada = baseline). Nenhuma matemática do gate é reimplementada.
//
//   ⚠ PONTO CEGO — CENA SINTÉTICA. As sequências são geradas: a pessoa é um RETÂNGULO
//   RÍGIDO de luma uniforme atravessando um fundo texturado. Isto mede a decisão do
//   gate sobre uma geometria conhecida; NÃO mede o mundo. Fora de cobertura, sem
//   número nenhum aqui: textura/estampa da roupa, movimento INTERNO (braços/pernas —
//   que muda pixel sem transladar o corpo), sombra projetada, mudança de iluminação/
//   AGC/auto-exposição (que acorda o gate inteiro de graça), oclusão, empoeiramento
//   de lente, vibração de câmera, e o próprio D-FINE (se o detector VÊ a pessoa que o
//   gate deixou passar). Direção do viés, por INFERÊNCIA (não medida): o corpo rígido
//   SUBESTIMA a mudança de quem é grande (braço que balança já muda célula) e é
//   ~neutro para quem é pequeno (o membro inteiro cabe em sub-célula). O fechamento
//   com GT REAL (replay MOT com gate ON × OFF, o outro meio de CA-9) continua ABERTO.
//
//   O que ANCORA o sintético no real: `--fidelity` (roda por padrão) renderiza a MESMA
//   cena em 1920×1080, comprime em JPEG e passa pelo caminho de decode de PRODUÇÃO
//   (sharp shrink-on-load → 64×48 fill → greyscale → raw, espelho de engine.decodeThumb),
//   comparando ratio e DECISÃO com o renderizador analítico. É a evidência de que o
//   modelo de cobertura por área aproxima o resize real (lanczos3) + JPEG.
//
// AS TRÊS COLUNAS DO TRADE-OFF (nunca só o lado bom — CLAUDE.md §6):
//   1. RECALL do gate      — rodadas com pessoa presente E em movimento que o gate
//                            DEIXOU o motor observar. Separado em `motion` (o que o
//                            MECANISMO comprou — Regra 11) e `total` (motion+probe,
//                            o que o operador de fato recebe: o probe é o piso
//                            nunca-cego, não mérito do detector de movimento);
//   2. LATÊNCIA de descoberta — do 1º instante visível até a 1ª rodada observada;
//   3. ECONOMIA de CPU     — % de rodadas puladas (cada pulo = uma inferência inteira,
//                            89-97% do custo do frame, medição-âncora de motion.js).
//
// ESTATÍSTICA (CLAUDE.md §6, "13/13 NÃO é 100%"):
//   Toda proporção sai com n e Wilson 95%. E o n do intervalo é o nº de TRIALS
//   INDEPENDENTES, não o de rodadas (Regra 8: rodadas do mesmo trial são a MESMA
//   geometria, ρ≈1 por construção — não são evidência independente). O que o
//   intervalo cobre: a amostragem de FASE sub-célula e de ruído DENTRO do modelo.
//   O que ele NÃO cobre: a distância entre o modelo e o mundo (§PONTO CEGO). Não há
//   intervalo para isso — só o `--fidelity` e, um dia, o replay com GT.
//
// O QUE ELE MEDIU NA 1ª EXECUÇÃO (2026-07-27, gate INTOCADO — é a baseline de §BASELINE):
//   • FAIXA CEGA: pessoa de 25px a 85px (2,3%-7,9% da altura do quadro) andando a 2,8
//     larguras de corpo/s tem recall de MOVIMENTO de 0,0% — 0/16 trials acordaram o gate
//     uma única vez, em QUALQUER das 4 velocidades varridas. O detector enxerga a partir
//     de ~25px; o gate não deixa olhar. Sobra o probe: 16,7% das rodadas (1 em 6), com
//     buracos de até 5000ms sem observar (o interpolador do front expira em 2600ms).
//   • ONDE VIRA: ≥50% de recall só a partir de 120px, ≥95% a partir de 175px (contraste
//     60 luma; com Δluma 35 a curva anda um degrau de tamanho para cima).
//   • CORREÇÃO DE ÂNCORA: a aritmética "16 de 3072 células ⇒ ~8 células ⇒ ~68px cego"
//     SUBESTIMA a faixa cega. Medido: a pegada de uma caixa pequena toca MAIS células do
//     que sua área (bordas parciais), mas o piso de |Δluma|>22 DESCARTA as bordas com
//     cobertura < 0,37 — e o líquido é uma faixa cega que vai até ~85px, não ~68px. A
//     estimativa de que "90px acorda andando uma largura de corpo" NÃO se confirmou:
//     90px não acorda em velocidade nenhuma.
//   • A CÂMERA FOCADA É O PIOR CASO do mecanismo (a que o operador está olhando): a 6 fps
//     o deslocamento POR RODADA cai 6× e 145px despenca de 94,6% para 21,9% de recall.
//
// DETERMINÍSTICO: PRNG semeado, zero Date.now, zero rede, zero modelo ONNX. Roda em ~1-3 s
// (medido). Por isso ENTRA no CI (justificativa e régua de reprovação em §BASELINE).
//
// NÃO MEXE EM KNOB NENHUM: medir vem antes de intervir. Este arquivo é o instrumento.
//
// Uso: node eval/gate-recall.mjs [--no-fidelity] [--trials N] [--update-baseline]
//   --trials N muda a AMOSTRA (fases sub-célula) ⇒ fora do n canônico (16) a régua vira
//   INFORMATIVA. O CI roda sem flag. --update-baseline só IMPRIME o bloco: quem edita a
//   régua é humano (sensor que reescreve a própria baseline é máquina de falso-OK).
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const motion = require(path.join(ROOT, "server", "analysis", "motion.js"));
const { PRECISION } = require(path.join(ROOT, "server", "analysis", "precision.js"));

const { motionRatio, gateDecision, THUMB_W, THUMB_H } = motion;
const CELLS = THUMB_W * THUMB_H;
const MOTION_THR = PRECISION.gate.motionRatio;
const PIXEL_DELTA = PRECISION.gate.pixelDelta;

// ── Geometria da cena (declarada — cada constante é uma hipótese explícita) ───
// Quadro de referência: 1080p (o que as câmeras do CD entregam; o thumbnail é
// fit:"fill", então o que importa é a FRAÇÃO do quadro — a coluna "% da altura"
// das tabelas é a forma portável do mesmo número).
const FRAME_W = 1920;
const FRAME_H = 1080;
// Razão largura/altura da bbox de pedestre EM PÉ. 0.41 = meio da faixa observada em
// MOT/COCO (~0.35-0.45). É a constante mais sensível do modelo: o gate conta CÉLULAS,
// e a célula é 30×22.5 px — a LARGURA é que some primeiro (M7 da spec: o squash
// encolhe a horizontal 3× e a vertical 1,7×).
const ASPECT = 0.41;
// Contraste pessoa×fundo em níveis de luma (0..255). 60 = roupa escura em piso claro
// de CD, generoso de propósito: o critério do gate é |Δluma| > pixelDelta(22) POR
// CÉLULA, então contraste ALTO é o caso FAVORÁVEL ao gate. Tabela §4 varre o resto.
const CONTRAST = 60;
const BG_BASE = 120; // luma média do piso
const BG_TEXTURE = 12; // σ da textura ESTÁTICA do fundo, no nível da CÉLULA (pós-downsample)
// σ do ruído por rodada, no nível da CÉLULA. Note a escala: uma célula é a média de
// ~675 px, então ruído de sensor por pixel praticamente DESAPARECE aqui (√675 ≈ 26×).
// O que sobra em campo é outra coisa (AGC, flicker, folha/empilhadeira ao fundo) e é
// justamente o que faz o gate acordar de graça — varrido na tabela §5.
const NOISE = 1.0;

// Velocidade LATERAL aparente em LARGURAS DE CORPO POR SEGUNDO. Escala-livre e
// comparável entre cadências (o deslocamento POR RODADA — que é o que o gate vê —
// sai daqui × roundMs). Âncora: caminhada de 1,4 m/s com ombro de ~0,5 m ≈ 2,8 lc/s
// atravessando o quadro. Quem anda NA DIREÇÃO da câmera tem velocidade lateral ≈ 0 —
// é o caso 0.25, e ele NÃO tem conserto por limiar (não há o que detectar).
const SPEEDS = [
  { bws: 0.25, label: "0,25 lc/s (quase frontal)" },
  { bws: 0.7, label: "0,70 lc/s (lento)" },
  { bws: 1.4, label: "1,40 lc/s (moderado)" },
  { bws: 2.8, label: "2,80 lc/s (caminhada)" },
];
const WALK = 2.8; // a velocidade de referência das réguas (caminhada normal)

// Alturas aparentes varridas (px @1080p). Piso 25 px = o limite do DETECTOR a 640
// (README do motor §Dimensionamento + spec-marcacao-tempo-real-v2 §1) — abaixo disso a
// pessoa não existe nem se o gate deixar passar. Teto 320 px = pessoa perto da câmera.
const DETECTOR_FLOOR_PX = 25;
const HEIGHTS = [25, 40, 55, 70, 85, 100, 120, 145, 175, 210, 260, 320];

// Cadências REAIS do engine.js (FPS/FPS_LINE/FPS_FOCUS + probe do painel).
const CADENCES = [
  { key: "normal", label: "câmera normal 1 fps", roundMs: 1000, probeMs: PRECISION.gate.probeMs },
  { key: "linha", label: "câmera de linha 2 fps", roundMs: 500, probeMs: PRECISION.gate.probeMs },
  { key: "focada", label: "câmera FOCADA 6 fps", roundMs: 167, probeMs: PRECISION.gate.probeFocusMs },
];
const MAIN = CADENCES[0]; // a varredura principal roda no default de deploy (1 fps)

const MAX_ROUNDS = 60; // teto de rodadas por trial (60 s a 1 fps) — censura declarada
const WARMUP = 3; // rodadas de cena VAZIA antes da entrada (consomem o baseline)

// ── PRNG determinístico + Gaussiana tabelada ─────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Tabela de normais (Box-Muller 1×, consultada por índice): o custo do ruído cai de
// log/sqrt por célula para uma indexação. Aproximação DECLARADA — 8192 níveis.
const NORMALS = (() => {
  const r = mulberry32(0x5eed);
  const t = new Float32Array(8192);
  for (let i = 0; i < t.length; i++) {
    const u = Math.max(1e-9, r());
    t[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  return t;
})();

/** Intervalo de Wilson 95% (CLAUDE.md: "13/13 NÃO é 100%"). Retorna [lo,hi] em 0..1.
 *  Duplicação DECLARADA de eval/reid.mjs:118 — aquele módulo executa main() no import
 *  (e chama process.exit), então não é importável de um harness. Mesma fórmula. */
export function wilsonInterval(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(center - half) / denom, (center + half) / denom];
}

// ── Renderizador ANALÍTICO do thumbnail (cobertura por ÁREA) ─────────────────
// Modelo: cada célula do 64×48 é a média da área do quadro que ela cobre — a caixa
// da pessoa entra proporcionalmente à FRAÇÃO da célula que ela ocupa. É o box-filter
// ideal; o resize real (lanczos3 + shrink-on-load do JPEG) difere, e a diferença é
// MEDIDA no §fidelity em vez de assumida.
/**
 * @param {Uint8Array} out         destino (CELLS)
 * @param {Float32Array} bg        fundo estático por célula (CELLS)
 * @param {{x:number,y:number,w:number,h:number}|null} rect  pessoa em coords normalizadas
 * @param {number} personLuma
 * @param {number} noiseSigma
 * @param {()=>number} rng
 */
function renderThumb(out, bg, rect, personLuma, noiseSigma, rng) {
  for (let i = 0; i < CELLS; i++) {
    const n = noiseSigma > 0 ? NORMALS[(rng() * 8192) | 0] * noiseSigma : 0;
    const v = bg[i] + n;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  if (!rect) return;
  const x0 = Math.max(0, Math.floor(rect.x * THUMB_W));
  const x1 = Math.min(THUMB_W, Math.ceil((rect.x + rect.w) * THUMB_W));
  const y0 = Math.max(0, Math.floor(rect.y * THUMB_H));
  const y1 = Math.min(THUMB_H, Math.ceil((rect.y + rect.h) * THUMB_H));
  for (let cy = y0; cy < y1; cy++) {
    const oy =
      Math.max(0, Math.min(rect.y + rect.h, (cy + 1) / THUMB_H) - Math.max(rect.y, cy / THUMB_H)) *
      THUMB_H;
    if (oy <= 0) continue;
    for (let cx = x0; cx < x1; cx++) {
      const ox =
        Math.max(0, Math.min(rect.x + rect.w, (cx + 1) / THUMB_W) - Math.max(rect.x, cx / THUMB_W)) *
        THUMB_W;
      if (ox <= 0) continue;
      const cov = ox * oy;
      const i = cy * THUMB_W + cx;
      const v = out[i] * (1 - cov) + personLuma * cov;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
}

/** Fundo estático por célula (textura do piso) — mesma seed ⇒ mesmo fundo. */
function makeBackground(seed) {
  const rng = mulberry32(seed);
  const bg = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++) bg[i] = BG_BASE + NORMALS[(rng() * 8192) | 0] * BG_TEXTURE;
  return bg;
}

// ── UM TRIAL: uma travessia, laço FIEL ao engine.gateAndDispatch ──────────────
// Fidelidade que importa (engine.js:535-577):
//   • prevLuma := thumbnail de TODA rodada gateada — inclusive a PULADA (por isso o
//     que o gate enxerga é o deslocamento POR RODADA, não desde a última inferência);
//   • hasPrev=false na 1ª rodada → baseline (infer);
//   • lastInferAt := now SÓ quando despacha → sinceMs é a base do piso de probe;
//   • sem máscara de ignore (cena sem hotspot) e sem fail-open (aqui o decode não falha).
/**
 * @returns {{rounds:Array<{gt:boolean,infer:boolean,reason:string,ratio:number}>}}
 */
function runTrial({ heightPx, bws, roundMs, probeMs, contrast, noiseSigma, seed }) {
  const rng = mulberry32(seed);
  const bg = makeBackground(seed ^ 0x9e3779b9);
  const hN = heightPx / FRAME_H;
  const wN = (heightPx * ASPECT) / FRAME_W;
  const stepN = ((bws * heightPx * ASPECT) / FRAME_W) * (roundMs / 1000); // deslocamento/rodada
  const footY = 0.35 + rng() * 0.4; // altura do pé no quadro (varia por trial)
  const yN = Math.max(0, Math.min(1 - hN, footY - hN));
  const phase = rng(); // FASE sub-célula da entrada: o que decide se o corpo cruza fronteira
  let x = -wN - phase * stepN;

  const cur = new Uint8Array(CELLS);
  let prev = null;
  let lastInferAt = 0;
  const rounds = [];
  const total = WARMUP + MAX_ROUNDS;
  for (let i = 0; i < total; i++) {
    const now = (i + 1) * roundMs;
    const active = i >= WARMUP;
    if (active && i > WARMUP) x += stepN;
    // GT: "presente e em movimento" exige o corpo majoritariamente DENTRO do quadro —
    // 5% de ombro na borda não é pessoa nem para o detector. Censura declarada.
    const visible =
      active && Math.max(0, Math.min(1, x + wN) - Math.max(0, x)) >= 0.5 * wN && x < 1;
    const rect = visible ? { x, y: yN, w: wN, h: hN } : null;
    renderThumb(cur, bg, rect, BG_BASE + contrast, noiseSigma, rng);
    const hasPrev = prev !== null;
    const m = hasPrev ? motionRatio(cur, prev, null, PIXEL_DELTA) : { ratio: 0 };
    const dec = gateDecision({
      ratio: m.ratio,
      sinceMs: now - lastInferAt,
      threshold: MOTION_THR,
      probeMs,
      hasPrev,
    });
    if (prev === null) prev = new Uint8Array(CELLS);
    prev.set(cur);
    if (dec.infer) lastInferAt = now;
    // GT de MOVIMENTO: visível nesta rodada E deslocada em relação à anterior. A 1ª
    // rodada visível conta (entrar em quadro É mudança) e é onde a descoberta começa.
    rounds.push({ gt: visible && stepN > 0, infer: dec.infer, reason: dec.reason, ratio: m.ratio });
    if (x > 1) break; // saiu do quadro
  }
  return { rounds, roundMs };
}

// ── Agregação de uma CÉLULA da varredura (nº de trials = n independente) ──────
function measureCell(cfg, trials) {
  let gtRounds = 0;
  let obs = 0;
  let byMotion = 0;
  let allRounds = 0;
  let skipped = 0;
  const blindMs = [];
  const discoveryMs = [];
  let trialsWithMotion = 0;
  let trialsObserved = 0;
  for (let t = 0; t < trials; t++) {
    const { rounds, roundMs } = runTrial({ ...cfg, seed: 0x1000 + t * 7919 });
    let streak = 0;
    let worst = 0;
    let firstGt = -1;
    let firstObs = -1;
    let anyMotion = false;
    rounds.forEach((r, i) => {
      allRounds += 1;
      if (!r.infer) skipped += 1;
      if (!r.gt) return;
      if (firstGt < 0) firstGt = i;
      gtRounds += 1;
      if (r.infer) {
        obs += 1;
        if (firstObs < 0) firstObs = i;
        if (r.reason === "motion") {
          byMotion += 1;
          anyMotion = true;
        }
        streak = 0;
      } else {
        streak += 1;
        if (streak > worst) worst = streak;
      }
    });
    if (firstGt >= 0) {
      blindMs.push(worst * roundMs);
      // Latência de descoberta CENSURADA: nunca observado ⇒ conta o trial inteiro
      // (limite INFERIOR do valor real, não o valor).
      discoveryMs.push(((firstObs >= 0 ? firstObs : rounds.length - 1) - firstGt) * roundMs);
      if (firstObs >= 0) trialsObserved += 1;
    }
    if (anyMotion) trialsWithMotion += 1;
  }
  const pMotion = gtRounds ? byMotion / gtRounds : 0;
  const pObs = gtRounds ? obs / gtRounds : 0;
  // n do Wilson = TRIALS (Regra 8): rodadas do mesmo trial repetem a MESMA geometria.
  const wMotion = wilsonInterval(Math.round(pMotion * trials), trials);
  const wObs = wilsonInterval(Math.round(pObs * trials), trials);
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  return {
    gtRounds,
    trials,
    recallMotion: pMotion,
    recallMotionCI: wMotion,
    recallObs: pObs,
    recallObsCI: wObs,
    trialsWithMotion,
    trialsObserved,
    skipPct: allRounds ? skipped / allRounds : 0,
    blindMedianMs: med(blindMs),
    blindMaxMs: blindMs.length ? Math.max(...blindMs) : 0,
    discoveryMedianMs: med(discoveryMs),
    discoveryMaxMs: discoveryMs.length ? Math.max(...discoveryMs) : 0,
  };
}

// ── Ancoragem no caminho REAL de decode (§fidelity) ───────────────────────────
// Espelho de engine.decodeThumb (engine.js:403-415 — não é exportado; são 5 linhas de
// I/O, e a MATEMÁTICA do gate segue importada). O quadro 1080p é construído a partir
// das MESMAS células de fundo (upsample nearest) para isolar o que se quer medir: o
// KERNEL do resize (lanczos3/shrink-on-load) + JPEG, não o modelo de textura.
async function decodeThumbLikeProduction(jpeg) {
  const { data, info } = await sharp(jpeg)
    .resize(THUMB_W, THUMB_H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels || 1;
  if (ch === 1 && data.length === CELLS) return data;
  const out = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) out[i] = data[i * ch];
  return out;
}

function renderFullFrame(bg, rect, personLuma) {
  const px = new Uint8Array(FRAME_W * FRAME_H);
  for (let y = 0; y < FRAME_H; y++) {
    const cy = Math.min(THUMB_H - 1, ((y / FRAME_H) * THUMB_H) | 0);
    for (let x = 0; x < FRAME_W; x++) {
      const cx = Math.min(THUMB_W - 1, ((x / FRAME_W) * THUMB_W) | 0);
      const v = bg[cy * THUMB_W + cx];
      px[y * FRAME_W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  if (rect) {
    const x0 = Math.max(0, Math.round(rect.x * FRAME_W));
    const x1 = Math.min(FRAME_W, Math.round((rect.x + rect.w) * FRAME_W));
    const y0 = Math.max(0, Math.round(rect.y * FRAME_H));
    const y1 = Math.min(FRAME_H, Math.round((rect.y + rect.h) * FRAME_H));
    const l = Math.max(0, Math.min(255, Math.round(personLuma)));
    for (let y = y0; y < y1; y++) px.fill(l, y * FRAME_W + x0, y * FRAME_W + x1);
  }
  return px;
}

const toJpeg = (px) =>
  sharp(Buffer.from(px), { raw: { width: FRAME_W, height: FRAME_H, channels: 1 } })
    .jpeg({ quality: 80 })
    .toBuffer();

/**
 * Para cada caso: renderiza duas rodadas consecutivas (pessoa deslocada de stepN) nos
 * DOIS caminhos e compara ratio + DECISÃO do gate. Sem ruído por rodada: o objeto da
 * comparação é o kernel do resize, e ruído injetaria variância alheia à pergunta.
 */
async function runFidelity(cases) {
  const rows = [];
  for (const c of cases) {
    const bg = makeBackground(0xbeef);
    const hN = c.heightPx / FRAME_H;
    const wN = (c.heightPx * ASPECT) / FRAME_W;
    const stepN = ((c.bws * c.heightPx * ASPECT) / FRAME_W) * (MAIN.roundMs / 1000);
    const yN = 0.5 - hN;
    const rA = { x: 0.4, y: yN, w: wN, h: hN };
    const rB = { x: 0.4 + stepN, y: yN, w: wN, h: hN };
    const luma = BG_BASE + CONTRAST;
    const a = new Uint8Array(CELLS);
    const b = new Uint8Array(CELLS);
    renderThumb(a, bg, rA, luma, 0, () => 0.5);
    renderThumb(b, bg, rB, luma, 0, () => 0.5);
    const synth = motionRatio(b, a, null, PIXEL_DELTA).ratio;
    const [ja, jb] = await Promise.all([
      toJpeg(renderFullFrame(bg, rA, luma)),
      toJpeg(renderFullFrame(bg, rB, luma)),
    ]);
    const [ta, tb] = await Promise.all([decodeThumbLikeProduction(ja), decodeThumbLikeProduction(jb)]);
    const real = motionRatio(tb, ta, null, PIXEL_DELTA).ratio;
    rows.push({
      ...c,
      synth,
      real,
      synthInfer: synth >= MOTION_THR,
      realInfer: real >= MOTION_THR,
    });
  }
  return rows;
}

// ── BASELINE / RÉGUA DE REPROVAÇÃO ───────────────────────────────────────────
// POR QUE ENTRA NO CI: é o único sensor que olha "pessoa pequena ANDANDO sob o gate".
// Sem ele, a próxima mexida em `motionRatio`/`pixelDelta`/`probeMs` (Onda 2 da spec vai
// mexer) é cega — e o custo de errar é o sintoma que o dono já relatou. Custo: ~10 s,
// zero rede, zero modelo, determinístico (PRNG semeado) — não é fonte de flake.
//
// O QUE REPROVA (regressão RELATIVA — nenhum número de aprovação foi inventado; a
// baseline abaixo é o ESTADO MEDIDO em 2026-07-27, não um alvo):
//   1. `blindCeilingPx` — a MAIOR altura varrida com recall de MOVIMENTO 0% em
//      caminhada — não pode SUBIR (mais gente ficaria invisível ao mecanismo);
//   2. recall de movimento nas alturas-âncora não pode CAIR mais que TOL_PP;
//   3. `maxBlindMs` a 1 fps não pode SUBIR (é o buraco que apaga a caixa na tela).
// O que NÃO reprova (e por quê): a ECONOMIA de CPU. Ela é o outro lado do MESMO knob;
// cair é DECISÃO de produto (recall × câmeras por core), e um gate que reprova os dois
// lados trava qualquer escolha. Sai como delta impresso + AVISO acima de WARN_PP.
const TOL_PP = 1.0;
const WARN_PP = 5.0;
// "Cego" com folga em vez de recall EXATAMENTE 0: com n grande aparece 1 trial em que a
// fase sub-célula favorável arranca uma única rodada (85px dá 0,1% com 48 trials). Um
// teto definido por `=== 0` mudaria de degrau conforme o nº de trials — o que faria a
// régua medir o TAMANHO DA AMOSTRA, não o gate. 1% é "não se pode contar com isso".
const BLIND_EPS = 0.01;
// n CANÔNICO da baseline. `--trials N` muda a AMOSTRA (outras fases sub-célula), logo
// muda os pontos — a 48 trials o 145px sai 93,4% em vez de 94,6%. Isso não é regressão,
// é amostragem: fora do n canônico a régua vira INFORMATIVA (imprime, não reprova). O CI
// roda sem flag, então o caminho gateado é sempre este; o flag é para exploração.
const BASELINE_TRIALS = 16;
const BASELINE = {
  measuredAt: "2026-07-27",
  note: "estado MEDIDO do gate (motionRatio 0.005 · pixelDelta 22 · probe 6000ms) — NÃO é alvo",
  blindCeilingPx: 85, // maior altura varrida com 0,0% de recall de movimento em caminhada
  maxBlindMs: 5000, // maior sequência sem observar com pessoa andando (1 fps, probe 6000)
  recallMotionAtWalk: { 40: 0, 70: 0, 100: 0.3184, 145: 0.9457, 210: 1, 320: 1 },
  skipPctAt70Walk: 0.8298, // o OUTRO lado: rodadas puladas na cena de 70px andando (só AVISA)
};

// ── Formatação ────────────────────────────────────────────────────────────────
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const ci = ([lo, hi]) => `[${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}]`;
const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);

export async function runGateRecall(opts = {}) {
  const trials = opts.trials ?? 16;
  const withFidelity = opts.fidelity !== false;
  const t0 = Date.now();
  console.log(`\n[eval/gate-recall] RECALL DO GATE DE MOVIMENTO — pessoa ANDANDO (cena SINTÉTICA)`);
  console.log(
    `  gate REAL: motion.motionRatio + motion.gateDecision · knobs de precision.js: ` +
      `motionRatio ${MOTION_THR} (= ${Math.ceil(MOTION_THR * CELLS)} de ${CELLS} células) · ` +
      `pixelDelta ${PIXEL_DELTA} · probe ${PRECISION.gate.probeMs}/${PRECISION.gate.probeFocusMs}ms`,
  );
  console.log(
    `  cena: pessoa RÍGIDA ${ASPECT} (l/a) · contraste ${CONTRAST} luma · fundo ${BG_BASE}±${BG_TEXTURE} · ` +
      `ruído/rodada σ${NOISE} · quadro ${FRAME_W}×${FRAME_H} · ${trials} trials/célula (fase e ruído variam)`,
  );
  console.log(
    `  ⚠ PONTO CEGO: cena SINTÉTICA — mede a FUNÇÃO DE DECISÃO do gate, não o mundo. Sem cobertura:\n` +
      `    movimento interno (braços/pernas), textura de roupa, sombra, iluminação variável/AGC,\n` +
      `    oclusão, vibração de câmera — e se o DETECTOR veria a pessoa que o gate deixou passar.`,
  );

  // ── §1 CURVA PRINCIPAL: recall × tamanho aparente × velocidade (1 fps) ──────
  console.log(`\n─ §1 RECALL DO MECANISMO (rodadas acordadas por MOVIMENTO) — ${MAIN.label}, probe ${MAIN.probeMs}ms`);
  console.log(`  a pergunta: de todas as rodadas com pessoa PRESENTE e ANDANDO, quantas o gate deixou observar?\n`);
  const grid = new Map();
  const head = SPEEDS.map((s) => padS(s.bws.toFixed(2), 13)).join("");
  console.log(`  ${pad("altura", 9)}${pad("% quadro", 10)}${pad("céls", 7)}${head}   ← lc/s (larguras de corpo por segundo)`);
  for (const heightPx of HEIGHTS) {
    const cellsOcupadas = ((heightPx / FRAME_H) * THUMB_H * ((heightPx * ASPECT) / FRAME_W) * THUMB_W).toFixed(1);
    let line = `  ${pad(heightPx + "px", 9)}${pad(((heightPx / FRAME_H) * 100).toFixed(1) + "%", 10)}${pad(cellsOcupadas, 7)}`;
    for (const sp of SPEEDS) {
      const cfg = {
        heightPx,
        bws: sp.bws,
        roundMs: MAIN.roundMs,
        probeMs: MAIN.probeMs,
        contrast: CONTRAST,
        noiseSigma: NOISE,
      };
      const m = measureCell(cfg, trials);
      grid.set(`${heightPx}|${sp.bws}`, m);
      line += padS(pct(m.recallMotion), 13);
    }
    console.log(line);
  }
  const atWalk = (h) => grid.get(`${h}|${WALK}`);
  console.log(
    `\n  n por célula: ${trials} trials independentes (fase sub-célula + ruído) · ` +
      `${atWalk(HEIGHTS[0]).gtRounds} rodadas com GT na coluna de caminhada da 1ª linha.`,
  );
  console.log(`  Wilson 95% (caminhada, n=${trials} TRIALS — NÃO rodadas; Regra 8):`);
  for (const h of [40, 70, 100, 145, 210, 320]) {
    const m = atWalk(h);
    if (m) console.log(`    ${padS(h + "px", 7)}: ${padS(pct(m.recallMotion), 7)}  Wilson ${ci(m.recallMotionCI)}%  · trials que acordaram o gate ao menos 1×: ${m.trialsWithMotion}/${trials}`);
  }

  // ── §2 O TRADE-OFF INTEIRO na velocidade de caminhada ───────────────────────
  console.log(`\n─ §2 O TRADE-OFF INTEIRO (caminhada ${WALK} lc/s, ${MAIN.label}) — os três lados, lado a lado`);
  console.log(
    `  ${pad("altura", 9)}${padS("recall MOV", 12)}${padS("recall TOTAL", 14)}${padS("(+probe)", 10)}` +
      `${padS("buraco méd", 12)}${padS("buraco máx", 12)}${padS("descoberta méd/máx", 20)}${padS("CPU poupada", 13)}`,
  );
  for (const h of HEIGHTS) {
    const m = atWalk(h);
    console.log(
      `  ${pad(h + "px", 9)}${padS(pct(m.recallMotion), 12)}${padS(pct(m.recallObs), 14)}` +
        `${padS(pct(m.recallObs - m.recallMotion), 10)}${padS(m.blindMedianMs + "ms", 12)}` +
        `${padS(m.blindMaxMs + "ms", 12)}${padS(`${m.discoveryMedianMs}/${m.discoveryMaxMs}ms`, 20)}${padS(pct(m.skipPct), 13)}`,
    );
  }
  console.log(
    `  "recall TOTAL" inclui o PROBE (piso nunca-cego). A coluna (+probe) é o que o DESENHO salva,\n` +
      `  não o que o detector de movimento comprou (Regra 11: mede-se o delta do MECANISMO, não o agregado).\n` +
      `  "buraco" = maior sequência contínua de rodadas puladas com a pessoa andando em quadro.\n` +
      `  Referência do front: o interpolador expira a caixa em 2600ms (config.ts) — buraco maior = caixa SOME.\n` +
      `  ⚠ "CPU poupada" é DESTA cena (uma pessoa atravessando o quadro quase o tempo todo) — o PIOR caso\n` +
      `  para a economia. Em cena VAZIA e limpa o ratio é 0 e o gate pula qualquer que seja o limiar (§5 mostra\n` +
      `  o que ruído de cena faz com isso). Não extrapole esta coluna para "economia do deploy".`,
  );

  // ── §3 CADÊNCIA: a focada é o pior caso do gate ────────────────────────────
  console.log(`\n─ §3 CADÊNCIA (mesma pessoa, mesma velocidade FÍSICA — muda só o intervalo entre rodadas)`);
  console.log(`  ${pad("altura", 9)}${CADENCES.map((c) => padS(c.label, 24)).join("")}`);
  const cadCells = new Map();
  for (const h of [70, 100, 145, 210, 320]) {
    let line = `  ${pad(h + "px", 9)}`;
    for (const c of CADENCES) {
      const m = measureCell(
        { heightPx: h, bws: WALK, roundMs: c.roundMs, probeMs: c.probeMs, contrast: CONTRAST, noiseSigma: NOISE },
        trials,
      );
      cadCells.set(`${h}|${c.key}`, m);
      line += padS(`${pct(m.recallMotion)} (buraco ${m.blindMaxMs}ms)`, 24);
    }
    console.log(line);
  }
  console.log(
    `  O gate compara rodadas CONSECUTIVAS: mais fps = MENOS deslocamento por rodada = menos célula mudada.\n` +
      `  A câmera FOCADA (a que o operador está OLHANDO) é o pior caso do mecanismo — só o probe de 2s a socorre.`,
  );

  // ── §4 CONTRASTE: o critério é |Δluma| > 22 POR CÉLULA ─────────────────────
  console.log(`\n─ §4 CONTRASTE pessoa×fundo (caminhada, ${MAIN.label}) — pixelDelta ${PIXEL_DELTA} é um piso ABSOLUTO de luma`);
  const CONTRASTS = [20, 35, 50, 60, 90];
  console.log(`  ${pad("altura", 9)}${CONTRASTS.map((c) => padS(`Δluma ${c}`, 11)).join("")}`);
  for (const h of [100, 145, 210, 320]) {
    let line = `  ${pad(h + "px", 9)}`;
    for (const c of CONTRASTS) {
      const m = measureCell(
        { heightPx: h, bws: WALK, roundMs: MAIN.roundMs, probeMs: MAIN.probeMs, contrast: c, noiseSigma: NOISE },
        trials,
      );
      line += padS(pct(m.recallMotion), 11);
    }
    console.log(line);
  }
  console.log(
    `  Uma célula só conta se |Δluma| > ${PIXEL_DELTA}: com cobertura parcial o delta é cov×Δluma, então\n` +
      `  Δluma ${20} exige cobertura > ${(PIXEL_DELTA / 20).toFixed(2)} da célula (impossível na borda) e Δluma 60 exige ${(PIXEL_DELTA / 60).toFixed(2)}.\n` +
      `  Roupa cinza em piso cinza é INVISÍVEL para o gate em qualquer tamanho abaixo do teto de área.`,
  );

  // ── §5 RUÍDO: quando o gate deixa de economizar ────────────────────────────
  console.log(`\n─ §5 RUÍDO DE CENA (σ por CÉLULA, pós-downsample — AGC/flicker/fundo vivo), pessoa de 70px andando`);
  console.log(`  ${pad("σ ruído", 10)}${padS("recall MOV", 12)}${padS("CPU poupada", 14)}`);
  for (const s of [0, 1, 2, 4, 5, 6, 7, 8, 12]) {
    const m = measureCell(
      { heightPx: 70, bws: WALK, roundMs: MAIN.roundMs, probeMs: MAIN.probeMs, contrast: CONTRAST, noiseSigma: s },
      trials,
    );
    console.log(`  ${pad("σ" + s, 10)}${padS(pct(m.recallMotion), 12)}${padS(pct(m.skipPct), 14)}`);
  }
  console.log(
    `  Leitura: a cegueira do gate é PROPRIEDADE DA CENA LIMPA. Cena "viva" acorda o gate por ruído —\n` +
      `  a pessoa passa a ser observada de graça, e a economia de CPU (a razão de existir do gate) EVAPORA.\n` +
      `  Os dois lados são o MESMO knob: não existe ajuste que compre recall sem pagar em inferência.`,
  );

  // ── §6 ANCORAGEM no caminho real de decode ─────────────────────────────────
  let fidelity = null;
  if (withFidelity) {
    console.log(`\n─ §6 ANCORAGEM (--fidelity): renderizador analítico × caminho de decode de PRODUÇÃO`);
    console.log(`  mesma cena em ${FRAME_W}×${FRAME_H} → JPEG q80 → sharp resize ${THUMB_W}×${THUMB_H} fill → greyscale → raw`);
    const cases = [];
    // Alturas escolhidas em volta da FRONTEIRA de decisão (85-120px): é onde uma
    // divergência de kernel viraria decisão diferente — medir longe da fronteira só
    // produziria concordância barata.
    for (const h of [55, 85, 100, 120, 175, 260]) for (const bws of [0.7, 2.8]) cases.push({ heightPx: h, bws });
    fidelity = await runFidelity(cases);
    console.log(`  ${pad("altura", 9)}${pad("lc/s", 7)}${padS("ratio analítico", 17)}${padS("ratio real", 12)}${padS("decisão", 22)}`);
    let agree = 0;
    for (const r of fidelity) {
      if (r.synthInfer === r.realInfer) agree += 1;
      console.log(
        `  ${pad(r.heightPx + "px", 9)}${pad(r.bws.toFixed(2), 7)}${padS(r.synth.toFixed(5), 17)}${padS(r.real.toFixed(5), 12)}` +
          `${padS(`${r.synthInfer ? "INFER" : "pula"} × ${r.realInfer ? "INFER" : "pula"}${r.synthInfer === r.realInfer ? "" : "  ← DIVERGE"}`, 22)}`,
      );
    }
    const [lo, hi] = wilsonInterval(agree, fidelity.length);
    console.log(
      `  concordância de DECISÃO: ${agree}/${fidelity.length} = ${pct(agree / fidelity.length)} ` +
        `(Wilson 95% ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%) — n pequeno, é âncora, não prova.`,
    );
  }

  // ── §7 VEREDITO + RÉGUA (regressão relativa contra a baseline MEDIDA) ──────
  const fails = [];
  const warns = [];
  let blindCeiling = 0;
  for (const h of HEIGHTS) if (atWalk(h).recallMotion < BLIND_EPS) blindCeiling = Math.max(blindCeiling, h);
  const maxBlind = Math.max(...HEIGHTS.map((h) => atWalk(h).blindMaxMs));
  const firstAbove = (p) => HEIGHTS.find((h) => atWalk(h).recallMotion >= p);
  console.log(`\n─ §7 VEREDITO (a resposta com número à pergunta "quanto recall o gate custa, e em que faixa")`);
  const ceil = atWalk(blindCeiling);
  console.log(
    `  FAIXA CEGA MEDIDA: pessoa de ${DETECTOR_FLOOR_PX}px a ${blindCeiling}px de altura andando a ${WALK} lc/s tem recall de\n` +
      `  MOVIMENTO abaixo de ${pct(BLIND_EPS)} (no topo da faixa, ${blindCeiling}px: ${pct(ceil.recallMotion)} — ` +
      `${ceil.trialsWithMotion}/${trials} trials acordaram o gate ao menos 1×).\n` +
      `  Nessa faixa o DETECTOR enxerga (piso ~${DETECTOR_FLOOR_PX}px a 640, README do motor) e o GATE não deixa\n` +
      `  olhar: o motor só a observa no PROBE.`,
  );
  console.log(
    `  ONDE VIRA: ≥50% de recall a partir de ${firstAbove(0.5)}px · ≥95% a partir de ${firstAbove(0.95)}px ` +
      `(contraste ${CONTRAST}; com Δluma 35 a mesma curva anda ~1 degrau de tamanho para cima — §4).`,
  );
  console.log(
    `  O QUE SOBRA NA FAIXA CEGA: só o piso de probe — ${pct(atWalk(70).recallObs)} das rodadas (1 a cada ` +
      `${Math.round(MAIN.probeMs / MAIN.roundMs)}), buraco de até ${atWalk(70).blindMaxMs}ms sem observar, ` +
      `descoberta mediana ${atWalk(70).discoveryMedianMs}ms.\n` +
      `  O QUE ISSO COMPRA: ${pct(atWalk(70).skipPct)} das rodadas puladas nessa cena — cada pulo é uma inferência\n` +
      `  inteira (89-97% do custo do frame). O gate NÃO está quebrado: está fazendo exatamente o que foi pedido.\n` +
      `  A pergunta que este sensor devolve ao produto é se o preço (a faixa cega) é o que se quer pagar.`,
  );
  const canonical = trials === BASELINE_TRIALS;
  console.log(
    `\n─ §8 RÉGUA — regressão relativa contra a baseline medida em ${BASELINE.measuredAt}` +
      (canonical ? "" : ` (n=${trials} ≠ n canônico ${BASELINE_TRIALS} → INFORMATIVA, não reprova)`),
  );
  console.log(
    `  faixa CEGA ao mecanismo (recall de movimento < ${pct(BLIND_EPS)} em caminhada): até ${blindCeiling}px ` +
      `(baseline ${BASELINE.blindCeilingPx}px) — o detector enxerga a partir de ~${DETECTOR_FLOOR_PX}px`,
  );
  console.log(`  maior buraco de observação a 1 fps: ${maxBlind}ms (baseline ${BASELINE.maxBlindMs}ms)`);
  if (blindCeiling > BASELINE.blindCeilingPx)
    fails.push(`faixa cega CRESCEU: ${blindCeiling}px > ${BASELINE.blindCeilingPx}px da baseline`);
  if (maxBlind > BASELINE.maxBlindMs)
    fails.push(`buraco de observação CRESCEU: ${maxBlind}ms > ${BASELINE.maxBlindMs}ms da baseline`);
  for (const [hStr, base] of Object.entries(BASELINE.recallMotionAtWalk)) {
    const m = atWalk(Number(hStr));
    if (!m) continue;
    const delta = (m.recallMotion - base) * 100;
    const flag = delta < -TOL_PP ? "✗" : Math.abs(delta) > TOL_PP ? "↑" : "·";
    console.log(
      `  ${flag} recall MOV @${padS(hStr + "px", 6)}: ${padS(pct(m.recallMotion), 7)} (baseline ${pct(base)}, Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp)`,
    );
    if (delta < -TOL_PP) fails.push(`recall de movimento CAIU em ${hStr}px: ${pct(m.recallMotion)} < baseline ${pct(base)} − ${TOL_PP}pp`);
    else if (delta > TOL_PP) warns.push(`recall de movimento SUBIU em ${hStr}px (${delta.toFixed(1)}pp) — atualize a baseline no ARQUIVO e declare o custo de CPU`);
  }
  const cpuNow = atWalk(70).skipPct;
  const cpuDelta = (cpuNow - BASELINE.skipPctAt70Walk) * 100;
  console.log(
    `  economia de CPU (70px andando, cena limpa): ${pct(cpuNow)} das rodadas puladas ` +
      `(baseline ${pct(BASELINE.skipPctAt70Walk)}, Δ ${cpuDelta >= 0 ? "+" : ""}${cpuDelta.toFixed(1)}pp) — AVISA, não reprova (§BASELINE)`,
  );
  if (Math.abs(cpuDelta) > WARN_PP)
    warns.push(
      `economia de CPU mudou ${cpuDelta.toFixed(1)}pp nesta cena — é o OUTRO lado do mesmo knob. ` +
        `Se foi troca deliberada, declare o custo em câmeras por core e atualize a baseline`,
    );
  if (fidelity) {
    const diverge = fidelity.filter((r) => r.synthInfer !== r.realInfer).length;
    if (diverge > fidelity.length / 2)
      fails.push(`ancoragem QUEBROU: ${diverge}/${fidelity.length} casos decidem diferente do caminho real — o modelo sintético deixou de aproximar produção`);
  }

  for (const w of warns) console.log(`  ⚠ ${w}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  // Bloco pronto para colar — o sensor NUNCA reescreve a própria régua (um gate que
  // se auto-atualiza é uma máquina de falso-OK: a regressão viraria "nova baseline").
  if (opts.updateBaseline || warns.length || fails.length) {
    const atW = {};
    for (const h of Object.keys(BASELINE.recallMotionAtWalk)) atW[h] = +atWalk(Number(h)).recallMotion.toFixed(4);
    console.log(
      `\n  Baseline MEDIDA nesta execução (cole no BASELINE deste arquivo, com data e o porquê no commit):\n` +
        `    blindCeilingPx: ${blindCeiling}, maxBlindMs: ${maxBlind},\n` +
        `    recallMotionAtWalk: ${JSON.stringify(atW).replace(/"/g, "").replace(/,/g, ", ").replace(/:/g, ": ")},\n` +
        `    skipPctAt70Walk: ${cpuNow.toFixed(4)},`,
    );
  }
  const failed = canonical ? fails.length : 0;
  console.log(
    `\n[eval/gate-recall] ${failed ? `FALHOU — ${failed} regressão(ões)` : "OK — sem regressão"} ` +
      `· ${((Date.now() - t0) / 1000).toFixed(1)}s · ${trials} trials/célula` +
      (canonical || !fails.length ? "" : ` (${fails.length} desvio(s) NÃO reprovam fora do n canônico)`),
  );
  if (!failed)
    console.log(
      `  Lembrete: "sem regressão" NÃO é "o gate está bom". A baseline é o ESTADO MEDIDO do gate hoje,\n` +
        `  faixa cega inclusa. Quem quiser mudar o limiar mede AQUI antes (Onda 2 da spec, CA-8/CA-9).\n`,
    );
  return { failed, deviations: fails.length, blindCeiling, maxBlind, grid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const trialsArg = argv.indexOf("--trials");
  const r = await runGateRecall({
    fidelity: !argv.includes("--no-fidelity"),
    updateBaseline: argv.includes("--update-baseline"), // IMPRIME o bloco; quem edita é humano
    trials: trialsArg >= 0 ? Number(argv[trialsArg + 1]) : undefined,
  });
  process.exit(r.failed ? 1 : 0);
}
