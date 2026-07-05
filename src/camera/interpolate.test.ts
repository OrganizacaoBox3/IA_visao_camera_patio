// Testes da interpolação de tracks do hub (interpolate.ts — Fase 2 do retrofit de performance).
// Cobrem o motivo de existir: a caixa do hub chega a ~1fps e, crua, congela+teleporta (fantasma+
// miss). Aqui provamos: (1) interpolação linear de bbox por id entre dois payloads; (2) dedupe do
// payload repetido; (3) extrapolação limitada; (4) fade + expiração de quem some.
import { describe, it, expect } from "vitest";
import {
  lerpBbox,
  TrackInterpolator,
  DEFAULT_INTERP,
  type Snapshot,
  type Bbox,
} from "./interpolate";

const box = (x: number, y: number, w = 0.1, h = 0.2): Bbox => [x, y, w, h];
const snap = (ts: number, tracks: Array<{ id: number; bbox: Bbox }>): Snapshot => ({
  ts,
  tracks: tracks.map((t) => ({ id: t.id, bbox: t.bbox, zone: null })),
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
