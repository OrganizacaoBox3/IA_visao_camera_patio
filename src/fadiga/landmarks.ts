// Helpers puros do modo Fadiga — EAR/MAR, gestos de mão e geometria de retângulos.
// Portado de sensor_fadiga_mvp (sem alterar o projeto de origem).
import { APP_CONFIG } from "../config";

export type Landmark = { x: number; y: number; z?: number };
export type Handedness = "Left" | "Right" | "Unknown";
export type ManualSignal = "SEM_SINAL" | "MAO_ABERTA" | "PUNHO_FECHADO" | "JOINHA";
export type Rect = { x: number; y: number; width: number; height: number };
export type RiskState = "OK" | "ALERTA_FADIGA" | "ALERTA_CELULAR" | "ALERTA_DUPLO";
export type PhoneDetection = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
} | null;
export type HandDetection = {
  landmarks: Landmark[];
  handedness: Handedness;
  signal: ManualSignal;
}[];

const F = APP_CONFIG.fadiga;
const LEFT_EYE = F.eyeIndices.left;
const RIGHT_EYE = F.eyeIndices.right;
const MOUTH_W = F.mouthIndices.width;
const MOUTH_O = F.mouthIndices.open;

const HAND_INDEX_TIP = 8,
  HAND_INDEX_PIP = 6,
  HAND_MIDDLE_TIP = 12,
  HAND_MIDDLE_PIP = 10;
const HAND_RING_TIP = 16,
  HAND_RING_PIP = 14,
  HAND_PINKY_TIP = 20,
  HAND_PINKY_PIP = 18;
const HAND_THUMB_TIP = 4,
  HAND_THUMB_IP = 3,
  HAND_THUMB_MCP = 2;

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(landmarks: Landmark[], indices: readonly number[]): number | null {
  const [p1, p2, p3, p4, p5, p6] = indices.map((idx) => landmarks[idx]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;
  const horizontal = distance(p1, p4);
  if (horizontal <= Number.EPSILON) return null;
  return (distance(p2, p6) + distance(p3, p5)) / (2 * horizontal);
}

export function calcEar(landmarks: Landmark[]): number | null {
  const l = eyeAspectRatio(landmarks, LEFT_EYE),
    r = eyeAspectRatio(landmarks, RIGHT_EYE);
  if (l == null || r == null) return null;
  return (l + r) / 2;
}

export function calcMar(landmarks: Landmark[]): number | null {
  const wA = landmarks[MOUTH_W[0]],
    wB = landmarks[MOUTH_W[1]],
    oA = landmarks[MOUTH_O[0]],
    oB = landmarks[MOUTH_O[1]];
  if (!wA || !wB || !oA || !oB) return null;
  const width = distance(wA, wB);
  if (width <= Number.EPSILON) return null;
  return distance(oA, oB) / width;
}

function fingerExtended(l: Landmark[], tip: number, pip: number): boolean {
  const t = l[tip],
    p = l[pip];
  return !!t && !!p && t.y < p.y;
}
function thumbExtended(l: Landmark[], hand: Handedness): boolean {
  const tip = l[HAND_THUMB_TIP],
    ip = l[HAND_THUMB_IP],
    mcp = l[HAND_THUMB_MCP];
  if (!tip || !ip || !mcp) return false;
  if (hand === "Right") return tip.x < ip.x && ip.x < mcp.x;
  if (hand === "Left") return tip.x > ip.x && ip.x > mcp.x;
  return Math.abs(tip.x - ip.x) > 0.03;
}

export function inferManualSignal(l: Landmark[], hand: Handedness): ManualSignal {
  const idx = fingerExtended(l, HAND_INDEX_TIP, HAND_INDEX_PIP);
  const mid = fingerExtended(l, HAND_MIDDLE_TIP, HAND_MIDDLE_PIP);
  const ring = fingerExtended(l, HAND_RING_TIP, HAND_RING_PIP);
  const pinky = fingerExtended(l, HAND_PINKY_TIP, HAND_PINKY_PIP);
  const thumb = thumbExtended(l, hand);
  const ext = [idx, mid, ring, pinky].filter(Boolean).length;
  if (thumb && ext <= 1) return "JOINHA";
  if (ext >= 3 && thumb) return "MAO_ABERTA";
  if (ext <= 1 && !thumb) return "PUNHO_FECHADO";
  return "SEM_SINAL";
}

export function rectIntersectionArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x),
    y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width),
    y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
export function rectIou(a: Rect, b: Rect): number {
  const i = rectIntersectionArea(a, b);
  if (i <= 0) return 0;
  const u = a.width * a.height + b.width * b.height - i;
  return u <= 0 ? 0 : i / u;
}
export function normalizedLandmarksRect(
  landmarks: Landmark[],
  width: number,
  height: number,
): Rect | null {
  if (!landmarks.length) return null;
  const xs = landmarks.map((p) => p.x * width),
    ys = landmarks.map((p) => p.y * height);
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) - minX),
    height: Math.max(1, Math.max(...ys) - minY),
  };
}
export function earZones(faceRect: Rect): Rect[] {
  const w = faceRect.width * 0.42,
    h = faceRect.height * 0.62,
    y = faceRect.y + faceRect.height * 0.12;
  return [
    { x: faceRect.x - faceRect.width * 0.35, y, width: w, height: h },
    { x: faceRect.x + faceRect.width - faceRect.width * 0.07, y, width: w, height: h },
  ];
}
