// TRIAGEM DE TRACKS QUASE-ESTÁTICOS — separar OPERADOR PARADO de MOBÍLIA detectada como pessoa.
//
// ═══ POR QUE ESTE MÓDULO EXISTE (a armadilha, apontada por revisão externa em 2026-07-12) ═══
// A mineração de fragmentação classificou tracks de baixo deslocamento como "flicker de mobília" e
// os DESCARTOU. Um operador PARADO NA MESA tem EXATAMENTE o mesmo perfil de deslocamento. Filtrar
// por deslocamento é, portanto, medir a população ERRADA — o mesmo erro, na mesma variável, duas
// vezes. E as duas leituras possíveis são AMBAS grandes:
//   • São PESSOAS PARADAS → o dataset de permanência (H2) já está na gravação, de graça.
//   • É MOBÍLIA contada como pessoa → é BUG DE OCUPAÇÃO, e a ocupação é a BASE do bookkeeping
//     (petri-conservation.ts) e do piso de anônimos (`pessoas − tags` em zone-assignment.ts).
// Este módulo não decide por deslocamento: ele extrai DISCRIMINANTES FÍSICOS e vota.
//
// ═══ OS DISCRIMINANTES (e o que cada um vale) ═══
//  1. DESLOCAMENTO DO PÉ (bottom-center do bbox — o mesmo ponto que a homografia usa), em unidades
//     de LARGURA DE CORPO (bbox w). Escala-livre: 1,0 = a caixa andou o próprio corpo de lado.
//     Mobília não se relocaliza; ruído de detector é fração pequena da caixa.
//  2. VARIAÇÃO DE ALTURA do bbox (CV = std/média). É o discriminante de POSTURA, e é ORTOGONAL ao
//     deslocamento: uma pessoa que se inclina/agacha/estica muda de ALTURA com o PÉ PARADO. Uma
//     cadeira tem altura constante — só o jitter do detector a move.
//  3. CICLO DE VIDA: mobília existe do PRIMEIRO ao ÚLTIMO frame da sessão (ela estava lá antes da
//     câmera ligar). Pessoa NASCE e MORRE no meio. Este é o discriminante mais BARATO e mais duro.
//  4. Micro-movimento (balanço postural): ver o AVISO DE RESOLUÇÃO abaixo — em geral INDISPONÍVEL.
//
// ═══ AVISO DE RESOLUÇÃO DO INSTRUMENTO (Regra 9 — verificar se o instrumento resolve o efeito) ═══
// O balanço postural humano é de ~cm a ~0,1–1 Hz. Para vê-lo é preciso amostrar a ≥2 Hz. A gravação
// de fusão amostra o snapshot de tracks a ~0,17 Hz (Δt mediano ~6 s na sessão de campo). O balanço
// postural está ALIASADO — irrecuperável. Portanto `microMovementResolvable` sai FALSE e o veredito
// NÃO usa micro-movimento; ele é reportado (residual/autocorrelação) apenas como diagnóstico, e
// afirmar qualquer coisa a partir dele seria inventar física que o dado não tem.
// O PISO DE JITTER do detector (`estimateJitterFloor`) é estimado do PRÓPRIO dado (o menor passo
// mediano entre os episódios) — é um LIMITE SUPERIOR do ruído do instrumento, não a sua medida: só
// autoriza a dizer "este deslocamento é grande DEMAIS para ser jitter", nunca "isto é micro-movimento".
//
// Responsabilidade única: extrair features de um track e votar. Não carrega arquivo, não associa
// tags, não conta ocupação. Puro/determinístico. Nunca NaN (série degenerada → features 0).
import type { DrawTrack } from "./frame";

/** Um frame de UM track: instante (ms) e a caixa. */
export type TrackFrame = { ts: number; bbox: readonly [number, number, number, number] };

/** Um episódio de track: janela CONTÍGUA de presença de um trackId (mesma definição de episódio do
 *  visit-metrics.ts — quebra na AUSÊNCIA da pista), com os frames FRESCOS (hold desfeito).
 *
 *  ATENÇÃO À SEPARAÇÃO (bug corrigido na bancada): `startTs`/`endTs` são a PRESENÇA de relógio de
 *  parede (primeiro e último TICK em que a pista existiu — o que a produção enxerga), enquanto
 *  `frames` são só as OBSERVAÇÕES FRESCAS. Tirar a duração dos frames frescos perderia a cauda
 *  segurada pelo hold — e, no limite de um objeto PERFEITAMENTE imóvel (bbox bit-idêntica), o dedup
 *  colapsaria a coisa toda num único frame e a mobília "duraria 0 s". Duração é presença; evidência
 *  é frame fresco. As duas coisas NÃO são a mesma. */
export type TrackEpisode = {
  trackId: number;
  frames: TrackFrame[];
  startTs: number;
  endTs: number;
};

export type TriageVerdict = "PESSOA_PARADA" | "MOBILIA" | "INCONCLUSIVO";

/** As features + o voto de UM episódio. Tudo em unidades declaradas — nada adimensional escondido. */
export type TrackTriage = {
  trackId: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  /** Frames FRESCOS (após desfazer o hold do resample — ver `dedupeHeldFrames`). */
  nFrames: number;
  /** Δt mediano entre frames frescos (s) — a RESOLUÇÃO TEMPORAL do instrumento neste episódio. */
  dtMedianS: number;

  // ——— 1. deslocamento (do PÉ: bottom-center) ———
  /** Maior distância entre dois pés do episódio, em fração de imagem (a métrica da mineração antiga). */
  maxFootDispImg: number;
  /** O MESMO deslocamento, em LARGURAS DE CORPO (maxFootDispImg / bbox w médio) — escala-livre. */
  maxFootDispBw: number;
  /** Passo mediano entre frames consecutivos, em larguras de corpo. */
  stepMedianBw: number;
  /** Comprimento do caminho percorrido pelo pé (soma dos passos), em larguras de corpo. */
  pathLenBw: number;

  // ——— 2. bbox ———
  /** Pé MÉDIO do episódio (fração de imagem) — a ÂNCORA espacial usada pela busca de hotspot. */
  meanFootX: number;
  meanFootY: number;
  meanW: number;
  meanH: number;
  /** CV da ALTURA do bbox (std/média) — o discriminante de POSTURA. */
  heightCv: number;
  /** CV da LARGURA do bbox. */
  widthCv: number;
  /** CV do aspecto (h/w). */
  aspectCv: number;

  // ——— 3. ciclo de vida (relativo à sessão) ———
  /** Nasceu no PRIMEIRO frame da sessão (estava lá antes da câmera). */
  bornAtSessionStart: boolean;
  /** Morreu no ÚLTIMO frame da sessão. */
  diedAtSessionEnd: boolean;
  /** Nasceu E morreu no meio da sessão — a assinatura de quem CHEGA e VAI EMBORA. */
  midSessionLifecycle: boolean;

  // ——— 4. micro-movimento (DIAGNÓSTICO — ver AVISO DE RESOLUÇÃO no cabeçalho) ———
  /** `dtMedianS <= MICRO_MAX_DT_S`. FALSE ⇒ balanço postural ALIASADO ⇒ NÃO entra no veredito. */
  microMovementResolvable: boolean;
  /** std do resíduo do pé após remover a TENDÊNCIA LINEAR (fração de imagem). Só diagnóstico. */
  residualStdImg: number;
  /** Autocorrelação de lag-1 desse resíduo. i.i.d. (ruído de detector) → ~0; movimento com memória
   *  → >0. Só diagnóstico enquanto `microMovementResolvable` for false. */
  residualLag1: number;

  // ——— 5. coexistência espacial ———
  /** Maior IoU com QUALQUER outro track presente no mesmo instante (oclusão/sobreposição). */
  maxIoUWithOthers: number;

  verdict: TriageVerdict;
  /** As evidências que sustentam o voto — nunca um veredito mudo. */
  reasons: string[];
};

// ——— Limiares do voto (declarados; justificados no cabeçalho) ———
/** Pé andou ≥ meia largura de corpo (~25 cm) — ordens de grandeza acima de qualquer jitter. */
const PERSON_DISP_BW = 0.5;
/** Altura do bbox variou ≥10% — postura (inclinar/agachar/esticar). Mobília não muda de altura. */
const PERSON_HEIGHT_CV = 0.1;
/** Piso de "não se mexeu": ≤10% de uma largura de corpo (~5 cm) em TODO o episódio. */
const FURNITURE_DISP_BW = 0.1;
/** Altura praticamente constante: ≤3% de CV. */
const FURNITURE_HEIGHT_CV = 0.03;
/** Resolução temporal MÍNIMA para tentar ver balanço postural (Nyquist grosseiro de ~0,5 Hz). */
const MICRO_MAX_DT_S = 1;

/** Pé (bottom-center) da caixa — o MESMO ponto que frame.ts leva pela homografia. */
function foot(b: readonly [number, number, number, number]): { x: number; y: number } {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** CV = std/média; 0 quando a média é ~0 (nunca NaN/Infinity). */
function cv(xs: readonly number[]): number {
  const m = mean(xs);
  if (Math.abs(m) < 1e-9) return 0;
  return std(xs) / Math.abs(m);
}

/**
 * Desfaz o HOLD do resample: a grade de ticks (session-loader) REPETE o último snapshot de tracks
 * até o próximo "trk" chegar — na gravação de campo o snapshot vem a cada ~6 s e a grade é de 500 ms,
 * então CADA frame aparece ~12×. Contar essas repetições como observações fabricaria autocorrelação
 * perfeita e um n_eff inflado — é EXATAMENTE o pecado de sample-and-hold que o `distinctConsecutive`
 * já mata no RSSI (visit-metrics.ts) e que `freshAcf` mata na ACF (residual-autocorr.ts).
 * Aqui a regra é a mesma: só uma MUDANÇA de caixa conta frame novo.
 */
export function dedupeHeldFrames(frames: readonly TrackFrame[]): TrackFrame[] {
  const out: TrackFrame[] = [];
  for (const f of frames) {
    const p = out[out.length - 1];
    if (
      p &&
      p.bbox[0] === f.bbox[0] &&
      p.bbox[1] === f.bbox[1] &&
      p.bbox[2] === f.bbox[2] &&
      p.bbox[3] === f.bbox[3]
    ) {
      continue;
    }
    out.push(f);
  }
  return out;
}

/** Um tick de tracks — o que `parseFusionSession` devolve (subset do SimTick). */
export type TrackTick = { ts: number; tracks: readonly DrawTrack[] };

/**
 * Recorta os ticks em EPISÓDIOS de track: janela contígua de presença de um trackId, com o hold
 * desfeito. Quebra na AUSÊNCIA da pista (mesma definição de episódio do visit-metrics.ts, para que
 * a triagem fale da MESMA população que as métricas de visita). Um trackId que reaparece depois de
 * sumir gera DOIS episódios.
 */
export function buildTrackEpisodes(ticks: readonly TrackTick[]): TrackEpisode[] {
  const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
  const open = new Map<number, TrackFrame[]>();
  const done: TrackEpisode[] = [];
  const close = (id: number): void => {
    const raw = open.get(id) ?? [];
    open.delete(id);
    if (raw.length === 0) return;
    // Duração = PRESENÇA (raw, com hold); evidência = frames FRESCOS. Ver TrackEpisode.
    done.push({
      trackId: id,
      frames: dedupeHeldFrames(raw),
      startTs: raw[0].ts,
      endTs: raw[raw.length - 1].ts,
    });
  };

  for (const tick of sorted) {
    const seen = new Set<number>();
    for (const t of tick.tracks) {
      seen.add(t.id);
      let arr = open.get(t.id);
      if (!arr) {
        arr = [];
        open.set(t.id, arr);
      }
      arr.push({ ts: tick.ts, bbox: t.bbox });
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) close(id);
  }
  for (const id of [...open.keys()]) close(id);
  done.sort((a, b) => a.startTs - b.startTs || a.trackId - b.trackId);
  return done;
}

/**
 * LIMITE SUPERIOR do jitter posicional do detector, estimado DO PRÓPRIO DADO: o MENOR passo mediano
 * (em fração de imagem) entre os episódios com ≥`minFrames` frames. O episódio mais quieto da sessão
 * não pode estar se mexendo MENOS que o ruído do instrumento — logo o passo mediano dele é um teto
 * para esse ruído.
 *
 * É um TETO, não uma medida: se todo objeto da cena se move, o número sai alto e superestima o
 * jitter (conservador — torna a triagem MENOS propensa a chamar ruído de movimento). Serve para
 * responder "este deslocamento é grande demais para ser jitter?" — NUNCA para afirmar que um
 * deslocamento pequeno É micro-movimento humano. 0 se nenhum episódio qualifica.
 */
export function estimateJitterFloor(episodes: readonly TrackEpisode[], minFrames = 5): number {
  let floor = Infinity;
  for (const ep of episodes) {
    if (ep.frames.length < minFrames) continue;
    const steps: number[] = [];
    for (let i = 1; i < ep.frames.length; i++) {
      const a = foot(ep.frames[i - 1].bbox);
      const b = foot(ep.frames[i].bbox);
      steps.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    const m = median(steps);
    if (m > 0 && m < floor) floor = m;
  }
  return Number.isFinite(floor) ? floor : 0;
}

/** Autocorrelação de lag-1 de uma série (0 se degenerada). */
function lag1(xs: readonly number[]): number {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  let s2 = 0;
  let s1 = 0;
  for (const x of xs) s2 += (x - m) * (x - m);
  for (let i = 1; i < xs.length; i++) s1 += (xs[i] - m) * (xs[i - 1] - m);
  if (s2 < 1e-15) return 0;
  return s1 / s2;
}

/** Resíduo do pé após remover a TENDÊNCIA LINEAR em ts (a "deriva" lenta — a pessoa que anda devagar
 *  ou a cadeira que foi empurrada); o que sobra é jitter + micro-movimento. Devolve a norma do
 *  resíduo 2D por frame. */
function footResiduals(frames: readonly TrackFrame[]): number[] {
  const n = frames.length;
  if (n < 3) return [];
  const ts = frames.map((f) => f.ts);
  const mt = mean(ts);
  let stt = 0;
  for (const t of ts) stt += (t - mt) * (t - mt);
  if (stt < 1e-9) return [];
  const detrend = (vals: number[]): number[] => {
    const mv = mean(vals);
    let stv = 0;
    for (let i = 0; i < n; i++) stv += (ts[i] - mt) * (vals[i] - mv);
    const slope = stv / stt;
    return vals.map((v, i) => v - (mv + slope * (ts[i] - mt)));
  };
  const ex = detrend(frames.map((f) => foot(f.bbox).x));
  const ey = detrend(frames.map((f) => foot(f.bbox).y));
  return ex.map((_, i) => Math.hypot(ex[i], ey[i]));
}

/** IoU de duas caixas [x,y,w,h]. */
function iou(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/** Maior IoU do episódio com QUALQUER outro track presente no MESMO ts (sobreposição/oclusão). */
function maxIoUWithOthers(ep: TrackEpisode, ticks: readonly TrackTick[]): number {
  const byTs = new Map<number, readonly DrawTrack[]>();
  for (const t of ticks) byTs.set(t.ts, t.tracks);
  let best = 0;
  for (const f of ep.frames) {
    const others = byTs.get(f.ts);
    if (!others) continue;
    for (const o of others) {
      if (o.id === ep.trackId) continue;
      const v = iou(f.bbox, o.bbox);
      if (v > best) best = v;
    }
  }
  return best;
}

/** Limites da SESSÃO (primeiro/último ts de frame de track) — o referencial do ciclo de vida. */
export type SessionBounds = { firstTs: number; lastTs: number };

export function sessionBounds(ticks: readonly TrackTick[]): SessionBounds {
  let firstTs = Infinity;
  let lastTs = -Infinity;
  for (const t of ticks) {
    if (t.tracks.length === 0) continue;
    if (t.ts < firstTs) firstTs = t.ts;
    if (t.ts > lastTs) lastTs = t.ts;
  }
  return Number.isFinite(firstTs)
    ? { firstTs, lastTs }
    : { firstTs: 0, lastTs: 0 };
}

/**
 * Extrai as features de UM episódio e VOTA (ver cabeçalho).
 *
 * A REGRA DO VOTO (3 indicadores ortogonais, nenhum deles "deslocamento sozinho"):
 *   • PESSOA_PARADA: ≥2 dos 3 indicadores de pessoa — pé andou ≥0,5 largura de corpo; altura do bbox
 *     variou ≥10% (postura); nasceu E morreu no meio da sessão.
 *   • MOBILIA: os 3 indicadores de mobília JUNTOS — pé praticamente imóvel (≤0,1 largura de corpo),
 *     altura ~constante (CV ≤3%) e presença do primeiro ao último frame da sessão.
 *   • INCONCLUSIVO: o resto. É um RESULTADO, não uma falha — significa que o dado não separa.
 * Micro-movimento NÃO entra no voto quando `microMovementResolvable` é false (o caso da gravação de
 * campo, Δt~6 s). O `tolerance` (piso de jitter) só entra como sanidade: um deslocamento abaixo do
 * piso do instrumento nunca conta como "andou".
 */
export function triageTrackEpisode(
  ep: TrackEpisode,
  ticks: readonly TrackTick[],
  bounds: SessionBounds,
  jitterFloorImg = 0,
): TrackTriage {
  const frames = ep.frames;
  const feet = frames.map((f) => foot(f.bbox));
  const ws = frames.map((f) => f.bbox[2]);
  const hs = frames.map((f) => f.bbox[3]);
  const meanW = mean(ws);
  const meanH = mean(hs);
  const bw = Math.max(meanW, 1e-6); // largura de corpo (nunca divide por 0)

  let maxFootDispImg = 0;
  for (let i = 0; i < feet.length; i++) {
    for (let j = i + 1; j < feet.length; j++) {
      const d = Math.hypot(feet[j].x - feet[i].x, feet[j].y - feet[i].y);
      if (d > maxFootDispImg) maxFootDispImg = d;
    }
  }
  const steps: number[] = [];
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    steps.push(Math.hypot(feet[i].x - feet[i - 1].x, feet[i].y - feet[i - 1].y));
    gaps.push((frames[i].ts - frames[i - 1].ts) / 1000);
  }
  const pathLenImg = steps.reduce((a, b) => a + b, 0);
  const dtMedianS = median(gaps);

  const res = footResiduals(frames);
  const microMovementResolvable = dtMedianS > 0 && dtMedianS <= MICRO_MAX_DT_S;

  const bornAtSessionStart = ep.startTs <= bounds.firstTs;
  const diedAtSessionEnd = ep.endTs >= bounds.lastTs;
  const midSessionLifecycle = !bornAtSessionStart && !diedAtSessionEnd;

  const maxFootDispBw = maxFootDispImg / bw;
  const heightCv = cv(hs);
  const widthCv = cv(ws);
  const aspectCv = cv(hs.map((h, i) => h / Math.max(ws[i], 1e-6)));

  // Deslocamento SÓ conta se está acima do piso de jitter do instrumento (sanidade — ver
  // estimateJitterFloor): abaixo dele, "andou" é indistinguível de ruído do detector.
  const movedForReal = maxFootDispImg > jitterFloorImg;
  const iPerson = [
    movedForReal && maxFootDispBw >= PERSON_DISP_BW,
    heightCv >= PERSON_HEIGHT_CV,
    midSessionLifecycle,
  ];
  const nPerson = iPerson.filter(Boolean).length;
  const isFurniture =
    maxFootDispBw <= FURNITURE_DISP_BW &&
    heightCv <= FURNITURE_HEIGHT_CV &&
    bornAtSessionStart &&
    diedAtSessionEnd;

  const reasons: string[] = [];
  reasons.push(
    `pé: ${maxFootDispBw.toFixed(2)} larguras de corpo (${maxFootDispImg.toFixed(4)} img) ${
      iPerson[0] ? "≥" : "<"
    } ${PERSON_DISP_BW} → ${iPerson[0] ? "RELOCALIZOU (pessoa)" : "não relocalizou"}`,
  );
  reasons.push(
    `altura bbox: CV ${(heightCv * 100).toFixed(1)}% ${iPerson[1] ? "≥" : "<"} ${
      PERSON_HEIGHT_CV * 100
    }% → ${iPerson[1] ? "MUDOU DE POSTURA (pessoa)" : "altura estável"}`,
  );
  reasons.push(
    `ciclo de vida: ${
      midSessionLifecycle
        ? "NASCEU E MORREU no meio da sessão (pessoa chega e vai embora)"
        : `${bornAtSessionStart ? "presente desde o 1º frame" : "nasceu no meio"}, ${
            diedAtSessionEnd ? "presente até o último frame" : "morreu no meio"
          }`
    }`,
  );
  if (!microMovementResolvable) {
    reasons.push(
      `micro-movimento NÃO RESOLVÍVEL (Δt ${dtMedianS.toFixed(1)} s > ${MICRO_MAX_DT_S} s — balanço postural aliasado): NÃO entra no voto`,
    );
  }

  let verdict: TriageVerdict;
  if (isFurniture) {
    verdict = "MOBILIA";
    reasons.push("VOTO: os 3 indicadores de mobília juntos (imóvel + altura constante + eterna)");
  } else if (nPerson >= 2) {
    verdict = "PESSOA_PARADA";
    reasons.push(`VOTO: ${nPerson}/3 indicadores de PESSOA`);
  } else {
    verdict = "INCONCLUSIVO";
    reasons.push(
      `VOTO: ${nPerson}/3 indicadores de pessoa e não fecha mobília — o dado NÃO separa este track`,
    );
  }

  return {
    trackId: ep.trackId,
    startTs: ep.startTs,
    endTs: ep.endTs,
    durationMs: ep.endTs - ep.startTs,
    nFrames: frames.length,
    dtMedianS,
    maxFootDispImg,
    maxFootDispBw,
    stepMedianBw: median(steps) / bw,
    pathLenBw: pathLenImg / bw,
    meanFootX: mean(feet.map((f) => f.x)),
    meanFootY: mean(feet.map((f) => f.y)),
    meanW,
    meanH,
    heightCv,
    widthCv,
    aspectCv,
    bornAtSessionStart,
    diedAtSessionEnd,
    midSessionLifecycle,
    microMovementResolvable,
    residualStdImg: std(res),
    residualLag1: lag1(res),
    maxIoUWithOthers: maxIoUWithOthers(ep, ticks),
    verdict,
    reasons,
  };
}

/** Triagem de TODOS os episódios de uma sessão (piso de jitter estimado do próprio conjunto). */
export function triageSession(ticks: readonly TrackTick[]): TrackTriage[] {
  const episodes = buildTrackEpisodes(ticks);
  const bounds = sessionBounds(ticks);
  const floor = estimateJitterFloor(episodes);
  return episodes.map((ep) => triageTrackEpisode(ep, ticks, bounds, floor));
}

/**
 * HOTSPOT ESTÁTICO — o teste que fecha o BURACO do ciclo de vida (a hipótese "mobília PISCANDO").
 *
 * O discriminante de ciclo de vida (`bornAtSessionStart && diedAtSessionEnd`) é NECESSÁRIO para uma
 * mobília DETECTADA DE FORMA CONTÍNUA — mas uma cadeira que o detector só enxerga às vezes ("flicker")
 * NÃO seria contínua: ela viraria DEZENAS de episódios CURTOS, e escaparia inteira daquele teste.
 * Essa é precisamente a hipótese que a mineração de fragmentação levantou. Ela precisa de outro
 * discriminante — e ele existe, porque a cadeira tem uma propriedade que a pessoa não tem:
 *
 *   ELA NÃO SAI DO LUGAR. Um objeto fixo re-detectado ao longo de horas devolve episódios cujo PÉ
 *   cai SEMPRE no MESMO ponto, do começo ao fim da sessão. Uma pessoa, mesmo que trabalhe parada,
 *   não volta ao mesmo pixel hora após hora — e mesmo que voltasse, ela ENTRA e SAI, e o LOCAL não
 *   ficaria continuamente re-populado por episódios ao longo de TODO o span.
 *
 * Este agrupador junta episódios ESTÁTICOS cujo pé médio dista menos de `radiusBw` larguras de corpo
 * um do outro (guloso, semente = o episódio mais longo ainda livre) e reporta, por local: quantos
 * episódios, o SPAN (do 1º ao último) e a presença somada.
 *
 * O QUE O RESULTADO AUTORIZA A DIZER (leia antes de usar):
 *   • Hotspot com span ~sessão inteira = CONDIÇÃO NECESSÁRIA para mobília piscando. NÃO é prova —
 *     um posto de trabalho onde pessoas se revezam produz o mesmo padrão. Hotspot ⇒ investigar.
 *   • AUSÊNCIA de hotspot de span longo ⇒ a hipótese "mobília piscando" está REFUTADA para aquele
 *     conjunto: não há objeto fixo sendo re-detectado ali. Este é o uso FORTE (modus tollens).
 * Responsabilidade única: agrupar por proximidade. Não vota, não conta ocupação.
 */
export type StaticHotspot = {
  /** Pé médio do cluster (fração de imagem). */
  x: number;
  y: number;
  /** Caixa MÉDIA dos episódios do cluster (fração de imagem) — separa "caixa de gente" de caixa
   *  minúscula/distorcida (falso-positivo fixo do detector). Diagnóstico, não voto. */
  meanW: number;
  meanH: number;
  nEpisodes: number;
  firstTs: number;
  lastTs: number;
  /** lastTs − firstTs: por quanto tempo este LOCAL segue devolvendo episódios (o sinal de mobília). */
  spanMs: number;
  /** Soma das durações dos episódios do cluster (presença acumulada no local). */
  presenceMs: number;
  trackIds: number[];
};

export function findStaticHotspots(
  triages: readonly TrackTriage[],
  radiusBw = 0.5,
): StaticHotspot[] {
  const pool = [...triages].sort((a, b) => b.durationMs - a.durationMs);
  const taken = new Set<number>();
  const out: StaticHotspot[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (taken.has(i)) continue;
    const seed = pool[i];
    const radius = Math.max(seed.meanW, 1e-6) * radiusBw;
    const members = [seed];
    taken.add(i);
    for (let j = i + 1; j < pool.length; j++) {
      if (taken.has(j)) continue;
      const c = pool[j];
      if (Math.hypot(c.meanFootX - seed.meanFootX, c.meanFootY - seed.meanFootY) <= radius) {
        members.push(c);
        taken.add(j);
      }
    }
    let firstTs = Infinity;
    let lastTs = -Infinity;
    let presenceMs = 0;
    for (const m of members) {
      if (m.startTs < firstTs) firstTs = m.startTs;
      if (m.endTs > lastTs) lastTs = m.endTs;
      presenceMs += m.durationMs;
    }
    out.push({
      x: mean(members.map((m) => m.meanFootX)),
      y: mean(members.map((m) => m.meanFootY)),
      meanW: mean(members.map((m) => m.meanW)),
      meanH: mean(members.map((m) => m.meanH)),
      nEpisodes: members.length,
      firstTs,
      lastTs,
      spanMs: lastTs - firstTs,
      presenceMs,
      trackIds: members.map((m) => m.trackId),
    });
  }
  out.sort((a, b) => b.spanMs - a.spanMs || b.nEpisodes - a.nEpisodes);
  return out;
}

/**
 * A FRAÇÃO DA OCUPAÇÃO MEDIDA que cada veredito responde — o número que o PRODUTO consome.
 *
 * A ocupação de produção não conta EPISÓDIOS, conta TRACKS PRESENTES POR TICK (é isso que vira
 * `pessoas` no piso de anônimos `pessoas − tags` de zone-assignment.ts e nos tokens da conservação
 * por zona de petri-conservation.ts). Logo a unidade honesta aqui é o **track-tick**: um track
 * presente num tick = uma unidade de ocupação. Um episódio de 40 min de mobília pesa 4 800 vezes
 * mais no bookkeeping do que um blip de 0,5 s — contar episódios esconderia exatamente isso.
 *
 * `mobiliaShare` = track-ticks de episódios votados MOBILIA / track-ticks totais. É o ERRO DE
 * OCUPAÇÃO diretamente: se dá 0, o bookkeeping não está inflado por mobília; se dá 0,3, então 30%
 * da "gente" que o sistema conta é móvel.
 *
 * Responsabilidade única: contar presença por veredito. Não vota (recebe os vereditos prontos).
 */
export type OccupancyByVerdict = {
  /** Track-ticks (track presente num tick) por veredito. */
  PESSOA_PARADA: number;
  MOBILIA: number;
  INCONCLUSIVO: number;
  /** Track-ticks totais = a ocupação medida acumulada da sessão. */
  total: number;
  /** MOBILIA / total — a fração da ocupação que seria mobília (0 = bookkeeping limpo). */
  mobiliaShare: number;
  /** Track-ticks sem episódio correspondente (não deve acontecer; 0 em uso normal). */
  unmatched: number;
};

export function occupancyByVerdict(
  ticks: readonly TrackTick[],
  triages: readonly TrackTriage[],
): OccupancyByVerdict {
  const byTrack = new Map<number, TrackTriage[]>();
  for (const t of triages) {
    let arr = byTrack.get(t.trackId);
    if (!arr) {
      arr = [];
      byTrack.set(t.trackId, arr);
    }
    arr.push(t);
  }
  const out: OccupancyByVerdict = {
    PESSOA_PARADA: 0,
    MOBILIA: 0,
    INCONCLUSIVO: 0,
    total: 0,
    mobiliaShare: 0,
    unmatched: 0,
  };
  for (const tick of ticks) {
    for (const trk of tick.tracks) {
      out.total++;
      const cands = byTrack.get(trk.id);
      const ep = cands?.find((c) => tick.ts >= c.startTs && tick.ts <= c.endTs);
      if (!ep) {
        out.unmatched++;
        continue;
      }
      out[ep.verdict]++;
    }
  }
  out.mobiliaShare = out.total > 0 ? out.MOBILIA / out.total : 0;
  return out;
}
