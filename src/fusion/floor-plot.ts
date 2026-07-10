// Plotagem de tags no chão — lógica PURA, sem deps, sem DOM.
//
// FÍSICA (docs/cientifica/ — teto provado): 1 estação + RSSI dá DISTÂNCIA, não posição.
// A visualização HONESTA de uma tag sem posição resolvida é um ANEL de raio d ao redor da
// estação — nunca um ponto inventado (rótulo errado é pior que rótulo nenhum).
//
// CALIBRAÇÃO EM TEMPO REAL: as 4 tags-âncora dos cantos têm posição MUNDO conhecida → cada
// leitura dá um par (RSSI, distância-verdadeira-à-estação). Esses pares ajustam o modelo
// log-distância  RSSI(d) = rssi0 − 10·n·log10(d)  por mínimos quadrados em x = log10(d).
// IDENTIFICABILIDADE: o expoente n só é estimável se as âncoras cobrirem span suficiente em
// log10(d); com âncoras quase equidistantes da estação (geometria real do campo) calibramos
// SÓ o offset do ambiente (rssi0) com n fixo — regime DECLARADO (source:"anchors-offset").
// Sem âncoras suficientes caímos num default conservador e DECLARADO (source:"default") —
// o chamador sabe que o raio é chute de modelo, não medição calibrada.
//
// Responsabilidade única: fit do path-loss + inversão RSSI→distância + anel projetado em px.
// Projeção usa o MESMO contrato numérico de src/vision/homography (invertMatrix3+applyMatrix3,
// a decomposição do worldToPixel), com filtro de cheirality: ponto além do horizonte NÃO entra.

import type { Matrix3, Vec2 } from "../vision/homography";
import { applyMatrix3, invertMatrix3 } from "../vision/homography";

/** Leitura de uma tag-âncora: posição MUNDO conhecida (metros) + RSSI atual (dBm). */
export type AnchorObs = { mac: string; world: Vec2; rssi: number };

/**
 * Modelo log-distância. source declara o regime de calibração:
 * - "anchors": fit completo (rssi0 E n) — âncoras espalhadas o bastante em log10(d);
 * - "anchors-offset": âncoras pouco espalhadas → só o OFFSET do ambiente (rssi0) é calibrado,
 *   n fica no default (melhor que o default cru, mas o expoente é chute declarado);
 * - "default": sem âncoras suficientes — tudo é chute de modelo.
 */
export type PathLossModel = {
  rssi0: number; // RSSI a 1 m (dBm)
  n: number; // expoente de path-loss (2 = espaço livre; indoor típico 1.8–3.5)
  source: "anchors" | "anchors-offset" | "default";
  samples: number; // quantas âncoras VÁLIDAS entraram (informativo mesmo no default)
};

// Limites de plausibilidade física (indoor). Fora disto o fit está contaminado → clamp.
const N_MIN = 1.2;
const N_MAX = 4.5;
const RSSI0_MIN = -70;
const RSSI0_MAX = -20;
// Âncora colada na estação (d ≤ 0.3 m) está em campo próximo — log10(d) explode e o par
// não informa o expoente; fica fora do fit.
const MIN_ANCHOR_DIST_M = 0.3;
// Identificabilidade do EXPOENTE: n só é estimável se as âncoras cobrirem um span mínimo em
// x = log10(d). Abaixo de 0.4 década (razão dmax/dmin < ~2.5) a reta "passa" numericamente,
// mas a inclinação — e portanto n — é ruído puro (geometria real do campo: âncoras a
// ~1.2–1.6 m da estação ≈ 0.11 década). Nesse regime só o offset (rssi0) é calibrável.
const SPAN_MIN_DECADES = 0.4;
// Faixa de saída de distância: abaixo de 0.1 m e acima de 100 m o RSSI não discrimina nada.
const DIST_MIN_M = 0.1;
const DIST_MAX_M = 100;
// Mesmo limiar de w≈0 do applyMatrix3 (horizonte projetivo) — contrato numérico compartilhado.
const W_EPS = 1e-12;

const DEFAULT_MODEL: Omit<PathLossModel, "samples"> = { rssi0: -45, n: 2.2, source: "default" };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === "object" && isFiniteNum((v as Vec2).x) && isFiniteNum((v as Vec2).y);

/**
 * Ajusta RSSI(d) = rssi0 − 10·n·log10(d) por mínimos quadrados (reta y = a + b·x com
 * x = log10(d), y = rssi; então rssi0 = a e n = −b/10) sobre as âncoras válidas
 * (coordenadas finitas e d > 0.3 m da estação).
 *
 * source:"anchors" exige 2+ âncoras válidas E span de log10(d) ≥ 0.4 década (dmax/dmin
 * ≥ ~2.5) — abaixo disso o expoente NÃO é identificável (o fit "passaria" com n = ruído);
 * nesse caso fixamos n no default e ajustamos SÓ o rssi0 (média de y + 10·n·x), regime
 * declarado como source:"anchors-offset". Com <2 âncoras → default declarado.
 * rssi0/n saem CLAMPADOS à faixa plausível. Nunca devolve NaN.
 */
export function fitPathLoss(obs: AnchorObs[], stationWorld: Vec2): PathLossModel {
  const station = isVec(stationWorld) ? stationWorld : null;
  // x = log10(d), y = rssi — só âncoras válidas entram.
  const xs: number[] = [];
  const ys: number[] = [];
  if (station && Array.isArray(obs)) {
    for (const o of obs) {
      if (!o || !isVec(o.world) || !isFiniteNum(o.rssi)) continue;
      const d = Math.hypot(o.world.x - station.x, o.world.y - station.y);
      if (d <= MIN_ANCHOR_DIST_M) continue;
      xs.push(Math.log10(d));
      ys.push(o.rssi);
    }
  }
  const m = xs.length;
  if (m < 2) return { ...DEFAULT_MODEL, samples: m };

  // Mínimos quadrados clássicos: b = Sxy/Sxx, a = ȳ − b·x̄.
  let sx = 0;
  let sy = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (let i = 0; i < m; i++) {
    sx += xs[i];
    sy += ys[i];
    if (xs[i] < xMin) xMin = xs[i];
    if (xs[i] > xMax) xMax = xs[i];
  }
  const mx = sx / m;
  const my = sy / m;

  // GATE DE IDENTIFICABILIDADE (por span, não por zero numérico): âncoras pouco espalhadas em
  // log10(d) não informam o expoente — fixamos n no default e calibramos SÓ o offset do
  // ambiente: rssi0 = média de (y + 10·n·x). Subsume o caso degenerado (todas à mesma
  // distância → span 0): mesmo aí o offset naquela distância é medição real, melhor que o
  // default cru — e o regime sai DECLARADO ("anchors-offset") para o chamador.
  if (xMax - xMin < SPAN_MIN_DECADES) {
    const n = DEFAULT_MODEL.n;
    return {
      rssi0: clamp(my + 10 * n * mx, RSSI0_MIN, RSSI0_MAX),
      n,
      source: "anchors-offset",
      samples: m,
    };
  }

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const b = sxy / sxx; // inclinação = −10·n
  const a = my - b * mx; // intercepto = rssi0 (RSSI a 1 m, pois log10(1) = 0)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...DEFAULT_MODEL, samples: m };

  return {
    rssi0: clamp(a, RSSI0_MIN, RSSI0_MAX),
    n: clamp(-b / 10, N_MIN, N_MAX),
    source: "anchors",
    samples: m,
  };
}

/**
 * Inverte o modelo: d = 10^((rssi0 − rssi)/(10·n)), clampado a [0.1, 100] m.
 * Robustez: entradas não-finitas caem no default do campo (rssi sem sinal → longe = 100 m);
 * nunca devolve NaN.
 */
export function distFromRssi(model: PathLossModel, rssi: number): number {
  const rssi0 = model && isFiniteNum(model.rssi0) ? model.rssi0 : DEFAULT_MODEL.rssi0;
  const n = model && isFiniteNum(model.n) && model.n > 0 ? model.n : DEFAULT_MODEL.n;
  if (!isFiniteNum(rssi)) return DIST_MAX_M; // sem leitura ≈ fora de alcance → teto
  const d = Math.pow(10, (rssi0 - rssi) / (10 * n)); // pode estourar a Infinity — o clamp resolve
  return clamp(Number.isFinite(d) ? d : DIST_MAX_M, DIST_MIN_M, DIST_MAX_M);
}

/**
 * Amostra `segments` pontos (default 48) do círculo de raio radiusM ao redor de stationWorld
 * NO MUNDO (metros) e projeta cada um em pixel via H⁻¹ (invertida UMA vez; mesmo contrato do
 * worldToPixel). CHEIRALITY: o w homogêneo (inv[6]·x + inv[7]·y + inv[8]) troca de sinal ao
 * cruzar o horizonte da câmera; ponto com sinal OPOSTO ao da estação projetaria um pixel
 * finito porém ESPELHADO (traço fantasma no quadro) — é descartado, junto com |w| ≈ 0
 * (horizonte) e H singular. Devolve a polilinha em px NORMALIZADO — pode sair de [0,1];
 * quem desenha clipa. Determinístico (ângulos fixos, sem random).
 */
export function ringPixels(
  H: Matrix3,
  stationWorld: Vec2,
  radiusM: number,
  segments = 48,
): Vec2[] {
  if (!isVec(stationWorld) || !isFiniteNum(radiusM) || radiusM <= 0) return [];
  const segs = isFiniteNum(segments) && segments >= 3 ? Math.floor(segments) : 48;
  const inv = invertMatrix3(H);
  if (!inv) return []; // H singular → nada projeta (mesmo comportamento do worldToPixel)
  // Sinal de referência: o w da ESTAÇÃO (centro do anel). Estação no próprio horizonte →
  // não há lado "de dentro" definível — nenhum ponto é honesto.
  const wStation = inv[6] * stationWorld.x + inv[7] * stationWorld.y + inv[8];
  if (Math.abs(wStation) < W_EPS) return [];
  const out: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const th = (2 * Math.PI * i) / segs;
    const p = {
      x: stationWorld.x + radiusM * Math.cos(th),
      y: stationWorld.y + radiusM * Math.sin(th),
    };
    // Cheirality: só entra quem está do MESMO lado do horizonte que a estação.
    const w = inv[6] * p.x + inv[7] * p.y + inv[8];
    if (Math.abs(w) < W_EPS || w * wStation < 0) continue;
    const px = applyMatrix3(inv, p);
    if (px) out.push(px);
  }
  return out;
}
