// ─────────────────────────────────────────────────────────────────────────────
// zones.js — PORT da atribuição de zona de src/CameraWorkspace.tsx (zoneAtAtiv,
// ~linha 614) + do subconjunto de máscara de src/zoneMask.ts que ela consome —
// mudanças de comportamento devem ser feitas LÁ e re-portadas; os testes
// (zones.test.js) garantem paridade. CommonJS, JS puro, SEM dependências
// (motor de análise server-side, F1 do plano-analise-server-side).
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
//   attributeZone(bboxOuPonto, zones) → label | null
//     bboxOuPonto: [x,y,w,h] normalizado (Track.bbox) OU ponto {x,y} / {cx,cy}.
//     zones: Array<{ label, x, y, w, h, mask? }> (Zone de src/zones.ts).
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
 * Zona da pessoa/objeto. Ver critério no cabeçalho.
 * @param {[number,number,number,number] | {x?:number,y?:number,cx?:number,cy?:number}} target
 *   bbox normalizado [x,y,w,h] (o centro é derivado dele — Track.cx/cy É o centro
 *   do bbox no bytetrack) OU um ponto {x,y}/{cx,cy} (sem desempate por overlap).
 * @param {Array<{label:string,x:number,y:number,w:number,h:number,mask?:string}>} zones
 * @returns {string | null} label da zona vencedora, ou null.
 */
function attributeZone(target, zones) {
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
    const mc = maskFor(z.mask);
    if (mc && mc.any && !containsNorm(mc.mask, cx, cy)) continue;
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
  return best ? (best.label ?? null) : null;
}

// ── zona de exclusão (calibração — analises/acuracia-modelos.md Medida A) ────
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
    const mc = maskFor(z.mask);
    if (mc && mc.any && !containsNorm(mc.mask, fx, fy)) continue; // fora da máscara → não exclui
    return true;
  }
  return false;
}

module.exports = {
  attributeZone,
  inExclusionZone,
  // helpers de máscara (mesma semântica do zoneMask.ts; exportados p/ testes/engine)
  createMask,
  anySet,
  containsNorm,
  fillRectNorm,
  encodeMask,
  decodeMask,
};
