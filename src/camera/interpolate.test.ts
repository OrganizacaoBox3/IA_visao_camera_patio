// Testes da interpolação de tracks do hub (interpolate.ts — Fase 2 do retrofit de performance).
// Cobrem o motivo de existir: a caixa do hub chega a ~1fps e, crua, congela+teleporta (fantasma+
// miss). Aqui provamos: (1) interpolação linear de bbox por id entre dois payloads; (2) dedupe do
// payload repetido; (3) extrapolação limitada; (4) fade + expiração de quem some.
import { describe, it, expect } from "vitest";
import {
  lerpBbox,
  TrackInterpolator,
  toDisplayTracks,
  DEFAULT_INTERP,
  type Snapshot,
  type Bbox,
} from "./interpolate";

const box = (x: number, y: number, w = 0.1, h = 0.2): Bbox => [x, y, w, h];
const snap = (
  ts: number,
  tracks: Array<{ id: number; bbox: Bbox; score?: number; vx?: number; vy?: number }>,
): Snapshot => ({
  ts,
  tracks: tracks.map((t) => ({
    id: t.id,
    bbox: t.bbox,
    zone: null,
    score: t.score,
    vx: t.vx,
    vy: t.vy,
  })),
});

describe("lerpBbox", () => {
  it("t=0 → a, t=1 → b, t=0.5 → ponto médio", () => {
    const a = box(0, 0);
    const b = box(0.4, 0.2);
    expect(lerpBbox(a, b, 0)).toEqual([0, 0, 0.1, 0.2]);
    expect(lerpBbox(a, b, 1)).toEqual([0.4, 0.2, 0.1, 0.2]);
    expect(lerpBbox(a, b, 0.5)).toEqual([0.2, 0.1, 0.1, 0.2]);
  });
  it("t>1 extrapola na direção a→b", () => {
    expect(lerpBbox(box(0, 0), box(0.1, 0), 2)[0]).toBeCloseTo(0.2, 6);
  });
});

describe("TrackInterpolator — interpolação linear por id", () => {
  // delayMs:0 para amostrar direto na hora pedida (sem atraso de reprodução).
  const cfg = { delayMs: 0 };

  it("anima a bbox do penúltimo ao último keyframe ao longo do tempo real", () => {
    const it0 = new TrackInterpolator(cfg);
    it0.ingest(snap(1, [{ id: 7, bbox: box(0, 0) }]), 0); // keyframe A @ t=0
    it0.ingest(snap(2, [{ id: 7, bbox: box(0.2, 0) }]), 1000); // keyframe B @ t=1000 (andou p/ direita)

    // no meio do intervalo → meio do caminho (x = 0.1)
    const mid = it0.sample(500);
    expect(mid).toHaveLength(1);
    expect(mid[0].id).toBe(7);
    expect(mid[0].bbox[0]).toBeCloseTo(0.1, 6);
    expect(mid[0].opacity).toBe(1);

    // exatamente no último keyframe → posição de B
    expect(it0.sample(1000)[0].bbox[0]).toBeCloseTo(0.2, 6);
  });

  it("dedupe: reingerir o MESMO ts não desloca o keyframe (caixa não anda sem dado novo)", () => {
    const it0 = new TrackInterpolator(cfg);
    it0.ingest(snap(1, [{ id: 1, bbox: box(0, 0) }]), 0);
    it0.ingest(snap(2, [{ id: 1, bbox: box(0.2, 0) }]), 1000);
    it0.ingest(snap(2, [{ id: 1, bbox: box(0.9, 0) }]), 1500); // MESMO ts → ignorado
    // segue interpolando A→B (x≈0.1 no meio), não A→(0.9)
    expect(it0.sample(500)[0].bbox[0]).toBeCloseTo(0.1, 6);
  });

  it("passthrough de score: sample devolve o score do ÚLTIMO keyframe (undefined se ausente)", () => {
    const withScore = new TrackInterpolator(cfg);
    withScore.ingest(snap(1, [{ id: 4, bbox: box(0, 0), score: 0.9 }]), 0);
    withScore.ingest(snap(2, [{ id: 4, bbox: box(0.2, 0), score: 0.4 }]), 1000); // score novo
    expect(withScore.sample(500)[0].score).toBe(0.4); // sempre o do último keyframe, não interpolado

    const noScore = new TrackInterpolator(cfg);
    noScore.ingest(snap(1, [{ id: 4, bbox: box(0, 0) }]), 0); // hub antigo → sem score
    expect(noScore.sample(0)[0].score).toBeUndefined();
  });

  it("id recém-visto (1 keyframe só) fica estático — nada a interpolar", () => {
    const it0 = new TrackInterpolator(cfg);
    it0.ingest(snap(1, [{ id: 3, bbox: box(0.3, 0.3) }]), 0);
    expect(it0.sample(50)[0].bbox).toEqual([0.3, 0.3, 0.1, 0.2]);
  });

  it("extrapola ALÉM do último keyframe, mas limitado por maxExtrapMs", () => {
    // expire alto p/ isolar a CLAMPAGEM da extrapolação da expiração por idade.
    const it0 = new TrackInterpolator({ delayMs: 0, maxExtrapMs: 500, expireMs: 1e6, fadeStartMs: 1e6 });
    it0.ingest(snap(1, [{ id: 5, bbox: box(0, 0) }]), 0);
    it0.ingest(snap(2, [{ id: 5, bbox: box(0.1, 0) }]), 1000); // v = 0.1 / 1000ms
    // 500ms além do último → +0.05 (meio intervalo)
    expect(it0.sample(1500)[0].bbox[0]).toBeCloseTo(0.15, 6);
    // 5000ms além → clampado ao teto (maxExtrap 500ms = +0.05), não dispara
    expect(it0.sample(6000)[0].bbox[0]).toBeCloseTo(0.15, 6);
  });
});

describe("TrackInterpolator — dead-reckoning por velocidade do Kalman (vx/vy)", () => {
  it("move a caixa por vx/vy JÁ no 1º keyframe (nasce se movendo, sem penúltimo)", () => {
    // maxExtrap alto p/ isolar o dead-reckoning da clampagem; delay 0 amostra na hora pedida.
    const it0 = new TrackInterpolator({ delayMs: 0, maxExtrapMs: 1000 });
    it0.ingest(snap(1, [{ id: 7, bbox: box(0, 0), vx: 0.2, vy: 0.1 }]), 0); // 1 keyframe só + velocidade
    // 500ms depois → +v×0.5s: x = 0.2×0.5 = 0.1 ; y = 0.1×0.5 = 0.05 (extrapolação sem penúltimo)
    const d = it0.sample(500);
    expect(d).toHaveLength(1);
    expect(d[0].bbox[0]).toBeCloseTo(0.1, 6);
    expect(d[0].bbox[1]).toBeCloseTo(0.05, 6);
    // w/h não escalam com a velocidade (só posição)
    expect(d[0].bbox[2]).toBeCloseTo(0.1, 6);
    expect(d[0].bbox[3]).toBeCloseTo(0.2, 6);
  });

  it("CLAMP por maxExtrapMs: a previsão para quando a pessoa para (não dispara)", () => {
    // expire/fade altos p/ isolar a clampagem da extrapolação da expiração por idade.
    const it0 = new TrackInterpolator({
      delayMs: 0,
      maxExtrapMs: 500,
      expireMs: 1e6,
      fadeStartMs: 1e6,
    });
    it0.ingest(snap(1, [{ id: 5, bbox: box(0, 0), vx: 0.1, vy: 0 }]), 0); // v = 0.1/s
    // 500ms além → +0.05 (v × 0.5s)
    expect(it0.sample(500)[0].bbox[0]).toBeCloseTo(0.05, 6);
    // 6000ms além → dt clampado a maxExtrap (500ms) → +0.05, NÃO foge (o corpo "parou")
    expect(it0.sample(6000)[0].bbox[0]).toBeCloseTo(0.05, 6);
  });

  it("vx/vy = 0 (parado): caixa fica no bbox detectado, sem drift", () => {
    const it0 = new TrackInterpolator({ delayMs: 0, maxExtrapMs: 1000 });
    it0.ingest(snap(1, [{ id: 6, bbox: box(0.3, 0.3), vx: 0, vy: 0 }]), 0);
    expect(it0.sample(900)[0].bbox).toEqual([0.3, 0.3, 0.1, 0.2]);
  });

  it("DEFAULT maxExtrapMs=1000: acompanha o gap INTEIRO (~1s), não congela em 500ms (fix do overlay lag)", () => {
    // SEM override de maxExtrapMs → usa o DEFAULT (1000). A medição (07-*) mostrou cadência real
    // ~727ms-1000ms mesmo focada; o cap antigo de 500ms congelava a caixa na 2ª metade do gap.
    // expire/fade altos p/ isolar a extrapolação da expiração por idade.
    const it0 = new TrackInterpolator({ delayMs: 0, expireMs: 1e6, fadeStartMs: 1e6 });
    it0.ingest(snap(1, [{ id: 5, bbox: box(0, 0), vx: 0.1, vy: 0 }]), 0); // v = 0.1/s
    // 900ms além → +0.09 (segue prevendo; com o cap antigo de 500 estaria congelado em 0.05)
    expect(it0.sample(900)[0].bbox[0]).toBeCloseTo(0.09, 6);
    // 1000ms → +0.10 (limite = 1 intervalo-base)
    expect(it0.sample(1000)[0].bbox[0]).toBeCloseTo(0.1, 6);
    // 1500ms além → clampado ao DEFAULT (1000ms = +0.10), não dispara quando a pessoa para
    expect(it0.sample(1500)[0].bbox[0]).toBeCloseTo(0.1, 6);
  });

  it("FALLBACK sem vx/vy: usa a estimativa por 2 keyframes (retrocompat, hub antigo)", () => {
    // Sem velocidade no payload → o ramo de dead-reckoning NÃO é tomado; anima do penúltimo ao último.
    const it0 = new TrackInterpolator({ delayMs: 0, maxExtrapMs: 1000 });
    it0.ingest(snap(1, [{ id: 8, bbox: box(0, 0) }]), 0); // sem vx/vy
    it0.ingest(snap(2, [{ id: 8, bbox: box(0.2, 0) }]), 1000);
    // meio do intervalo → meio do caminho (prova que é 2-keyframe, não dead-reckoning)
    expect(it0.sample(500)[0].bbox[0]).toBeCloseTo(0.1, 6);
  });

  it("EASING no snap: a correção do payload novo transita suave, não teleporta", () => {
    const it0 = new TrackInterpolator({ delayMs: 0, maxExtrapMs: 1000, snapMs: 200 });
    it0.ingest(snap(1, [{ id: 1, bbox: box(0, 0), vx: 0.1, vy: 0 }]), 0); // reta A: prevê x=0.1 em t=1000
    // Nova detecção corrige p/ x=0.2 (erro de predição de 0.1) — a caixa NÃO deve saltar p/ 0.2.
    it0.ingest(snap(2, [{ id: 1, bbox: box(0.2, 0), vx: 0.1, vy: 0 }]), 1000);

    // no instante do payload: começa onde a caixa ESTAVA (predição A ≈ 0.1), não em 0.2
    expect(it0.sample(1000)[0].bbox[0]).toBeCloseTo(0.1, 6);
    // no meio da janela de snap (t=1100, k=0.5): entre a predição antiga e a nova reta
    const midX = it0.sample(1100)[0].bbox[0];
    expect(midX).toBeGreaterThan(0.1);
    expect(midX).toBeLessThan(0.21);
    // após snapMs (t=1200, k=1): totalmente na nova reta de dead-reckoning (0.2 + 0.1×0.2s = 0.22)
    expect(it0.sample(1200)[0].bbox[0]).toBeCloseTo(0.22, 6);
  });
});

describe("TrackInterpolator — fade + expiração", () => {
  it("opacidade cai entre fadeStart e expire; depois some", () => {
    const it0 = new TrackInterpolator({ delayMs: 0 });
    it0.ingest(snap(1, [{ id: 9, bbox: box(0, 0) }]), 0);

    // fresco → opacidade cheia
    expect(it0.sample(DEFAULT_INTERP.fadeStartMs)[0].opacity).toBe(1);

    // no meio da janela de fade → ~0.5
    const mid = (DEFAULT_INTERP.fadeStartMs + DEFAULT_INTERP.expireMs) / 2;
    expect(it0.sample(mid)[0].opacity).toBeCloseTo(0.5, 2);

    // além do expire → caixa removida do estado
    expect(it0.sample(DEFAULT_INTERP.expireMs + 1)).toHaveLength(0);
    expect(it0.size()).toBe(0);
  });

  it("id que some de um payload posterior envelhece e expira; os presentes seguem", () => {
    const it0 = new TrackInterpolator({ delayMs: 0 });
    it0.ingest(snap(1, [{ id: 1, bbox: box(0, 0) }, { id: 2, bbox: box(0.5, 0) }]), 0);
    it0.ingest(snap(2, [{ id: 1, bbox: box(0.05, 0) }]), 1000); // id 2 sumiu do payload

    // logo após: ambos ainda vivos (id 2 fresco há 1000ms, < fadeStart)
    const drawn = it0.sample(1000).sort((a, b) => a.id - b.id);
    expect(drawn.map((d) => d.id)).toEqual([1, 2]);

    // t=3000: id 2 (visto por último em t=0, idade 3000 > expire) some; id 1 (visto em t=1000,
    // idade 2000 < expire) continua.
    const later = it0.sample(3000);
    expect(later.map((d) => d.id)).toEqual([1]);
  });
});

describe("toDisplayTracks — ponte sample() → drawTracks da câmera focada", () => {
  it("monta o shape de desenho: score default 1, firstSeen do lookup, foot e opacity", () => {
    const drawn = [
      { id: 1, bbox: [0.2, 0.3, 0.1, 0.4] as [number, number, number, number], zone: "Z", opacity: 0.6, ageMs: 0, score: 0.8 },
      { id: 2, bbox: [0, 0, 0.2, 0.2] as [number, number, number, number], zone: null, opacity: 1, ageMs: 0 }, // sem score
    ];
    const firstSeen = new Map<number, number>([[1, 111]]); // id 2 ausente → fallback now
    const out = toDisplayTracks(drawn, firstSeen, 999);

    expect(out[0]).toEqual({
      id: 1,
      bbox: [0.2, 0.3, 0.1, 0.4],
      zone: "Z",
      score: 0.8,
      firstSeen: 111,
      opacity: 0.6,
      foot: { x: 0.2 + 0.1 / 2, y: 0.3 + 0.4 },
    });
    expect(out[1].score).toBe(1); // sem score no sample → 1 (nunca atenua)
    expect(out[1].firstSeen).toBe(999); // id fora do mapa (fade) → fallback now
  });
});
