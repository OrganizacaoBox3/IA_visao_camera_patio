// Lógica PURA do auto-surface + layout da grade (extraída do god-component DashboardPage para virar
// testável — auditoria §S2). Sem estado nem efeitos: recebe statuses/alarmes/relógio por parâmetro.
import { type Camera, type CameraStatus } from "./types";
import { type AlarmEvent } from "../../api";

// Janela de "atividade recente" para o auto-surface (recência decai linear dentro dela).
export const AUTOSURFACE_WINDOW_MS = 10 * 60_000;

// Colunas da grade em função da quantidade de tiles visíveis (layout responsivo simples).
export function colsFor(n: number): number {
  return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4;
}

// Critério de ATIVIDADE para o auto-surface (documentado): combina os sinais já disponíveis na
// central:
//   • alarmes recentes da câmera (dentro da janela) — sinal mais forte de "está acontecendo algo",
//     ponderado por prioridade (crítico=100 / alta=40 / informativo=15) e por recência (decai linear);
//   • fps do camera-status (frames fluindo = câmera viva/movimentada) como contribuição menor;
//   • câmeras em erro/paradas afundam para o fim (não faz sentido destacá-las).
export function activityScore(
  camId: string,
  statuses: Record<string, CameraStatus>,
  alarms: AlarmEvent[],
  now: number,
  windowMs: number = AUTOSURFACE_WINDOW_MS,
): number {
  const s = statuses[camId];
  const state = s?.state ?? "online";
  if (state === "error" || state === "stopped") return -1_000 + (s?.fps ?? 0); // afunda offline/erro
  let score = 0;
  for (const a of alarms) {
    if (a.cameraId !== camId) continue;
    const age = now - a.ts;
    if (age < 0 || age > windowMs) continue;
    const w = a.priority === "critical" ? 100 : a.priority === "high" ? 40 : 15;
    const recency = 1 - age / windowMs; // 1 (agora) → 0 (limite da janela)
    score += w * (0.5 + 0.5 * recency);
  }
  score += (s?.fps ?? 0) * 0.5; // câmera com mais frames/s pesa um pouco mais
  return score;
}

// Ordem final dos tiles: auto-surface reordena por atividade (decrescente); senão mantém a ordem da
// view/lista. Pré-computa o score 1× por câmera (O(N·alarmes)) em vez de recalcular a cada comparação
// do sort (O(N·log N·alarmes)).
export function orderedCameras(
  viewCameras: Camera[],
  autoSurface: boolean,
  statuses: Record<string, CameraStatus>,
  alarms: AlarmEvent[],
  now: number,
): Camera[] {
  if (!autoSurface) return viewCameras;
  const scores = new Map(
    viewCameras.map((c) => [c.id, activityScore(c.id, statuses, alarms, now)]),
  );
  return [...viewCameras].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
}
