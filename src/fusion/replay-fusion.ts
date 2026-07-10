// Harness de REPLAY da fusão tag↔pessoa: roda o TagTrackAssociator DE PRODUÇÃO sobre cenários
// sintéticos (sim.ts) e mede identidade (identity-metrics.ts). A alimentação é FIEL ao
// useTagFusion de produção: tick sem leituras BLE é PULADO (nem push nem assign); com leituras,
// push(buildFusionFrame(...)) + assign(ts) — mesmo caminho de código, mesmo timing de 500 ms.
// A suíte mede DUAS alimentações que existem na prática:
// - calibrada completa: H calibrada + stationPx calibrado (cenários com stationPx do sim);
// - câmera calibrada SEM ponto de estação configurado (cenário grade-sem-station, flag
//   omitStationPx): H presente, stationPx omitido → frame.ts cai no default (0.5, 1.0) =
//   "estação junto da câmera". Estado real possível; também era o comportamento do CameraTile
//   da grade ANTES do fix de 2026-07-10.
// Determinístico por construção: cenário vem de seed fixo; aqui não há relógio nem sorteio.
// Responsabilidade única: só o replay + a suíte fixa de cenários; simular e medir moram ao lado.
import { TagTrackAssociator } from "./associate";
import type { FusionConfig } from "./associate";
import { fitPathLoss, distFromRssi } from "./floor-plot";
import type { AnchorObs } from "./floor-plot";
import { buildFusionFrame } from "./frame";
import type { RawReading } from "./frame";
import { simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts } from "./sim";
import { computeIdentityMetrics } from "./identity-metrics";
import type { IdentityMetrics, IdentityTick } from "./identity-metrics";
import { pixelToWorld } from "../vision/homography";

export type FusionReplayResult = { ticks: IdentityTick[]; metrics: IdentityMetrics };

// EMA do RSSI por âncora (v4): suaviza o ruído de 4 dB antes do fit — α=0,2 ≈ meia-vida de ~3
// leituras (1,5 s a 2 Hz de tick processado), rápido o bastante p/ o replay de 120 s e lento o
// bastante p/ não perseguir ruído. Determinístico (só aritmética sobre o cenário).
const ANCHOR_EMA_ALPHA = 0.2;

/**
 * Reproduz um cenário no associador REAL, tick a tick, exatamente como a produção o alimentaria.
 * Todo tick PROCESSADO (com leituras) vira um IdentityTick avaliável; os pulados não existem
 * para a métrica (a produção também não decide nada neles).
 * `omitStationPx` reproduz a câmera calibrada SEM ponto de estação configurado: H presente mas
 * stationPx omitido (frame.ts usa o default 0.5,1.0). Sem calibração (H null) o stationPx nunca
 * é consumido.
 *
 * ÂNCORAS (v4): quando o cenário exporta tags-âncora (posições-mundo conhecidas), o replay faz o
 * que a produção faria com o modelo calibrado: mantém uma EMA do RSSI por âncora, REFITA o
 * path-loss A CADA tick processado (fitPathLoss — 4 âncoras, custo desprezível; 1×/s daria na
 * mesma porque a EMA já domina a inércia) e computa `distM` de TODA leitura via distFromRssi
 * ANTES de buildFusionFrame. distM só entra com modelo de fato calibrado (source ≠ "default") e
 * com a estação conhecida (H + stationPx) — sem isso, leituras seguem intactas (pré-v4).
 *
 * EXCLUSÃO DE ÂNCORAS (decisão da revisão adversarial de 2026-07-10): âncora CADASTRADA nunca é
 * candidata do associador — os MACs de sc.anchors (as posições-verdade que o sim exporta) são
 * passados como `excludeTags` ao buildFusionFrame, EXATAMENTE como a produção passa os MACs de
 * calibration.points (useCameraTagLabels → useTagFusion). A decisão anterior ("âncoras entram
 * como leituras normais") media o quanto o associador resistia a elas — e a medição decompôs o
 * ganho do gate/blend: era TODO âncora grudando em gente (falsos rótulos de âncora 73→1 e 78→0),
 * com o wrong pessoa↔pessoa SUBINDO. A exclusão captura esse ganho sem modelo de RSSI (imune a
 * viés); as âncoras seguem visíveis p/ CALIBRAR o path-loss — só saem do jogo de candidatas.
 * `anchorMacs` vai também à métrica: wrongAnchor decomposto (0 por construção com a exclusão).
 */
export function replayFusion(
  sc: SimFusionScenario,
  cfg?: FusionConfig,
  warmupMs?: number,
  opts?: { omitStationPx?: boolean },
): FusionReplayResult {
  const assoc = new TagTrackAssociator(cfg);
  const ticks: IdentityTick[] = [];

  // Setup da calibração por âncoras (v4): precisa de âncoras E estação conhecida no MUNDO.
  const anchors = sc.anchors ?? [];
  const stationWorld =
    anchors.length > 0 && sc.H && !opts?.omitStationPx ? pixelToWorld(sc.H, sc.stationPx) : null;
  const anchorMacs = new Set(anchors.map((a) => a.mac));
  // Exclusão de âncoras (mesma forma da produção): MACs MAIÚSCULOS p/ o excludeTags do frame.
  const excludeTags =
    anchors.length > 0 ? new Set(anchors.map((a) => a.mac.toUpperCase())) : undefined;
  const emaRssi = new Map<string, number>();

  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue; // produção pula o tick sem BLE (useTagFusion)
    let readings: readonly RawReading[] = tick.readings;
    if (stationWorld) {
      // 1) EMA do RSSI de cada âncora vista neste tick.
      for (const r of tick.readings) {
        if (!anchorMacs.has(r.mac)) continue;
        const prev = emaRssi.get(r.mac);
        emaRssi.set(r.mac, prev === undefined ? r.rssi : prev + ANCHOR_EMA_ALPHA * (r.rssi - prev));
      }
      // 2) Refit do path-loss pelas âncoras já observadas (posição-verdade + EMA do RSSI).
      const obs: AnchorObs[] = [];
      for (const a of anchors) {
        const rssi = emaRssi.get(a.mac);
        if (rssi !== undefined) obs.push({ mac: a.mac, world: a.world, rssi });
      }
      const model = fitPathLoss(obs, stationWorld);
      // 3) distM por leitura — só com modelo CALIBRADO (default = chute, não medição; fica fora).
      if (model.source !== "default")
        readings = tick.readings.map((r) => ({ ...r, distM: distFromRssi(model, r.rssi) }));
    }
    // stationPx calibrado só no caminho fullscreen; grade (omitStationPx) e H=null caem no default.
    const stationPx = sc.H && !opts?.omitStationPx ? sc.stationPx : undefined;
    assoc.push(buildFusionFrame(tick.tracks, readings, sc.H, tick.ts, stationPx, excludeTags));
    const assignments = assoc.assign(tick.ts);
    ticks.push({ ts: tick.ts, assignments, truthTagByTrack: tick.truthTagByTrack });
  }
  return { ticks, metrics: computeIdentityMetrics(ticks, { warmupMs, anchorMacs }) };
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
    // Câmera calibrada SEM ponto de estação configurado: H presente mas stationPx OMITIDO
    // (default 0.5,1.0 do frame.ts) com a estação real no canto (0,0). Estado real possível;
    // também era o comportamento do CameraTile da grade ANTES do fix de 2026-07-10. Idêntico ao
    // canonico fora isso — a diferença entre os dois é o custo medido de operar sem o station.
    name: "grade-sem-station",
    opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
    seed: 42,
    omitStationPx: true,
  },
  {
    // v4: canonico + 4 tags-âncora fixas (sensores de calibração do path-loss). Com a EXCLUSÃO
    // de âncoras (decisão da revisão adversarial), mede o cenário realista: âncoras calibram o
    // modelo mas nunca são candidatas — wrongAnchor tem de ser 0 por construção.
    // NOTA: NÃO é o canonico + âncoras "sobrepostas" — as âncoras consomem RNG, então as
    // trajetórias divergem do canonico; é um cenário novo com a mesma receita e seed.
    name: "ancoras-canonico",
    opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint", anchors: true },
    seed: 42,
  },
  {
    // v4: multidão + âncoras — o cenário onde a decomposição do ganho foi medida (todo o ganho
    // do gate/blend era âncora grudando em gente; a exclusão captura isso sem modelo de RSSI).
    name: "ancoras-multidao",
    opts: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint", anchors: true },
    seed: 123,
  },
  {
    // SENTINELA DE VIÉS (a lição da circularidade virou gate permanente): multidão+âncoras com
    // −6 dB de atenuação corporal SÓ nas tags de pessoa — o viés que o campo real tem e o sim
    // do fit não via. Foi ESTE experimento que derrubou gate/blend dos defaults (ligados, o
    // cenário despencava p/ 26% de precisão / 1,8% de cobertura — pior que desligados). Com os
    // defaults OFF + exclusão de âncoras ele é BYTE-IDÊNTICO ao ancoras-multidao: correlação é
    // invariante a offset constante e a exclusão não depende de modelo de RSSI (imune a viés).
    name: "ancoras-multidao-bias",
    opts: {
      steps: STEPS,
      people: 6,
      tagged: 4,
      walk: "waypoint",
      anchors: true,
      personRssiBiasDb: -6,
    },
    seed: 123,
  },
  {
    // SENTINELA DE VIÉS 2: canal com expoente n=3,0 (o fit anchors-offset assume n=2,2). A
    // correlação é invariante a transformação afim do RSSI (este caso, a menos do arredondamento
    // a inteiro), então com defaults OFF + exclusão o cenário se comporta como o ancoras-multidao
    // — mais um teste que qualquer re-adoção futura do gate/blend terá que sobreviver.
    name: "ancoras-mismatch-n",
    opts: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint", anchors: true, channelN: 3.0 },
    seed: 123,
  },
];

/** Roda a suíte inteira (simula + replay + mede) — determinístico, pronto p/ tuning medido. */
export function runFusionBenchmark(cfg?: FusionConfig): { scenario: string; m: IdentityMetrics }[] {
  return FUSION_SCENARIOS.map(({ name, opts, seed, omitStationPx }) => ({
    scenario: name,
    m: replayFusion(simulateFusionScenario(opts, seed), cfg, undefined, { omitStationPx }).metrics,
  }));
}
