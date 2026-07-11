// Aceite §9.1 do escopo da bancada (docs/cientifica/simulador.md): "os 8 cenários atuais [hoje 12,
// ver replay-fusion.ts/FUSION_SCENARIOS], reescritos como World Specs, reproduzem os pinos do CI
// BIT-A-BIT antes de qualquer feature nova." Este arquivo é esse gate — migra os 12 cenários pra
// WorldSpecV1 e prova igualdade PROFUNDA (toEqual, não só métricas agregadas) do SimFusionScenario
// gerado pelos dois caminhos.
//
// NOTA HONESTA: "grade-sem-station" tem exatamente os MESMOS parâmetros de GERAÇÃO que "canonico"
// (mesmo opts, mesmo seed) — a diferença entre os dois vive no REPLAY (omitStationPx, uma opção de
// `replayFusion`/`buildFusionFrame`, não da geração do mundo) — fora do escopo de WorldSpecV1 (que
// só cobre geração). Por isso os dois nomes mapeiam pro MESMO spec aqui, de propósito, não por
// engano.
import { describe, expect, it } from "vitest";
import { simulateFusionScenario } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { simulateFromWorldSpec } from "./world-spec";
import type { WorldSpecV1 } from "./world-spec";

const STEPS = 240;

const WORLD_SPEC_SCENARIOS: Record<string, WorldSpecV1> = {
  canonico: {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
  },
  parado: {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "parado" },
  },
  bloco: {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "bloco" },
  },
  cruzamento: {
    version: 1,
    seed: 7,
    population: { steps: STEPS, people: 2, tagged: 2, walk: "cruzamento", idSwitchOnCross: true },
  },
  "ruido-alto": {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
    physics: { rssiNoiseDb: 8 },
  },
  multidao: {
    version: 1,
    seed: 123,
    population: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" },
  },
  "sem-calibracao": {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
    sensors: { uncalibrated: true, stationAtCamera: true },
  },
  // Mesma geração de "canonico" (ver nota no header) — a distinção de "grade-sem-station" é de
  // REPLAY (omitStationPx), fora do escopo do World Spec de geração.
  "grade-sem-station": {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
  },
  "ancoras-canonico": {
    version: 1,
    seed: 42,
    population: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" },
    sensors: { anchors: true },
  },
  "ancoras-multidao": {
    version: 1,
    seed: 123,
    population: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" },
    sensors: { anchors: true },
  },
  "ancoras-multidao-bias": {
    version: 1,
    seed: 123,
    population: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" },
    sensors: { anchors: true },
    physics: { personRssiBiasDb: -6 },
  },
  "ancoras-mismatch-n": {
    version: 1,
    seed: 123,
    population: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" },
    sensors: { anchors: true },
    physics: { channelN: 3.0 },
  },
};

describe("World Spec — aceite §9.1: reprodução bit-a-idêntica dos cenários pinados", () => {
  it("todo cenário de FUSION_SCENARIOS tem um World Spec correspondente registrado", () => {
    for (const def of FUSION_SCENARIOS) {
      expect(WORLD_SPEC_SCENARIOS[def.name], `sem World Spec pro cenário "${def.name}"`).toBeDefined();
    }
  });

  for (const def of FUSION_SCENARIOS) {
    it(`"${def.name}": simulateFromWorldSpec === simulateFusionScenario (igualdade profunda)`, () => {
      const viaOpts = simulateFusionScenario(def.opts, def.seed);
      const viaSpec = simulateFromWorldSpec(WORLD_SPEC_SCENARIOS[def.name]);
      expect(viaSpec).toEqual(viaOpts);
    });
  }
});
