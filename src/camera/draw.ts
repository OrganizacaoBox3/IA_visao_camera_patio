// ── Helpers PUROS de desenho do CameraWorkspace ──────────────────────────────
// Extraídos do CameraWorkspace.tsx (R2.1) SEM mudança de comportamento: geometria
// do letterbox, resolução de tokens p/ o canvas (going-gray) e desenhos folha
// (overlay de fadiga na zona, quadro de revisão do cine-loop). Funções puras /
// testáveis; o desenho do palco completo (`drawScene`) segue no componente porque
// fecha sobre vários refs/estado do React.
import { APP_CONFIG, type OverlayLayers } from "../config";
import { fmtDuration } from "../format";
import { type ZoneState, type ZoneView } from "../processors/atividade";
import { type FadigaModelState } from "../processors/fadiga";
import { type RiskState } from "../fadiga/landmarks";
import { type FadigaScene } from "../fadiga/draw";
import { type ObjDetection } from "../objects/detector";
import { objClass } from "../objects/catalog";
import { anySet, type Mask } from "../zoneMask";
import { ZONE_MODE_LABEL, zonePolygon, type Zone, type ZonePoint } from "../zones";
import { type CineFrame } from "./cineBuffer";
import { type Occupancy, type Tripwire, type TripwireCounts, inwardNormal } from "../vision/counting";
import { coveredByAny } from "../vision/nms";
import { worldToPixel, type Matrix3, type Vec2 } from "../vision/homography";
import type { FloorTagsView } from "../fusion/useFloorTags"; // type-only: sem ciclo (o hook não importa daqui)

// Resultado por zona guardado p/ desenho + painel. Vive aqui (perto do desenho que o
// consome) e é reimportado pelo CameraWorkspace; mover não muda comportamento.
export type ZoneResult =
  | { modo: "atividade"; view: ZoneView }
  | {
      modo: "leitura";
      lastCode: string | null;
      perMin: number;
      passes: number;
      ratePct: number;
      noReads: number;
    }
  | { modo: "objetos"; counts: Record<string, number>; total: number; dets: ObjDetection[] }
  | {
      modo: "fadiga";
      risk: RiskState;
      ear: number | null;
      phone: boolean;
      faceState: FadigaModelState;
      scene: FadigaScene;
    };

// risco → rótulo (cor de canvas via riskCanvasColor). Compartilhado com o painel/alertas do workspace.
export const RISK_LABEL: Record<RiskState, string> = {
  OK: "OK",
  ALERTA_FADIGA: "Fadiga",
  ALERTA_CELULAR: "Celular",
  ALERTA_DUPLO: "Duplo",
};

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
  // (3.3) MESMO canvas de palco do drawScene (canvasRef do CameraWorkspace): os atributos do 1º
  // getContext valem p/ sempre — pedir os MESMOS {alpha:false, desynchronized} evita depender da
  // ordem de chamada. Com alpha:false o letterbox é pintado (fillRect) na cor do fundo do palco
  // (--cam-surface-bg) em vez de clearRect (que ficaria PRETO opaco… mesma cor por sorte, mas
  // pintar explícito mantém o token como fonte da verdade).
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = cssVar("--cam-surface-bg", "#05080c");
  ctx.fillRect(0, 0, vpW, vpH);
  const cr = getContentRect(vpW, vpH, fr.w, fr.h);
  ctx.drawImage(fr.bmp, cr.x, cr.y, cr.w, cr.h);
}

// ── OVERLAYS do palco (camadas independentes do laço por-zona) ───────────────
// Extraídos de `drawScene` (R2.1, 2ª passada) SEM mudança de comportamento. São
// funções FOLHA: recebem o ctx 2D já transformado (dpr) + o retângulo de conteúdo
// (letterbox) + os dados do frame, e pintam UMA camada. Os GATES (toggles de
// camada/refs/estado) permanecem em `drawScene` no componente; aqui só o desenho.

// Heatmap de ocupação (camada) — lê a grade normalizada (0..1) da lib pura counting.ts
// e pinta com ramp warn→critical (tokens going-gray). Sob as geometrias.
export function drawOccupancyHeatmap(ctx: CanvasRenderingContext2D, cr: Rect, occ: Occupancy) {
  const g = occ.grid(),
    cols = occ.cols,
    rows = occ.rows;
  let max = 0;
  for (let i = 0; i < g.length; i++) if (g[i] > max) max = g[i];
  if (max <= 0.05) return;
  const cw = cr.w / cols,
    ch = cr.h / rows;
  const warn = hexToRgb(cssVar("--state-warn", "#eab308"));
  const crit = hexToRgb(cssVar("--state-critical", "#ef4444"));
  for (let rr = 0; rr < rows; rr++)
    for (let cc = 0; cc < cols; cc++) {
      const v = g[rr * cols + cc];
      if (v < 0.05) continue; // já é raw/max (0..1)
      const R = Math.round(warn[0] + (crit[0] - warn[0]) * v);
      const G = Math.round(warn[1] + (crit[1] - warn[1]) * v);
      const B = Math.round(warn[2] + (crit[2] - warn[2]) * v);
      ctx.fillStyle = `rgba(${R},${G},${B},${(0.12 + 0.45 * v).toFixed(3)})`;
      ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
    }
}

// Tracks anônimos (Presença) — caixas + rótulo. Atenua abaixo da confiança global.
// `inspecting` (⏸ + tela cheia) acrescenta tempo em cena/zona ao rótulo (idêntico ao original).
export type TrackBox = {
  id: number;
  score: number;
  bbox: [number, number, number, number];
  firstSeen: number;
  zone: string | null;
  // Opacidade do FADE (interpolate.ts): caixa sumindo desenha esmaecida. OPCIONAL/retrocompatível:
  // ausente → 1 (opaca). Só a câmera focada (interpolador) a passa; os demais chamadores omitem.
  opacity?: number;
};
export function drawTracks(
  ctx: CanvasRenderingContext2D,
  cr: Rect,
  tracks: ReadonlyArray<TrackBox>,
  conf: number,
  inspecting: boolean,
  // Rótulo da TAG BLE associada a esta pessoa (fusão, caminho C). Devolve o nome quando há confiança;
  // null = "não sei" → cai no genérico "Pessoa". Ausente = feature desligada (comportamento de sempre).
  labelFor?: (trackId: number) => string | null,
) {
  ctx.lineWidth = 1.5;
  const personStroke = cssVar("--state-info", "#38bdf8");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.7)");
  const personFg = cssVar("--state-info-fg", "#bae6fd");
  for (const t of tracks) {
    // Atenuação do slider de confiança (score<conf) × opacidade do fade (caixa sumindo). O fade
    // é opcional (default 1) → o full agora mostra a caixa esmaecer ao expirar, como a grade.
    ctx.globalAlpha = (t.score < conf ? 0.3 : 1) * (t.opacity ?? 1);
    const x = cr.x + t.bbox[0] * cr.w,
      y = cr.y + t.bbox[1] * cr.h,
      w = t.bbox[2] * cr.w,
      h = t.bbox[3] * cr.h;
    ctx.strokeStyle = personStroke;
    ctx.strokeRect(x, y, w, h);
    // INVARIANTE DE RENDERIZAÇÃO (decisão do dono, 2026-07-12): a caixa da pessoa NUNCA exibe
    // NÚMERO — nem id de track, nem contagem. Sem tag associada, o rótulo é o genérico "Pessoa".
    // O id é detalhe interno do tracker (muda a cada re-associação) e não significa nada para o
    // operador; contagem de pessoas vive no PAINEL, não sobre a imagem ("a imagem é soberana").
    const who = labelFor?.(t.id) || "Pessoa";
    const tag = inspecting
      ? `${who} · ${fmtDuration(performance.now() - t.firstSeen)}${t.zone ? " · " + t.zone : ""}`
      : who;
    ctx.font = inspecting ? "bold 12px ui-sans-serif, system-ui" : "10px monospace";
    const tw = ctx.measureText(tag).width + 8;
    ctx.fillStyle = scrim;
    ctx.fillRect(x, y - 15, tw, 14);
    ctx.fillStyle = personFg;
    ctx.fillText(tag, x + 4, y - 4);
  }
  ctx.globalAlpha = 1;
}

// Tripwires (linhas de contagem com direção) — linha a→b + seta da direção "in"
// (via inwardNormal, compensando o aspecto do letterbox) + HUD in/out por linha.
export function drawTripwires(
  ctx: CanvasRenderingContext2D,
  cr: Rect,
  wires: ReadonlyArray<Tripwire>,
  counts: Record<string, TripwireCounts>,
  // Na GRADE a contagem fica pausada (detecção esparsa "teleporta" os tracks — contar seria
  // inventar número); o HUD declara o estado em vez de mostrar contadores parados sem explicação.
  paused = false,
  // (1.2) Acumulado do DIA vindo do servidor (loadFlowToday), somado à sessão no HUD — a
  // contagem exibida sobrevive a reload/reabertura. Ausente/erro de load → só a sessão (como antes).
  base?: Record<string, TripwireCounts>,
) {
  if (!wires.length) return;
  const info = cssVar("--state-info", "#38bdf8");
  const neutral = cssVar("--state-neutral", "#64748b");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  for (let wi = 0; wi < wires.length; wi++) {
    const w = wires[wi];
    const ax = cr.x + w.a.x * cr.w,
      ay = cr.y + w.a.y * cr.h;
    const bx = cr.x + w.b.x * cr.w,
      by = cr.y + w.b.y * cr.h;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = info;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.fillStyle = info;
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, Math.PI * 2);
    ctx.fill();
    // seta da direção "in": normal mapeada p/ tela (compensa o aspecto do letterbox) a partir do ponto médio
    const n = inwardNormal(w);
    let dx = n.x * cr.w,
      dy = n.y * cr.h;
    const dl = Math.hypot(dx, dy) || 1;
    const AR = 16;
    dx = (dx / dl) * AR;
    dy = (dy / dl) * AR;
    const mx = (ax + bx) / 2,
      my = (ay + by) / 2,
      ex = mx + dx,
      ey = my + dy;
    ctx.strokeStyle = neutral;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const ang = Math.atan2(dy, dx),
      ha = 0.5,
      hl = 6;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(ang - ha), ey - hl * Math.sin(ang - ha));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(ang + ha), ey - hl * Math.sin(ang + ha));
    ctx.stroke();
    // HUD discreto: in/out "hoje" por linha (acumulado do servidor + sessão corrente),
    // do lado oposto à seta p/ não cobri-la.
    const c = counts[w.id] ?? { in: 0, out: 0 };
    const b = base?.[w.id];
    const tin = (b?.in ?? 0) + c.in,
      tout = (b?.out ?? 0) + c.out;
    const tag = paused
      ? `L${wi + 1} ⏸ conta na câmera aberta`
      : `L${wi + 1}  in ${tin}  out ${tout}`;
    ctx.font = "bold 11px ui-sans-serif, system-ui";
    const tw = ctx.measureText(tag).width + 10;
    const hx = mx - dx - tw / 2,
      hy = my - dy - 18;
    ctx.fillStyle = scrim;
    ctx.fillRect(hx, hy, tw, 16);
    ctx.fillStyle = info;
    ctx.fillText(tag, hx + 5, hy + 12);
  }
}

// ── HUD de telemetria (Fase 0.1 — retrofit de performance) — a RÉGUA da câmera aberta ──
// Overlay pequeno no canto do vídeo: FPS exibido, ms/frame na main-thread, pipeline ativo
// (hub/local) e IDADE do overlay (ms desde o último track do hub — expõe a caixa "congelada"
// a ~1fps). Going-gray: base NEUTRA; cada linha satura p/ warn SÓ na anormalidade (fps baixo,
// main-thread estourada, overlay velho). Função FOLHA/pura: pinta a partir do snapshot `s`;
// os GATES (toggle + modo full) ficam no componente. `dropped`/`recvFps` são opcionais (outra
// frente pode expô-los no FrameSource) — desenhados só quando presentes.
export type HudStats = {
  fps: number; // FPS exibido (frames desenhados/s)
  msFrame: number; // ms na main-thread por tick do rAF (rolling)
  pipeline: "hub" | "local"; // motor ativo no que o usuário vê
  overlayAgeMs: number | null; // ms desde o último payload de track do hub (null = local/sem payload)
  dropped?: number; // opcional: frames dropados na recepção
  recvFps?: number; // opcional: fps de RECEPÇÃO de frames
  // Telemetria POR ESTÁGIO dos processadores (última medição; ausente/null = estágio inativo).
  // Campos ADITIVOS/opcionais — a régua por estágio que precede qualquer ajuste de cadência.
  detectMs?: number | null; // objetos: OWL-ViT (worker)
  decodeMs?: number | null; // leitura: ZXing/BarcodeDetector
  faceMs?: number | null; // fadiga: FaceLandmarker (main-thread)
  handMs?: number | null; // fadiga: HandLandmarker (main-thread)
  objMs?: number | null; // fadiga: coco/celular (assíncrono)
  queue?: { running: number; queued: number }; // fila do scheduler global de inferência
};
// Limiares de anormalidade (going-gray: satura só acima deles).
const HUD_FPS_LOW = 12; // abaixo disso o vídeo "pula"
const HUD_MS_HI = 8; // meta do plano: <8 ms/frame na main-thread
const HUD_OVERLAY_STALE_MS = 1200; // overlay mais velho que isto = caixa congelada visível
export function drawTelemetryHud(ctx: CanvasRenderingContext2D, cr: Rect, s: HudStats) {
  const neutral = cssVar("--cam-overlay-fg", "#cbd5e1");
  const warn = cssVar("--state-warn", "#eab308");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  // [texto, anômalo?] — o anômalo satura p/ warn (going-gray).
  const lines: Array<[string, boolean]> = [
    [`${Math.round(s.fps)} fps`, s.fps > 0 && s.fps < HUD_FPS_LOW],
    [`${s.msFrame.toFixed(1)} ms/frame`, s.msFrame > HUD_MS_HI],
    [`pipe ${s.pipeline}`, false],
  ];
  if (s.overlayAgeMs != null)
    lines.push([
      `overlay ${Math.round(s.overlayAgeMs)}ms`,
      s.overlayAgeMs > HUD_OVERLAY_STALE_MS,
    ]);
  if (s.recvFps != null) lines.push([`recv ${Math.round(s.recvFps)} fps`, s.recvFps < HUD_FPS_LOW]);
  if (s.dropped != null) lines.push([`drop ${s.dropped}`, s.dropped > 0]);
  // Estágios dos processadores + fila (neutros: régua de medição, não anormalidade — going-gray).
  if (s.detectMs != null) lines.push([`owl ${Math.round(s.detectMs)} ms`, false]);
  if (s.decodeMs != null) lines.push([`zxing ${Math.round(s.decodeMs)} ms`, false]);
  if (s.faceMs != null) lines.push([`face ${Math.round(s.faceMs)} ms`, false]);
  if (s.handMs != null) lines.push([`hand ${Math.round(s.handMs)} ms`, false]);
  if (s.objMs != null) lines.push([`cel ${Math.round(s.objMs)} ms`, false]);
  if (s.queue) lines.push([`fila ${s.queue.running}/${s.queue.queued}`, false]);
  ctx.font = "11px ui-monospace, monospace";
  const lh = 14,
    pad = 5;
  let bw = 0;
  for (const [t] of lines) bw = Math.max(bw, ctx.measureText(t).width);
  const boxW = bw + pad * 2,
    boxH = lines.length * lh + pad * 2 - 2;
  // canto SUPERIOR DIREITO do retângulo de conteúdo (os rótulos de zona vivem no top-left).
  const bx = cr.x + cr.w - boxW - 6,
    by = cr.y + 6;
  ctx.fillStyle = scrim;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = lines[i][1] ? warn : neutral;
    ctx.fillText(lines[i][0], bx + pad, by + pad + i * lh);
  }
  ctx.textBaseline = "alphabetic"; // restaura o default (o resto do palco assume-o)
}

// ── Malha de CALIBRAÇÃO (homografia do chão) — camada de conferência na câmera ABERTA ──
// Feedback visual do posicionamento no piso: projeta uma GRADE métrica do chão de volta na imagem
// (worldToPixel) + marca os PONTOS que o operador cadastrou na calibração. Toggleável (opt-in) — o
// GATE (estado/ref) vive no componente; aqui só o desenho (função FOLHA/pura). Going-gray: grade em
// --state-info SUTIL (linha fina, esmaecida, "conferência"); pontos com rótulo curto da âncora/MAC.
// Coords px/world são NORMALIZADAS 0..1 → escaladas pelo retângulo de conteúdo (cr), como os demais.
export type CalibDot = { px: Vec2; world: Vec2; mac?: string };
export function drawCalibrationOverlay(
  ctx: CanvasRenderingContext2D,
  cr: Rect,
  points: ReadonlyArray<CalibDot>,
  H: Matrix3 | null,
) {
  // GRADE do chão: só com H válida. Deriva o range métrico dos `world` dos pontos e liga linhas a
  // cada `step` m (passo de ~1 m; sobe p/ retângulos grandes → ≤ ~13 linhas/eixo, como a conferência
  // do CalibrationPanel). Cada endpoint (mundo→px normalizado via worldToPixel) é escalado por `cr`.
  if (H && points.length >= 2) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of points) {
      if (p.world.x < minX) minX = p.world.x;
      if (p.world.x > maxX) maxX = p.world.x;
      if (p.world.y < minY) minY = p.world.y;
      if (p.world.y > maxY) maxY = p.world.y;
    }
    const spanX = maxX - minX,
      spanY = maxY - minY;
    if (spanX > 1e-6 && spanY > 1e-6) {
      const step = Math.max(1, Math.ceil(Math.max(spanX, spanY) / 12));
      const toPx = (wx: number, wy: number): Vec2 | null => {
        const w = worldToPixel(H, { x: wx, y: wy });
        return w ? { x: cr.x + w.x * cr.w, y: cr.y + w.y * cr.h } : null;
      };
      ctx.save();
      ctx.strokeStyle = cssVar("--state-info", "#38bdf8");
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let x = minX; x <= maxX + 1e-6; x += step) {
        const a = toPx(x, minY),
          b = toPx(x, maxY);
        if (a && b) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      }
      for (let y = minY; y <= maxY + 1e-6; y += step) {
        const a = toPx(minX, y),
          b = toPx(maxX, y);
        if (a && b) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  // PONTOS cadastrados: círculo marcado no px normalizado; rótulo curto (últimos octetos do MAC/âncora)
  // ao lado quando o ponto tiver `mac`. Going-gray: contorno --state-info, texto sobre scrim discreto.
  const dot = cssVar("--state-info", "#38bdf8");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  const fg = cssVar("--cam-overlay-fg", "#cbd5e1");
  ctx.font = "10px ui-monospace, monospace";
  for (const p of points) {
    const px = cr.x + p.px.x * cr.w,
      py = cr.y + p.px.y * cr.h;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = dot;
    ctx.fillStyle = scrim;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (p.mac) {
      const tag = p.mac.length > 5 ? p.mac.slice(-5) : p.mac; // âncora curta (ex.: "EE:FF")
      const tw = ctx.measureText(tag).width + 6;
      ctx.fillStyle = scrim;
      ctx.fillRect(px + 6, py - 7, tw, 13);
      ctx.fillStyle = fg;
      ctx.fillText(tag, px + 9, py + 3);
    }
  }
}

// ── TAGS NO CHÃO (fusão BLE) — âncoras exatas, estação e ANÉIS de distância ──
// Função FOLHA/pura: recebe a visão derivada (fusion/useFloorTags) e pinta UMA camada.
//
// COR: exceção LEGÍTIMA ao going-gray — este overlay pinta SOBRE VÍDEO (imagem arbitrária, não a
// UI neutra); cinza/neutro some na cena. Croma aqui é CONTRASTE, não estado. Não há token --cam-*
// p/ cores vivas de overlay (os --cam-* são superfície/scrim/texto) → constantes locais:
//   âncoras (losango + sufixo)            = AMARELO vivo  (FLOOR_ANCHOR)
//   anéis + rótulo "~X m" + estação       = CIANO vivo    (FLOOR_RING — distinto do azul
//                                           --state-info #38bdf8 das caixas de pessoa)
//   âncora calada há 15+ s                = VERMELHO --state-critical (anomalia real: âncora fixa
//                                           deveria ser ouvida sempre; distinto do amarelo normal)
// Textos sempre sobre SCRIM escuro (legível sobre vídeo claro). O anel segue TRACEJADO de
// propósito: comunica incerteza — RSSI dá DISTÂNCIA à estação, não posição (floor-plot.ts).
// Coords normalizadas 0..1 do frame → escaladas pelo retângulo de conteúdo (cr), como os demais.
const FLOOR_ANCHOR = "#facc15"; // amarelo vivo (= hex do --state-warn-fg; aqui é contraste, não warn)
const FLOOR_RING = "#22d3ee"; // ciano vivo
const FLOOR_SCRIM = "rgba(2,6,10,0.82)"; // scrim mais denso que o --cam-overlay-scrim (texto colorido)

// AUTO-DIAGNÓSTICO por âncora (backlog científico A4, fusion/useFloorTags.ts FloorAnchor.residualM):
// |distância real − distância prevista pelo modelo| acima disto = âncora "discordando" do modelo
// que ELA MESMA ajuda a calibrar (multipath/obstrução naquele ponto, não câmera/rede em geral).
// 1,5 m é a MESMA ordem de grandeza de DIST_BLEND_SCALE_M (fusion/associate.ts): erro mediano de
// distância que ~4 dB de ruído de RSSI já induzem sozinho no modelo log-distância — abaixo disso
// o desvio é "consistente com ruído normal"; acima, começa a cheirar a sensor mentindo.
const RESIDUAL_ANOMALY_M = 1.5;
// Âncora discordante: anel pontilhado LARANJA — deliberadamente DISTINTO do amarelo vivo
// FLOOR_ANCHOR (âncora normal) e do vermelho --state-critical (âncora offline, sem leitura há
// 15+ s): 3 estados, 3 cores — "normal" / "sinal estranho, mas viva" / "sumida". O operador não
// pode confundir "essa âncora está mentindo" com "essa âncora está muda".
const FLOOR_ANOMALY = "#f97316";

// Cache de measureText por texto (mesma técnica do TrackOverlay): fonte fixa e textos repetidos por
// muitos frames entre derivações (2 Hz); limpa se crescer demais (MACs/distâncias ao longo de horas).
const floorTextW = new Map<string, number>();
function floorTextWidth(ctx: CanvasRenderingContext2D, txt: string): number {
  let w = floorTextW.get(txt);
  if (w === undefined) {
    if (floorTextW.size > 512) floorTextW.clear();
    w = ctx.measureText(txt).width;
    floorTextW.set(txt, w);
  }
  return w;
}

export function drawFloorTags(ctx: CanvasRenderingContext2D, cr: Rect, v: FloorTagsView) {
  const critical = cssVar("--state-critical", "#ef4444");
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";

  // Estação: marcador ciano (ponto + círculo fino) — a referência dos anéis.
  if (v.station) {
    const sx = cr.x + v.station.px.x * cr.w,
      sy = cr.y + v.station.px.y * cr.h;
    ctx.fillStyle = FLOOR_RING;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = FLOOR_RING;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Anéis de distância: tracejado ciano + rótulo "nome · ~X m" no ponto do anel mais BAIXO
  // visível (perto da câmera — legível sem cobrir o centro da cena). Pontos fora do quadro só
  // saem do clip do canvas; fechar o path com pontos descartados (horizonte) vira uma corda
  // reta — aceitável no tracejado (o anel continua comunicando "distância", não contorno).
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = FLOOR_RING;
  for (const r of v.rings) {
    if (r.pixels.length < 2) continue;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(cr.x + r.pixels[0].x * cr.w, cr.y + r.pixels[0].y * cr.h);
    for (let i = 1; i < r.pixels.length; i++)
      ctx.lineTo(cr.x + r.pixels[i].x * cr.w, cr.y + r.pixels[i].y * cr.h);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
    let lp: Vec2 | null = null;
    for (const p of r.pixels)
      if (p.x >= 0.02 && p.x <= 0.98 && p.y >= 0.04 && p.y <= 0.96 && (!lp || p.y > lp.y)) lp = p;
    if (lp) {
      const dist = r.radiusM < 10 ? r.radiusM.toFixed(1) : String(Math.round(r.radiusM));
      const txt = `${r.label} · ~${dist} m`;
      const tw = floorTextWidth(ctx, txt) + 6;
      const tx = cr.x + lp.x * cr.w - tw / 2,
        ty = cr.y + lp.y * cr.h;
      ctx.fillStyle = FLOOR_SCRIM;
      ctx.fillRect(tx, ty - 6, tw, 13);
      ctx.fillStyle = FLOOR_RING;
      ctx.fillText(txt, tx + 3, ty + 4);
    }
  }
  ctx.setLineDash([]);

  // Âncoras: losango PEQUENO no px exato da calibração + sufixo do MAC (a.label, pré-computado
  // na derivação). Amarelo vivo com leitura fresca; VERMELHO quando calada há 15+ s (anomalia de
  // AUSÊNCIA). Anomalia de SINAL (auto-diagnóstico A4: a âncora discorda do modelo que ela mesma
  // calibra) é um problema DIFERENTE — âncora viva, mas RSSI incoerente — e ganha indicador
  // PRÓPRIO (anel pontilhado laranja + "±Xm" no rótulo) para não ser confundida com "offline".
  for (const a of v.anchors) {
    const ax = cr.x + a.px.x * cr.w,
      ay = cr.y + a.px.y * cr.h;
    const c = a.fresh ? FLOOR_ANCHOR : critical;
    const anomalous = a.fresh && a.residualM !== null && a.residualM > RESIDUAL_ANOMALY_M;
    const R = 5;
    ctx.beginPath();
    ctx.moveTo(ax, ay - R);
    ctx.lineTo(ax + R, ay);
    ctx.lineTo(ax, ay + R);
    ctx.lineTo(ax - R, ay);
    ctx.closePath();
    ctx.fillStyle = FLOOR_SCRIM;
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (anomalous) {
      // Anel pontilhado laranja ao redor do losango — "sensor mentindo", distinto do losango
      // vermelho de âncora muda.
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = FLOOR_ANOMALY;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ax, ay, R + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const label = anomalous ? `${a.label} ±${a.residualM!.toFixed(1)}m` : a.label;
    const labelColor = anomalous ? FLOOR_ANOMALY : c;
    const tw = floorTextWidth(ctx, label) + 6;
    ctx.fillStyle = FLOOR_SCRIM;
    ctx.fillRect(ax + 7, ay - 7, tw, 13);
    ctx.fillStyle = labelColor;
    ctx.fillText(label, ax + 10, ay + 3);
  }
  ctx.restore();
}

// Grade de pintura (ao editar a máscara de uma zona).
export function drawPaintGrid(ctx: CanvasRenderingContext2D, cr: Rect, cols: number, rows: number) {
  const cw = cr.w / cols,
    ch = cr.h / rows;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(148,163,184,0.28)";
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    ctx.moveTo(cr.x + c * cw, cr.y);
    ctx.lineTo(cr.x + c * cw, cr.y + cr.h);
  }
  for (let rr = 0; rr <= rows; rr++) {
    ctx.moveTo(cr.x, cr.y + rr * ch);
    ctx.lineTo(cr.x + cr.w, cr.y + rr * ch);
  }
  ctx.stroke();
}

// Rascunho de arraste (viewport px): retângulo de uma nova zona OU traçado de uma tripwire.
export type DragBox = { active: boolean; sx: number; sy: number; cx: number; cy: number };
export function drawZoneDraft(ctx: CanvasRenderingContext2D, d: DragBox | null) {
  if (!d?.active) return;
  const x = Math.min(d.sx, d.cx),
    y = Math.min(d.sy, d.cy);
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#38bdf8";
  ctx.strokeRect(x, y, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
  ctx.setLineDash([]);
}
export function drawTripwireDraft(ctx: CanvasRenderingContext2D, td: DragBox | null) {
  if (!td?.active) return;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = cssVar("--state-info", "#38bdf8");
  ctx.beginPath();
  ctx.moveTo(td.sx, td.sy);
  ctx.lineTo(td.cx, td.cy);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── ZONA POLIGONAL (spec zonas-poligonais F2) ────────────────────────────────

// Traça o path FECHADO do polígono no ctx (coords normalizadas → letterbox). Folha reusada
// pelo fill/stroke/clip — quem chama decide o que fazer com o path corrente.
function tracePolygon(ctx: CanvasRenderingContext2D, cr: Rect, pts: ReadonlyArray<ZonePoint>) {
  ctx.beginPath();
  ctx.moveTo(cr.x + pts[0].x * cr.w, cr.y + pts[0].y * cr.h);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(cr.x + pts[i].x * cr.w, cr.y + pts[i].y * cr.h);
  ctx.closePath();
}

// Alças de VÉRTICE (CA-7): alvos visíveis p/ o arraste na câmera aberta (o hit-test generoso
// vive no usePolygonEditor). Só no modo cheio (detailed) — o tile não edita.
function drawVertexHandles(
  ctx: CanvasRenderingContext2D,
  cr: Rect,
  pts: ReadonlyArray<ZonePoint>,
  color: string,
) {
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(cr.x + p.x * cr.w, cr.y + p.y * cr.h, 4, 0, Math.PI * 2);
    ctx.fillStyle = scrim;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// Rascunho do POLÍGONO em desenho (P1): arestas tracejadas + linha até o cursor + vértices;
// o 1º vértice ganha um ANEL (alvo de fecho generoso) quando o polígono já pode fechar (≥3).
export type PolygonDraft = { points: ZonePoint[]; cursor: ZonePoint | null };
export function drawPolygonDraft(ctx: CanvasRenderingContext2D, cr: Rect, d: PolygonDraft | null) {
  if (!d || d.points.length === 0) return;
  const info = cssVar("--state-info", "#38bdf8");
  const px = (p: ZonePoint) => ({ x: cr.x + p.x * cr.w, y: cr.y + p.y * cr.h });
  const p0 = px(d.points[0]);
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = info;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < d.points.length; i++) {
    const p = px(d.points[i]);
    ctx.lineTo(p.x, p.y);
  }
  if (d.cursor) {
    const c = px(d.cursor);
    ctx.lineTo(c.x, c.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = info;
  for (const pt of d.points) {
    const p = px(pt);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (d.points.length >= 3) {
    ctx.beginPath(); // anel do fecho: clicar aqui fecha o polígono (alvo generoso — P7)
    ctx.arc(p0.x, p0.y, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ── Laço por-zona do palco (retângulo/máscara + rótulo + detecções de objeto + overlay de fadiga) ──
// Extraído de `drawScene` (R3) SEM mudança de comportamento. Função FOLHA: recebe o ctx 2D já
// transformado (dpr), o retângulo de conteúdo (letterbox) e os dados por-zona (zonas/resultados/
// camadas/confiança/detalhe) já resolvidos pelo componente. Os GATES de camada (layers.*) e o
// `maskOf` (getMask, que fecha sobre o estado de pintura) continuam vindo do componente; aqui só o desenho.
// DECISÃO (bug de campo "2 caixas p/ 1 pessoa"): quando o TRACKER está ativo, a caixa
// de PESSOA na tela é desenhada SÓ pelo track (drawTracks, camada "caixas"). A camada
// de dets do modo "objetos" OMITE a det de pessoa já coberta por um track (IoU ≥ 0.45
// ou contenção ≥ 0.7 — mesma geometria de vision/nms.ts). Sem tracker (câmera só com
// zona de objetos: tracks vazios), as dets de pessoa seguem sendo desenhadas — nada some.
const TRACK_COVER_IOU = 0.45;
const TRACK_COVER_CONTAIN = 0.7;

// ── ZONA PROIBIDA (spec alerta-por-atividade E6) ─────────────────────────────
// Subset ESTRUTURAL do payload `analysis-tracks` + o campo `presenca` — estado do ciclo de
// vida calculado pelo MOTOR DO HUB. O produtor (zonesProibidas, contrato pinado da Onda B)
// emite `presenca: boolean` (true = VIOLADA); o hook antigo aceitava a string "VIOLADA" —
// o desenho aceita AMBOS (aditivo). Estrutural de propósito: este módulo não é dono do
// contrato do payload; só declara o que o desenho precisa.
export type HubZoneState = { id: string; label: string; people: number; presenca?: boolean | string };

// Hachura diagonal SUTIL da zona proibida quieta — identidade visual própria sem croma (E6:
// "armada" ≠ "em alarme"; o traço/hachura distingue o modo, a cor só entra na violação).
// `trace` (opcional) troca o clip retangular pelo PATH do polígono (mesma hachura — F2).
function drawProibidaHatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  trace?: () => void,
) {
  ctx.save();
  if (trace) trace();
  else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
  }
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 14;
  for (let d = -h; d < w; d += step) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawZoneOverlays(
  ctx: CanvasRenderingContext2D,
  cr: Rect,
  zones: ReadonlyArray<Zone>,
  results: Map<string, ZoneResult>,
  layers: OverlayLayers,
  conf: number,
  detailed: boolean,
  maskOf: (z: Zone) => Mask | null,
  // bboxes normalizadas dos TRACKS de pessoa já desenhados por drawTracks (mesma rodada).
  // Opcional/aditivo: ausente → comportamento anterior (todas as dets desenhadas).
  personTrackBoxes: ReadonlyArray<readonly [number, number, number, number]> = [],
  // zones[] do último payload FRESCO do hub (hubZonesRef) — estado da zona PROIBIDA.
  // Opcional/aditivo: ausente → proibida desenha sempre ARMADA quieta (sem estado do motor).
  hubZones?: ReadonlyArray<HubZoneState> | null,
) {
  for (const z of zones) {
    const x = cr.x + z.x * cr.w,
      y = cr.y + z.y * cr.h,
      w = z.w * cr.w,
      h = z.h * cr.h;

    // ── PROIBIDA: desenho próprio, fora do caminho padrão (E6) ──
    // "Armada" ≠ "em alarme": ARMADA quieta = contorno NEUTRO tracejado + hachura sutil + badge
    // discreto; VIOLADA = --state-critical + fill saturado (going-gray: vermelho SÓ na violação).
    // O estado vem do MOTOR DO HUB: quando `presenca` existir no payload ele é a AUTORIDADE;
    // enquanto o produtor não o emite, deriva de people>0 (presença BRUTA, sem dwell —
    // display-only; o ALARME real nasce no hub, com dwell/off-delay). Sem hub: sempre ARMADA
    // quieta — limitação conhecida desta onda (câmera sem motor não tem produtor de presença).
    if (z.modo === "proibida") {
      const hz = hubZones?.find((zz) => zz.id === z.id || zz.label === z.label);
      const violada = hz
        ? hz.presenca != null
          ? hz.presenca === true || hz.presenca === "VIOLADA"
          : hz.people > 0
        : false;
      const cor = violada
        ? cssVar("--state-critical", "#ef4444")
        : cssVar("--state-neutral", "#64748b");
      // Polígono (F2): desenha por PATH — a máscara vira legado quando há points (P5).
      const pts = zonePolygon(z);
      const mask = pts ? null : maskOf(z);
      const hasMask = !!(mask && anySet(mask));
      if (hasMask && mask && layers.mask) {
        // área irregular: células pintadas (fill mais denso SÓ na violação)
        const cw = cr.w / mask.cols,
          ch = cr.h / mask.rows;
        ctx.fillStyle = cor + (violada ? "3a" : "14");
        for (let rr = 0; rr < mask.rows; rr++)
          for (let cc = 0; cc < mask.cols; cc++)
            if (mask.bits[rr * mask.cols + cc])
              ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
      }
      if (layers.zones) {
        if (pts) {
          // a MESMA linguagem do retângulo (hachura quieta / fill saturado na violação),
          // recortada pelo path do polígono; rótulo/badge seguem ancorados na bbox.
          if (violada) {
            tracePolygon(ctx, cr, pts);
            ctx.fillStyle = cor + "2e"; // fill saturado da violação
            ctx.fill();
          } else {
            drawProibidaHatch(ctx, x, y, w, h, cor, () => tracePolygon(ctx, cr, pts));
          }
        } else if (!hasMask) {
          if (violada) {
            ctx.fillStyle = cor + "2e"; // fill saturado da violação
            ctx.fillRect(x, y, w, h);
          } else {
            drawProibidaHatch(ctx, x, y, w, h, cor);
          }
        }
        ctx.setLineDash([6, 4]); // tracejado: identidade da zona proibida mesmo quieta
        ctx.lineWidth = violada ? 3 : 1.5;
        ctx.strokeStyle = cor;
        if (pts) {
          tracePolygon(ctx, cr, pts);
          ctx.stroke();
        } else {
          ctx.strokeRect(x, y, w, h);
        }
        ctx.setLineDash([]);
        if (pts && detailed) drawVertexHandles(ctx, cr, pts, cor);
        // rótulo do modo + badge de estado (ARMADA discreto / VIOLADA saturado)
        const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
        const label2 = `${z.label} · ${ZONE_MODE_LABEL[z.modo]}`;
        ctx.font = "bold 11px ui-sans-serif, system-ui";
        const tw = ctx.measureText(label2).width + 10;
        ctx.fillStyle = scrim;
        ctx.fillRect(x, y, tw, 17);
        ctx.fillStyle = cor;
        ctx.fillText(label2, x + 5, y + 12);
        const badge = violada ? "VIOLADA" : "ARMADA";
        ctx.font = "bold 9px ui-sans-serif, system-ui";
        const bw = ctx.measureText(badge).width + 8;
        ctx.fillStyle = scrim;
        ctx.fillRect(x, y + 19, bw, 13);
        ctx.fillStyle = violada ? cor : cssVar("--state-neutral-dim", "#5b6b7a");
        ctx.fillText(badge, x + 4, y + 29);
      }
      continue;
    }

    const r = results.get(z.id);
    let color = cssVar("--state-neutral", "#64748b");
    let label2 = `${z.label} · ${ZONE_MODE_LABEL[z.modo]}`;
    if (r?.modo === "atividade") {
      color = stateCanvasColor(r.view.state);
      label2 = `${z.label} · ${r.view.state}`;
    } else if (r?.modo === "leitura") {
      color = cssVar("--state-info", "#38bdf8");
      label2 = `${z.label} · ${r.lastCode ?? "leitura…"}`;
    } else if (r?.modo === "objetos") {
      color = cssVar("--state-neutral", "#64748b"); // contagem = operação normal (going-gray); classes mantêm cor categórica
      const parts = Object.entries(r.counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${objClass(k)?.emoji ?? ""}${n}`);
      label2 = `${z.label} · ${parts.length ? parts.join(" ") : "0"}`;
      if (layers.boxes) {
        const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.7)");
        for (const d of r.dets) {
          if (d.score < conf) continue; // slider global de confiança filtra detecções
          const cx = d.bbox[0] + d.bbox[2] / 2,
            cy = d.bbox[1] + d.bbox[3] / 2;
          if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
          const oc = objClass(d.key);
          // 1 pessoa = 1 caixa: det de pessoa já coberta por um track é do track (ver DECISÃO acima)
          if (
            oc?.coco.includes("person") &&
            coveredByAny(d.bbox, personTrackBoxes, TRACK_COVER_IOU, TRACK_COVER_CONTAIN)
          )
            continue;
          const cc = oc?.color ?? color;
          const bx = cr.x + d.bbox[0] * cr.w,
            by = cr.y + d.bbox[1] * cr.h;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = cc;
          ctx.strokeRect(bx, by, d.bbox[2] * cr.w, d.bbox[3] * cr.h);
          if (detailed) {
            // rótulo da classe acima da bbox (só no modo cheio, p/ não poluir o tile)
            const tag = `${oc?.emoji ?? ""} ${oc?.label ?? d.key}`;
            ctx.font = "10px ui-sans-serif, system-ui";
            const tw = ctx.measureText(tag).width + 6;
            ctx.fillStyle = scrim;
            ctx.fillRect(bx, by - 13, tw, 12);
            ctx.fillStyle = cc;
            ctx.fillText(tag, bx + 3, by - 4);
          }
        }
      }
    } else if (r?.modo === "fadiga") {
      color = riskCanvasColor(r.risk);
      label2 = `${z.label} · ${RISK_LABEL[r.risk]}${r.ear != null ? ` · EAR ${r.ear.toFixed(2)}` : ""}${r.phone ? " · 📱" : ""}`;
    }
    // Polígono (F2): fill/stroke por PATH na mesma linguagem do retângulo; a máscara vira
    // legado quando há points (P5). Rótulo/estado seguem ancorados na bbox derivada.
    const pts = zonePolygon(z);
    const mask = pts ? null : maskOf(z);
    const hasMask = !!(mask && anySet(mask));
    const alerting = r?.modo === "atividade" && r.view.state === "ALERTA";
    if (pts) {
      if (layers.zones) {
        tracePolygon(ctx, cr, pts);
        ctx.lineWidth = alerting ? 3 : 2;
        ctx.strokeStyle = color;
        ctx.fillStyle = color + "1f";
        ctx.fill();
        ctx.stroke();
        if (detailed) drawVertexHandles(ctx, cr, pts, color);
      }
    } else if (hasMask && mask) {
      // área irregular: pinta as células marcadas na cor do modo (camada "máscara")
      if (layers.mask) {
        const cw = cr.w / mask.cols,
          ch = cr.h / mask.rows;
        ctx.fillStyle = color + (alerting ? "3a" : "26");
        for (let rr = 0; rr < mask.rows; rr++)
          for (let cc = 0; cc < mask.cols; cc++)
            if (mask.bits[rr * mask.cols + cc])
              ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
      }
      if (layers.zones) {
        ctx.lineWidth = alerting ? 2 : 1;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);
      } // contorno da bbox
    } else if (layers.zones) {
      ctx.lineWidth = alerting ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = color + "1f";
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    if (layers.zones) {
      ctx.font = "bold 11px ui-sans-serif, system-ui";
      const tw = ctx.measureText(label2).width + 10;
      ctx.fillStyle = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
      ctx.fillRect(x, y, tw, 17);
      ctx.fillStyle = color;
      ctx.fillText(label2, x + 5, y + 12);
      if (
        detailed &&
        r?.modo === "atividade" &&
        r.view.state !== "ATIVA" &&
        r.view.state !== "LENTA"
      ) {
        ctx.font = "10px monospace";
        ctx.fillStyle = cssVar("--cam-overlay-fg", "#cbd5e1");
        ctx.fillText(`parada ${fmtDuration(r.view.idleMs)}`, x + 5, y + 28);
      }
    }
    if (layers.boxes && detailed && r?.modo === "fadiga") drawFadigaZone(ctx, x, y, w, h, r.scene);
  }
}
