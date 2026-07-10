// Sentinela adversarial da persistência de rótulo (docs/cientifica/escopo-persistencia-rotulo.md,
// Mordida 2 — revisão do especialista, 2026-07-10): injeta um id-switch DETERMINÍSTICO do tracker
// — sem sorteio, no instante EXATO que o experimento pede — e mede se a política de memória
// (label-memory.ts) segue acreditando no rótulo ERRADO por algum tempo depois. Diferente do
// `idSwitchOnCross` de sim.ts (probabilístico, por proximidade): aqui o instante é escolhido pelo
// PRÓPRIO comportamento observado da política de memória (o tick exato de confirmação, ou N ticks
// depois de entrar em memória) — replay-e-descobre, depois regenera com a injeção cirúrgica no
// ponto certo (mesmo mecanismo `inject` que docs/cientifica/simulador.md propõe para o simulador
// geral; aqui é a implementação mínima que a rodada da persistência precisa AGORA).
//
// FÍSICA DA INJEÇÃO (por que o "sem salto físico" é honesto, não decorativo): a troca é aplicada
// via `SimOpts.forceSwitchAt` (sim.ts) — o MESMO ponto onde `idSwitchOnCross` trocaria
// probabilisticamente `trackIdOfPerson[a]`/`trackIdOfPerson[b]`. A partir do tick injetado, o
// trackId que a política tinha CONFIRMADO passa a seguir a posição física da OUTRA pessoa — mas a
// leitura RSSI de cada tag segue vindo da pessoa REAL que a carrega (independente de trackId), então
// a correlação eventualmente aponta pra tag certa; o que este módulo mede é quanto tempo a memória
// demora a perceber. Só vale como sentinela "sem salto" quando o instante escolhido tem as duas
// pessoas FISICAMENTE PRÓXIMAS (ver `SILENT_SWAP_MAX_DIST_M`) — sem isso seria outro experimento
// (salto detectável), não este.
//
// Responsabilidade única: achar o instante certo + montar o cenário injetado. Não mede
// erro-segundos/cobertura (métricas novas do escopo, ainda não construídas — próximo passo).
import { TagTrackAssociator } from "./associate";
import type { Assignment, FusionConfig } from "./associate";
import { LabelMemoryPolicy } from "./label-memory";
import type { MemoryBelief, MemoryConfig } from "./label-memory";
import { simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts, SimTick } from "./sim";
import { buildFusionFrame } from "./frame";
import { pixelToWorld } from "../vision/homography";
import type { Matrix3, Vec2 } from "../vision/homography";

/** Janela de busca (em ticks) ao redor do evento-alvo (confirmação, ou fim do sustain de memória)
 *  por um instante fisicamente próximo o bastante pra injetar sem salto — 20 ticks a 500ms/tick
 *  ≈ 10s pra cada lado, generoso o bastante pro cenário "cruzamento" ter passado por 1 cruzamento. */
const SEARCH_WINDOW_TICKS = 20;
/** Distância MÁXIMA (m) entre as duas pessoas no tick escolhido pra injeção contar como "sem salto
 *  físico detectável" — bem abaixo do SWITCH_NEAR_M (0,7 m) de sim.ts (folga deliberada: o objetivo
 *  aqui é o pior caso pra sentinela, não o limiar mínimo de disparo do mecanismo probabilístico). */
const SILENT_SWAP_MAX_DIST_M = 0.4;

export type ConfirmationEvent = { tickIndex: number; ts: number; trackId: number; tag: string };

/** Roda o associador + a política de memória juntos sobre o cenário (tick a tick, sem consumir
 *  RNG) e devolve as crenças (`MemoryBelief[]`) de cada tick — a MESMA alimentação fiel à produção
 *  do replay-fusion.ts (tick sem leituras é pulado), mas com a camada de memória por cima. */
export function replayWithMemory(
  sc: SimFusionScenario,
  cfg?: FusionConfig,
  memCfg?: MemoryConfig,
): { tickIndex: number; ts: number; assignments: Assignment[]; beliefs: MemoryBelief[] }[] {
  const assoc = new TagTrackAssociator(cfg);
  const mem = new LabelMemoryPolicy(memCfg);
  const out: { tickIndex: number; ts: number; assignments: Assignment[]; beliefs: MemoryBelief[] }[] =
    [];
  for (let i = 0; i < sc.ticks.length; i++) {
    const tick = sc.ticks[i];
    if (tick.readings.length === 0) continue; // mesma regra do replayFusion — produção pula o tick
    assoc.push(buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, sc.stationPx));
    const assignments = assoc.assign(tick.ts);
    const beliefs = mem.step(tick.ts, assignments);
    out.push({ tickIndex: i, ts: tick.ts, assignments, beliefs });
  }
  return out;
}

/** Primeiro tick em que ALGUM track é confirmado com `targetTag` — null se nunca confirma nesse
 *  cenário/seed/config (a sentinela não se aplica sem uma confirmação real pra atacar). */
export function findFirstConfirmation(
  sc: SimFusionScenario,
  targetTag: string,
  cfg?: FusionConfig,
  memCfg?: MemoryConfig,
): ConfirmationEvent | null {
  for (const row of replayWithMemory(sc, cfg, memCfg)) {
    const hit = row.beliefs.find((b) => b.state === "confirmada" && b.label === targetTag);
    if (hit) return { tickIndex: row.tickIndex, ts: row.ts, trackId: hit.trackId, tag: targetTag };
  }
  return null;
}

/** Primeiro tick em que `trackId` está em `memoria` por `sustainTicks` CONSECUTIVOS — null se nunca
 *  sustenta por tanto tempo nesse cenário (ex.: reentra em confirmada antes, ou quebra por timeout). */
export function findSustainedMemoria(
  sc: SimFusionScenario,
  trackId: number,
  sustainTicks: number,
  cfg?: FusionConfig,
  memCfg?: MemoryConfig,
): { tickIndex: number; ts: number } | null {
  let streak = 0;
  for (const row of replayWithMemory(sc, cfg, memCfg)) {
    const b = row.beliefs.find((x) => x.trackId === trackId);
    if (b?.state === "memoria") {
      streak++;
      if (streak >= sustainTicks) return { tickIndex: row.tickIndex, ts: row.ts };
    } else {
      streak = 0;
    }
  }
  return null;
}

/** Posição-mundo do track que a VERDADE do cenário-base associa a `personTag` neste tick — via
 *  homografia (pé do bbox), a mesma projeção do resto do domínio (frame.ts/derive-player-frame.ts).
 *  null quando a pessoa não está visível no tick (dropout/fora do FOV) ou H ausente. */
function taggedPersonWorldPos(tick: SimTick, H: Matrix3, personTag: string): Vec2 | null {
  for (const t of tick.tracks) {
    if (tick.truthTagByTrack[t.id] !== personTag) continue;
    const foot: Vec2 = { x: t.bbox[0] + t.bbox[2] / 2, y: t.bbox[1] + t.bbox[3] };
    return pixelToWorld(H, foot);
  }
  return null;
}

/** Busca, numa janela ao redor de `aroundIdx`, o tick MAIS PRÓXIMO fisicamente entre as duas
 *  pessoas (dist ≤ `SILENT_SWAP_MAX_DIST_M`) — o candidato honesto a instante de injeção "sem
 *  salto". null se nenhum tick da janela atende (o cenário não cruzou perto o bastante ali). */
function findNearbyTick(
  sc: SimFusionScenario,
  H: Matrix3,
  tagA: string,
  tagB: string,
  aroundIdx: number,
): number | null {
  const lo = Math.max(0, aroundIdx - SEARCH_WINDOW_TICKS);
  const hi = Math.min(sc.ticks.length - 1, aroundIdx + SEARCH_WINDOW_TICKS);
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const pa = taggedPersonWorldPos(sc.ticks[i], H, tagA);
    const pb = taggedPersonWorldPos(sc.ticks[i], H, tagB);
    if (!pa || !pb) continue;
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist <= SILENT_SWAP_MAX_DIST_M ? best : null;
}

export type SentinelResult = {
  /** Cenário COM a troca injetada — pronto pra `replayWithMemory`/`replayFusion`. */
  scenario: SimFusionScenario;
  injectedAtTick: number;
  personA: number;
  personB: number;
  tagA: string;
  tagB: string;
};

/** Tag de cada pessoa no cenário-base, lida do PRIMEIRO tick (antes de qualquer troca) — evita
 *  depender de constantes internas de sim.ts (MACS não é exportado; a verdade do tick 0 já entrega
 *  a mesma informação, já que trackIdOfPerson[p]=p até a primeira troca). */
function personTag(base: SimFusionScenario, personIdx: number): string | null {
  return base.ticks[0]?.truthTagByTrack[personIdx] ?? null;
}

/**
 * MORDIDA 2, sentinela 1 — id-switch NO INSTANTE DA CONFIRMAÇÃO: acha o primeiro tick em que
 * `personA` é confirmado, procura o instante mais próximo fisicamente entre `personA`/`personB`
 * (janela de busca ao redor da confirmação) e regenera o cenário com a troca injetada exatamente
 * ali. `null` quando o pré-requisito falha (nunca confirma, ou nunca cruza perto o bastante) —
 * decisão honesta: a sentinela não se aplica de qualquer jeito, não força um instante ruim.
 */
export function buildConfirmationSentinel(
  opts: SimOpts,
  seed: number,
  personA: number,
  personB: number,
  cfg?: FusionConfig,
  memCfg?: MemoryConfig,
): SentinelResult | null {
  const base = simulateFusionScenario(opts, seed);
  if (!base.H) return null; // sem H não há posição-mundo pra medir proximidade
  const tagA = personTag(base, personA);
  const tagB = personTag(base, personB);
  if (!tagA || !tagB) return null;

  const confirmation = findFirstConfirmation(base, tagA, cfg, memCfg);
  if (!confirmation) return null;

  const nearTick = findNearbyTick(base, base.H, tagA, tagB, confirmation.tickIndex);
  if (nearTick === null) return null;

  const scenario = simulateFusionScenario(
    { ...opts, forceSwitchAt: { tickIndex: nearTick, personA, personB } },
    seed,
  );
  return { scenario, injectedAtTick: nearTick, personA, personB, tagA, tagB };
}

/**
 * MORDIDA 2, sentinela 2 — id-switch DURANTE A MEMÓRIA (o pior caso real, ver escopo): acha a
 * confirmação de `personA`, depois o instante em que aquele MESMO track sustenta `sustainTicks`
 * consecutivos em `memoria`, e injeta a troca no cruzamento físico mais próximo dali. `null` nas
 * mesmas condições de falha do sentinela 1, mais "nunca sustenta memória por tanto tempo".
 */
export function buildMemoriaSentinel(
  opts: SimOpts,
  seed: number,
  personA: number,
  personB: number,
  sustainTicks: number,
  cfg?: FusionConfig,
  memCfg?: MemoryConfig,
): SentinelResult | null {
  const base = simulateFusionScenario(opts, seed);
  if (!base.H) return null;
  const tagA = personTag(base, personA);
  const tagB = personTag(base, personB);
  if (!tagA || !tagB) return null;

  const confirmation = findFirstConfirmation(base, tagA, cfg, memCfg);
  if (!confirmation) return null;

  const memoria = findSustainedMemoria(base, confirmation.trackId, sustainTicks, cfg, memCfg);
  if (!memoria) return null;

  const nearTick = findNearbyTick(base, base.H, tagA, tagB, memoria.tickIndex);
  if (nearTick === null) return null;

  const scenario = simulateFusionScenario(
    { ...opts, forceSwitchAt: { tickIndex: nearTick, personA, personB } },
    seed,
  );
  return { scenario, injectedAtTick: nearTick, personA, personB, tagA, tagB };
}
