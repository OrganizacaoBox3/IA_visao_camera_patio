// ─────────────────────────────────────────────────────────────────────────────
// zones.js — PORT da atribuição de zona de src/CameraWorkspace.tsx (zoneAtAtiv)
// + do subconjunto de máscara de src/zoneMask.ts que ela consome — mudanças de
// comportamento devem ser feitas LÁ e re-portadas; os testes (zones.test.js) cobrem
// ESTE lado (paridade cross-language é residual: revisão em par). CommonJS, JS puro, SEM dependências.
//
// CRITÉRIO (idêntico ao zoneAtAtiv do CameraWorkspace):
//   PRIMÁRIO — centro do bbox (ou o ponto dado) DENTRO do retângulo da zona,
//   respeitando a MÁSCARA quando a zona tem células pintadas (área irregular).
//   Com zonas SOBREPOSTAS, desempata pela MAIOR área de interseção bbox∩zona
//   (a zona que mais "contém" o corpo vence); persistindo o empate, vence a
//   zona de MENOR área (a mais específica); persistindo ainda, a PRIMEIRA da
//   lista. Sem bbox (só ponto), todas as candidatas têm overlap 0 → vence a de
//   menor área.
//
// MÁSCARA — 100% PORTÁVEL (nenhuma divergência de comportamento): a máscara é
// grade de bits (Uint8Array) serializada como "<cols>x<rows>:<base64>"
// (zoneMask.ts) — não depende de canvas/ImageData. Única adaptação: o base64
// usa Buffer em vez de atob/btoa (mesmo resultado; entrada malformada é
// validada por regex p/ manter o contrato "inválido → null" do atob).
//
// COORDENADAS: tudo NORMALIZADO 0..1, origem topo-esquerda — mesmo sistema de
// bytetrack.js/counting.js. O caller pré-filtra as zonas por modo ("atividade"),
// como o CameraWorkspace faz — esta função não filtra.
//
// API:
//   resolveZone(bboxOuPonto, zones) → a ZONA vencedora (o objeto) | null
//   attributeZone(bboxOuPonto, zones) → label | null   (= resolveZone(...)?.label ?? null)
//     bboxOuPonto: [x,y,w,h] normalizado (Track.bbox) OU ponto {x,y} / {cx,cy}.
//     zones: Array<{ id?, label, x, y, w, h, mask?, points? }> (Zone de src/zones.ts).
//
// POR QUE DUAS FUNÇÕES (e por que a nova é a MAIS fiel ao TS): o espelho no cliente
// (src/zones.ts assignZone) devolve a ZONA; quem quer o rótulo faz `?.label ?? null` no
// call-site (CameraWorkspace.tsx:614). Este port nasceu já colapsado no rótulo — e o rótulo
// NÃO é identidade: duas zonas homônimas (o caminho PADRÃO, já que camcfg rotula toda zona sem
// nome como "Área") são indistinguíveis por ele. Isso somava a contagem de uma na outra
// (bug medido 2026-07-26; ver pipeline.test.js "zonas HOMÔNIMAS"). `resolveZone` é o 1:1 do
// assignZone (mesma regra, mesmo desempate, mesmo retorno) e `attributeZone` passou a ser o
// wrapper de rótulo — assinatura e semântica INALTERADAS, porque ela é contrato de outros
// call-sites (presence-alert.js, camcfg.test.js) e do par de paridade zones.test.ts/js.
// Quem precisa de IDENTIDADE (contagem por zona) usa resolveZone; quem precisa de TEXTO
// (overlay, alarme) usa attributeZone. Mudança de COMPORTAMENTO segue sendo feita no TS e
// re-portada aqui — não há comportamento novo nesta dupla, só o retorno que o TS já tinha.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// ── máscara em grade (port do subconjunto usado de src/zoneMask.ts) ──────────

/** @returns {{cols:number, rows:number, bits:Uint8Array}} */
function createMask(cols, rows) {
  return { cols, rows, bits: new Uint8Array(cols * rows) };
}

function anySet(m) {
  return m.bits.some((b) => b === 1);
}

/** célula que contém um ponto NORMALIZADO (0..1) do frame */
function cellAtNorm(m, nx, ny) {
  return {
    col: Math.min(m.cols - 1, Math.max(0, Math.floor(nx * m.cols))),
    row: Math.min(m.rows - 1, Math.max(0, Math.floor(ny * m.rows))),
  };
}

function containsNorm(m, nx, ny) {
  const { col, row } = cellAtNorm(m, nx, ny);
  return m.bits[row * m.cols + col] === 1;
}

/** pinta/apaga um retângulo NORMALIZADO (útil p/ montar máscaras em teste/seed) */
function fillRectNorm(m, x, y, w, h, on) {
  const c0 = Math.max(0, Math.floor(x * m.cols)),
    c1 = Math.min(m.cols - 1, Math.ceil((x + w) * m.cols) - 1);
  const r0 = Math.max(0, Math.floor(y * m.rows)),
    r1 = Math.min(m.rows - 1, Math.ceil((y + h) * m.rows) - 1);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m.bits[r * m.cols + c] = on ? 1 : 0;
}

/** serializa: "<cols>x<rows>:<base64 dos bits empacotados>" (mesmo formato do zoneMask.ts) */
function encodeMask(m) {
  const bytes = new Uint8Array(Math.ceil(m.bits.length / 8));
  for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  return `${m.cols}x${m.rows}:${Buffer.from(bytes).toString("base64")}`;
}

/** desserializa; null p/ entrada ausente/malformada (paridade com o atob que lança) */
function decodeMask(str) {
  if (!str) return null;
  const sep = str.indexOf(":");
  if (sep < 0) return null;
  const dims = str.slice(0, sep).split("x");
  const cols = Number(dims[0]),
    rows = Number(dims[1]);
  if (!cols || !rows) return null;
  const b64 = str.slice(sep + 1);
  // atob (browser) LANÇA em base64 inválido → null; Buffer é leniente — validamos antes.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const raw = Buffer.from(b64, "base64");
  const m = createMask(cols, rows);
  for (let i = 0; i < m.bits.length; i++) {
    const byte = raw[i >> 3] || 0;
    m.bits[i] = (byte >> (i & 7)) & 1;
  }
  return m;
}

// ── ZONA POLIGONAL (spec zonas-poligonais F1) — espelhos byte-a-byte do TS ───
// pointInPolygon: cópia EXATA de src/fusion/floor-polygon.ts (ray casting par/ímpar). Mudou lá,
// re-porta AQUI — o sensor de paridade cross-language são as fixtures compartilhadas
// src/zones-polygon-fixtures.json (CA-4), consumidas por zones.test.ts E zones.test.js.
// Ponto exatamente sobre aresta: determinístico, sem garantia dentro/fora (documentado lá).

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec = (v) => !!v && typeof v === "object" && isFiniteNum(v.x) && isFiniteNum(v.y);

function pointInPolygon(p, polygon) {
  if (!isVec(p) || !Array.isArray(polygon) || polygon.length < 3) return false;
  const n = polygon.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses) {
      const xIntersect = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

// Validação do polígono — espelho de src/zones.ts (isSimplePolygon/sanitizeZonePoints/
// polygonBBox; comentários de decisão vivem LÁ). Consumida por camcfg.js (cleanZone).
const POLYGON_MIN_POINTS = 3;
const POLYGON_MAX_POINTS = 20;
const clampCoord = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function onSegment(p, q, r) {
  return (
    Math.min(p.x, r.x) <= q.x &&
    q.x <= Math.max(p.x, r.x) &&
    Math.min(p.y, r.y) <= q.y &&
    q.y <= Math.max(p.y, r.y)
  );
}
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  if (d1 === 0 && onSegment(p3, p1, p4)) return true;
  if (d2 === 0 && onSegment(p3, p2, p4)) return true;
  if (d3 === 0 && onSegment(p1, p3, p2)) return true;
  if (d4 === 0 && onSegment(p1, p4, p2)) return true;
  return false;
}
function isSimplePolygon(pts) {
  const n = pts.length;
  if (n < POLYGON_MIN_POINTS) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // arestas adjacentes compartilham vértice
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  return true;
}
/** malformado → undefined, NUNCA [] (armadilha 8); válido → vértices clampados 0..1 */
function sanitizeZonePoints(raw) {
  if (!Array.isArray(raw) || raw.length < POLYGON_MIN_POINTS || raw.length > POLYGON_MAX_POINTS)
    return undefined;
  const pts = [];
  for (const p of raw) {
    const x = p ? p.x : undefined;
    const y = p ? p.y : undefined;
    if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
    if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
    pts.push({ x: clampCoord(x), y: clampCoord(y) });
  }
  return isSimplePolygon(pts) ? pts : undefined;
}
/** bbox derivada dos vértices (padrão maskBBoxNorm) — o pré-filtro retangular segue válido */
function polygonBBox(pts) {
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}
/** polígono efetivo da zona (já saneado por cleanZone) ou null — espelho de zonePolygon */
function polygonOf(z) {
  const p = z.points;
  return Array.isArray(p) && p.length >= POLYGON_MIN_POINTS ? p : null;
}

/**
 * P6 — RASTERIZAÇÃO do polígono numa grade (espelho byte-a-byte de rasterizePolygonMask em
 * src/zones.ts). Quem consome POR PIXEL não chama pointInPolygon por pixel/frame: o polígono
 * é rasterizado 1× e o laço consome a grade. Um mecanismo, dois consumos — EXATO por ponto
 * (attributeZone/inExclusionZone), RASTERIZADO por pixel. Critério da célula: o CENTRO dela
 * dentro do polígono (determinístico).
 * No hub o consumidor é o GATE DE MOVIMENTO (engine.buildMotionIgnore, grade 64×48 do thumbnail):
 * rasterizar é o que impede a exclusão poligonal de cegar o gate na ENVOLVENTE dela.
 * @param {number} cols @param {number} rows @param {Array<{x:number,y:number}>} pts
 * @returns {{cols:number, rows:number, bits:Uint8Array}}
 */
function rasterizePolygonMask(cols, rows, pts) {
  const m = createMask(cols, rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (pointInPolygon({ x: (c + 0.5) / cols, y: (r + 0.5) / rows }, pts))
        m.bits[r * cols + c] = 1;
  return m;
}

// Cache de máscaras decodificadas (config de zona muda raramente; o motor chama
// attributeZone por track × rodada). Chave = string codificada. Cap defensivo.
const maskCache = new Map();
function maskFor(enc) {
  if (!enc) return null;
  let c = maskCache.get(enc);
  if (c === undefined) {
    if (maskCache.size >= 256) maskCache.clear();
    const mask = decodeMask(enc);
    c = mask ? { mask, any: anySet(mask) } : null;
    maskCache.set(enc, c);
  }
  return c;
}

// ── atribuição de zona (port 1:1 do zoneAtAtiv) ──────────────────────────────

/**
 * Zona da pessoa/objeto — devolve a ZONA (identidade preservada). Ver critério no cabeçalho.
 * Espelho 1:1 de assignZone (src/zones.ts): mesma candidatura (centro no retângulo + teste fino
 * points>mask) e mesmo desempate (maior interseção, depois menor área, depois a 1ª da lista).
 * @param {[number,number,number,number] | {x?:number,y?:number,cx?:number,cy?:number}} target
 *   bbox normalizado [x,y,w,h] (o centro é derivado dele — Track.cx/cy É o centro
 *   do bbox no bytetrack) OU um ponto {x,y}/{cx,cy} (sem desempate por overlap).
 * @template {{x:number,y:number,w:number,h:number,label?:string,mask?:string}} Z
 * @param {Array<Z>} zones
 * @returns {Z | null} a zona vencedora, ou null.
 */
function resolveZone(target, zones) {
  let bbox = null;
  let cx, cy;
  if (Array.isArray(target)) {
    bbox = target;
    cx = target[0] + target[2] / 2;
    cy = target[1] + target[3] / 2;
  } else {
    cx = target.x ?? target.cx;
    cy = target.y ?? target.cy;
  }
  if (typeof cx !== "number" || typeof cy !== "number") return null;

  let best = null;
  let bestOv = -1;
  for (const z of zones) {
    if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
    // Teste fino após o pré-filtro bbox — PRECEDÊNCIA points>mask (P5, idêntica ao cliente):
    // zona poligonal usa pointInPolygon EXATO no CENTRO (âncora preservada, CA-6); a máscara
    // vira legado quando points existe. Sem points: caminho de máscara intocado (CA-5).
    const poly = polygonOf(z);
    if (poly) {
      if (!pointInPolygon({ x: cx, y: cy }, poly)) continue;
    } else {
      const mc = maskFor(z.mask);
      if (mc && mc.any && !containsNorm(mc.mask, cx, cy)) continue;
    }
    let ov = 0;
    if (bbox) {
      const ix = Math.min(bbox[0] + bbox[2], z.x + z.w) - Math.max(bbox[0], z.x);
      const iy = Math.min(bbox[1] + bbox[3], z.y + z.h) - Math.max(bbox[1], z.y);
      ov = Math.max(0, ix) * Math.max(0, iy);
    }
    if (!best || ov > bestOv || (ov === bestOv && z.w * z.h < best.w * best.h)) {
      best = z;
      bestOv = ov;
    }
  }
  return best;
}

/**
 * Rótulo da zona da pessoa/objeto — wrapper de resolveZone (idêntico ao `?.label ?? null` que o
 * cliente faz sobre o assignZone). Contrato INALTERADO: mesma assinatura, mesmo retorno.
 * NÃO usar para CONTAR por zona — rótulo não é identidade (duas zonas podem ter o mesmo).
 * @param {[number,number,number,number] | {x?:number,y?:number,cx?:number,cy?:number}} target
 * @param {Array<{label:string,x:number,y:number,w:number,h:number,mask?:string}>} zones
 * @returns {string | null} label da zona vencedora, ou null.
 */
function attributeZone(target, zones) {
  const best = resolveZone(target, zones);
  return best ? (best.label ?? null) : null;
}

/**
 * Zona por SOBREPOSIÇÃO — espelho 1:1 de assignZoneByOverlap (src/zones.ts). Usada SÓ para
 * contagem de PESSOA em zona modo "objetos" (decisão de produto igual ao cliente: basta parte
 * da caixa estar na área, não o centro — resolveZone/centro é estrito demais e sub-conta gente
 * na borda). Mesmo desempate de resolveZone (maior interseção, depois menor área). NÃO usar
 * para atividade/tripwire/proibida — essas mantêm o critério de centro (resolveZone).
 * @param {[number,number,number,number]} bbox
 * @param {Array<{id?:string,label:string,x:number,y:number,w:number,h:number,mask?:string,points?:Array<{x:number,y:number}>}>} zones
 * @returns {object | null} a zona vencedora, ou null.
 */
function resolveZoneByOverlap(bbox, zones) {
  let best = null;
  let bestOv = -1;
  for (const z of zones) {
    const ix = Math.min(bbox[0] + bbox[2], z.x + z.w) - Math.max(bbox[0], z.x);
    const iy = Math.min(bbox[1] + bbox[3], z.y + z.h) - Math.max(bbox[1], z.y);
    if (ix <= 0 || iy <= 0) continue; // sem sobreposição de retângulo → nem candidata
    const poly = polygonOf(z);
    const mc = !poly ? maskFor(z.mask) : null;
    const cn = poly
      ? (nx, ny) => pointInPolygon({ x: nx, y: ny }, poly)
      : mc && mc.any
        ? (nx, ny) => containsNorm(mc.mask, nx, ny)
        : null;
    if (cn) {
      const rx0 = Math.max(bbox[0], z.x),
        ry0 = Math.max(bbox[1], z.y);
      const rx1 = rx0 + ix,
        ry1 = ry0 + iy;
      const hit =
        cn(rx0, ry0) || cn(rx1, ry0) || cn(rx0, ry1) || cn(rx1, ry1) || cn((rx0 + rx1) / 2, (ry0 + ry1) / 2);
      if (!hit) continue; // retângulos se tocam, mas fora da máscara/polígono
    }
    const ov = ix * iy;
    if (!best || ov > bestOv || (ov === bestOv && z.w * z.h < best.w * best.h)) {
      best = z;
      bestOv = ov;
    }
  }
  return best;
}

// ── zona de exclusão (calibração — docs/analises/acuracia-modelos.md Medida A) ────
/**
 * A pessoa está numa zona de EXCLUSÃO? Critério = o PÉ (bottom-center do bbox: cx,
 * y+h) dentro do retângulo de ALGUMA zona, respeitando a MÁSCARA quando pintada.
 * Diferente do attributeZone (que usa o CENTRO): FP de objeto fixo — grade, placa,
 * janela de van — é lido no CHÃO da caixa, então ancorar no pé casa a supressão
 * exatamente onde o objeto está. Serve p/ o engine DESCARTAR a detecção ANTES de
 * tracking/contagem/ingest. `zones` já deve vir filtrado por modo ("exclusao").
 * @param {[number,number,number,number] | {x?:number,y?:number,cx?:number,cy?:number}} target
 *   bbox normalizado [x,y,w,h] (deriva o pé) OU um ponto {x,y}/{cx,cy} já no pé.
 * @param {Array<{x:number,y:number,w:number,h:number,mask?:string}>} zones
 * @returns {boolean}
 */
function inExclusionZone(target, zones) {
  if (!zones || zones.length === 0) return false;
  let fx, fy;
  if (Array.isArray(target)) {
    fx = target[0] + target[2] / 2; // pé: centro horizontal
    fy = target[1] + target[3]; //     base vertical do bbox
  } else {
    fx = target.x ?? target.cx;
    fy = target.y ?? target.cy;
  }
  if (typeof fx !== "number" || typeof fy !== "number") return false;
  for (const z of zones) {
    if (fx < z.x || fx > z.x + z.w || fy < z.y || fy > z.y + z.h) continue;
    // PRECEDÊNCIA points>mask (P5) com a âncora no PÉ preservada (CA-6 — NÃO unificar com o
    // centro do attributeZone); sem points, caminho de máscara intocado (CA-5).
    const poly = polygonOf(z);
    if (poly) {
      if (!pointInPolygon({ x: fx, y: fy }, poly)) continue; // fora do polígono → não exclui
    } else {
      const mc = maskFor(z.mask);
      if (mc && mc.any && !containsNorm(mc.mask, fx, fy)) continue; // fora da máscara → não exclui
    }
    return true;
  }
  return false;
}

module.exports = {
  resolveZone, // identidade (contagem por zona) — 1:1 do assignZone do cliente
  attributeZone, // rótulo (overlay/alarme) — wrapper de resolveZone
  resolveZoneByOverlap, // identidade por SOBREPOSIÇÃO — 1:1 do assignZoneByOverlap (só objetos+pessoa)
  inExclusionZone,
  // helpers de máscara (mesma semântica do zoneMask.ts; exportados p/ testes/engine)
  createMask,
  anySet,
  containsNorm,
  fillRectNorm,
  encodeMask,
  decodeMask,
  // helpers de POLÍGONO (espelhos de src/zones.ts + fusion/floor-polygon.ts; consumidos por
  // camcfg.js/cleanZone, pelo gate de movimento (engine.buildMotionIgnore) e pelos testes de
  // paridade — fixtures compartilhadas, CA-4)
  pointInPolygon,
  isSimplePolygon,
  sanitizeZonePoints,
  polygonBBox,
  polygonOf,
  rasterizePolygonMask,
};
