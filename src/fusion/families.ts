// Bancada de simulação (docs/cientifica/simulador.md) — Fase 3: FAMÍLIAS PARAMÉTRICAS headless.
// Regime §7.1 do escopo: "um eixo varia, ≥20 seeds por ponto, IC (bootstrap), decomposição por
// tipo de erro obrigatória (regra da casa)". Uma família = uma pergunta de produto do §8
// ("até quantas pessoas?", "quanto ruído aguenta?", "quão bem preciso instalar?") respondida como
// CURVA DE DEGRADAÇÃO com intervalo de confiança — não como um ponto anedótico de seed único.
//
// DECISÕES DE DESIGN:
// - NÃO reimplementa nada do pipeline: cada célula (ponto do eixo × seed) é literalmente
//   `replayFusion(simulateFusionScenario(...))` — o MESMO motor (sim.ts), o MESMO associador de
//   produção e as MESMAS métricas (identity-metrics.ts) dos 12 cenários pinados do CI. A família
//   só ORQUESTRA (varre eixo × seeds) e AGREGA (média + IC por bootstrap). Motor único, §2 do escopo.
// - Seeds DETERMINÍSTICOS 1..N (nunca aleatórios): a curva inteira é reproduzível bit-a-bit — rodar
//   duas vezes dá o mesmo resultado, e um ponto suspeito é re-simulável isolado (seed conhecido).
// - IC 95% por BOOTSTRAP percentil (reamostragem com reposição das médias): não assume normalidade
//   — as métricas são taxas/contagens de cauda feia (precision satura em 1, contadores em 0), onde
//   o IC gaussiano (±1,96·σ/√n) mentiria nas bordas. O PRNG do bootstrap é um LCG seedado PRÓPRIO
//   (mesma disciplina de sim.ts — zero Math.random), com seed derivado do ÍNDICE do ponto no eixo:
//   o sorteio da reamostragem nunca se mistura com o RNG dos cenários e é idêntico a cada execução.
//   SUBCOBERTURA CONHECIDA (achado M2, revisão adversarial da Fase 4, 2026-07-11): bootstrap
//   percentil com n pequeno SUBCOBRE — o rótulo "IC 95%" tem cobertura real medida de ~88–93% com
//   n=20 (≈87,8% p/ distribuição tipo-precisão; ≈92,9% tipo-contagem). Suficiente pra leitura de
//   CURVA (tendência/joelho), insuficiente pra teste de hipótese rigoroso — testes de hipótese
//   usem margens folgadas ou aumentem n.
// - Decomposição por tipo de erro OBRIGATÓRIA (regra da casa, §7.1): além de precisão/cobertura, a
//   curva carrega wrong, falseLabels e idSwitches (os totais do run, como IdentityMetrics já conta)
//   — uma queda de precisão sem a decomposição não diz SE o erro é confusão pessoa↔pessoa (wrong),
//   rótulo em quem não tem tag (falseLabels) ou instabilidade temporal (idSwitches).
// - TAXAS junto das contagens (achado C1, revisão adversarial da Fase 4, 2026-07-11): contagem
//   ABSOLUTA de erro num eixo que muda o Nº DE OPORTUNIDADES é armadilha de leitura — na família
//   ×pessoas, wrong 10→87 pareceu "aceleração de erro", mas o nº de decisões cresce ~3,5× ao longo
//   do eixo; normalizado por decisões (wrong/decisões), o erro SATURA (2,4%→5,3%→platô ~5,5%).
//   Por isso cada ponto carrega também: `wrongRate` (a taxa que IdentityMetrics JÁ computa e era
//   descartada aqui), `swap` (wrong−falseLabels POR SEED, antes de agregar — o pessoa↔pessoa REAL,
//   já que falseLabels é SUBCONJUNTO de wrong em identity-metrics.ts) e `opportunities` (o
//   denominador — permite qualquer releitura da curva). Cuidado ao comparar: people=2 tem 1 só tag
//   ⇒ swap é IMPOSSÍVEL ali (wrong=falseLabels por construção); o ponto não é comparável aos demais.
// - Pinos: curvas novas NÃO nascem pinadas — "curvas novas ganham pinos próprios quando
//   estabilizarem" (§7.1). Os 12 pinos antigos ficam intocados (replay-fusion.test.ts).
//
// Responsabilidade única: varrer famílias e agregar estatística. Simular é sim.ts; associar é
// associate.ts (via replay-fusion.ts); medir é identity-metrics.ts.
import { replayFusion } from "./replay-fusion";
import type { FusionConfig } from "./associate";
import { simulateFusionScenario } from "./sim";
import type { SimOpts } from "./sim";

/** Estatística de UMA métrica em UM ponto do eixo: média entre seeds + IC 95% (bootstrap). */
export type BootstrapCi = { mean: number; lo: number; hi: number };

/** Um ponto da curva: valor do eixo + estatísticas das métricas de identidade + decomposição. */
export type FamilyPoint = {
  axisValue: number;
  /** Seeds usados neste ponto (1..N — determinísticos, ver cabeçalho). */
  seeds: number[];
  precision: BootstrapCi;
  coverage: BootstrapCi;
  /** Decomposição por tipo de erro (regra da casa): totais do run, agregados entre seeds. */
  wrong: BootstrapCi;
  falseLabels: BootstrapCi;
  idSwitches: BootstrapCi;
  /**
   * wrong/decisões — a TAXA que identity-metrics.ts já computa por run. Leitura imune à armadilha
   * da contagem absoluta (achado C1 do cabeçalho): num eixo que muda o nº de oportunidades, é ela
   * (não `wrong`) que diz se o erro acelera ou satura.
   */
  wrongRate: BootstrapCi;
  /**
   * wrong−falseLabels POR SEED (subtraído ANTES de agregar) — a confusão pessoa↔pessoa REAL,
   * já que falseLabels é subconjunto de wrong (identity-metrics.ts conta falso-rótulo nos dois).
   */
  swap: BootstrapCi;
  /** Média de oportunidades (decisões onde a pessoa tinha tag) — o denominador pra releituras. */
  opportunities: BootstrapCi;
};

export type FamilyResult = { name: string; axisName: string; points: FamilyPoint[] };

/** Definição de uma família paramétrica: um eixo varia, o resto do mundo é função dele. */
export type ParametricFamily = {
  name: string;
  /** Nome do parâmetro variado (eixo x da curva) — só documentação/relatório. */
  axisName: string;
  /** Valores do eixo, na ordem em que a curva será reportada. */
  axis: number[];
  /** Monta o cenário (SimOpts) para um valor do eixo. Deve ser PURA — mesmo valor, mesmo cenário. */
  scenario: (axisValue: number) => SimOpts;
  /** Seeds por ponto (default 20 — piso do §7.1). */
  seedsPerPoint?: number;
};

export type RunFamilyOpts = {
  /** Override do eixo (ex.: eixo reduzido no CI — a curva completa fica atrás de FAMILY_FULL=1). */
  axis?: number[];
  /** Override dos seeds por ponto (ex.: 5 no CI). */
  seedsPerPoint?: number;
  /** Reamostragens do bootstrap (default 1000). */
  bootstrapResamples?: number;
  /** Config do associador (default = produção, igual aos cenários pinados). */
  cfg?: FusionConfig;
};

const DEFAULT_SEEDS_PER_POINT = 20; // piso do §7.1 do escopo
const DEFAULT_BOOTSTRAP_RESAMPLES = 1000;
// Seed-base do PRNG do bootstrap (arbitrário, FIXO): somado ao índice do ponto no eixo, dá a cada
// ponto um stream próprio e reproduzível, independente dos seeds dos cenários (1..N).
const BOOTSTRAP_SEED_BASE = 0xb007;

// LCG (Numerical Recipes) — MESMA disciplina de sim.ts (que não o exporta; 6 linhas, duplicação
// consciente > exportar um privado do motor só pra isto). Zero Math.random neste módulo.
type Rng = () => number;
function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Média aritmética (vazio → 0; nunca NaN — mesma postura de identity-metrics.ts). */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * IC 95% por bootstrap percentil: `resamples` reamostragens com reposição, média de cada uma,
 * percentis 2,5/97,5 da distribuição das médias. Determinístico dado o `rng` (LCG seedado do
 * chamador). Amostra vazia → {0,0,0}; amostra constante → lo=média=hi (IC degenerado honesto).
 */
export function bootstrapCi(values: readonly number[], rng: Rng, resamples: number): BootstrapCi {
  const n = values.length;
  const m = mean(values);
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const means = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += values[Math.floor(rng() * n)];
    means[b] = sum / n;
  }
  means.sort((a, z) => a - z);
  const lo = means[Math.floor(0.025 * (resamples - 1))];
  const hi = means[Math.ceil(0.975 * (resamples - 1))];
  return { mean: m, lo, hi };
}

/**
 * Roda uma família paramétrica ponta-a-ponta: para cada valor do eixo, simula `seedsPerPoint`
 * cenários (seeds 1..N), reproduz cada um no associador DE PRODUÇÃO (replayFusion) e agrega
 * média + IC 95% (bootstrap) de precisão, cobertura e da decomposição de erro. 100% determinístico
 * — mesma família + mesmos seeds ⇒ mesmo resultado, bit a bit.
 */
export function runFamily(family: ParametricFamily, opts?: RunFamilyOpts): FamilyResult {
  const axis = opts?.axis ?? family.axis;
  const seedsPerPoint = opts?.seedsPerPoint ?? family.seedsPerPoint ?? DEFAULT_SEEDS_PER_POINT;
  const resamples = opts?.bootstrapResamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seeds = Array.from({ length: seedsPerPoint }, (_, k) => k + 1); // 1..N, nunca aleatórios

  const points: FamilyPoint[] = axis.map((axisValue, i) => {
    const simOpts = family.scenario(axisValue);
    const precision: number[] = [];
    const coverage: number[] = [];
    const wrong: number[] = [];
    const falseLabels: number[] = [];
    const idSwitches: number[] = [];
    const wrongRate: number[] = [];
    const swap: number[] = [];
    const opportunities: number[] = [];
    for (const seed of seeds) {
      const m = replayFusion(simulateFusionScenario(simOpts, seed), opts?.cfg).metrics;
      precision.push(m.precision);
      coverage.push(m.coverage);
      wrong.push(m.wrong);
      falseLabels.push(m.falseLabels);
      idSwitches.push(m.idSwitches);
      wrongRate.push(m.wrongRate);
      swap.push(m.wrong - m.falseLabels); // por seed, ANTES de agregar (ver doc do campo)
      opportunities.push(m.opportunities);
    }
    // Um stream de bootstrap POR PONTO (seed = base + índice no eixo), consumido pelas 8 métricas
    // em ordem fixa — as 3 novas (wrongRate/swap/opportunities) DEPOIS das 5 originais, então os
    // ICs antigos permanecem bit-idênticos. O contrato garantido é reprodutibilidade da MESMA
    // chamada (mesma família + mesmos opts ⇒ mesmos bits) — mudar eixo/seeds/resamples muda o IC
    // legitimamente (é outra medição), nunca por sorteio escondido.
    const rng = lcg(BOOTSTRAP_SEED_BASE + i);
    return {
      axisValue,
      seeds,
      precision: bootstrapCi(precision, rng, resamples),
      coverage: bootstrapCi(coverage, rng, resamples),
      wrong: bootstrapCi(wrong, rng, resamples),
      falseLabels: bootstrapCi(falseLabels, rng, resamples),
      idSwitches: bootstrapCi(idSwitches, rng, resamples),
      wrongRate: bootstrapCi(wrongRate, rng, resamples),
      swap: bootstrapCi(swap, rng, resamples),
      opportunities: bootstrapCi(opportunities, rng, resamples),
    };
  });

  return { name: family.name, axisName: family.axisName, points };
}

// ——— Famílias concretas ———

// 240 passos = 120 s — mesmo tamanho dos cenários pinados (replay-fusion.ts): a janela de 8 s do
// associador precisa de amostra farta DEPOIS do warmup pra métrica não medir só o transitório.
const FAMILY_STEPS = 240;

/**
 * Precisão × nº de pessoas — a curva "até quantas pessoas?" do §8 do escopo, e o teste da
 * previsão falseável (b): "a curva precisão×pessoas tem JOELHO, não declive linear — colisão de
 * assinatura no espaço 1D (distância radial) domina a partir de certa densidade".
 * Eixo: people 2..7; tagged = people−1 (sempre há UMA pessoa sem tag — mantém o modo de erro
 * falseLabels vivo em todos os pontos); walk "waypoint" (o regime canônico dos pinos).
 * NOTA: o eixo PARA em 7 porque o sim tem 6 MACs de tag — em 7 pessoas, tagged=6 usa todas; além
 * disso o clamp do motor achataria tagged e o eixo deixaria de medir só densidade (mediria também
 * a fração sem-tag mudando junto — dois eixos num, proibido pelo §7.1).
 */
export const FAMILY_PRECISION_VS_PEOPLE: ParametricFamily = {
  name: "precisao-vs-pessoas",
  axisName: "people",
  axis: [2, 3, 4, 5, 6, 7],
  scenario: (people) => ({
    steps: FAMILY_STEPS,
    people,
    tagged: people - 1,
    walk: "waypoint",
  }),
};

/**
 * Precisão × σ de ruído RSSI — a curva "quanto ruído aguenta?" do §8 do escopo.
 * Eixo: rssiNoiseDb 2..12 dB — o default do sim é 4 e a mineração das 6h reais mediu σ≈5,6
 * (relatorio-consolidado-2026-07-10.md), então o eixo cobre de "melhor que o campo" a "bem pior".
 * People 3 / tagged 2 / waypoint / 240 passos — o regime canônico dos pinos: a ÚNICA coisa
 * variando é o ruído (§7.1: um eixo por família, nunca dois).
 */
export const FAMILY_PRECISION_VS_NOISE: ParametricFamily = {
  name: "precisao-vs-ruido",
  axisName: "rssiNoiseDb",
  axis: [2, 4, 6, 8, 10, 12],
  scenario: (rssiNoiseDb) => ({
    steps: FAMILY_STEPS,
    people: 3,
    tagged: 2,
    walk: "waypoint",
    rssiNoiseDb,
  }),
};

/**
 * Precisão × viés corporal — a curva "×viés corporal" do §8 do escopo. Eixo = `peakDb` do
 * bodyBias (a atenuação de pior caso, corpo entre a tag e a estação); `meanDb` acompanha
 * proporcional (peakDb/3 — preserva a razão piso/pico ~6/18 dos valores literatura+minerados de
 * sim.ts) e `angWidthDeg` = 100 é o `[chute marcado]` do §3 do escopo (sem medição própria ainda).
 * peakDb = 0 ⇒ meanDb = 0 ⇒ viés nulo em toda direção — o ponto-controle da curva (equivale a
 * não ter o knob; bodyBias não consome RNG, então o cenário é o mesmo do canônico).
 */
export const FAMILY_PRECISION_VS_BODY_BIAS: ParametricFamily = {
  name: "precisao-vs-vies-corporal",
  axisName: "bodyBiasPeakDb",
  axis: [0, 4, 8, 12, 16, 20, 24],
  scenario: (peakDb) => ({
    steps: FAMILY_STEPS,
    people: 3,
    tagged: 2,
    walk: "waypoint",
    bodyBias: { meanDb: peakDb / 3, peakDb, angWidthDeg: 100 },
  }),
};

/**
 * Precisão × erro de posição de âncora — a curva "quão bem preciso instalar?" do §8 do escopo e o
 * TESTE da previsão falseável (c): "erro de posição de âncora move auditoria e anéis, NÃO a
 * precisão de identidade — a associação por correlação não consome posição de âncora. Se mover,
 * há acoplamento escondido (bug ou suposição não documentada)". Eixo: anchorPosErrorM 0..2 m
 * (0 = cadastro perfeito). Cenário com anchors:true — o replay refita o path-loss pelas posições
 * CADASTRADAS (erradas quando o eixo > 0), então o `distM` das leituras muda; a previsão é que a
 * identidade fica parada porque gate/blend estão OFF por default (revisão adversarial de
 * 2026-07-10) e a correlação ignora distM. O teste que cobra a previsão vive em families.test.ts.
 */
export const FAMILY_PRECISION_VS_ANCHOR_ERROR: ParametricFamily = {
  name: "precisao-vs-erro-ancora",
  axisName: "anchorPosErrorM",
  axis: [0, 0.5, 1, 1.5, 2],
  scenario: (anchorPosErrorM) => ({
    steps: FAMILY_STEPS,
    people: 3,
    tagged: 2,
    walk: "waypoint",
    anchors: true,
    anchorPosErrorM,
  }),
};
