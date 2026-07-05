// ── Sub-passos PUROS do rAF do CameraWorkspace ───────────────────────────────
// Extraídos do laço de vídeo (Onda C) como funções que recebem params EXPLÍCITOS (sem fechar sobre
// refs/estado do React) — testáveis em Vitest. O laço em si fica no componente (rAF/ADR-007); aqui
// só a DECISÃO/montagem, sem mudar ordem nem semântica.
import { APP_CONFIG } from "../config";
import { type DetectFrameOpts } from "../vision/detect";

// Cadência da detecção de pessoas (coco/D-FINE local): rápida na câmera ABERTA, muito mais lenta na
// GRADE (libera a main-thread; overlay/contagem seguem o gate de tile).
export function detectionInterval(
  mode: "tile" | "full",
  fullIntervalMs: number,
  tileIntervalMs: number,
): number {
  return mode === "full" ? fullIntervalMs : tileIntervalMs;
}

// Gate de disparo: passou o intervalo E não há detecção em voo (objBusy). Mantém no máximo 1
// detectFrame em voo por câmera (o próximo dispara com o frame mais novo ao concluir).
export function shouldRunDetection(
  now: number,
  lastObjAt: number,
  objInterval: number,
  objBusy: boolean,
): boolean {
  return now - lastObjAt > objInterval && !objBusy;
}

// Monta o `schedule` (fila única + prioridade) e as `opts` do detectFrame. Longo alcance liga o
// tiling na GRADE (mesmo fora do full) + tile maior + limiar baixo; caso contrário só o schedule.
// `tiled` liga o tiling na câmera ABERTA (mode "full"). Retrocompatível com detectFrame.
export function detectScheduleOpts(
  cameraId: string,
  mode: "tile" | "full",
  longRange: boolean,
): { tiled: boolean; opts: DetectFrameOpts } {
  const schedule: DetectFrameOpts["schedule"] = {
    key: `${cameraId}:atividade`,
    priority: mode === "full" ? "high" : "low",
  };
  const LR = APP_CONFIG.detection.longRange;
  const opts: DetectFrameOpts = longRange
    ? { tiles: LR.tiles, tileWidth: LR.detectTileWidth, minScore: LR.minScore, schedule }
    : { schedule };
  return { tiled: mode === "full", opts };
}
