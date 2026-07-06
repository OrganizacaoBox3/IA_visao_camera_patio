// ─────────────────────────────────────────────────────────────────────────────
// counting.js — PORT de src/vision/counting.ts — mudanças de comportamento
// devem ser feitas LÁ e re-portadas; os testes (counting.test.js) garantem
// paridade. CommonJS, JS puro, SEM dependências. Em produção o engine injeta os
// knobs do painel (precision.js).
//
// Biblioteca PURA de contagem por linha (tripwire) com direção + heatmap de
// ocupação. Funções determinísticas + fábricas de estado encapsulado (closures).
//
// ── UNIDADES E SISTEMA DE COORDENADAS ────────────────────────────────────────
// TUDO em coordenadas NORMALIZADAS 0..1, origem no TOPO-ESQUERDA, x→direita,
// y→baixo — idêntico a zones.js e aos tracks do bytetrack.js.
//
// ── CONVENÇÃO DE DIREÇÃO DA TRIPWIRE (entrada/saída) ─────────────────────────
// Tripwire = segmento orientado de `a` → `b` (a "seta"). Para um ponto p:
//     side(p) = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
//   • side(p) > 0 → p à DIREITA da seta a→b; < 0 → à ESQUERDA; = 0 → sobre.
// CONTAGEM: deslocamento (anterior → atual) que INTERSECTA o segmento:
//   • esquerda → direita da seta (side: − → +) conta "in"  (ENTRADA)
//   • direita → esquerda da seta (side: + → −) conta "out" (SAÍDA)
// Para inverter o sentido de uma linha (in↔out) basta trocar `a` e `b`.
//
// API (idêntica ao TS):
//   orient(a,b,p) / segmentsIntersect(p1,p2,p3,p4) / inwardNormal(wire)
//   centroidOfBBox(bboxPx, frameW, frameH)
//   createCounter(tripwires?, opts?) → { update(tracks, now?) → CrossEvent[],
//     counts(), totals(), setTripwires(), tripwires(), reset() }
//   createOccupancy(options) → { cols, rows, add(), decayStep(), grid(),
//     rawGrid(), dwellSeconds(fps), reset() }
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// ── Geometria pura ───────────────────────────────────────────────────────────

/**
 * Orientação 2D (produto vetorial) do ponto P em relação à reta A→B.
 * >0 à direita da seta, <0 à esquerda, 0 colinear (coords de imagem, y p/ baixo).
 */
function orient(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/**
 * Interseção PRÓPRIA de segmentos [p1,p2] × [p3,p4] (toques/colinear → false).
 * Robusto p/ contagem: exige que cada segmento separe os extremos do outro.
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Ponto de interseção das retas que contêm [p1,p2] e [p3,p4]. Assume não-paralelas. */
function intersectionPoint(p1, p2, p3, p4) {
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
function inwardNormal(w) {
  const nx = w.a.y - w.b.y;
  const ny = w.b.x - w.a.x;
  const len = Math.hypot(nx, ny);
  return len === 0 ? { x: 0, y: 0 } : { x: nx / len, y: ny / len };
}

/** Centróide normalizado a partir de um bbox em pixels [x,y,w,h]. */
function centroidOfBBox(bbox, frameW, frameH) {
  return {
    x: frameW > 0 ? (bbox[0] + bbox[2] / 2) / frameW : 0,
    y: frameH > 0 ? (bbox[1] + bbox[3] / 2) / frameH : 0,
  };
}

// ── Contador de tripwire (estado encapsulado) ────────────────────────────────

/**
 * Cria um contador de linhas de contagem. Estado encapsulado; determinístico.
 * @param {Array<{id:string,a:{x,y},b:{x,y}}>} [tripwires] linhas iniciais (coords normalizadas).
 * @param {{ minMove?: number, ttl?: number, maxDist?: number, debounceMs?: number,
 *           minCrossingFrames?: number }} [opts]
 *   minMove: deslocamento mínimo (norm.) p/ avaliar cruzamento — filtra micro-jitter (default 0.01).
 *   ttl: TTL de track sem ser visto antes de descartar o last-pos (unidade de `now`, default 1500).
 *   maxDist: salto máximo (norm.) do MESMO track entre avaliações; acima é TELEPORTE →
 *            re-ancora SEM avaliar cruzamento (default Infinity = desligado).
 *   debounceMs: janela pós-cruzamento em que novos cruzamentos do MESMO track na MESMA
 *               linha são ignorados (default 0 = desligado).
 *   minCrossingFrames: HISTERESE multi-update — o lado novo precisa se sustentar por N
 *                      updates consecutivos antes de contar (o update do cruzamento é o 1º).
 *                      Default 1 = conta imediato.
 */
function createCounter(tripwires = [], opts = {}) {
  const minMove = opts.minMove ?? 0.01;
  const ttl = opts.ttl ?? 1500;
  const maxDist = opts.maxDist ?? Number.POSITIVE_INFINITY;
  const debounceMs = opts.debounceMs ?? 0;
  const minCrossingFrames = Math.max(1, opts.minCrossingFrames ?? 1);

  let wires = tripwires.map(cloneWire);
  const counts = new Map();
  const last = new Map();
  let frameClock = 0; // relógio de fallback (frames) quando `now` não é informado

  for (const w of wires) counts.set(w.id, { in: 0, out: 0 });

  // Conta 1 cruzamento (respeitando o debounce por track×linha) e emite o evento.
  // Usado no caminho imediato (minCrossingFrames=1) e na CONFIRMAÇÃO da histerese.
  function tryCount(prev, trackId, w, dir, x, y, t, events) {
    if (debounceMs > 0) {
      const lastAt = prev.crossAt?.get(w.id);
      if (lastAt !== undefined && t - lastAt < debounceMs) return;
      (prev.crossAt ??= new Map()).set(w.id, t);
    }
    const c = counts.get(w.id) ?? { in: 0, out: 0 };
    c[dir] += 1;
    counts.set(w.id, c);
    events.push({ tripwireId: w.id, trackId, dir, x, y });
  }

  /**
   * Chamar 1x por frame com os tracks atuais ({id, cx, cy, foot?}, coords
   * normalizadas; `foot` presente → TODO o julgamento usa o pé do bbox).
   * Retorna os eventos de cruzamento ocorridos NESTE frame.
   */
  function update(tracks, now) {
    const t = now ?? ++frameClock;
    const events = [];
    const seen = new Set();

    for (const tr of tracks) {
      seen.add(tr.id);
      const prev = last.get(tr.id);
      // Âncora do julgamento: PÉ do bbox quando presente; senão o centróide.
      const cur = tr.foot ? { x: tr.foot.x, y: tr.foot.y } : { x: tr.cx, y: tr.cy };
      if (!prev) {
        last.set(tr.id, { x: cur.x, y: cur.y, lastSeen: t });
        continue;
      }
      const stale = t - prev.lastSeen > ttl; // gap sem update → continuidade perdida
      prev.lastSeen = t; // visto neste frame (mantém vivo p/ TTL)
      const moved = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const lost = stale || moved > maxDist; // continuidade perdida (gap/teleporte)
      // HISTERESE: confirma/cancela pendências ANTES do gate de minMove — quem cruza e
      // PARA em cima do lado novo também confirma. Num frame de continuidade perdida
      // não se confirma nada (não inventa contagem).
      if (!lost && prev.pending?.size) {
        for (const w of wires) {
          const pd = prev.pending.get(w.id);
          if (!pd) continue;
          const s = orient(w.a, w.b, cur);
          const side = pd.dir === "in" ? s : -s; // >0 sustenta o lado novo; <0 voltou (jitter)
          if (side > 0) {
            pd.sustained += 1;
            if (pd.sustained >= minCrossingFrames) {
              prev.pending.delete(w.id);
              tryCount(prev, tr.id, w, pd.dir, pd.x, pd.y, t, events);
            }
          } else if (side < 0) prev.pending.delete(w.id); // jitter de 1 frame: não conta
        }
      }
      // micro-jitter: acumula deslocamento (NÃO atualiza last-pos) até passar o limiar.
      if (moved < minMove) continue;
      // continuidade perdida (gap > ttl) ou TELEPORTE (salto > maxDist): re-ancora a
      // posição sem avaliar cruzamento e descarta pendências.
      if (lost) {
        prev.x = cur.x;
        prev.y = cur.y;
        prev.pending?.clear();
        continue;
      }

      const from = { x: prev.x, y: prev.y };
      for (const w of wires) {
        if (!segmentsIntersect(from, cur, w.a, w.b)) continue;
        const d1 = orient(w.a, w.b, from);
        const d2 = orient(w.a, w.b, cur);
        let dir = null;
        if (d1 < 0 && d2 > 0) dir = "in";
        else if (d1 > 0 && d2 < 0) dir = "out";
        if (!dir) continue;
        const ip = intersectionPoint(from, cur, w.a, w.b);
        if (minCrossingFrames > 1) {
          // histerese ligada: NÃO conta ainda — o lado novo precisa se sustentar nos
          // próximos updates (este é o 1º). Um novo cruzamento substitui a pendência.
          (prev.pending ??= new Map()).set(w.id, { dir, x: ip.x, y: ip.y, sustained: 1 });
        } else {
          tryCount(prev, tr.id, w, dir, ip.x, ip.y, t, events);
        }
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

  /** Snapshot dos contadores por tripwire (cópia; seguro de guardar/mutar). */
  function snapshot() {
    const out = {};
    for (const w of wires) {
      const c = counts.get(w.id) ?? { in: 0, out: 0 };
      out[w.id] = { in: c.in, out: c.out };
    }
    return out;
  }

  /** Soma de todas as tripwires. */
  function totals() {
    let cin = 0,
      cout = 0;
    for (const w of wires) {
      const c = counts.get(w.id);
      if (c) {
        cin += c.in;
        cout += c.out;
      }
    }
    return { in: cin, out: cout };
  }

  /** Substitui a geometria das linhas preservando contadores das que continuam (por id). */
  function setTripwires(next) {
    wires = next.map(cloneWire);
    const keep = new Set(wires.map((w) => w.id));
    for (const id of [...counts.keys()]) if (!keep.has(id)) counts.delete(id);
    for (const w of wires) if (!counts.has(w.id)) counts.set(w.id, { in: 0, out: 0 });
  }

  /** Zera contadores e o histórico de posições (geometria mantida). */
  function reset() {
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

function cloneWire(w) {
  return { id: w.id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } };
}

// ── Heatmap de ocupação (grade com decaimento temporal) ──────────────────────

/**
 * Cria um heatmap de ocupação em grade normalizada com decaimento temporal.
 * @param {{ cols: number, rows: number, decay: number, addAmount?: number,
 *           max?: number, decayOnAdd?: boolean }} options
 *   decay: fator de decaimento por frame (0..1). addAmount: incremento base por
 *   ponto (default 0.6). max: teto do valor cru por célula (default 6).
 *   decayOnAdd (default true): add() aplica UM passo de decaimento antes de somar.
 */
function createOccupancy(options) {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const decay = clamp01(options.decay);
  const addAmount = options.addAmount ?? 0.6;
  const max = options.max ?? 6;
  const decayOnAdd = options.decayOnAdd ?? true;

  const raw = new Float32Array(cols * rows);
  const normBuf = new Float32Array(cols * rows);
  const dwellBuf = new Float32Array(cols * rows);

  /** Aplica apenas um passo de decaimento (p/ frames pausados/sem detecções). */
  function decayStep() {
    for (let i = 0; i < raw.length; i++) raw[i] *= decay;
  }

  /**
   * Acumula os pontos ({x,y,weight?}, coords normalizadas) do frame na grade.
   * Por padrão aplica 1 passo de decaimento ANTES de somar — chame 1x por frame.
   */
  function add(points) {
    if (decayOnAdd) decayStep();
    for (const p of points) {
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue; // fora do frame
      const c = clampInt(Math.floor(p.x * cols), 0, cols - 1);
      const r = clampInt(Math.floor(p.y * rows), 0, rows - 1);
      const k = r * cols + c;
      raw[k] = Math.min(max, raw[k] + addAmount * (p.weight ?? 1));
    }
  }

  /** Grade NORMALIZADA 0..1 (valor cru / máximo atual). Buffer reutilizado: copie p/ reter. */
  function grid() {
    let m = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] > m) m = raw[i];
    if (m <= 0) {
      normBuf.fill(0);
      return normBuf;
    }
    for (let i = 0; i < raw.length; i++) normBuf[i] = raw[i] / m;
    return normBuf;
  }

  /**
   * Aproximação de "dwell time" (segundos) por célula. Buffer reutilizado.
   * MÉTRICA RELATIVA de permanência recente (ver comentário no TS de origem);
   * para dwell EXATO por área use timers de presença por zona.
   */
  function dwellSeconds(fps) {
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

  /** Zera a grade. */
  function reset() {
    raw.fill(0);
  }

  return { cols, rows, add, decayStep, grid, rawGrid: () => raw, dwellSeconds, reset };
}

// ── utils ────────────────────────────────────────────────────────────────────

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = {
  orient,
  segmentsIntersect,
  inwardNormal,
  centroidOfBBox,
  createCounter,
  createOccupancy,
};
