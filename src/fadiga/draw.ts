// Desenho do feed + overlay do modo Fadiga (landmarks de olhos/boca, bbox de celular/mãos, HUD).
// Adaptado de sensor_fadiga_mvp: aqui o frame é desenhado SEM espelhar (o nó envia o frame cru),
// então os landmarks são mapeados com x direto (sem 1-x).
import { APP_CONFIG } from "../config";
import type { Landmark, Rect, ManualSignal, RiskState, PhoneDetection, HandDetection } from "./landmarks";

const LEFT_EYE = APP_CONFIG.fadiga.eyeIndices.left;
const RIGHT_EYE = APP_CONFIG.fadiga.eyeIndices.right;
const MOUTH_DRAW = APP_CONFIG.fadiga.mouthIndices.draw;

type Viewport = { x: number; y: number; width: number; height: number };
function contentRect(vpW: number, vpH: number, vidW: number, vidH: number): Viewport {
  if (!vidW || !vidH) return { x: 0, y: 0, width: vpW, height: vpH };
  const s = Math.min(vpW / vidW, vpH / vidH);
  const w = vidW * s, h = vidH * s;
  return { x: (vpW - w) / 2, y: (vpH - h) / 2, width: w, height: h };
}

export type FadigaScene = {
  landmarks: Landmark[] | null;
  ear: number | null;
  mar: number | null;
  yawnDetected: boolean;
  phone: PhoneDetection;
  hands: HandDetection;
  confirmedSignal: ManualSignal;
  riskState: RiskState;
  videoWidth: number;
  videoHeight: number;
};

export function drawFadigaScene(canvas: HTMLCanvasElement, viewport: HTMLDivElement, frame: CanvasImageSource, fW: number, fH: number, data: FadigaScene) {
  const dpr = window.devicePixelRatio || 1;
  const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
  if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) { canvas.width = Math.round(vpW * dpr); canvas.height = Math.round(vpH * dpr); }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vpW, vpH);
  const cr = contentRect(vpW, vpH, fW, fH);
  ctx.drawImage(frame, cr.x, cr.y, cr.width, cr.height);

  const mapLandmark = (p: Landmark) => ({ x: cr.x + p.x * cr.width, y: cr.y + p.y * cr.height });
  const mapVideoRect = (r: Rect): Rect => ({
    x: cr.x + (r.x / (data.videoWidth || fW)) * cr.width,
    y: cr.y + (r.y / (data.videoHeight || fH)) * cr.height,
    width: (r.width / (data.videoWidth || fW)) * cr.width,
    height: (r.height / (data.videoHeight || fH)) * cr.height,
  });

  // moldura de risco (verde/âmbar/vermelho)
  const frameColor = data.riskState === "ALERTA_DUPLO" ? "rgba(248,113,113,0.98)"
    : data.riskState === "OK" ? "rgba(34,197,94,0.95)" : "rgba(250,204,21,0.98)";
  const boxW = Math.round(cr.width * 0.42), boxH = Math.round(cr.height * 0.62);
  ctx.strokeStyle = frameColor; ctx.lineWidth = 2;
  ctx.strokeRect(Math.round(cr.x + (cr.width - boxW) / 2), Math.round(cr.y + (cr.height - boxH) / 2), boxW, boxH);

  if (data.landmarks && data.landmarks.length) {
    ctx.fillStyle = "rgba(56,189,248,0.95)";
    for (const idx of [...LEFT_EYE, ...RIGHT_EYE]) { const p = data.landmarks[idx]; if (!p) continue; const m = mapLandmark(p); ctx.beginPath(); ctx.arc(m.x, m.y, 2.4, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = data.yawnDetected ? "rgba(248,113,113,0.95)" : "rgba(251,191,36,0.95)";
    for (const idx of MOUTH_DRAW) { const p = data.landmarks[idx]; if (!p) continue; const m = mapLandmark(p); ctx.beginPath(); ctx.arc(m.x, m.y, 2.8, 0, Math.PI * 2); ctx.fill(); }
    const pts = data.landmarks.map(mapLandmark);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.max(cr.x, Math.min(...xs)), minY = Math.max(cr.y, Math.min(...ys));
    const maxX = Math.min(cr.x + cr.width, Math.max(...xs)), maxY = Math.min(cr.y + cr.height, Math.max(...ys));
    ctx.strokeStyle = "rgba(56,189,248,0.85)"; ctx.lineWidth = 1.5;
    ctx.strokeRect(minX, minY, Math.max(4, maxX - minX), Math.max(4, maxY - minY));
  }

  if (data.phone) {
    const r = mapVideoRect(data.phone);
    ctx.strokeStyle = "rgba(250,204,21,0.95)"; ctx.lineWidth = 2; ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.fillStyle = "rgba(250,204,21,0.85)"; ctx.fillRect(r.x, Math.max(cr.y, r.y - 20), 120, 18);
    ctx.fillStyle = "#111827"; ctx.font = "700 12px ui-sans-serif, system-ui";
    ctx.fillText(`Celular ${(data.phone.score * 100).toFixed(0)}%`, r.x + 6, Math.max(cr.y + 13, r.y - 7));
  }

  for (const hand of data.hands) {
    const pts = hand.landmarks.map(mapLandmark);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.max(cr.x, Math.min(...xs)), minY = Math.max(cr.y, Math.min(...ys));
    const maxX = Math.min(cr.x + cr.width, Math.max(...xs)), maxY = Math.min(cr.y + cr.height, Math.max(...ys));
    ctx.strokeStyle = "rgba(167,139,250,0.95)"; ctx.lineWidth = 1.6; ctx.strokeRect(minX, minY, Math.max(4, maxX - minX), Math.max(4, maxY - minY));
    ctx.fillStyle = "rgba(167,139,250,0.92)";
    for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill(); }
    if (hand.signal !== "SEM_SINAL") {
      ctx.fillStyle = "rgba(167,139,250,0.92)"; ctx.fillRect(minX, Math.max(cr.y, minY - 20), 140, 18);
      ctx.fillStyle = "#111827"; ctx.font = "700 12px ui-sans-serif, system-ui";
      ctx.fillText(`${hand.handedness}: ${hand.signal}`, minX + 6, Math.max(cr.y + 13, minY - 7));
    }
  }
}
