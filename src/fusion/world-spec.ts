// Bancada de simulação (docs/cientifica/simulador.md) — Fase 1, passo zero: World Spec MÍNIMO.
// "Passo zero da trilha: migrar os 8 cenários [hoje 12] para specs com pinos intactos ANTES de
// qualquer física nova" (plano aprovado, C:\Users\crist\.claude\plans\peppy-wondering-garden.md).
//
// DECISÃO DE DESIGN (baixo risco, deliberada): este módulo NÃO reescreve `simulateFusionScenario`
// nem toca a ordem de consumo do RNG (o miolo delicado que garante determinismo byte-a-byte hoje).
// Em vez disso, é uma camada de TRADUÇÃO — WorldSpecV1 (JSON declarativo) → SimOpts (o que o motor
// já consome) → mesma `simulateFusionScenario`. Reprodução bit-a-idêntica (aceite §9.1 do escopo)
// sai TRIVIALMENTE verdadeira (é literalmente a mesma função por baixo), sem o risco de reescrever
// o gerador. Reescrever o MIOLO do gerador pra ler JSON nativamente fica pra depois, SE doer (v4 do
// simulador) — YAGNI: não vale o risco agora que a tradução já entrega o declarativo.
//
// ESCOPO v1 (mapeia 1:1 o que `SimOpts` já tem — geometria/câmera/estação seguem FIXAS no motor,
// ver sim.ts): população homogênea (todo mundo no mesmo padrão de `walk`), física de canal simples,
// tracker com dropout/jitter uniformes, injeção cirúrgica de id-switch (a sentinela da
// persistência). NENHUM parâmetro de física NOVA (obstáculos, ruído AR(1), offsets regionais, viés
// corporal direcional, oclusão estruturada) entra aqui — isso é Fase 2, e cada um daqueles PRECISA
// vir com fonte (medido/literatura/chute marcado, ver simulador.md §3) — nenhum weight neste módulo
// hoje é "novo": são os MESMOS defaults que sim.ts já tem, só expressos em JSON.
//
// Responsabilidade única: tradução WorldSpecV1 ↔ SimOpts. Não simula (isso é sim.ts).
import { simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts, SimWalk } from "./sim";

export type WorldSpecV1 = {
  version: 1;
  seed: number;
  population: {
    steps?: number;
    people?: number;
    tagged?: number;
    walk?: SimWalk;
    idSwitchOnCross?: boolean;
  };
  physics?: {
    rssiNoiseDb?: number;
    rssiPeriodTicks?: number;
    channelN?: number;
    /** [chute marcado] sentinela de viés — não é física real, é o knob que provou a circularidade
     *  v4 (ver associate.ts). Mantido aqui por completude do mapeamento, não por recomendação de uso. */
    personRssiBiasDb?: number;
  };
  tracker?: {
    pxJitter?: number;
    dropoutP?: number;
  };
  sensors?: {
    stationAtCamera?: boolean;
    anchors?: boolean;
    uncalibrated?: boolean;
  };
  /** Injeção cirúrgica de id-switch determinístico (sentinela da persistência de rótulo,
   *  Mordida 2) — mapeia direto pro `forceSwitchAt` de sim.ts. O MESMO campo `inject` que
   *  simulador.md §3 propõe para o simulador geral; esta é a forma mínima que já existe. */
  inject?: { tickIndex: number; personA: number; personB: number };
};

export function worldSpecToSimOpts(spec: WorldSpecV1): SimOpts {
  return {
    steps: spec.population.steps,
    people: spec.population.people,
    tagged: spec.population.tagged,
    walk: spec.population.walk,
    idSwitchOnCross: spec.population.idSwitchOnCross,
    rssiNoiseDb: spec.physics?.rssiNoiseDb,
    rssiPeriodTicks: spec.physics?.rssiPeriodTicks,
    channelN: spec.physics?.channelN,
    personRssiBiasDb: spec.physics?.personRssiBiasDb,
    pxJitter: spec.tracker?.pxJitter,
    dropoutP: spec.tracker?.dropoutP,
    stationAtCamera: spec.sensors?.stationAtCamera,
    anchors: spec.sensors?.anchors,
    uncalibrated: spec.sensors?.uncalibrated,
    forceSwitchAt: spec.inject,
  };
}

/** Gera o cenário a partir do World Spec — mesma `simulateFusionScenario` de sempre por baixo
 *  (ver header: nenhuma lógica de geração vive aqui, só tradução). */
export function simulateFromWorldSpec(spec: WorldSpecV1): SimFusionScenario {
  return simulateFusionScenario(worldSpecToSimOpts(spec), spec.seed);
}
