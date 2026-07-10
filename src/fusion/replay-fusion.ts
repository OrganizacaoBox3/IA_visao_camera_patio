// Harness de REPLAY da fusão tag↔pessoa: roda o TagTrackAssociator DE PRODUÇÃO sobre cenários
// sintéticos (sim.ts) e mede identidade (identity-metrics.ts). A alimentação é FIEL ao
// useTagFusion de produção: tick sem leituras BLE é PULADO (nem push nem assign); com leituras,
// push(buildFusionFrame(...)) + assign(ts) — mesmo caminho de código, mesmo timing de 500 ms.
// A produção tem DOIS call-sites com alimentações DIFERENTES, e a suíte mede os dois:
// - fullscreen: passa H calibrada + stationPx calibrado (cenários com stationPx do sim);
// - CameraTile da grade: chama useTagFusion com H mas SEM stationPx → frame.ts cai no default
//   (0.5, 1.0) = "estação junto da câmera" (cenário grade-sem-station, flag omitStationPx).
// Determinístico por construção: cenário vem de seed fixo; aqui não há relógio nem sorteio.
// Responsabilidade única: só o replay + a suíte fixa de cenários; simular e medir moram ao lado.
import { TagTrackAssociator } from "./associate";
import type { FusionConfig } from "./associate";
import { buildFusionFrame } from "./frame";
import { simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts } from "./sim";
import { computeIdentityMetrics } from "./identity-metrics";
import type { IdentityMetrics, IdentityTick } from "./identity-metrics";

export type FusionReplayResult = { ticks: IdentityTick[]; metrics: IdentityMetrics };

/**
 * Reproduz um cenário no associador REAL, tick a tick, exatamente como a produção o alimentaria.
 * Todo tick PROCESSADO (com leituras) vira um IdentityTick avaliável; os pulados não existem
 * para a métrica (a produção também não decide nada neles).
 * `omitStationPx` reproduz o call-site do CameraTile da grade: H presente mas stationPx omitido
 * (frame.ts usa o default 0.5,1.0). Sem calibração (H null) o stationPx nunca é consumido.
 */
export function replayFusion(
  sc: SimFusionScenario,
  cfg?: FusionConfig,
  warmupMs?: number,
  opts?: { omitStationPx?: boolean },
): FusionReplayResult {
  const assoc = new TagTrackAssociator(cfg);
  const ticks: IdentityTick[] = [];
  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue; // produção pula o tick sem BLE (useTagFusion)
    // stationPx calibrado só no caminho fullscreen; grade (omitStationPx) e H=null caem no default.
    const stationPx = sc.H && !opts?.omitStationPx ? sc.stationPx : undefined;
    assoc.push(buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, stationPx));
    const assignments = assoc.assign(tick.ts);
    ticks.push({ ts: tick.ts, assignments, truthTagByTrack: tick.truthTagByTrack });
  }
  return { ticks, metrics: computeIdentityMetrics(ticks, { warmupMs }) };
}

// Suíte fixa de cenários do gate. 240 passos = 120 s — a janela de 8 s do associador precisa de
// amostra farta DEPOIS do warmup para a métrica não medir só o transitório.
const STEPS = 240;

export const FUSION_SCENARIOS: {
  name: string;
  opts: SimOpts;
  seed: number;
  /** true = alimenta buildFusionFrame SEM stationPx (call-site do CameraTile da grade). */
  omitStationPx?: boolean;
}[] = [
  { name: "canonico", opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" }, seed: 42 },
  { name: "parado", opts: { steps: STEPS, people: 3, tagged: 2, walk: "parado" }, seed: 42 },
  { name: "bloco", opts: { steps: STEPS, people: 3, tagged: 2, walk: "bloco" }, seed: 42 },
  {
    name: "cruzamento",
    opts: { steps: STEPS, people: 2, tagged: 2, walk: "cruzamento", idSwitchOnCross: true },
    seed: 7,
  },
  {
    name: "ruido-alto",
    opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint", rssiNoiseDb: 8 },
    seed: 42,
  },
  { name: "multidao", opts: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" }, seed: 123 },
  {
    // Config RECOMENDADA para operar sem H: estação junto da câmera (caminho C do frame.ts) —
    // o proxy 1/bh e o RSSI medem a distância ao MESMO ponto.
    name: "sem-calibracao",
    opts: {
      steps: STEPS,
      people: 3,
      tagged: 2,
      walk: "waypoint",
      uncalibrated: true,
      stationAtCamera: true,
    },
    seed: 42,
  },
  {
    // Call-site do CameraTile da grade: H calibrada mas stationPx OMITIDO (default 0.5,1.0 do
    // frame.ts) com a estação real no canto (0,0). Idêntico ao canonico fora isso — a diferença
    // entre os dois é o custo medido de a grade não passar o station.
    name: "grade-sem-station",
    opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
    seed: 42,
    omitStationPx: true,
  },
];

/** Roda a suíte inteira (simula + replay + mede) — determinístico, pronto p/ tuning medido. */
export function runFusionBenchmark(cfg?: FusionConfig): { scenario: string; m: IdentityMetrics }[] {
  return FUSION_SCENARIOS.map(({ name, opts, seed, omitStationPx }) => ({
    scenario: name,
    m: replayFusion(simulateFusionScenario(opts, seed), cfg, undefined, { omitStationPx }).metrics,
  }));
}
