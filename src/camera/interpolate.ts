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
  /** score real da detecção 0..1 (passthrough p/ o desenho: a CÂMERA FOCADA atenua pelo slider de
   *  confiança; a GRADE ignora). Ausente = hub antigo → sample devolve undefined (consumidor trata 1). */
  score?: number;
  /** VELOCIDADE do Kalman do tracker (contrato aditivo do hub): normalizada 0..1 por SEGUNDO, mesma
   *  convenção do bbox. Presente → DEAD-RECKONING (posição = bbox + v×dt, extrapola já no 1º keyframe).
   *  Ausente (hub antigo) → fallback à estimativa por 2 keyframes (retrocompat). */
  vx?: number;
  vy?: number;
};

/** Um payload do hub (contrato `analysis-tracks`, só o que interessa aqui). */
export type Snapshot = {
  ts: number;
  tracks: readonly InterpTrack[];
  /** Idade captura→emissão do frame no hub (ms, aditivo). Ancora o keyframe em `recvT - latencyMs`
   *  → a extrapolação prevê pro AGORA e a caixa senta na pessoa (07-diagnostico-overlay-lag.md).
   *  Ausente/0 (hub antigo) → ancora em `recvT`, comportamento de antes (retrocompat). */
  latencyMs?: number;
};

/** Caixa pronta para desenhar: bbox já interpolada + opacidade do fade + idade (telemetria). */
export type DrawnTrack = {
  id: number;
  bbox: [number, number, number, number];
  zone: string | null;
  opacity: number; // 0..1 (1 = presente; <1 = sumindo)
  ageMs: number; // ms desde o último payload que citou este id
  score?: number; // score do ÚLTIMO keyframe (passthrough); undefined = payload sem score
};

export type InterpConfig = {
  /** Atraso de reprodução (ms): quanto mais alto, mais suave e mais atrasado. Baixo → extrapola. */
  delayMs: number;
  /** Piso/teto do intervalo entre keyframes (denominador da velocidade), robusto a jitter. */
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Não prever mais que isto ALÉM do último keyframe (limita overshoot quando a pessoa para). */
  maxExtrapMs: number;
  /** Janela do EASING de correção: quando o payload novo corrige a predição (dead-reckoning), a caixa
   *  transita da posição exibida p/ a nova reta ao longo de `snapMs` em vez de teleportar. */
  snapMs: number;
  /** Idade a partir da qual a caixa começa a sumir (deve ser > intervalo do payload p/ não piscar). */
  fadeStartMs: number;
  /** Idade em que a caixa some de vez (removida do estado). */
  expireMs: number;
  /** EMA da VELOCIDADE entre keyframes (0..1; peso do dado NOVO). O hub manda delta cru — a 6fps o
   *  jitter de geometria vira ruído de velocidade que a extrapolação amplifica (oscilação de campo
   *  2026-07-26). 1 = sem suavização (comportamento antigo). */
  vAlpha: number;
  /** EMA do TAMANHO exibido (w/h), ancorada no PÉ — o detector alterna hipóteses de enquadramento e a
   *  caixa crua "respira". Display-only (a lógica lê tracks exatos). 1 = sem suavização. */
  sizeAlpha: number;
  /** Teto ADAPTATIVO de extrapolação: não prever além de `extrapIntervalFactor × intervalo OBSERVADO
   *  entre payloads` (piso extrapFloorMs; teto segue maxExtrapMs). Prever 3× além do PRÓXIMO dado só
   *  amplifica ruído — quando a cadência é alta, renderiza-se perto do dado; quando é baixa (grade
   *  1fps), extrapola-se longe como antes. */
  extrapIntervalFactor: number;
  extrapFloorMs: number;
  /** Fade/expiração ADAPTATIVOS à cadência observada (bug de campo m09: nascimento espúrio de 1
   *  rodada — mão detectada como "pessoa" — ficava fadeStart→expire na tela, 1,5-2,6s). Efetivo =
   *  min(teto do config, max(piso, intervalo×fator)): a 1fps valem os tetos (grade inalterada);
   *  a 6fps ~400/700ms — o fragmento pisca e some. */
  fadeIntervalFactor: number;
  expireIntervalFactor: number;
  fadeFloorMs: number;
  expireFloorMs: number;
};

// Defaults calibrados p/ payload a ~1fps: fade só depois de 1,5s (não pisca entre payloads),
// some em 2,6s. delay baixo (extrapolação leve) privilegia latência; subir delayMs troca por
// suavidade.
// maxExtrapMs=1000 (um intervalo-base inteiro): a MEDIÇÃO (docs/analises/reconhecimento-pessoas/07-*)
// mostrou que a cadência REAL do overlay é ~727ms-1000ms MESMO com a câmera focada (a inferência
// ~640ms/1080p serializa por câmera → o alvo de 6fps não é atingido). Com o cap antigo de 500ms
// (meio intervalo) a caixa CONGELAVA na 2ª metade de cada gap enquanto a pessoa seguia andando =
// o "marcador atrás" relatado. 1000ms deixa a caixa PREVER o gap inteiro. Seguro contra overshoot
// quando a pessoa PARA: o Kalman leva vx/vy→0 (teste "parado: sem drift") — o cap de meio-intervalo
// era redundante com essa proteção. Overshoot em MUDANÇA de direção é limitado ao próximo payload
// (≤~1s) e suavizado pelo easing do snap.
export const DEFAULT_INTERP: InterpConfig = {
  delayMs: 100,
  minIntervalMs: 150,
  maxIntervalMs: 2000,
  maxExtrapMs: 1000,
  snapMs: 180,
  fadeStartMs: 1500,
  expireMs: 2600,
  // Anti-oscilação (2026-07-26 — payloads a 6fps expuseram o trio ruído-de-v × caixa-que-respira ×
  // extrapolação-longa): v suavizada a 0.4 (≈ últimos 3-4 payloads mandam), tamanho a 0.5, e o teto
  // de extrapolação vira função da cadência OBSERVADA (1.25× o intervalo, piso 250ms) — a 6fps
  // prevê-se ~210ms à frente (estável); a 1fps, os mesmos ~1000ms de antes (nada regride na grade).
  vAlpha: 0.4,
  sizeAlpha: 0.5,
  extrapIntervalFactor: 1.25,
  extrapFloorMs: 250,
  fadeIntervalFactor: 2.5,
  expireIntervalFactor: 4,
  fadeFloorMs: 400,
  expireFloorMs: 700,
};

/** Clamp escalar (sem alocar), usado no hot-path do dead-reckoning. */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Interpolação linear de bbox: t=0 → a, t=1 → b, t>1 extrapola na direção a→b. Pura. */
export function lerpBbox(a: Bbox, b: Bbox, t: number): [number, number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

type Keyframe = { bbox: Bbox; zone: string | null; score?: number; vx?: number; vy?: number; t: number };
// snapFrom/snapT: origem do EASING de correção (posição EXIBIDA no instante do payload novo), capturada
// no ingest a partir do keyframe ANTIGO. Só populada no ramo dead-reckoning (vx/vy); undefined no legacy.
// vxS/vyS: velocidade SUAVIZADA (EMA entre keyframes) usada no dead-reckoning — o hub manda o delta
// CRU ((bbox−prev)/dt): a 6fps o jitter de geometria vira ruído de velocidade e a extrapolação o
// AMPLIFICA (a oscilação de campo de 2026-07-26). wS/hS: tamanho SUAVIZADO p/ exibição — o detector
// alterna hipóteses de enquadramento (close-up: largura medida 0,41→0,78→1,0 entre frames) e a caixa
// crua "respira"; a suavização é ancorada no PÉ (bottom-center), o âncora estável da pessoa.
// hist: HISTÓRICO de keyframes (janela HIST_KEEP_MS) — o MODO SÍNCRONO (decisão do dono
// 2026-07-26: "nem que coloque alguns segundos de delay no vídeo, mas sem arrasto") renderiza o
// PASSADO (renderT segundos atrás, casado com o vídeo atrasado): entre dois keyframes REAIS a
// caixa é interpolação EXATA — zero extrapolação, zero arrasto por construção. Cada kf carrega
// wS/hS (tamanho suavizado NO INGEST, temporalmente consistente) p/ o passado não "respirar".
type Keyframe2 = Keyframe & { wS: number; hS: number };
type Entry = {
  prev: Keyframe | null;
  last: Keyframe;
  hist: Keyframe2[];
  snapFrom?: [number, number, number, number];
  snapT?: number;
  vxS?: number;
  vyS?: number;
  wS?: number;
  hS?: number;
};

// Janela do histórico por id (cobre o teto do modo síncrono + folga). Memória: ~6fps × 6s × poucos
// tracks — dezenas de objetos pequenos, irrelevante.
const HIST_KEEP_MS = 6000;

// Estado por id: 2 keyframes (o penúltimo e o último payload que citaram o id). A VELOCIDADE, quando o
// hub a emite (vx/vy do Kalman), vem do PRÓPRIO track — DEAD-RECKONING a partir do último bbox (preciso
// e já move no 1º keyframe). Sem vx/vy (hub antigo), cai no fallback: velocidade estimada de 2 keyframes
// (last - prev)/(last.t - prev.t). O desenho amostra a posição resultante na hora corrente.
export class TrackInterpolator {
  private readonly cfg: InterpConfig;
  private readonly entries = new Map<number, Entry>();
  private lastTs = Number.NEGATIVE_INFINITY;
  // Cadência OBSERVADA entre payloads distintos (EMA da chegada local) — alimenta o teto
  // ADAPTATIVO de extrapolação (extrapCapMs): prever 3× além do próximo dado só amplifica ruído.
  private lastRecvT = Number.NEGATIVE_INFINITY;
  private intervalEma: number | null = null;

  constructor(cfg: Partial<InterpConfig> = {}) {
    this.cfg = { ...DEFAULT_INTERP, ...cfg };
  }

  /** Teto de extrapolação da rodada: função da cadência observada (piso/teto do cfg). */
  private extrapCapMs(): number {
    const c = this.cfg;
    if (this.intervalEma == null) return c.maxExtrapMs; // 1 payload só: sem cadência medida ainda
    return clampNum(this.intervalEma * c.extrapIntervalFactor, c.extrapFloorMs, c.maxExtrapMs);
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
    // Cadência observada (payloads DISTINTOS — o dedupe acima garante): EMA leve, robusta a jitter.
    if (Number.isFinite(this.lastRecvT)) {
      const dt = recvT - this.lastRecvT;
      if (dt > 0) this.intervalEma = this.intervalEma == null ? dt : 0.3 * dt + 0.7 * this.intervalEma;
    }
    this.lastRecvT = recvT;
    // Latência captura→emissão do hub: ancora o keyframe ATRÁS de recvT nesse tanto, p/ a extrapolação
    // prever pro AGORA real (a caixa nasceria ~latencyMs atrás). Capada ao teto de extrapolação
    // (maxExtrapMs) — não adianta compensar mais do que se extrapola, e limita a inflação da idade
    // (ageMs = now - kf.t) p/ não disparar fade cedo. Ausente/negativa → 0 (retrocompat).
    const lat = clampNum(snap.latencyMs ?? 0, 0, this.cfg.maxExtrapMs);
    const kfT = recvT - lat;
    for (const tr of snap.tracks) {
      const kf: Keyframe = {
        bbox: tr.bbox,
        zone: tr.zone,
        score: tr.score,
        vx: tr.vx,
        vy: tr.vy,
        t: kfT,
      };
      const e = this.entries.get(tr.id);
      if (e) {
        // Dead-reckoning: captura a posição ATUALMENTE exibida (predita pelo keyframe antigo) p/
        // suavizar a correção da próxima reta (não teleporta). Ancorada em `recvT - delayMs` para
        // que, no instante do payload, o easing comece exatamente onde a caixa está (k=0).
        if (tr.vx !== undefined && tr.vy !== undefined) {
          const snapT = recvT - this.cfg.delayMs;
          e.snapFrom = this.boxAt(e, snapT); // usa o keyframe ANTIGO (ainda em e.last)
          e.snapT = snapT;
        } else {
          e.snapFrom = undefined; // legacy (sem vx/vy) → sem easing, mantém a estimativa por 2 kf
          e.snapT = undefined;
        }
        e.prev = e.last;
        e.last = kf;
        // EMAs anti-oscilação: velocidade (o hub manda delta CRU) e tamanho (a caixa "respira").
        const va = this.cfg.vAlpha;
        e.vxS = tr.vx === undefined ? undefined : e.vxS === undefined ? tr.vx : va * tr.vx + (1 - va) * e.vxS;
        e.vyS = tr.vy === undefined ? undefined : e.vyS === undefined ? tr.vy : va * tr.vy + (1 - va) * e.vyS;
        const sa = this.cfg.sizeAlpha;
        e.wS = e.wS === undefined ? tr.bbox[2] : sa * tr.bbox[2] + (1 - sa) * e.wS;
        e.hS = e.hS === undefined ? tr.bbox[3] : sa * tr.bbox[3] + (1 - sa) * e.hS;
        e.hist.push({ ...kf, wS: e.wS, hS: e.hS }); // tamanho suavizado CONGELADO no kf (consistente no passado)
        const cutoff = kf.t - HIST_KEEP_MS;
        while (e.hist.length > 1 && e.hist[0].t < cutoff) e.hist.shift();
      } else {
        this.entries.set(tr.id, {
          prev: null,
          last: kf,
          hist: [{ ...kf, wS: tr.bbox[2], hS: tr.bbox[3] }],
          vxS: tr.vx,
          vyS: tr.vy,
          wS: tr.bbox[2],
          hS: tr.bbox[3],
        });
      }
    }
  }

  /**
   * Amostra as caixas interpoladas na hora local `now`. Poda ids já expirados (efeito colateral).
   *
   * `videoLagMs` (Onda 2 — spec-overlay-tempo-real CA-4): idade do QUADRO EXIBIDO sob o overlay.
   * A extrapolação passa a mirar o instante do QUADRO (now − delay − videoLag) em vez do agora
   * absoluto — sem isto, com vídeo atrasado a caixa PREVÊ À FRENTE da pessoa NA IMAGEM ("a imagem
   * é soberana", ADR-003). Default 0 = comportamento de sempre; o valor vem do knob calibrável
   * APP_CONFIG.overlay.videoLagMs (por transporte), medido em campo com o HUD (`vid`). Clamp ≥0.
   * Só desloca o instante RENDERIZADO — fade/expiração seguem pela idade do DADO (ageMs), senão
   * um lag alto apagaria caixas frescas.
   */
  sample(now: number, videoLagMs = 0): DrawnTrack[] {
    const c = this.cfg;
    const lag = videoLagMs > 0 ? videoLagMs : 0;
    const renderT = now - c.delayMs - lag;
    const out: DrawnTrack[] = [];
    for (const [id, e] of this.entries) {
      const ageMs = now - e.last.t; // idade do DADO (exposta — HUD/telemetria)
      // Fade/expiração pela idade RENDERIZADA (renderT − último kf): no modo síncrono a caixa
      // tem de viver até o VÍDEO atrasado alcançar o fim do track — expirar pela idade do dado
      // apagaria a caixa segundos antes da pessoa sumir NA TELA. Com lag 0, ageR == ageMs − delay
      // (comportamento de sempre nos testes, que usam delayMs 0).
      // Janelas ADAPTATIVAS à cadência (nascimento espúrio de 1 rodada pisca e some a 6fps;
      // a 1fps da grade os tetos do config valem — nada regride no caso lento).
      const iv = this.intervalEma;
      const fadeEff =
        iv == null ? c.fadeStartMs : Math.min(c.fadeStartMs, Math.max(c.fadeFloorMs, iv * c.fadeIntervalFactor));
      const expEff =
        iv == null ? c.expireMs : Math.min(c.expireMs, Math.max(c.expireFloorMs, iv * c.expireIntervalFactor));
      const ageR = renderT - e.last.t;
      if (ageR > expEff) {
        this.entries.delete(id);
        continue;
      }
      const opacity = ageR <= fadeEff ? 1 : Math.max(0, 1 - (ageR - fadeEff) / (expEff - fadeEff));
      out.push({
        id,
        bbox: this.boxAt(e, renderT),
        zone: e.last.zone,
        score: e.last.score,
        opacity,
        ageMs,
      });
    }
    return out;
  }

  /** Número de ids vivos (telemetria/teste). */
  size(): number {
    return this.entries.size;
  }

  private boxAt(e: Entry, renderT: number): [number, number, number, number] {
    const c = this.cfg;
    const last = e.last;
    // ── MODO SÍNCRONO (renderT no PASSADO, com histórico): interpolação EXATA entre duas
    // observações REAIS que cercam o instante — zero extrapolação, zero arrasto por construção.
    // Lerp em (centro-x, PÉ, tamanho suavizado) — os eixos estáveis da pessoa.
    if (renderT < last.t && e.hist.length > 1) {
      const h = e.hist;
      let bi = 0;
      while (bi < h.length && h[bi].t < renderT) bi++;
      if (bi === 0) {
        const k = h[0]; // antes do histórico: clampa na 1ª observação conhecida
        return [k.bbox[0] + k.bbox[2] / 2 - k.wS / 2, k.bbox[1] + k.bbox[3] - k.hS, k.wS, k.hS];
      }
      if (bi < h.length) {
        const a = h[bi - 1];
        const b = h[bi];
        const f = b.t > a.t ? (renderT - a.t) / (b.t - a.t) : 1;
        const cx = a.bbox[0] + a.bbox[2] / 2 + (b.bbox[0] + b.bbox[2] / 2 - (a.bbox[0] + a.bbox[2] / 2)) * f;
        const bot = a.bbox[1] + a.bbox[3] + (b.bbox[1] + b.bbox[3] - (a.bbox[1] + a.bbox[3])) * f;
        const w = a.wS + (b.wS - a.wS) * f;
        const hh = a.hS + (b.hS - a.hS) * f;
        return [cx - w / 2, bot - hh, w, hh];
      }
      // renderT entre o último kf do hist e last (não deveria ocorrer — last está no hist) →
      // cai nos ramos ao vivo abaixo (comportamento de sempre).
    }
    // ── DEAD-RECKONING (velocidade REAL do Kalman) ────────────────────────────────────────────────
    // posição = último bbox + v × dt (dt em segundos desde o keyframe), w/h do keyframe (não escala).
    // dt clampado a [-maxExtrap, +maxExtrap]: à frente limita o overshoot (pessoa que PAROU tem v≈0 do
    // Kalman → não dispara; e mesmo com v alto a previsão não foge além de meio intervalo); atrás cobre
    // o atraso de reprodução (delayMs). Move já no 1º keyframe (não precisa do penúltimo).
    if (last.vx !== undefined && last.vy !== undefined) {
      // Velocidade SUAVIZADA (EMA — anti-oscilação) + teto de extrapolação ADAPTATIVO à cadência.
      const vx = e.vxS ?? last.vx;
      const vy = e.vyS ?? last.vy;
      const dtSec = clampNum(renderT - last.t, -c.maxExtrapMs, this.extrapCapMs()) / 1000;
      const px = last.bbox[0] + vx * dtSec;
      const py = last.bbox[1] + vy * dtSec;
      // Tamanho SUAVIZADO ancorado no PÉ (bottom-center estável da pessoa): a caixa cresce/encolhe
      // em volta do pé, sem arrastar o topo nem o chão — mata o "respirar" da geometria do detector.
      const w = e.wS ?? last.bbox[2];
      const h = e.hS ?? last.bbox[3];
      const bx = px + last.bbox[2] / 2 - w / 2; // mesmo centro-x do movimento
      const by = py + last.bbox[3] - h; // mesmo pé (bottom)
      // EASING no snap: enquanto k<1, transita da posição exibida no payload (snapFrom) p/ a nova reta.
      const s = e.snapFrom;
      if (s && e.snapT !== undefined) {
        const k = clampNum((renderT - e.snapT) / c.snapMs, 0, 1);
        if (k < 1) {
          return [
            s[0] + (bx - s[0]) * k,
            s[1] + (by - s[1]) * k,
            s[2] + (w - s[2]) * k,
            s[3] + (h - s[3]) * k,
          ];
        }
      }
      return [bx, by, w, h];
    }
    // ── LEGACY (sem vx/vy — hub antigo): estimativa por 2 keyframes, comportamento de antes ──────────
    // Sem penúltimo (id recém-visto): 1 amostra só → caixa estática (nada a interpolar).
    if (!e.prev) return [last.bbox[0], last.bbox[1], last.bbox[2], last.bbox[3]];
    const dt = last.t - e.prev.t;
    const interval = Math.min(c.maxIntervalMs, Math.max(c.minIntervalMs, dt));
    if (renderT <= e.prev.t) {
      return [e.prev.bbox[0], e.prev.bbox[1], e.prev.bbox[2], e.prev.bbox[3]];
    }
    // alpha em unidades de intervalo: 1 = no último keyframe; >1 extrapola (limitado por maxExtrap).
    const maxAlpha = 1 + c.maxExtrapMs / interval;
    const alpha = Math.min(maxAlpha, (renderT - e.prev.t) / interval);
    return lerpBbox(e.prev.bbox, last.bbox, alpha);
  }
}

// ── Ponte sample() → drawTracks da CÂMERA FOCADA ────────────────────────────────────────────────
// A grade desenha o DrawnTrack direto (bbox+opacity+id). A câmera focada reusa drawTracks/draw.ts, que
// pede o shape TrackBox (id/score/bbox/firstSeen/zone) + opacity. Aqui montamos esse shape a partir do
// sample(): score do passthrough (default 1), firstSeen via lookup no mapa mantido pelo applyHubAnalysis,
// foot = bottom-center do bbox (paridade com Track; não usado no desenho) e opacity do fade. PURO/testável.

/** Track pronto p/ o drawTracks da câmera focada: sample() do interpolador + firstSeen (externo). */
export type DisplayTrack = {
  id: number;
  bbox: [number, number, number, number];
  zone: string | null;
  score: number;
  firstSeen: number;
  opacity: number;
  foot: { x: number; y: number };
};

export function toDisplayTracks(
  drawn: readonly DrawnTrack[],
  firstSeen: ReadonlyMap<number, number>,
  now: number,
): DisplayTrack[] {
  const out: DisplayTrack[] = [];
  for (const d of drawn) {
    out.push({
      id: d.id,
      bbox: d.bbox,
      zone: d.zone,
      // hub antigo (sample sem score) → 1: nunca atenuado pelo slider, como antes.
      score: d.score ?? 1,
      // permanência POR ID (mantida pelo applyHubAnalysis entre payloads). Id em fade já saiu do
      // mapa → cai no `now` (a caixa está sumindo; a duração no rótulo é irrelevante).
      firstSeen: firstSeen.get(d.id) ?? now,
      opacity: d.opacity,
      foot: { x: d.bbox[0] + d.bbox[2] / 2, y: d.bbox[1] + d.bbox[3] },
    });
  }
  return out;
}
