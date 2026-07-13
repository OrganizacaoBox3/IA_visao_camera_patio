// GUIA DE INSTALAÇÃO das estações BLE (spec multi-antena, M4/F3) — lógica PURA, sem deps, sem DOM.
//
// POR QUE existe: o ganho da 2ª antena NÃO vem de "mais sinal" — vem de GEOMETRIA. Os erros de
// identidade medidos no arco vêm do RIVAL RADIALMENTE CONFUNDÍVEL: o vizinho que espelha o meu
// perfil de distância à estação A. Duas estações só quebram esse espelho se derem EIXOS RADIAIS
// DISTINTOS ao longo do movimento real das pessoas. Duas consequências práticas:
//   • estações COLADAS uma na outra ≈ uma estação só (mesma geometria, ruído a mais);
//   • estações alinhadas COM O EIXO DE MOVIMENTO DOMINANTE (o corredor) não quebram o espelho: quem
//     anda no corredor se afasta das duas ao mesmo tempo, e o perfil do rival continua espelhado.
//     A instalação que quebra é a DIAGONAL (o mercado diz o mesmo: Quuppa/Kontakt/Minew).
//
// AVISO, NÃO BLOQUEIO (decisão da spec): o eixo dominante aqui é uma HEURÍSTICA declarada — o lado
// mais longo do retângulo calibrado (o corredor típico do CD). Um chão real pode ter outro eixo;
// por isso isto é texto de ajuda na calibração, nunca um veto no save. Quem manda é o walk-test.
//
// Responsabilidade única: dados os pontos das estações NO MUNDO (metros) + o eixo dominante,
// dizer o que a instalação tem de frágil. Sem I/O, sem estado, testável isolado.
import type { Vec2 } from "../vision/homography";

/** Um aviso de geometria de instalação. `code` p/ o teste; `text` é o que o operador lê. */
export type StationGeometryHint = { code: "muito-perto" | "colinear-eixo"; text: string };

/** Separação MÍNIMA recomendada entre estações (m) — M4 ("2,5–3 m, na diagonal"). Abaixo disto as
 *  duas antenas veem praticamente a MESMA distância de todo mundo: geometria redundante. */
const MIN_SEP_M = 2.5;
/** Ângulo mínimo (graus) entre a linha das estações e o eixo dominante p/ a instalação "quebrar" o
 *  rival. Abaixo disso a segunda antena repete o eixo do corredor. 20° é a leitura conservadora de
 *  "não-colinear" da M4 — o teste é feito pela EXTENSÃO PERPENDICULAR (ver abaixo), que generaliza
 *  para N estações sem escolher um par arbitrário. */
const MIN_AXIS_DEG = 20;

const EPS = 1e-9;
const isFiniteVec = (v: Vec2 | undefined): v is Vec2 =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y);

/** Maior distância entre dois pontos do conjunto (a "base" da instalação). */
function maxSeparation(pts: readonly Vec2[]): number {
  let max = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > max) max = d;
    }
  return max;
}

/** Extensão (max−min) das projeções dos pontos sobre um versor. */
function extent(pts: readonly Vec2[], ux: number, uy: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const t = p.x * ux + p.y * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

/**
 * Avisos de geometria para as estações JÁ marcadas na calibração (posições em METROS, via
 * homografia). `dominantAxis` = direção presumida do movimento (não precisa ser unitária; null =
 * desconhecida → o aviso de colinearidade não é emitido, só o de proximidade).
 *
 * Regras (as duas da M4, nesta ordem):
 *  1. `muito-perto`: maior separação entre estações < 2,5 m → geometria redundante.
 *  2. `colinear-eixo`: a EXTENSÃO PERPENDICULAR ao eixo dominante é pequena perto da separação —
 *     perp < sep·sen(20°). Para 2 estações isso é exatamente "o ângulo com o eixo é < 20°"; para N
 *     é a generalização honesta (todas as antenas praticamente sobre a linha do corredor).
 *
 * Menos de 2 estações → nada a avisar (uma antena não tem geometria a discutir).
 */
export function stationGeometryHints(
  stationsWorld: readonly Vec2[],
  dominantAxis: Vec2 | null,
): StationGeometryHint[] {
  const pts = stationsWorld.filter(isFiniteVec);
  if (pts.length < 2) return [];
  const hints: StationGeometryHint[] = [];

  const sep = maxSeparation(pts);
  if (sep < MIN_SEP_M)
    hints.push({
      code: "muito-perto",
      text: `As estações estão a ${sep.toFixed(1)} m uma da outra. Muito perto, elas medem quase a mesma distância de todo mundo — afaste para ${MIN_SEP_M.toFixed(1)} m ou mais.`,
    });

  const axisLen = dominantAxis ? Math.hypot(dominantAxis.x, dominantAxis.y) : 0;
  if (dominantAxis && axisLen > EPS && sep > EPS) {
    // Versor PERPENDICULAR ao eixo dominante: a extensão das estações nele é o quanto a instalação
    // "sai" do corredor. Perto de zero = todas na linha do corredor = não quebram o rival.
    const perp = extent(pts, -dominantAxis.y / axisLen, dominantAxis.x / axisLen);
    if (perp < sep * Math.sin((MIN_AXIS_DEG * Math.PI) / 180))
      hints.push({
        code: "colinear-eixo",
        text: "As estações estão alinhadas com o corredor (o lado mais longo da área calibrada). Assim a segunda antena repete o mesmo ângulo de visão da primeira e ajuda pouco a separar pessoas que andam juntas — prefira a DIAGONAL da área.",
      });
  }
  return hints;
}

/**
 * Eixo dominante PRESUMIDO do movimento a partir do retângulo calibrado: o lado MAIS LONGO (o
 * corredor). O mundo da calibração é o retângulo (0,0)→(L,0)→(L,C)→(0,C), então o eixo é o X ou o
 * Y do mundo. Dimensões inválidas → null (sem palpite, sem aviso).
 */
export function dominantAxisFromRect(L: number, C: number): Vec2 | null {
  if (!Number.isFinite(L) || !Number.isFinite(C) || L <= 0 || C <= 0) return null;
  return L >= C ? { x: 1, y: 0 } : { x: 0, y: 1 };
}
