// Geometria do RECEPTOR (Onda 1 do ADR-014) — o experimento DECISIVO e NÃO-CIRCULAR: dada a
// GEOMETRIA de uma caminhada (posições da pessoa em METROS) e uma posição candidata de receptor BLE,
// qual o SPAN RADIAL que a instalação fabrica? O span radial = std populacional de log10(dist
// euclidiana pessoa→receptor) sobre os pontos do episódio, em DÉCADAS (a "assinatura" que a fusão de
// identidade precisa — quanto a log-distância AO RECEPTOR varia durante a aproximação).
//
// POR QUE É NÃO-CIRCULAR (a razão de este módulo existir): o span radial é propriedade PURA da
// geometria de instalação (trajetória × distância euclidiana). Ele NÃO consome o modelo de RSSI do
// simulador — nenhuma função aqui olha para readings/RSSI/path-loss. Só entra a POSIÇÃO verdadeira da
// pessoa em metros e a posição do receptor. Por isso é um uso legítimo da bancada para responder
// "mover o receptor para o destino fabrica o span de 0,9 década que o gate H1 pediu?" SEM o risco de
// circularidade que contamina qualquer conclusão que passe pelo rádio simulado (ADR-014 item 7;
// docs/cientifica/checklist-entrada-sensor.md §1.5).
//
// Referências pinadas do ADR-014: ~0,42 década "passa por pouco"; ~0,9 década esperado com o receptor
// NO DESTINO da caminhada; ~0,08–0,11 medido hoje com o receptor JUNTO da câmera/estação.
//
// Responsabilidade única: só a geometria pura (span radial + varredura do ótimo + gerador de
// caminhada reta sintética para calibrar expectativa). Extrair a trajetória do simulador e reportar a
// tabela por cenário moram no teste ao lado (receiver-geometry.test.ts) — este arquivo não importa o
// simulador, é geometria e nada mais. Determinístico, sem estado, sem NaN (guardas explícitas).

export type Pt = { readonly x: number; readonly y: number };

/** O resultado da medição de span de UMA trajetória contra UM receptor. */
export type RadialSpan = {
  /** std POPULACIONAL de log10(dist ao receptor) sobre os pontos — em DÉCADAS (a "assinatura"). */
  spanDecades: number;
  /** max − min de log10(dist ao receptor) — em DÉCADAS (a faixa dinâmica bruta). */
  rangeDecades: number;
  /** nº de pontos que entraram no cálculo (após a guarda de <2 pontos). */
  nPoints: number;
};

// Piso da distância (metros) antes do log10 — a guarda "distância mínima > 0 (clamp)": receptor EM
// cima de um ponto da trajetória (dist 0) daria log10(0) = −∞. Mesmo valor do span do motor
// (DIST_FLOOR_M em visit-metrics.ts / GATE_MIN_DIST_M) para que os números sejam comparáveis à régua
// de identidade — o piso importa: modela "a pessoa chega ATÉ ~10 cm do receptor, não literalmente 0".
export const DEFAULT_DIST_FLOOR_M = 0.1;

/**
 * Span radial de uma trajetória (posições em metros) contra um receptor (posição em metros).
 * spanDecades = std populacional de log10(max(dist, piso)); rangeDecades = max−min do mesmo log.
 * Guardas (contrato explícito): trajetória com <2 pontos → span 0 e range 0 (nada a variar);
 * distância clampada ao piso (nunca log10(0) = −∞). Puro/determinístico, nunca NaN.
 */
export function radialSpan(
  trajectory: readonly Pt[],
  receiver: Pt,
  distFloorM: number = DEFAULT_DIST_FLOOR_M,
): RadialSpan {
  const n = trajectory.length;
  if (n < 2) return { spanDecades: 0, rangeDecades: 0, nPoints: n };

  const logs: number[] = new Array<number>(n);
  let mean = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = trajectory[i];
    const d = Math.hypot(p.x - receiver.x, p.y - receiver.y);
    const l = Math.log10(Math.max(d, distFloorM));
    logs[i] = l;
    mean += l;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  mean /= n;

  let ss = 0;
  for (let i = 0; i < n; i++) {
    const dv = logs[i] - mean;
    ss += dv * dv;
  }
  return { spanDecades: Math.sqrt(ss / n), rangeDecades: max - min, nPoints: n };
}

/** Grade de posições candidatas de receptor (metros) — retângulo varrido em passo fixo. */
export type GridSpec = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** passo do grid em metros (>0). */
  step: number;
};

// Grade padrão = a SALA do simulador (chão 8×6 m; ver FLOOR_PAIRS em sim.ts). Passo 0,5 m dá 17×13 =
// 221 candidatos — resolução farta para localizar a região de span máximo num relatório (o ótimo é
// tipicamente uma QUINA, região ampla; não precisa de sub-decímetro).
export const DEFAULT_ROOM_GRID: GridSpec = { minX: 0, maxX: 8, minY: 0, maxY: 6, step: 0.5 };

/** A posição de receptor que MAXIMIZA o span radial de uma trajetória, e o span nela. */
export type OptimalReceiver = { receiver: Pt; span: RadialSpan };

/**
 * Varre a grade e devolve a posição de receptor que MAXIMIZA spanDecades para a trajetória dada
 * (empate → o primeiro na varredura x-depois-y, determinístico). Trajetória com <2 pontos → span 0
 * em toda posição (devolve a primeira). O ε no laço cobre o erro de ponto-flutuante do passo para
 * incluir a borda superior da grade.
 */
export function optimalReceiver(
  trajectory: readonly Pt[],
  grid: GridSpec = DEFAULT_ROOM_GRID,
  distFloorM: number = DEFAULT_DIST_FLOOR_M,
): OptimalReceiver {
  const eps = grid.step * 1e-6;
  let best: OptimalReceiver | null = null;
  for (let x = grid.minX; x <= grid.maxX + eps; x += grid.step) {
    for (let y = grid.minY; y <= grid.maxY + eps; y += grid.step) {
      const receiver: Pt = { x, y };
      const span = radialSpan(trajectory, receiver, distFloorM);
      if (best === null || span.spanDecades > best.span.spanDecades) best = { receiver, span };
    }
  }
  // Grade sempre tem ≥1 posição (min ≤ max por construção do chamador); o fallback é defensivo.
  return best ?? { receiver: { x: grid.minX, y: grid.minY }, span: radialSpan(trajectory, { x: grid.minX, y: grid.minY }, distFloorM) };
}

/**
 * Caminhada RETA sintética: `n` pontos uniformes de `from` a `to` (inclui os dois extremos). Puro,
 * para CALIBRAR a expectativa geométrica no teste — é a aproximação idealizada "a pessoa anda em
 * linha reta ATÉ o receptor" que o ADR-014 associa ao ~0,9 década. NÃO é dado do simulador; é o
 * teto geométrico contra o qual as trajetórias (que vagueiam) são comparadas.
 */
export function straightApproach(from: Pt, to: Pt, n: number): Pt[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: from.x, y: from.y }];
  const steps = n - 1;
  const pts: Pt[] = new Array<Pt>(n);
  for (let i = 0; i < n; i++) {
    const t = i / steps;
    pts[i] = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  return pts;
}
