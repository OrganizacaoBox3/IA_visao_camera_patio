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
// E a EVIDÊNCIA ABSOLUTA v4 (gate maxDistRatio + blend distWeight) — knobs de PESQUISA,
// DESLIGADOS por default desde a revisão adversarial de 2026-07-10 (circularidade sim↔fit
// provada; ver cabeçalho de associate.ts). Testados aqui LIGANDO a config explicitamente:
// consistente passa, inconsistente zera, distM ausente/proxy = inerte mesmo com o knob ligado.
// E a fusão MULTI-FONTE por soma de Fisher-z (knob `multiSourceFisher`, ADR-013 item 4 — knob de
// PESQUISA, OFF por default): redução p/ fonte única bit-idêntica, diluição por ruído sem matar o
// par certo, desempate de correlação espúria pela 2ª fonte, retrocompat da fonte "default".
import { describe, it, expect } from "vitest";
import {
  TagTrackAssociator,
  type FusionConfig,
  type FusionFrame,
  type TagReading,
  type TrackDist,
} from "./associate";
import { buildFusionFrame } from "./frame";

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

describe("TagTrackAssociator — evidência de distância absoluta (v4: gate + blend, knobs de PESQUISA)", () => {
  // DESLIGADOS por default (ver cabeçalho do arquivo — revisão adversarial provou circularidade
  // sim↔fit). Estes testes exercitam o MECANISMO ligando os knobs explicitamente na config —
  // não é o comportamento de produção, é a garantia de que o knob, quando ligado, faz o que diz.
  const N = 10;
  // maxDistRatio=2 (log10≈0,301) separa limpo os dois cenários abaixo (medianas calculadas):
  // gapM=0,3 → mediana |log10(distM/dist)| ≈ 0,036 (passa); gapM=5 → ≈ 0,387 (veta).
  const GATE_ON: FusionConfig = { maxDistRatio: 2, distWeight: 0.3 };
  /** 1 pista em metros REAIS (metric) afastando-se 1→6 m + 1 tag cujo RSSI acompanha; o distM da
   *  tag fica a `gapM` metros da distância da pista (o desvio que o gate/blend enxergam). */
  const framesWithGap = (gapM: number, metric: boolean) =>
    makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, N), ...(metric ? { metric: true } : {}) }],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, N), distM: ramp(1, 6, i, N) + gapM }],
    }));

  it("par CONSISTENTE passa pelo gate: câmera 3 m, RSSI calibrado ~3,3 m → associa", () => {
    const a = new TagTrackAssociator(GATE_ON); // knob ligado explicitamente (default = desligado)
    for (const f of framesWithGap(0.3, true)) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBe("AA");
    // Blend: gaps(i) = distM−dist = gapM constante (0,3) p/ toda amostra → mediana = 0,3.
    // (1−0,3)·1 + 0,3·exp(−0,3/1,5) ≈ 0,95 — consistência quase perfeita mantém score alto.
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("par INCONSISTENTE zera: câmera diz 1→6 m, RSSI calibrado diz +5 m → score 0, tag null", () => {
    // A correlação é PERFEITA (a tendência engana), mas o VALOR absoluto denuncia: não é essa tag.
    const a = new TagTrackAssociator(GATE_ON);
    for (const f of framesWithGap(5, true)) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBeNull();
    expect(r.confidence).toBe(0); // gate zera o par — nem "chegou perto"
  });

  it("distM AUSENTE = comportamento IDÊNTICO ao pré-v4, MESMO com o knob ligado (retrocompat dura)", () => {
    // Mesmos frames sem distM: saída com os knobs v4 EXPLICITAMENTE ligados tem de ser
    // byte-idêntica à saída com eles desligados — sem a evidência, o mecanismo não pode existir.
    const build = (cfg?: ConstructorParameters<typeof TagTrackAssociator>[0]) => {
      const a = new TagTrackAssociator(cfg);
      for (const f of makeFrames(N, 0, 500, (i) => ({
        tracks: [
          { trackId: 1, dist: ramp(1, 6, i, N), metric: true },
          { trackId: 2, dist: ramp(6, 1, i, N), metric: true },
        ],
        readings: [
          { tag: "AA", rssi: ramp(-50, -75, i, N) },
          { tag: "BB", rssi: ramp(-75, -50, i, N) },
        ],
      }))) {
        a.push(f);
      }
      return a.assign();
    };
    expect(build()).toEqual(build(GATE_ON));
  });

  it("modo PROXY (pista sem metric) = gate INERTE mesmo com o knob ligado e gap absurdo", () => {
    // Sem homografia a distância da pista é proxy 1/bh — comparar proxy com metros seria físico
    // de mentira. O gap de 5 m que zeraria o par métrico NÃO pode zerar o par proxy, MESMO com
    // o gate explicitamente ligado (align() só popula gaps/logGaps quando track.metric===true).
    const a = new TagTrackAssociator(GATE_ON);
    for (const f of framesWithGap(5, false)) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBe("AA"); // a correlação continua mandando, como pré-v4
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("blend REPONDERA: gap maior (abaixo do gate) → confiança menor, sem derrubar a associação", () => {
    const conf = (gapM: number) => {
      // Só o blend ligado (gate desligado) — isola o efeito da reponderação.
      const a = new TagTrackAssociator({ distWeight: 0.3 });
      for (const f of framesWithGap(gapM, true)) a.push(f);
      const [r] = a.assign();
      expect(r.tag).toBe("AA");
      return r.confidence;
    };
    expect(conf(2.0)).toBeLessThan(conf(0.1)); // exp(−gap/1,5) decresce com o gap
  });

  it("blend NÃO resgata quem as guardas de correlação recusaram (parado + distM consistente → null)", () => {
    // Invariante preservada: com 1 estação a distância absoluta é um ANEL — sozinha não
    // desambigua. Pessoa parada segue "não sei" mesmo com distM batendo certinho.
    const a = new TagTrackAssociator();
    for (const f of makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: 3 + (i % 2) * 0.03, metric: true }],
      readings: [{ tag: "AA", rssi: -60 + (i % 3), distM: 3 }],
    }))) {
      a.push(f);
    }
    const [r] = a.assign();
    expect(r.tag).toBeNull();
    expect(r.confidence).toBe(0);
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

describe("TagTrackAssociator — instrumentação margin/hadConflict (reliability diagram)", () => {
  it("par CLARO (sem concorrente): margin alto (≈score), hadConflict false", () => {
    const N = 10;
    const frames = makeFrames(N, 1000, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, N) },
        { trackId: 2, dist: ramp(6, 1, i, N) },
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, N) },
        { tag: "BB", rssi: ramp(-75, -50, i, N) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const res = a.assign();
    const t1 = res.find((r) => r.trackId === 1)!;
    const t2 = res.find((r) => r.trackId === 2)!;
    expect(t1.tag).toBe("AA");
    expect(t2.tag).toBe("BB");
    expect(t1.margin).toBeGreaterThan(0.9);
    expect(t2.margin).toBeGreaterThan(0.9);
    expect(t1.hadConflict).toBe(false);
    expect(t2.hadConflict).toBe(false);
  });

  it("caso ambíguo (bloco): abstenção com margin baixo e hadConflict true", () => {
    const n = 10;
    const blocoFrames = makeFrames(n, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, n) },
        { trackId: 2, dist: ramp(1.3, 6.3, i, n) }, // paralela (bloco)
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, n) },
        { tag: "BB", rssi: ramp(-52, -77, i, n) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of blocoFrames) a.push(f);
    const res = a.assign();
    expect(res.map((r) => r.tag)).toEqual([null, null]);
    for (const r of res) {
      expect(r.margin).toBeLessThan(0.3); // empate físico → margem quase nula
      expect(r.margin).toBeGreaterThanOrEqual(0); // clamp/definição não deixa negativo neste caso
      expect(r.hadConflict).toBe(true);
    }
  });

  it("sem nenhum candidato elegível (tag ausente): margin 0, hadConflict false (não é empate, é falta de evidência)", () => {
    const N = 8;
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, N) }],
      readings: [], // nenhuma tag em cena
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [r] = a.assign();
    expect(r.tag).toBeNull();
    expect(r.margin).toBe(0);
    expect(r.hadConflict).toBe(false);
  });

  it("oclusão/flicker: abstenção por concorrência do fantasma também reporta margin baixo e hadConflict true", () => {
    const n = 10;
    const occlusionFrames = makeFrames(n, 0, 500, (i) => ({
      tracks:
        i === n - 1
          ? [{ trackId: 2, dist: ramp(1.3, 6.3, i, n) }]
          : [
              { trackId: 1, dist: ramp(1, 6, i, n) },
              { trackId: 2, dist: ramp(1.3, 6.3, i, n) },
            ],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, n) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of occlusionFrames) a.push(f);
    const [r] = a.assign();
    expect(r.trackId).toBe(2);
    expect(r.tag).toBeNull();
    expect(r.hadConflict).toBe(true);
    expect(r.margin).toBeLessThan(0.3);
  });
});

describe("TagTrackAssociator — diagnoseFunnel (funil de vetos instrumentado)", () => {
  it("par que fala → SPOKE (mesma decisão do assign), par oposto → belowMinConfidence", () => {
    const N = 10;
    const frames = makeFrames(N, 1000, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, N) },
        { trackId: 2, dist: ramp(6, 1, i, N) },
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, N) },
        { tag: "BB", rssi: ramp(-75, -50, i, N) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const funnel = a.diagnoseFunnel();
    expect(funnel).toHaveLength(4); // 2 pistas × 2 tags

    const f1AA = funnel.find((p) => p.trackId === 1 && p.tag === "AA")!;
    expect(f1AA.verdict).toBe("SPOKE");
    expect(f1AA.distSamples).toBe(N);
    expect(f1AA.rssiSamples).toBe(N);
    expect(f1AA.alignedSamples).toBe(N);
    expect(f1AA.spanMs).toBe((N - 1) * 500);
    expect(f1AA.corr).toBeLessThan(-0.99); // anti-correlação quase perfeita
    expect(f1AA.score).toBeGreaterThan(0.99);
    expect(f1AA.margin).toBeGreaterThan(0.9);
    expect(f1AA.thresholds.minSamples).toBe(5); // limiares vigentes expostos

    // Par cruzado (correlação POSITIVA → score 0): morre em belowMinConfidence.
    const f1BB = funnel.find((p) => p.trackId === 1 && p.tag === "BB")!;
    expect(f1BB.verdict).toBe("belowMinConfidence");
    expect(f1BB.score).toBe(0);
    expect(f1BB.margin).toBeNull();

    // Diagnóstico é SÓ LEITURA e coerente com a decisão real: SPOKE ⇔ assign fala o rótulo.
    const res = a.assign();
    expect(res.find((r) => r.trackId === 1)!.tag).toBe("AA");
    expect(res.find((r) => r.trackId === 2)!.tag).toBe("BB");
  });

  it("pessoa quase parada → lowMovement, com movVar reportado abaixo do limiar", () => {
    const N = 10;
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: 3 + (i % 2) * 0.03 }],
      readings: [{ tag: "AA", rssi: -60 + (i % 3) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [p] = a.diagnoseFunnel();
    expect(p.verdict).toBe("lowMovement");
    expect(p.movVar).not.toBeNull();
    expect(p.movVar!).toBeLessThan(p.thresholds.minMovement);
    expect(p.score).toBe(0); // o pairScore real também vetou (fonte única)
    expect(a.assign()[0].tag).toBeNull();
  });

  it("amostras de menos na janela → distSamples<minSamples", () => {
    const N = 3; // < minSamples (default 5)
    const frames = makeFrames(N, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, N) }],
      readings: [{ tag: "AA", rssi: ramp(-50, -75, i, N) }],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const [p] = a.diagnoseFunnel();
    expect(p.verdict).toBe("distSamples<minSamples");
    expect(p.distSamples).toBe(3);
    expect(p.corr).not.toBeNull(); // a correlação até existe — o veto é o n, não a matemática
    expect(a.assign()[0].tag).toBeNull();
  });

  it("bloco (empate físico): escolhidos morrem em belowMinMargin, perdedores da 1-1 em lostTieBreak", () => {
    const n = 10;
    const frames = makeFrames(n, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: ramp(1, 6, i, n) },
        { trackId: 2, dist: ramp(1.3, 6.3, i, n) }, // paralela (bloco)
      ],
      readings: [
        { tag: "AA", rssi: ramp(-50, -75, i, n) },
        { tag: "BB", rssi: ramp(-52, -77, i, n) },
      ],
    }));
    const a = new TagTrackAssociator();
    for (const f of frames) a.push(f);
    const funnel = a.diagnoseFunnel();
    const byVerdict = (v: string) => funnel.filter((p) => p.verdict === v);
    expect(byVerdict("belowMinMargin")).toHaveLength(2); // os 2 pares que a 1-1 escolheu
    expect(byVerdict("lostTieBreak")).toHaveLength(2); // os 2 elegíveis que perderam linha/coluna
    expect(byVerdict("SPOKE")).toHaveLength(0);
    for (const p of byVerdict("belowMinMargin")) {
      expect(p.margin).not.toBeNull();
      expect(p.margin!).toBeLessThan(p.thresholds.minMargin); // a razão exata do veto, em número
      expect(p.score).toBeGreaterThan(0.9); // chegou PERTO de falar — a assinatura do empate
    }
    expect(a.assign().map((r) => r.tag)).toEqual([null, null]); // coerente com a decisão real
  });
});

describe("TagTrackAssociator — recalibração dos gates (knobs de PESQUISA: useLogDistance / minMovementDecades / significanceGate)", () => {
  // OFF por default (byte-compat dura com os pinos de replay-fusion.test.ts); estes testes
  // exercitam o MECANISMO ligando cada knob explicitamente — o torneio que decide promoção mora
  // em gates-recalibration.test.ts. Prescrição completa no cabeçalho de associate.ts.

  /** RSSI pelo modelo físico log-distância (o que o canal real faz): −45 − 10·2,2·log10(d). */
  const logLaw = (d: number) => -45 - 22 * Math.log10(d);

  it("OFF explícito = byte-compat: knobs em OFF reproduzem a saída default (aditividade)", () => {
    const build = (cfg?: FusionConfig) => {
      const a = new TagTrackAssociator(cfg);
      for (const f of makeFrames(10, 0, 500, (i) => ({
        tracks: [
          { trackId: 1, dist: ramp(1, 6, i, 10) },
          { trackId: 2, dist: ramp(6, 1, i, 10) },
        ],
        readings: [
          { tag: "AA", rssi: ramp(-50, -75, i, 10) },
          { tag: "BB", rssi: ramp(-75, -50, i, 10) },
        ],
      }))) {
        a.push(f);
      }
      return a.assign();
    };
    expect(build({ useLogDistance: false, minMovementDecades: 0 })).toEqual(build());
  });

  it("useLogDistance: RSSI que segue o modelo log-distância → r sobe na variável certa (e vale p/ proxy)", () => {
    // Sem `metric` nas pistas — é exatamente o caso proxy/sem-H: o knob aplica o log igual
    // (proxy monotônico → log igualmente monotônico, ver FusionConfig.useLogDistance).
    const N = 10;
    const conf = (cfg?: FusionConfig) => {
      const a = new TagTrackAssociator(cfg);
      for (const f of makeFrames(N, 0, 500, (i) => ({
        tracks: [{ trackId: 1, dist: ramp(1, 6, i, N) }],
        readings: [{ tag: "AA", rssi: logLaw(ramp(1, 6, i, N)) }],
      }))) {
        a.push(f);
      }
      return a.assign()[0];
    };
    const linear = conf();
    const log = conf({ useLogDistance: true });
    expect(linear.tag).toBe("AA"); // a correlação linear também fala (monotônica)…
    expect(log.tag).toBe("AA");
    // …mas na variável do MODELO FÍSICO a anti-correlação é exata: r = −1 (a menos de fp).
    expect(log.confidence).toBeGreaterThan(0.9999);
    expect(log.confidence).toBeGreaterThan(linear.confidence);
  });

  it("minMovementDecades SEM useLogDistance é ignorado (décadas só existem na variável log)", () => {
    const build = (cfg?: FusionConfig) => {
      const a = new TagTrackAssociator(cfg);
      for (const f of makeFrames(10, 0, 500, (i) => ({
        tracks: [{ trackId: 1, dist: ramp(1, 6, i, 10) }],
        readings: [{ tag: "AA", rssi: ramp(-50, -75, i, 10) }],
      }))) {
        a.push(f);
      }
      return a.assign();
    };
    // Um limiar absurdo (9 décadas) que calaria qualquer par SE fosse aplicado: saída idêntica.
    expect(build({ minMovementDecades: 9 })).toEqual(build());
    expect(build({ minMovementDecades: 9 })[0].tag).toBe("AA");
  });

  it("gate em DÉCADAS substitui minMovement: caminhada curta em m² (0,10 < 0,15) mas rica em décadas fala", () => {
    // dist 0,5→1,5 m (sala pequena/perto da estação): variância ≈ 0,102 m² — FISICAMENTE
    // impassável pro minMovement 0,15 (o problema do campo real). Em décadas o span radial é
    // rico: std(log10 d) ≈ 0,150 década → o gate ADIMENSIONAL (0,12) deixa a física falar.
    const N = 10;
    const run = (cfg?: FusionConfig) => {
      const a = new TagTrackAssociator(cfg);
      for (const f of makeFrames(N, 0, 500, (i) => ({
        tracks: [{ trackId: 1, dist: ramp(0.5, 1.5, i, N) }],
        readings: [{ tag: "AA", rssi: logLaw(ramp(0.5, 1.5, i, N)) }],
      }))) {
        a.push(f);
      }
      return a.assign()[0];
    };
    expect(run().tag).toBeNull(); // default: var 0,102 m² < 0,15 → lowMovement
    expect(run({ useLogDistance: true }).tag).toBeNull(); // log SÓ na correlação: m² segue valendo
    expect(run({ useLogDistance: true, minMovementDecades: 0.12 }).tag).toBe("AA"); // substituiu
    expect(run({ useLogDistance: true, minMovementDecades: 0.18 }).tag).toBeNull(); // 0,150 < 0,18
  });

  /** Frames com correlação CONTROLADA por decomposição ortogonal: u = rampa centrada (ímpar em
   *  torno do centro), v = |u| − média (par) ⇒ u ⊥ v exatos. rssi = −cu·(u/σu) + cv·(v/σv) dá
   *  corr(rssi, dist) = −cu/√(cu²+cv²) EXATA (dist é afim em u). (cu,cv)=(3,4) → r = −0,6;
   *  (24,7) → r = −0,96. dt=300 ms p/ n=20 caber na janela de 8 s (5,7 s de span). */
  const corrFrames = (n: number, cu: number, cv: number) => {
    const u = Array.from({ length: n }, (_, i) => i - (n - 1) / 2);
    const absMean = u.reduce((s, x) => s + Math.abs(x), 0) / n;
    const v = u.map((x) => Math.abs(x) - absMean);
    const sd = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
    };
    const su = sd(u);
    const sv = sd(v);
    return makeFrames(n, 0, 300, (i) => ({
      tracks: [{ trackId: 1, dist: 6 + 0.5 * u[i] }],
      readings: [{ tag: "AA", rssi: -60 - cu * (u[i] / su) + cv * (v[i] / sv) }],
    }));
  };

  it("significanceGate SUBSTITUI minConfidence: r modesto mas significativo fala (janela rica)", () => {
    // n=20 distintas, ρ=0 → n_eff=20; limiar |z| ≥ 1,96·√(1/17) ≈ 0,475 → r crítico ≈ 0,44.
    // r = 0,6 (z = 0,693) É significativo → fala, mesmo com minConfidence 0,9 (substituído).
    const gate = { zCrit: 1.96, rho: 0, minNeff: 5 };
    const withGate = new TagTrackAssociator({ minConfidence: 0.9, significanceGate: gate });
    for (const f of corrFrames(20, 3, 4)) withGate.push(f);
    const [spoke] = withGate.assign();
    expect(spoke.tag).toBe("AA");
    expect(spoke.confidence).toBeCloseTo(0.6, 3); // semântica intacta: confidence segue −corr

    // Contraprova: SEM o gate, o MESMO minConfidence 0,9 barra o mesmo par (r 0,6 < 0,9).
    const without = new TagTrackAssociator({ minConfidence: 0.9 });
    for (const f of corrFrames(20, 3, 4)) without.push(f);
    expect(without.assign()[0].tag).toBeNull();
  });

  it("janela POBRE exige r alto: r=0,6 insignificante com n=8 abstém; r=0,96 fala na mesma janela", () => {
    // n=8, ρ=0 → n_eff=8; limiar |z| ≥ 1,96·√(1/5) ≈ 0,877 → r crítico ≈ 0,705.
    const gate = { zCrit: 1.96, rho: 0, minNeff: 5 };
    const poor = new TagTrackAssociator({ significanceGate: gate });
    for (const f of corrFrames(8, 3, 4)) poor.push(f);
    expect(poor.assign()[0].tag).toBeNull(); // z(0,6)=0,693 < 0,877 → abstém

    // Sem o gate, o comportamento ATUAL fala (0,6 ≥ minConfidence 0,5) — é isso que ele troca.
    const current = new TagTrackAssociator();
    for (const f of corrFrames(8, 3, 4)) current.push(f);
    expect(current.assign()[0].tag).toBe("AA");

    // E a MESMA janela pobre fala com r alto: z(0,96)=1,946 ≥ 0,877 → o "−0,9 do campo".
    const strong = new TagTrackAssociator({ significanceGate: gate });
    for (const f of corrFrames(8, 24, 7)) strong.push(f);
    const [r] = strong.assign();
    expect(r.tag).toBe("AA");
    expect(r.confidence).toBeCloseTo(0.96, 3);
  });

  it("dedup por valor consecutivo: snapshot que repete o último batch não infla o n", () => {
    // 24 frames, RSSI atualizado a cada 3 (8 valores distintos consecutivos, como o snapshot
    // real que repete o último batch entre atualizações). minNeff 10: a contagem INGÊNUA (24
    // amostras alinhadas) passaria; o dedup honesto conta 8 < 10 → abstém, apesar de |z| enorme.
    const gate = { zCrit: 1.96, rho: 0, minNeff: 10 };
    const N = 24;
    const dist = (i: number) => 1 + (5 * i) / (N - 1);
    const held = new TagTrackAssociator({ significanceGate: gate });
    for (const f of makeFrames(N, 0, 300, (i) => ({
      tracks: [{ trackId: 1, dist: dist(i) }],
      readings: [{ tag: "AA", rssi: logLaw(dist(3 * Math.floor(i / 3))) }], // “batch” repetido 3×
    }))) {
      held.push(f);
    }
    expect(held.assign()[0].tag).toBeNull(); // 8 distintas < minNeff 10 — o dedup foi contado

    // Mesma física com leitura FRESCA a cada frame: 24 distintas ≥ 10 e |z| enorme → fala.
    const fresh = new TagTrackAssociator({ significanceGate: gate });
    for (const f of makeFrames(N, 0, 300, (i) => ({
      tracks: [{ trackId: 1, dist: dist(i) }],
      readings: [{ tag: "AA", rssi: logLaw(dist(i)) }],
    }))) {
      fresh.push(f);
    }
    expect(fresh.assign()[0].tag).toBe("AA");
  });

  it("n_eff ≤ 3 → nunca fala, mesmo com anti-correlação PERFEITA (variância de Fisher indefinida)", () => {
    // ρ=0,7 → n_eff = 10·(0,3/1,7) ≈ 1,76 ≤ 3: abstém apesar de r = −1 exato na variável log
    // (atanh(−1) = −∞ passaria QUALQUER limiar — a proteção do n_eff tem de vir antes).
    const gate = { zCrit: 1.645, rho: 0.7, minNeff: 1 };
    const a = new TagTrackAssociator({ useLogDistance: true, significanceGate: gate });
    for (const f of makeFrames(10, 0, 500, (i) => ({
      tracks: [{ trackId: 1, dist: ramp(1, 6, i, 10) }],
      readings: [{ tag: "AA", rssi: logLaw(ramp(1, 6, i, 10)) }],
    }))) {
      a.push(f);
    }
    expect(a.assign()[0].tag).toBeNull();
  });

  it("invariante do parado preservada com TODOS os knobs ligados: sem movimento → nunca fala", () => {
    const cfg: FusionConfig = {
      useLogDistance: true,
      minMovementDecades: 0.12,
      significanceGate: { zCrit: 1.645, rho: 0, minNeff: 5 },
    };
    const a = new TagTrackAssociator(cfg);
    for (const f of makeFrames(10, 0, 500, (i) => ({
      tracks: [
        { trackId: 1, dist: 3 + (i % 2) * 0.03 },
        { trackId: 2, dist: 4 - (i % 2) * 0.03 },
      ],
      readings: [
        { tag: "AA", rssi: -60 + (i % 3) },
        { tag: "BB", rssi: -65 - (i % 3) },
      ],
    }))) {
      a.push(f);
    }
    const res = a.assign();
    expect(res.map((r) => r.tag)).toEqual([null, null]); // std(log10 d) ≈ 0,002 << 0,12 → veto
    expect(res.every((r) => r.confidence === 0)).toBe(true);
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

describe("TagTrackAssociator — fusão multi-fonte por soma de Fisher-z (knob multiSourceFisher, ADR-013 item 4)", () => {
  // Knob de PESQUISA, OFF por default (byte-compat dura). LIMITAÇÃO DE ESCOPO v1 documentada em
  // FusionConfig.multiSourceFisher: toda fonte correlaciona contra a MESMA série de distância da
  // pista (a da estação principal); geometria por-fonte (TrackDist por fonte) é a fase 2.
  const N = 16;
  const d = (i: number) => ramp(1, 8, i, N);
  const wiggle = (i: number) => (i % 2 === 0 ? 1 : -1);
  /** Fonte que SEGUE a física: anti-correlação forte (~−0,99) mas não perfeita (o wiggle evita
   *  correlação exata ±1 — queremos exercitar a soma de z, não o clamp). */
  const rssiFisica = (i: number) => -40 - 3 * d(i) + wiggle(i);
  /** Fonte de RUÍDO puro: alternância sem tendência — corr ~−0,11 com a rampa (perto de zero). */
  const rssiRuido = (i: number) => -60 + 2 * wiggle(i);
  /** Fonte que CONTRADIZ: RSSI SOBE com a distância (fisicamente impossível p/ o dono da tag) —
   *  corr ~+0,97: o z positivo quase cancela o z negativo da fonte espúria. */
  const rssiContra = (i: number) => -80 + 2 * d(i) + wiggle(i);

  const run = (
    gen: (i: number) => TagReading[],
    cfg?: FusionConfig,
    tracks: (i: number) => TrackDist[] = (i) => [{ trackId: 1, dist: d(i) }],
  ) => {
    const a = new TagTrackAssociator(cfg);
    for (const f of makeFrames(N, 0, 500, (i) => ({ tracks: tracks(i), readings: gen(i) })))
      a.push(f);
    return a.assign();
  };

  it("knob OFF (default): sourceId presente é IGNORADO — byte-idêntico à mesma cena sem o campo", () => {
    const comSrc = run((i) => [
      { tag: "AA", rssi: rssiFisica(i), sourceId: "A" },
      { tag: "AA", rssi: rssiRuido(i), sourceId: "B" },
    ]);
    const semSrc = run((i) => [
      { tag: "AA", rssi: rssiFisica(i) },
      { tag: "AA", rssi: rssiRuido(i) },
    ]);
    expect(JSON.stringify(comSrc)).toBe(JSON.stringify(semSrc)); // pool único, como sempre
  });

  it("ON com fonte ÚNICA = OFF bit-a-bit (a redução z_comb = z_1): sem sourceId e com sourceId único", () => {
    const gen = (i: number): TagReading[] => [{ tag: "AA", rssi: rssiFisica(i) }];
    const off = run(gen);
    const on = run(gen, { multiSourceFisher: true });
    expect(on).toEqual(off);
    expect(on[0].tag).toBe("AA");
    expect(on[0].confidence).toBe(off[0].confidence); // bit-a-bit, não aproximado
    // Mesma redução com a fonte EXPLÍCITA (todas as leituras da fonte "A"):
    const onSrc = run((i) => [{ tag: "AA", rssi: rssiFisica(i), sourceId: "A" }], {
      multiSourceFisher: true,
    });
    expect(JSON.stringify(onSrc)).toBe(JSON.stringify(off));
  });

  it("fonte com amostras de MENOS não vota (gate por fonte): bit-idêntico à fonte forte sozinha", () => {
    const onAB = run(
      (i) => {
        const r: TagReading[] = [{ tag: "AA", rssi: rssiFisica(i), sourceId: "A" }];
        if (i < 3) r.push({ tag: "AA", rssi: rssiRuido(i), sourceId: "B" }); // 3 < minSamples (5)
        return r;
      },
      { multiSourceFisher: true },
    );
    const offA = run((i) => [{ tag: "AA", rssi: rssiFisica(i) }]);
    expect(onAB[0].tag).toBe("AA");
    expect(onAB[0].confidence).toBe(offA[0].confidence); // a redução exata, sem round-trip de fp
  });

  it("2 fontes, uma FORTE + uma de RUÍDO puro: o par certo ainda fala — diluído, não morto", () => {
    const soloA = run((i) => [{ tag: "AA", rssi: rssiFisica(i), sourceId: "A" }], {
      multiSourceFisher: true,
    });
    const comRuido = run(
      (i) => [
        { tag: "AA", rssi: rssiFisica(i), sourceId: "A" },
        { tag: "AA", rssi: rssiRuido(i), sourceId: "B" },
      ],
      { multiSourceFisher: true },
    );
    expect(comRuido[0].tag).toBe("AA"); // ainda fala (z_comb ≈ z_A/√2 → score ~0,94)
    expect(comRuido[0].confidence).toBeGreaterThan(0.5);
    expect(comRuido[0].confidence).toBeLessThan(soloA[0].confidence); // o ruído DILUI, mede-se
  });

  it("correlação ESPÚRIA numa fonte só é ENFRAQUECIDA pela segunda (o desempate real de 2 antenas)", () => {
    // Sozinha, a fonte A “prova” o par (r ≈ −0,99, espúrio por hipótese). A fonte B mede o
    // CONTRÁRIO (RSSI subindo com a distância): z_B (+) quase cancela z_A (−) → score ~0,3 → abstém.
    const soloA = run((i) => [{ tag: "AA", rssi: rssiFisica(i), sourceId: "A" }], {
      multiSourceFisher: true,
    });
    expect(soloA[0].tag).toBe("AA"); // sem a 2ª fonte, a espúria falaria
    const both = run(
      (i) => [
        { tag: "AA", rssi: rssiFisica(i), sourceId: "A" },
        { tag: "AA", rssi: rssiContra(i), sourceId: "B" },
      ],
      { multiSourceFisher: true },
    );
    expect(both[0].tag).toBeNull(); // a 2ª fonte desempata: cai abaixo de minConfidence
    expect(both[0].confidence).toBeLessThan(0.5);
    expect(both[0].confidence).toBeLessThan(soloA[0].confidence);
  });

  it("leituras SEM sourceId caem na fonte 'default' (retrocompat): igual a rotulá-las explicitamente", () => {
    const implicita = run(
      (i) => [
        { tag: "AA", rssi: rssiFisica(i) }, // sem sourceId → fonte "default"
        { tag: "AA", rssi: rssiRuido(i), sourceId: "B" },
      ],
      { multiSourceFisher: true },
    );
    const explicita = run(
      (i) => [
        { tag: "AA", rssi: rssiFisica(i), sourceId: "A" },
        { tag: "AA", rssi: rssiRuido(i), sourceId: "B" },
      ],
      { multiSourceFisher: true },
    );
    expect(JSON.stringify(implicita)).toBe(JSON.stringify(explicita)); // 2 fontes nos dois casos
  });

  it("guarda de ambiguidade opera IGUAL sobre o score combinado: bloco com 2 fontes → abstém", () => {
    const tracks = (i: number): TrackDist[] => [
      { trackId: 1, dist: ramp(1, 6, i, N) },
      { trackId: 2, dist: ramp(1.3, 6.3, i, N) }, // paralela (bloco — o empate físico)
    ];
    const res = run(
      (i) => [
        { tag: "AA", rssi: ramp(-50, -75, i, N), sourceId: "A" },
        { tag: "AA", rssi: ramp(-51, -76, i, N), sourceId: "B" },
        { tag: "BB", rssi: ramp(-52, -77, i, N), sourceId: "A" },
        { tag: "BB", rssi: ramp(-53, -78, i, N), sourceId: "B" },
      ],
      { multiSourceFisher: true },
      tracks,
    );
    expect(res.map((r) => r.tag)).toEqual([null, null]); // 2 fontes CONCORDANTES não desfazem o empate
    expect(res.every((r) => r.confidence > 0.9)).toBe(true); // a assinatura da ambiguidade, intacta
  });

  it("buildFusionFrame repassa sourceId intacto (e não inventa a chave quando ausente)", () => {
    const ff = buildFusionFrame(
      [],
      [
        { mac: "M1", rotulo: "AA", rssi: -50, sourceId: "esp32-b" },
        { mac: "M2", rotulo: null, rssi: -60 },
      ],
      null,
      123,
    );
    expect(ff.readings[0].sourceId).toBe("esp32-b");
    expect("sourceId" in ff.readings[1]).toBe(false); // retrocompat dura: nem a chave existe
  });
});

