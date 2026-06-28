// ─────────────────────────────────────────────────────────────────────────────
// counting.ts — BIBLIOTECA PURA de contagem por linha (tripwire) com direção
//               e heatmap de ocupação (Onda C, item 13 — parte algorítmica).
//
// SEM React, SEM canvas, SEM I/O, SEM dependências, SEM estado global.
// Apenas funções determinísticas + fábricas de estado encapsulado (closures),
// para a Onda CW-3 plugar no loop rAF do CameraWorkspace (desenho/contagem ficam lá).
//
// ── UNIDADES E SISTEMA DE COORDENADAS ────────────────────────────────────────
// TUDO em coordenadas NORMALIZADAS 0..1, origem no TOPO-ESQUERDA, x→direita,
// y→baixo — idêntico a `zones.ts` (Zone.x/y/w/h) e aos centróides de track do
// CameraWorkspace (`Track.cx/cy`, já normalizados em updateTracks()). Assim a
// API é compatível: passe `tracks` (cx,cy) e `points` (x,y) sem conversão.
// Para detecções cruas (bbox em PIXELS, ver vision/model.ts → Detection.bbox =
// [x,y,w,h]), use o helper `centroidOfBBox(bbox, frameW, frameH)`.
//
// ── CONVENÇÃO DE DIREÇÃO DA TRIPWIRE (entrada/saída) ──────────────────────────
// Uma tripwire é o segmento orientado de `a` → `b` (a "seta"). Para um ponto p
// definimos o lado por meio do produto vetorial 2D (orientação):
//
//     side(p) = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
//
//   • side(p) > 0  → p está à DIREITA da seta a→b   (lado "positivo")
//   • side(p) < 0  → p está à ESQUERDA da seta a→b  (lado "negativo")
//   • side(p) = 0  → p sobre a linha
//
// (Em coordenadas de imagem, com y para baixo, o produto vetorial positivo cai
//  visualmente à DIREITA de quem caminha de a para b.)
//
// CONTAGEM: quando o deslocamento de um track (posição anterior → atual)
// INTERSECTA o segmento da tripwire:
//   • cruzar da ESQUERDA → DIREITA da seta (side: − → +)  conta como  "in"  (ENTRADA)
//   • cruzar da DIREITA → ESQUERDA da seta (side: + → −)  conta como  "out" (SAÍDA)
//
// O vetor "para dentro" (direção de uma ENTRADA) é a normal
//     n_in = (a.y - b.y, b.x - a.x)
// que aponta 90° à direita da seta a→b (no espaço de tela, y para baixo).
// Para inverter o sentido de uma linha (trocar in↔out) basta trocar `a` e `b`.
//
// ── COMO A CW-3 INTEGRA (contrato) ───────────────────────────────────────────
//   const counter = createCounter(tripwires);           // 1x ao montar/editar
//   // no loop rAF, por frame, com os tracks que já existem (cx,cy normalizados):
//   const events = counter.update(tracks, performance.now());
//   events.forEach(e => pushTimeline(`${e.dir==="in"?"Entrada":"Saída"} ${e.tripwireId}`, "info"));
//   const c = counter.counts();                          // { [wireId]: {in,out} } p/ HUD/painel
//
//   const occ = createOccupancy({ cols: 32, rows: 18, decay: 0.97 });
//   // por frame: acumula os centróides (pessoas/objetos) com decaimento temporal:
//   occ.add(tracks.map(t => ({ x: t.cx, y: t.cy })));    // (decai e soma — 1x/frame)
//   const g = occ.grid();                                // Float32Array cols*rows, 0..1
//   // desenhar g[row*cols + col] como no heatmap atual do CameraWorkspace.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tipos compartilhados ─────────────────────────────────────────────────────

/** Ponto em coordenadas normalizadas (0..1), origem topo-esquerda. */
export type Point = { x: number; y: number };

/** Linha de contagem orientada a→b (a "seta"), em coordenadas normalizadas. */
export type Tripwire = { id: string; a: Point; b: Point };

/** Sentido do cruzamento. "in" = entrada (esquerda→direita da seta); "out" = saída. */
export type CrossDir = "in" | "out";

/** Contadores acumulados por tripwire. */
export type TripwireCounts = { in: number; out: number };

/** Entrada mínima de track por frame (compatível com Track do CameraWorkspace). */
export type TrackPoint = { id: number | string; cx: number; cy: number };

/** Evento de cruzamento emitido por `update()` no frame em que ocorre. */
export type CrossEvent = {
  tripwireId: string;
  trackId: number | string;
  dir: CrossDir;
  /** Ponto de cruzamento estimado (interseção dos segmentos), normalizado. */
  x: number;
  y: number;
};

/** Opções do contador de tripwire. */
export type CounterOptions = {
  /** Deslocamento mínimo (norm.) p/ avaliar cruzamento — filtra micro-jitter. Default 0.01. */
  minMove?: number;
  /** TTL de um track sem ser visto antes de descartar seu last-pos (mesma unidade de `now`). Default 1500. */
  ttl?: number;
};

/** Instância do contador de linhas. Estado encapsulado; determinístico dado o histórico. */
export type Counter = {
  /**
   * Chamar 1x por frame com os tracks atuais (cx,cy normalizados). Mantém o
   * last-pos por id internamente, detecta cruzamentos desde a posição anterior
   * e incrementa in/out. Retorna os eventos ocorridos NESTE frame.
   * `now` (ms; ex.: performance.now()) é usado para o cleanup por TTL de tracks
   * que sumiram. Se omitido, usa um contador interno de frames como relógio.
   */
  update: (tracks: ReadonlyArray<TrackPoint>, now?: number) => CrossEvent[];
  /** Snapshot dos contadores por tripwire (cópia; seguro de guardar/mutar). */
  counts: () => Record<string, TripwireCounts>;
  /** Soma de todas as tripwires. */
  totals: () => TripwireCounts;
  /** Substitui a geometria das linhas preservando contadores das que continuam (por id). */
  setTripwires: (tripwires: ReadonlyArray<Tripwire>) => void;
  /** Tripwires atuais (cópia rasa). */
  tripwires: () => Tripwire[];
  /** Zera contadores e o histórico de posições (geometria mantida). */
  reset: () => void;
};

// ── Geometria pura ───────────────────────────────────────────────────────────

/**
 * Orientação 2D (produto vetorial) do ponto P em relação à reta A→B.
 * >0 à direita da seta, <0 à esquerda, 0 colinear (coords de imagem, y p/ baixo).
 */
export function orient(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/**
 * Interseção PRÓPRIA de segmentos [p1,p2] × [p3,p4] (toques/colinear → false).
 * Robusto p/ contagem: exige que cada segmento separe os extremos do outro.
 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** Ponto de interseção das retas que contêm [p1,p2] e [p3,p4]. Assume não-paralelas. */
function intersectionPoint(p1: Point, p2: Point, p3: Point, p4: Point): Point {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: p4.x - p3.x, y: p4.y - p3.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom === 0) return { x: p2.x, y: p2.y }; // paralelas (defensivo; não ocorre se intersect=true)
  const t = ((p3.x - p1.x) * s.y - (p3.y - p1.y) * s.x) / denom;
  return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}

/**
 * Normal "para dentro" de uma tripwire: vetor unitário que aponta no sentido de
 * uma ENTRADA (esquerda→direita da seta a→b). Útil p/ desenhar a seta de direção.
 * Retorna {x:0,y:0} se a e b coincidirem.
 */
export function inwardNormal(w: Tripwire): Point {
  const nx = w.a.y - w.b.y;
  const ny = w.b.x - w.a.x;
  const len = Math.hypot(nx, ny);
  return len === 0 ? { x: 0, y: 0 } : { x: nx / len, y: ny / len };
}

/** Centróide normalizado a partir de um bbox em pixels [x,y,w,h] (ver model.ts). */
export function centroidOfBBox(
  bbox: readonly [number, number, number, number],
  frameW: number,
  frameH: number,
): Point {
  return {
    x: frameW > 0 ? (bbox[0] + bbox[2] / 2) / frameW : 0,
    y: frameH > 0 ? (bbox[1] + bbox[3] / 2) / frameH : 0,
  };
}

// ── Contador de tripwire (estado encapsulado) ────────────────────────────────

type TrackState = { x: number; y: number; lastSeen: number };

/**
 * Cria um contador de linhas de contagem.
 * @param tripwires linhas iniciais (coords normalizadas). Pode editar via setTripwires().
 * @param opts limiar de jitter (minMove) e TTL de track.
 */
export function createCounter(
  tripwires: ReadonlyArray<Tripwire> = [],
  opts: CounterOptions = {},
): Counter {
  const minMove = opts.minMove ?? 0.01;
  const ttl = opts.ttl ?? 1500;

  let wires: Tripwire[] = tripwires.map(cloneWire);
  const counts = new Map<string, TripwireCounts>();
  const last = new Map<number | string, TrackState>();
  let frameClock = 0; // relógio de fallback (frames) quando `now` não é informado

  for (const w of wires) counts.set(w.id, { in: 0, out: 0 });

  function update(tracks: ReadonlyArray<TrackPoint>, now?: number): CrossEvent[] {
    const t = now ?? ++frameClock;
    const events: CrossEvent[] = [];
    const seen = new Set<number | string>();

    for (const tr of tracks) {
      seen.add(tr.id);
      const prev = last.get(tr.id);
      const cur = { x: tr.cx, y: tr.cy };
      if (!prev) {
        last.set(tr.id, { x: cur.x, y: cur.y, lastSeen: t });
        continue;
      }
      prev.lastSeen = t; // visto neste frame (mantém vivo p/ TTL)
      // micro-jitter: acumula deslocamento (NÃO atualiza last-pos) até passar o limiar.
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) < minMove) continue;

      const from = { x: prev.x, y: prev.y };
      for (const w of wires) {
        if (!segmentsIntersect(from, cur, w.a, w.b)) continue;
        const d1 = orient(w.a, w.b, from);
        const d2 = orient(w.a, w.b, cur);
        let dir: CrossDir | null = null;
        if (d1 < 0 && d2 > 0) dir = "in";
        else if (d1 > 0 && d2 < 0) dir = "out";
        if (!dir) continue;
        const c = counts.get(w.id) ?? { in: 0, out: 0 };
        c[dir] += 1;
        counts.set(w.id, c);
        const ip = intersectionPoint(from, cur, w.a, w.b);
        events.push({ tripwireId: w.id, trackId: tr.id, dir, x: ip.x, y: ip.y });
      }
      // avança o last-pos só após mover além do jitter (evita dupla contagem)
      prev.x = cur.x;
      prev.y = cur.y;
    }

    // cleanup por TTL de tracks que sumiram
    for (const [id, st] of last) {
      if (!seen.has(id) && t - st.lastSeen > ttl) last.delete(id);
    }
    return events;
  }

  function snapshot(): Record<string, TripwireCounts> {
    const out: Record<string, TripwireCounts> = {};
    for (const w of wires) {
      const c = counts.get(w.id) ?? { in: 0, out: 0 };
      out[w.id] = { in: c.in, out: c.out };
    }
    return out;
  }

  function totals(): TripwireCounts {
    let cin = 0, cout = 0;
    for (const w of wires) {
      const c = counts.get(w.id);
      if (c) { cin += c.in; cout += c.out; }
    }
    return { in: cin, out: cout };
  }

  function setTripwires(next: ReadonlyArray<Tripwire>): void {
    wires = next.map(cloneWire);
    const keep = new Set(wires.map((w) => w.id));
    for (const id of [...counts.keys()]) if (!keep.has(id)) counts.delete(id);
    for (const w of wires) if (!counts.has(w.id)) counts.set(w.id, { in: 0, out: 0 });
  }

  function reset(): void {
    last.clear();
    frameClock = 0;
    for (const w of wires) counts.set(w.id, { in: 0, out: 0 });
  }

  return {
    update,
    counts: snapshot,
    totals,
    setTripwires,
    tripwires: () => wires.map(cloneWire),
    reset,
  };
}

function cloneWire(w: Tripwire): Tripwire {
  return { id: w.id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } };
}

// ── Heatmap de ocupação (grade com decaimento temporal) ──────────────────────

/** Ponto a acumular no heatmap (coords normalizadas; weight default 1). */
export type OccupancyPoint = { x: number; y: number; weight?: number };

/** Opções do heatmap de ocupação. */
export type OccupancyOptions = {
  /** Colunas da grade. */
  cols: number;
  /** Linhas da grade. */
  rows: number;
  /** Fator de decaimento por frame (0..1). Ex.: 0.97 ≈ janela de ~33 frames. */
  decay: number;
  /** Incremento base por ponto acumulado. Default 0.6. */
  addAmount?: number;
  /** Teto do valor cru por célula (anti-saturação). Default 6. */
  max?: number;
  /** Se true (default), `add()` aplica UM passo de decaimento antes de somar. */
  decayOnAdd?: boolean;
};

/** Instância do heatmap de ocupação. Estado encapsulado; determinístico. */
export type Occupancy = {
  readonly cols: number;
  readonly rows: number;
  /**
   * Acumula os pontos do frame na grade. Por padrão aplica 1 passo de decaimento
   * ANTES de somar (decayOnAdd=true) — chame 1x por frame. Em frames sem pontos,
   * chame `add([])` (decai) ou `decayStep()`. Não chame os dois no mesmo frame
   * (decairia em dobro).
   */
  add: (points: ReadonlyArray<OccupancyPoint>) => void;
  /** Aplica apenas um passo de decaimento (p/ frames pausados/sem detecções). */
  decayStep: () => void;
  /** Grade NORMALIZADA 0..1 (valor cru / máximo atual). Buffer reutilizado: copie p/ reter. */
  grid: () => Float32Array;
  /** Grade CRUA acumulada (live view; não mutar). Útil p/ dwell aproximado. */
  rawGrid: () => Float32Array;
  /**
   * Aproximação de "dwell time" (segundos) por célula. Buffer reutilizado.
   * Deriva do valor cru: em ocupação contínua, o valor satura em
   * `addAmount/(1-decay)` (estado estável) e a "janela de memória" do decaimento
   * é τ = 1/(1-decay) frames. Logo dwell_s ≈ (raw / steadyState) * τ / fps,
   * i.e. uma célula sempre ocupada → ~τ/fps s. É uma MÉTRICA RELATIVA de
   * permanência recente; para dwell EXATO por área use timers de presença
   * por zona (firstSeen/lastSeen dos tracks, como em zones.ts/CameraWorkspace).
   */
  dwellSeconds: (fps: number) => Float32Array;
  /** Zera a grade. */
  reset: () => void;
};

/** Cria um heatmap de ocupação em grade normalizada com decaimento temporal. */
export function createOccupancy(options: OccupancyOptions): Occupancy {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const decay = clamp01(options.decay);
  const addAmount = options.addAmount ?? 0.6;
  const max = options.max ?? 6;
  const decayOnAdd = options.decayOnAdd ?? true;

  const raw = new Float32Array(cols * rows);
  const normBuf = new Float32Array(cols * rows);
  const dwellBuf = new Float32Array(cols * rows);

  function decayStep(): void {
    for (let i = 0; i < raw.length; i++) raw[i] *= decay;
  }

  function add(points: ReadonlyArray<OccupancyPoint>): void {
    if (decayOnAdd) decayStep();
    for (const p of points) {
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue; // fora do frame
      const c = clampInt(Math.floor(p.x * cols), 0, cols - 1);
      const r = clampInt(Math.floor(p.y * rows), 0, rows - 1);
      const k = r * cols + c;
      raw[k] = Math.min(max, raw[k] + addAmount * (p.weight ?? 1));
    }
  }

  function grid(): Float32Array {
    let m = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] > m) m = raw[i];
    if (m <= 0) { normBuf.fill(0); return normBuf; }
    for (let i = 0; i < raw.length; i++) normBuf[i] = raw[i] / m;
    return normBuf;
  }

  function dwellSeconds(fps: number): Float32Array {
    const tau = decay < 1 ? 1 / (1 - decay) : Number.POSITIVE_INFINITY; // frames
    const steady = decay < 1 ? addAmount / (1 - decay) : max;
    const perFrame = fps > 0 ? 1 / fps : 0;
    const windowS = Number.isFinite(tau) ? tau * perFrame : 0;
    for (let i = 0; i < raw.length; i++) {
      const frac = steady > 0 ? Math.min(1, raw[i] / steady) : 0;
      dwellBuf[i] = frac * windowS;
    }
    return dwellBuf;
  }

  function reset(): void {
    raw.fill(0);
  }

  return { cols, rows, add, decayStep, grid, rawGrid: () => raw, dwellSeconds, reset };
}

// ── utils ────────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
