// Agregador por PONTO DE LEITURA: N câmeras apontando o mesmo ponto da esteira.
// Caixa = "lida" se QUALQUER câmera leu (dedup por (ponto, code) dentro de uma janela).
// Métricas: caixas recentes, throughput (caixas/min), multi-reads, contribuição por câmera, fluxo ao vivo.
// Store em memória (singleton de módulo). LGPD: só códigos/indicadores, nunca imagens.

import { APP_CONFIG } from "../config";

export type ReadEvent = { cameraId: string; cameraLabel: string; ponto: string; code: string; format: string; ts: number };
export type CameraRef = { cameraId: string; cameraLabel: string };

export type PontoSnapshot = {
  ponto: string;
  boxesRecent: number;       // caixas distintas na janela recente
  perMin: number;            // throughput (caixas/min) na janela recente
  multiReads: number;        // caixas lidas por +1 câmera na janela
  passages: number;          // passagens físicas de caixa (motion deduplicado por ponto)
  noReads: number;           // passagens sem leitura = max(0, passages - boxes)
  readRatePct: number;       // taxa de leitura = boxes/passages (0..100; 100 se sem passagens)
  lastCode: string | null;
  lastFormat: string | null;
  lastTs: number;
  perCamera: { cameraId: string; cameraLabel: string; reads: number }[]; // contribuição (caixas em que a câmera participou)
  recentCodes: { code: string; ts: number; cameras: string[] }[];        // fluxo ao vivo (mais recente primeiro)
};

export type PassEvent = { cameraId: string; ponto: string; ts: number };

// Uma "caixa" agregada dentro de um ponto.
type Box = { code: string; firstTs: number; lastTs: number; format: string; cameras: Set<string> };

// Resultado da inclusão de um read — usado p/ persistir o histórico de leitura (F2).
export type PushResult = ReadEvent & { newBox: boolean; becameMulti: boolean };
export type PassResult = PassEvent & { newPassage: boolean };

const R = APP_CONFIG.reading;
const boxesByPonto = new Map<string, Box[]>();
const passesByPonto = new Map<string, number[]>(); // timestamps de passagens físicas (deduplicadas)
const labelByCamera = new Map<string, string>();

// Registra um evento de leitura vindo de uma ReadingView. Retorna como a caixa foi classificada.
export function pushRead(ev: ReadEvent): PushResult {
  labelByCamera.set(ev.cameraId, ev.cameraLabel);
  let boxes = boxesByPonto.get(ev.ponto);
  if (!boxes) { boxes = []; boxesByPonto.set(ev.ponto, boxes); }

  // mesma caixa = mesmo código no ponto dentro da janela de dedup (qualquer câmera)
  const open = boxes.find((b) => b.code === ev.code && ev.ts - b.lastTs <= R.dedupWindowMs);
  let newBox = false, becameMulti = false;
  if (open) {
    const before = open.cameras.size;
    open.lastTs = ev.ts; open.cameras.add(ev.cameraId); open.format = ev.format || open.format;
    becameMulti = before === 1 && open.cameras.size === 2; // 2ª câmera confirmou a mesma caixa
  } else {
    boxes.push({ code: ev.code, firstTs: ev.ts, lastTs: ev.ts, format: ev.format, cameras: new Set([ev.cameraId]) });
    newBox = true;
  }

  // poda o que saiu da janela recente (mantém o store enxuto)
  prune(ev.ponto, ev.ts);
  return { ...ev, newBox, becameMulti };
}

// Passagem física de caixa (motion no ROI de qualquer câmera). Dedup por ponto+janela:
// várias câmeras veem a MESMA caixa passar → uma passagem só.
export function pushPass(ev: PassEvent): PassResult {
  let passes = passesByPonto.get(ev.ponto);
  if (!passes) { passes = []; passesByPonto.set(ev.ponto, passes); }
  const last = passes.length ? passes[passes.length - 1] : -Infinity;
  const newPassage = ev.ts - last > R.dedupWindowMs; // mesma janela = mesma caixa passando
  if (newPassage) passes.push(ev.ts);
  prune(ev.ponto, ev.ts);
  return { ...ev, newPassage };
}

function prune(ponto: string, now: number): void {
  const cutoff = now - R.recentWindowMs;
  const boxes = boxesByPonto.get(ponto);
  if (boxes) { const keep = boxes.filter((b) => b.lastTs >= cutoff); if (keep.length !== boxes.length) boxesByPonto.set(ponto, keep); }
  const passes = passesByPonto.get(ponto);
  if (passes) { const keep = passes.filter((t) => t >= cutoff); if (keep.length !== passes.length) passesByPonto.set(ponto, keep); }
}

// Snapshot p/ a UI. `members` = câmeras atribuídas ao ponto na central (mostra contribuição 0 p/ quem não leu).
export function snapshot(ponto: string, members: CameraRef[], now: number): PontoSnapshot {
  prune(ponto, now);
  const boxes = (boxesByPonto.get(ponto) ?? []).slice().sort((a, b) => b.lastTs - a.lastTs);

  const perCameraMap = new Map<string, number>();
  for (const m of members) perCameraMap.set(m.cameraId, 0);
  let multiReads = 0;
  for (const b of boxes) {
    if (b.cameras.size > 1) multiReads++;
    for (const cid of b.cameras) perCameraMap.set(cid, (perCameraMap.get(cid) ?? 0) + 1);
  }

  const last = boxes[0] ?? null;
  const windowMin = R.recentWindowMs / 60_000;
  const passages = (passesByPonto.get(ponto) ?? []).length;
  const noReads = Math.max(0, passages - boxes.length);
  const readRatePct = passages > 0 ? Math.min(100, Math.round((boxes.length / passages) * 100)) : 100;

  return {
    ponto,
    boxesRecent: boxes.length,
    perMin: windowMin > 0 ? Math.round(boxes.length / windowMin) : 0,
    multiReads,
    passages,
    noReads,
    readRatePct,
    lastCode: last ? last.code : null,
    lastFormat: last ? last.format : null,
    lastTs: last ? last.lastTs : 0,
    perCamera: members.map((m) => ({ cameraId: m.cameraId, cameraLabel: labelByCamera.get(m.cameraId) ?? m.cameraLabel, reads: perCameraMap.get(m.cameraId) ?? 0 })),
    recentCodes: boxes.slice(0, 12).map((b) => ({ code: b.code, ts: b.lastTs, cameras: [...b.cameras] })),
  };
}

export function resetCluster(): void { boxesByPonto.clear(); passesByPonto.clear(); }
