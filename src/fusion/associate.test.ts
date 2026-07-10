// Testes do núcleo HONESTO de fusão tag↔pessoa (src/fusion/associate.ts).
// Cobre: casamento correto quando as trajetórias de distância diferem e o RSSI as segue; recusa
// honesta ("não sei" = tag null) quando parado, com amostras de menos, sem a tag em cena, sem
// correlação, ou com candidatos EMPATADOS (guarda de ambiguidade top-2, default desde o torneio
// medido de 2026-07-10); atribuição ótima global (knob `optimal`, Hungarian) corrigindo o guloso;
// sanidade da matemática (anti-correlação perfeita → score≈1; ortogonal → ~0); e determinismo
// (mesma entrada → mesma saída). Os casos CLAROS do primeiro describe rodam com o default novo
// (minMargin 0.1) — provam que a guarda não silencia quem tem margem de sobra. Inclui o furo de
// OCLUSÃO reproduzido em 2026-07-10: dono da tag ausente só do último frame não pode liberar o
// rótulo p/ o vizinho de bloco (concorrentes da guarda vêm da JANELA inteira, não só do frame).
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

describe("TagTrackAssociator — guarda de ambiguidade top-2 (minMargin)", () => {
  /** O caso 'bloco': duas pistas em rampas PARALELAS + duas tags que anti-correlacionam com AMBAS
   *  (todos os 4 scores ≈ 1) — fisicamente indistinguível com 1 estação. */
  const blocoFrames = (n: number) =>
    makeFrames(n, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, n) },
        { trackId: 2, dist: ramp(1.3, 6.3, i, n) }, // paralela (Pearson é invariante ao offset)
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, n) },
        { tag: "BB", rssi: ramp(-52, -77, i, n) },
      ],
    }));

  it("caso ambíguo (bloco) → AMBAS null com o default (as duas tags explicam igual)", () => {
    const a = new TagTrackAssociator();
    for (const f of blocoFrames(10)) a.push(f);
    const res = a.assign();
    expect(res.map((r) => r.tag)).toEqual([null, null]);
    // A assinatura da ambiguidade: "não sei" com score alto (chegou perto, mas havia empate).
    expect(res.every((r) => r.confidence > 0.9)).toBe(true);
  });

  it("knob desligável (retrocompat): minMargin 0 reproduz o comportamento antigo — fala no bloco", () => {
    const a = new TagTrackAssociator({ minMargin: 0 });
    for (const f of blocoFrames(10)) a.push(f);
    expect(a.assign().every((r) => r.tag !== null)).toBe(true);
  });

  it("eixo simétrico (da TAG): uma tag com duas pistas gêmeas → null (par ambíguo)", () => {
    // marginPista passa (não há outra tag), mas a MESMA tag explica as duas pistas igual → recusa.
    const n = 10;
    const frames = makeFrames(n, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, n) },
        { trackId: 2, dist: ramp(1.5, 6.5, i, n) },
      ],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, n) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    expect(a.assign().map((r) => r.tag)).toEqual([null, null]);
  });

  it("oclusão/flicker: dono da tag some SÓ do último frame → abstém (não entrega o rótulo ao vizinho)", () => {
    // FURO reproduzido (revisão adversarial de 2026-07-10): o scan de concorrentes da guarda só
    // enxergava as pistas do ÚLTIMO frame. Duas pessoas em bloco + 1 tag; a pista 1 (dona) some
    // apenas do frame mais recente (dropout/oclusão — o próprio sim tem dropoutP=0.05). Sem o
    // fix, a linha da dona saía da matriz, bestOtherTrack=0, e a pista 2 levava "AA" com
    // confiança ~1 — rótulo ERRADO. Com o fix, a dona segue concorrendo pela janela (fantasma)
    // → margem ~0 < minMargin → o candidato é abortado: tag=null.
    const n = 10;
    const occlusionFrames = makeFrames(n, 0, 500, (i) => ({
      tracks:
        i === n - 1
          ? [{ trackId: 2, dist: ramp(1.3, 6.3, i, n) }] // dona (pista 1) ausente SÓ aqui
          : [
              { trackId: 1, dist: ramp(1, 6, i, n) },
              { trackId: 2, dist: ramp(1.3, 6.3, i, n) }, // bloco: paralela à dona
            ],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, n) }], // explica AMBAS igualmente
    }));
    const a = new TagTrackAssociator();
    for (const f of occlusionFrames) a.push(f);
    const res = a.assign();
    // Saída segue restrita às pistas correntes (só a 2) — o fantasma não ganha Assignment.
    expect(res).toHaveLength(1);
    expect(res[0].trackId).toBe(2);
    expect(res[0].tag).toBeNull(); // antes do fix: "AA" com confiança ~1
    expect(res[0].confidence).toBeGreaterThan(0.9); // honesto: chegou perto, mas havia empate

    // Contraprova: a abstenção vem da GUARDA (com ela desligada, o rótulo ambíguo escapa).
    const semGuarda = new TagTrackAssociator({ minMargin: 0 });
    for (const f of occlusionFrames) semGuarda.push(f);
    expect(semGuarda.assign()[0].tag).toBe("AA");
  });

  it("caso CLARO passa pela guarda: margem de sobra → mantém a atribuição", () => {
    // Igual ao caso feliz do topo (rampas opostas): scores 1 vs 0 → margem 1 ≥ 0.1 nos dois eixos.
    const n = 10;
    const frames = makeFrames(n, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, n) },
        { trackId: 2, dist: ramp(6, 1, i, n) },
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, n) },
        { tag: "BB", rssi: ramp(-75, -50, i, n) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const res = a.assign();
    expect(res.find((r) => r.trackId === 1)!.tag).toBe("AA");
    expect(res.find((r) => r.trackId === 2)!.tag).toBe("BB");
  });
});

describe("TagTrackAssociator — atribuição ótima global (knob optimal, Hungarian)", () => {
  // Caso construído (verificado numericamente) em que o GULOSO erra e o ÓTIMO acerta:
  // duas pessoas andando quase em paralelo; a tag AA (da pessoa 2) por ruído correlaciona um
  // TIQUINHO melhor com a pista 1 (1.000 vs 0.996) — o guloso pega o par global-máximo (1,AA),
  // rouba a tag da pista errada e sobra (2,BB)=0.803: DOIS erros. O ótimo maximiza a SOMA
  // (0.850+0.996=1.846 > 1.000+0.803=1.803) e acerta os dois. Verdade: AA↔pista2, BB↔pista1.
  const d1 = [1, 2, 3, 4, 5, 6];
  const d2 = [1.3, 2.0, 3.3, 4.0, 5.3, 6.0];
  const rssiA = [-51, -52, -53, -54, -55, -56]; // segue exatamente a FORMA de d1 (o "ruído azarado")
  const rssiB = [-50, -54, -52, -58, -55, -60]; // ruidoso, mas decrescente (anti-corr ~0.85/0.80)
  const trapFrames = () =>
    makeFrames(d1.length, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: d1[i] },
        { trackId: 2, dist: d2[i] },
      ],
      readings: [
        { tag: "AA", rssi: rssiA[i] },
        { tag: "BB", rssi: rssiB[i] },
      ],
    }));

  it("guloso (sem guarda) cai na armadilha: ambos errados", () => {
    const a = new TagTrackAssociator({ optimal: false, minMargin: 0 });
    for (const f of trapFrames()) a.push(f);
    const res = a.assign();
    expect(res.find((r) => r.trackId === 1)!.tag).toBe("AA"); // errado (verdade: BB)
    expect(res.find((r) => r.trackId === 2)!.tag).toBe("BB"); // errado (verdade: AA)
  });

  it("ótimo (sem guarda) resolve: maximiza a soma e acerta os dois", () => {
    const a = new TagTrackAssociator({ optimal: true, minMargin: 0 });
    for (const f of trapFrames()) a.push(f);
    const res = a.assign();
    expect(res.find((r) => r.trackId === 1)!.tag).toBe("BB");
    expect(res.find((r) => r.trackId === 2)!.tag).toBe("AA");
  });

  it("default (guloso + guarda): abstém na armadilha — melhor null que errado", () => {
    // A margem no eixo da tag AA é 1.000−0.996 < 0.1 → o par cai; (2,BB) fica abaixo do melhor
    // concorrente da pista → cai também. O default não acerta este caso, mas NÃO erra.
    const a = new TagTrackAssociator();
    for (const f of trapFrames()) a.push(f);
    expect(a.assign().map((r) => r.tag)).toEqual([null, null]);
  });

  it("ótimo é determinístico e respeita minConfidence (par fraco não entra)", () => {
    // Só a tag BB presente e correlação ~0.85 com a pista 1: com minConfidence 0.9 → null.
    const frames = makeFrames(d1.length, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: d1[i] }],
      readings: [{ tag: "BB", rssi: rssiB[i] }],
    }));
    const strict = new TagTrackAssociator({ optimal: true, minConfidence: 0.9, minMargin: 0 });
    for (const f of frames) strict.push(f);
    expect(strict.assign()[0].tag).toBeNull();
    const run = () => {
      const a = new TagTrackAssociator({ optimal: true });
      for (const f of trapFrames()) a.push(f);
      return a.assign();
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
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
