// ── Helpers PUROS de desenho do CameraWorkspace ──────────────────────────────
// Extraídos do CameraWorkspace.tsx (R2.1) SEM mudança de comportamento: geometria
// do letterbox, resolução de tokens p/ o canvas (going-gray) e desenhos folha
// (overlay de fadiga na zona, quadro de revisão do cine-loop). Funções puras /
// testáveis; o desenho do palco completo (`drawScene`) segue no componente porque
// fecha sobre vários refs/estado do React.
import { APP_CONFIG } from "../config";
import { type ZoneState } from "../processors/atividade";
import { type RiskState } from "../fadiga/landmarks";
import { type FadigaScene } from "../fadiga/draw";
import { type CineFrame } from "./cineBuffer";

// Retângulo de conteúdo (letterbox): ajusta o vídeo no viewport preservando aspecto.
export type Rect = { x: number; y: number; w: number; h: number };
export function getContentRect(vpW: number, vpH: number, vidW: number, vidH: number): Rect {
  if (!vidW || !vidH) return { x: 0, y: 0, w: vpW, h: vpH };
  const s = Math.min(vpW / vidW, vpH / vidH);
  const w = vidW * s,
    h = vidH * s;
  return { x: (vpW - w) / 2, y: (vpH - h) / 2, w, h };
}

// ── Tokens da FUNDAÇÃO (Onda A) resolvidos p/ o canvas ──
// O canvas precisa de cores literais; lemos as CSS vars de :root (index.css) e cacheamos.
// Assim a tela de câmera CONSOME os tokens em vez de cores hardcoded ("going gray").
const _cssCache = new Map<string, string>();
export function cssVar(name: string, fallback: string): string {
  let v = _cssCache.get(name);
  if (v === undefined) {
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch {
      v = "";
    }
    if (!v) v = fallback;
    _cssCache.set(name, v);
  }
  return v;
}
// Going-gray: estado de ATIVIDADE → token semântico (canvas).
// ATIVA→neutral · LENTA/OCIOSA→warn · VAZIA→neutral-dim · ALERTA→critical.
export function stateCanvasColor(s: ZoneState): string {
  switch (s) {
    case "ALERTA":
      return cssVar("--state-critical", "#ef4444");
    case "OCIOSA":
    case "LENTA":
      return cssVar("--state-warn", "#eab308");
    case "VAZIA":
      return cssVar("--state-neutral-dim", "#5b6b7a");
    default:
      return cssVar("--state-neutral", "#64748b"); // ATIVA (normal → neutro)
  }
}
// Mesma semântica p/ inline styles do painel lateral (var() resolvido pelo CSS).
export function stateVar(s: ZoneState): string {
  switch (s) {
    case "ALERTA":
      return "var(--state-critical)";
    case "OCIOSA":
    case "LENTA":
      return "var(--state-warn)";
    case "VAZIA":
      return "var(--state-neutral-dim)";
    default:
      return "var(--state-neutral)";
  }
}
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = (
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h
  ).slice(0, 6);
  const n = parseInt(s || "000000", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// risco → cor/rótulo (going-gray: OK normal → neutro; fadiga/celular → warn; duplo → critical)
export function riskCanvasColor(r: RiskState): string {
  return r === "ALERTA_DUPLO"
    ? cssVar("--state-critical", "#ef4444")
    : r === "OK"
      ? cssVar("--state-neutral", "#64748b")
      : cssVar("--state-warn", "#eab308");
}

// Overlay compacto de fadiga DENTRO do retângulo da zona (olhos/boca + bbox de celular).
// Landmarks são normalizados ao recorte → mapeados direto no rect da zona. (Mesh completo fica na câmera dedicada.)
const FAD_LEFT = APP_CONFIG.fadiga.eyeIndices.left,
  FAD_RIGHT = APP_CONFIG.fadiga.eyeIndices.right,
  FAD_MOUTH = APP_CONFIG.fadiga.mouthIndices.draw;
export function drawFadigaZone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  s: FadigaScene,
) {
  const lm = s.landmarks;
  if (lm && lm.length) {
    ctx.fillStyle = "rgba(56,189,248,0.95)";
    for (const idx of [...FAD_LEFT, ...FAD_RIGHT]) {
      const p = lm[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(x + p.x * w, y + p.y * h, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = s.yawnDetected ? "rgba(248,113,113,0.95)" : "rgba(251,191,36,0.95)";
    for (const idx of FAD_MOUTH) {
      const p = lm[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(x + p.x * w, y + p.y * h, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (s.phone) {
    const vw = s.videoWidth || w,
      vh = s.videoHeight || h;
    ctx.strokeStyle = "rgba(250,204,21,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      x + (s.phone.x / vw) * w,
      y + (s.phone.y / vh) * h,
      (s.phone.width / vw) * w,
      (s.phone.height / vh) * h,
    );
  }
}

// ── CONGELAR + CINE-LOOP: render do quadro em revisão ──
// Desenha SÓ a imagem do buffer (letterbox idêntico ao ao vivo) + HUD de tempo relativo.
// Não reusa os overlays do ao vivo: eles correspondem ao frame corrente, não ao quadro revisado.
export function drawReviewFrame(
  canvas: HTMLCanvasElement,
  viewport: HTMLDivElement,
  fr: CineFrame,
) {
  const dpr = window.devicePixelRatio || 1;
  const vpW = viewport.clientWidth,
    vpH = viewport.clientHeight;
  if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) {
    canvas.width = Math.round(vpW * dpr);
    canvas.height = Math.round(vpH * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vpW, vpH);
  const cr = getContentRect(vpW, vpH, fr.w, fr.h);
  ctx.drawImage(fr.bmp, cr.x, cr.y, cr.w, cr.h);
}
