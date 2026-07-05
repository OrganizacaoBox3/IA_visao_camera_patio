// ── Interpolação de tracks do hub (Fase 2 — plano-retrofit-performance.md §Fase 2) ──────────────
// Lógica PURA/testável (sem DOM, sem rAF). Resolve o "fantasma+miss de detecção correta": o hub
// emite `analysis-tracks` a ~1fps; desenhar a caixa CRUA sobre o vídeo a ~30fps a congela onde a
// pessoa estava (lida como fantasma) e a deixa 1s atrás do corpo (lida como miss). Aqui a caixa
// de cada id é ANIMADA no tempo real entre os dois últimos payloads → acompanha a pessoa. Quem
// some faz fade suave e expira (não congela).
//
// OFFSET DE TIMESTAMP: não confiamos no `ts` do hub (relógio do servidor ≠ relógio do cliente);
// ancoramos cada keyframe na HORA LOCAL de chegada (`recvT`, monotônica). O `ts` do hub serve só
// para (a) DEDUPE do payload repetido (o getter da central devolve a mesma ref até o próximo) e
// (b) STALENESS (payload velho = motor reiniciando → deixa expirar em vez de desenhar dado morto).

/** bbox normalizado [x,y,w,h] em 0..1 do frame (mesma convenção de HubTrack/Track.bbox). */
export type Bbox = readonly [number, number, number, number];

/** Entrada por track (subconjunto de HubTrack que a interpolação usa). */
export type InterpTrack = {
  id: number;
  bbox: Bbox;
  zone: string | null;
};

/** Um payload do hub (contrato `analysis-tracks`, só o que interessa aqui). */
export type Snapshot = {
  ts: number;
  tracks: readonly InterpTrack[];
};

/** Caixa pronta para desenhar: bbox já interpolada + opacidade do fade + idade (telemetria). */
export type DrawnTrack = {
  id: number;
  bbox: [number, number, number, number];
  zone: string | null;
  opacity: number; // 0..1 (1 = presente; <1 = sumindo)
  ageMs: number; // ms desde o último payload que citou este id
};

export type InterpConfig = {
  /** Atraso de reprodução (ms): quanto mais alto, mais suave e mais atrasado. Baixo → extrapola. */
  delayMs: number;
  /** Piso/teto do intervalo entre keyframes (denominador da velocidade), robusto a jitter. */
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Não prever mais que isto ALÉM do último keyframe (limita overshoot quando a pessoa para). */
  maxExtrapMs: number;
  /** Idade a partir da qual a caixa começa a sumir (deve ser > intervalo do payload p/ não piscar). */
  fadeStartMs: number;
  /** Idade em que a caixa some de vez (removida do estado). */
  expireMs: number;
};

// Defaults calibrados p/ payload a ~1fps: fade só depois de 1,5s (não pisca entre payloads),
// some em 2,6s. delay baixo (extrapolação leve) privilegia latência; subir delayMs troca por
// suavidade. maxExtrap limita a previsão a meio intervalo (não dispara a caixa quando o corpo para).
export const DEFAULT_INTERP: InterpConfig = {
  delayMs: 100,
  minIntervalMs: 150,
  maxIntervalMs: 2000,
  maxExtrapMs: 500,
  fadeStartMs: 1500,
  expireMs: 2600,
};

/** Interpolação linear de bbox: t=0 → a, t=1 → b, t>1 extrapola na direção a→b. Pura. */
export function lerpBbox(a: Bbox, b: Bbox, t: number): [number, number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

type Keyframe = { bbox: Bbox; zone: string | null; t: number };
type Entry = { prev: Keyframe | null; last: Keyframe };

// Estado por id: 2 keyframes (o penúltimo e o último payload que citaram o id). A velocidade
// vem de (last - prev)/(last.t - prev.t); o desenho amostra essa reta na hora corrente.
export class TrackInterpolator {
  private readonly cfg: InterpConfig;
  private readonly entries = new Map<number, Entry>();
  private lastTs = Number.NEGATIVE_INFINITY;

  constructor(cfg: Partial<InterpConfig> = {}) {
    this.cfg = { ...DEFAULT_INTERP, ...cfg };
  }

  /**
   * Ingere um payload do hub. `recvT` = hora LOCAL de chegada (ms, monotônica — performance.now()).
   * Dedupe por `ts`: reingerir o mesmo payload (getter devolve a mesma ref) é no-op — não desloca
   * o keyframe, senão a caixa "andaria" a cada rAF sem dado novo. Ids ausentes deste payload NÃO
   * são tocados: envelhecem por `recvT` e somem no sample() (fade → expira).
   */
  ingest(snap: Snapshot, recvT: number): void {
    if (snap.ts === this.lastTs) return;
    this.lastTs = snap.ts;
    for (const tr of snap.tracks) {
      const kf: Keyframe = { bbox: tr.bbox, zone: tr.zone, t: recvT };
      const e = this.entries.get(tr.id);
      if (e) {
        e.prev = e.last;
        e.last = kf;
      } else {
        this.entries.set(tr.id, { prev: null, last: kf });
      }
    }
  }

  /** Amostra as caixas interpoladas na hora local `now`. Poda ids já expirados (efeito colateral). */
  sample(now: number): DrawnTrack[] {
    const c = this.cfg;
    const out: DrawnTrack[] = [];
    for (const [id, e] of this.entries) {
      const ageMs = now - e.last.t;
      if (ageMs > c.expireMs) {
        this.entries.delete(id);
        continue;
      }
      const opacity =
        ageMs <= c.fadeStartMs
          ? 1
          : Math.max(0, 1 - (ageMs - c.fadeStartMs) / (c.expireMs - c.fadeStartMs));
      out.push({ id, bbox: this.boxAt(e, now - c.delayMs), zone: e.last.zone, opacity, ageMs });
    }
    return out;
  }

  /** Número de ids vivos (telemetria/teste). */
  size(): number {
    return this.entries.size;
  }

  private boxAt(e: Entry, renderT: number): [number, number, number, number] {
    const c = this.cfg;
    // Sem penúltimo (id recém-visto): 1 amostra só → caixa estática (nada a interpolar).
    if (!e.prev) return [e.last.bbox[0], e.last.bbox[1], e.last.bbox[2], e.last.bbox[3]];
    const dt = e.last.t - e.prev.t;
    const interval = Math.min(c.maxIntervalMs, Math.max(c.minIntervalMs, dt));
    if (renderT <= e.prev.t) {
      return [e.prev.bbox[0], e.prev.bbox[1], e.prev.bbox[2], e.prev.bbox[3]];
    }
    // alpha em unidades de intervalo: 1 = no último keyframe; >1 extrapola (limitado por maxExtrap).
    const maxAlpha = 1 + c.maxExtrapMs / interval;
    const alpha = Math.min(maxAlpha, (renderT - e.prev.t) / interval);
    return lerpBbox(e.prev.bbox, e.last.bbox, alpha);
  }
}
