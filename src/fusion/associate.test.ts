// Testes do núcleo HONESTO de fusão tag↔pessoa (src/fusion/associate.ts).
// Cobre: casamento correto quando as trajetórias de distância diferem e o RSSI as segue; recusa
// honesta ("não sei" = tag null) quando parado, com amostras de menos, sem a tag em cena, ou sem
// correlação; sanidade da matemática (anti-correlação perfeita → score≈1; ortogonal → ~0); e
// determinismo (mesma entrada → mesma saída).
import { describe, it, expect } from "vitest";
import {
  TagTrackAssociator,
  type FusionFrame,
  type TagReading,
  type TrackDist,
} from "./associate";

/** Gera N frames a partir de startTs, passo dt; `gen(i)` devolve readings+tracks daquele instante. */
function makeFrames(
  n: number,
  startTs: number,
  dt: number,
  gen: (i: number) => { readings: TagReading[]; tracks: TrackDist[] },
): FusionFrame[] {
  const out: FusionFrame[] = [];
  for (let i = 0; i < n; i++) {
    const { readings, tracks } = gen(i);
    out.push({ ts: startTs + i * dt, readings, tracks });
  }
  return out;
}

/** Rampa linear de `a` a `b` em n pontos (índice i em [0..n-1]). */
const ramp = (a: number, b: number, i: number, n: number) => a + ((b - a) * i) / (n - 1);

describe("TagTrackAssociator — casamento por correlação (o caso que funciona)", () => {
  it("duas pessoas indo a distâncias claramente distintas → associação correta, confiança alta", () => {
    const N = 10;
    // track 1 se afasta (1→6m); track 2 se aproxima (6→1m). Os RSSI seguem a física (cai com distância).
    const frames = makeFrames(N, 1000, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, N) },
        { trackId: 2, dist: ramp(6, 1, i, N) },
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, N) }, // acompanha o afastamento do track 1
        { tag: "BB", rssi: ramp(-75, -50, i, N) }, // acompanha a aproximação do track 2
      ],
    }));

    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const res = a.assign();

    const t1 = res.find((r) => r.trackId === 1)!;
    const t2 = res.find((r) => r.trackId === 2)!;
    expect(t1.tag).toBe("AA");
    expect(t2.tag).toBe("BB");
    expect(t1.confidence).toBeGreaterThan(0.9);
    expect(t2.confidence).toBeGreaterThan(0.9);
  });

  it("uma pessoa + sua tag, anti-correlação perfeita → score ≈ 1", () => {
    const N = 8;
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 7, dist: ramp(1, 5, i, N) }],
      readings: [{ tag: "X", rssi: ramp(-40, -80, i, N) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [only] = a.assign();
    expect(only.trackId).toBe(7);
    expect(only.tag).toBe("X");
    expect(only.confidence).toBeGreaterThan(0.99);
  });
});

describe("TagTrackAssociator — recusa honesta (tag = null, nunca chutar)", () => {
  it("duas pessoas PARADAS (sem movimento) → ambas null (ambíguo, recusa honesta)", () => {
    const N = 10;
    // Distância quase constante (ruído << minMovement); RSSI até flutua, mas sem movimento é ambíguo.
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: 3 + (i % 2) * 0.03 },
        { trackId: 2, dist: 4 - (i % 2) * 0.03 },
      ],
      readings: [
        { tag: "AA", rssi: -60 + (i % 3) },
        { tag: "BB", rssi: -65 - (i % 3) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const res = a.assign();
    expect(res.map((r) => r.tag)).toEqual([null, null]);
    expect(res.every((r) => r.confidence === 0)).toBe(true);
  });

  it("amostras de menos na janela → null (não confia)", () => {
    const N = 3; // < minSamples (default 5)
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, N) }],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, N) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBeNull();
  });

  it("pessoa cuja tag não está em cena → null", () => {
    const N = 8;
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, N) }],
      readings: [], // nenhuma tag sendo vista
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("movimento presente mas RSSI SEM correlação com a distância → null (score ~0)", () => {
    // dist zigzag (variância alta, passa o guarda de movimento) e rssi ortogonal → Pearson ≈ 0.
    const distVals = [0, 4, 0, 4, 0, 4, 0, 4];
    const rssiVals = [0, 0, 4, 4, 0, 0, 4, 4]; // produto-cruzado soma zero → corr 0
    const frames = makeFrames(distVals.length, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: distVals[i] }],
      readings: [{ tag: "AA", rssi: -60 + rssiVals[i] }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBeNull();
    expect(r.confidence).toBeLessThan(0.5);
  });
});

describe("TagTrackAssociator — janela, determinismo e limpeza", () => {
  it("frames fora da janela são podados (não contam p/ a correlação)", () => {
    const a = new TagTrackAssociator({ windowMs: 2000 });
    // Frames antigos (t=0..1000) que sozinhos casariam, mas caem fora da janela de 2s.
    for (let i = 0; i < 6; i++) {
      a.push({
        ts: i * 200,
        tracks: [{ trackId: 1, dist: ramp(1, 6, i, 6) }],
        readings: [{ tag: "AA", rssi: ramp(-50, -75, i, 6) }],
      });
    }
    // Agora só 2 frames recentes dentro da janela → amostras de menos → null.
    a.push({ ts: 10000, tracks: [{ trackId: 1, dist: 2 }], readings: [{ tag: "AA", rssi: -55 }] });
    a.push({ ts: 10200, tracks: [{ trackId: 1, dist: 5 }], readings: [{ tag: "AA", rssi: -75 }] });
    const [r] = a.assign(10200);
    expect(r.tag).toBeNull();
  });

  it("mesma entrada → mesma saída (determinístico)", () => {
    const N = 10;
    const build = () => {
      const x = new TagTrackAssociator();
      for (const f of makeFrames(N, 0, 500, (i) => ({
        tracks: [
          { trackId: 1, dist: ramp(1, 6, i, N) },
          { trackId: 2, dist: ramp(6, 1, i, N) },
        ],
        readings: [
          { tag: "AA", rssi: ramp(-50, -75, i, N) },
          { tag: "BB", rssi: ramp(-75, -50, i, N) },
        ],
      }))) {
        x.push(f);
      }
      return x.assign();
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("reset() esvazia o buffer (sem pistas correntes → sem atribuições)", () => {
    const a = new TagTrackAssociator();
    a.push({ ts: 0, tracks: [{ trackId: 1, dist: 2 }], readings: [{ tag: "AA", rssi: -55 }] });
    a.reset();
    expect(a.assign()).toEqual([]);
  });

  it("uma tag não é atribuída a duas pessoas (1-para-1)", () => {
    const N = 10;
    // Dois tracks com trajetórias distintas, mas só a tag AA presente: casa com o melhor, o outro fica null.
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, N) }, // anti-correlaciona com AA
        { trackId: 2, dist: ramp(6, 1, i, N) }, // correlaciona positivo com AA → score 0
      ],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, N) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const res = a.assign();
    const tags = res.map((r) => r.tag);
    expect(tags.filter((t) => t === "AA")).toHaveLength(1);
    expect(res.find((r) => r.trackId === 1)!.tag).toBe("AA");
    expect(res.find((r) => r.trackId === 2)!.tag).toBeNull();
  });
});
