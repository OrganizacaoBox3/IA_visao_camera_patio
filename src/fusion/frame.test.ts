import { describe, it, expect } from "vitest";
import { buildFusionFrame } from "./frame";
import { TagTrackAssociator } from "./associate";
import type { Matrix3 } from "../vision/homography";
import type { PathLossModel } from "./floor-plot";

const ID: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identidade: pixelToWorld devolve as próprias coords

describe("buildFusionFrame — distância via homografia", () => {
  it("estação na base-centro; pé mais perto do rodapé = distância menor", () => {
    const tracks = [
      { id: 1, bbox: [0.4, 0.4, 0.2, 0.1] as const }, // pé (0.5, 0.5)
      { id: 2, bbox: [0.4, 0.8, 0.2, 0.1] as const }, // pé (0.5, 0.9) — mais perto da base
    ];
    const f = buildFusionFrame(tracks, [{ mac: "AA", rotulo: "João", rssi: -50 }], ID, 1000);
    const d1 = f.tracks.find((t) => t.trackId === 1)!.dist;
    const d2 = f.tracks.find((t) => t.trackId === 2)!.dist;
    expect(d1).toBeCloseTo(0.5, 5); // |(0.5,0.5) - (0.5,1.0)|
    expect(d2).toBeCloseTo(0.1, 5);
    expect(d2).toBeLessThan(d1); // mais perto da base = mais perto da estação
    expect(f.readings).toEqual([{ tag: "João", rssi: -50 }]); // rótulo vira o `tag`
    expect(f.ts).toBe(1000);
  });

  it("stationPx é a ORIGEM da distância: mesma pessoa, estação diferente → distância diferente", () => {
    const tracks = [{ id: 1, bbox: [0.4, 0.4, 0.2, 0.1] as const }]; // pé em (0.5, 0.5)
    // Default (base-centro 0.5,1.0): |(0.5,0.5) - (0.5,1.0)| = 0.5.
    const dDefault = buildFusionFrame(tracks, [], ID, 1000).tracks[0].dist;
    // Estação marcada na calibração em (0.1, 0.9): |(0.5,0.5) - (0.1,0.9)| = hypot(0.4,0.4).
    const dMarked = buildFusionFrame(tracks, [], ID, 1000, { x: 0.1, y: 0.9 }).tracks[0].dist;
    expect(dDefault).toBeCloseTo(0.5, 5);
    expect(dMarked).toBeCloseTo(Math.hypot(0.4, 0.4), 5);
    expect(dMarked).not.toBeCloseTo(dDefault, 5); // prova: o ponto passado É a origem
  });
});

describe("buildFusionFrame — fallback sem calibração", () => {
  it("proxy pelo tamanho da caixa: maior = mais perto (dist menor)", () => {
    const tracks = [
      { id: 1, bbox: [0, 0, 0.2, 0.5] as const }, // alta = perto
      { id: 2, bbox: [0, 0, 0.2, 0.25] as const }, // baixa = longe
    ];
    const f = buildFusionFrame(tracks, [], null, 0);
    const d1 = f.tracks.find((t) => t.trackId === 1)!.dist;
    const d2 = f.tracks.find((t) => t.trackId === 2)!.dist;
    expect(d1).toBeLessThan(d2);
  });

  it("reading sem rótulo cai no MAC", () => {
    const f = buildFusionFrame(
      [],
      [{ mac: "48:87:2D:9D:CE:8D", rotulo: null, rssi: -60 }],
      null,
      0,
    );
    expect(f.readings[0].tag).toBe("48:87:2D:9D:CE:8D");
  });
});

describe("buildFusionFrame — o elo stationId→sourceId (spec multi-antena F4, CA-2)", () => {
  it("leituras ao vivo com stationId → TagReading.sourceId preenchido (uma fonte por estação)", () => {
    const f = buildFusionFrame(
      [],
      [
        { mac: "AA", rotulo: null, rssi: -50, stationId: "est-a" },
        { mac: "AA", rotulo: null, rssi: -70, stationId: "est-b" },
      ],
      null,
      0,
    );
    expect(f.readings).toEqual([
      { tag: "AA", rssi: -50, sourceId: "est-a" },
      { tag: "AA", rssi: -70, sourceId: "est-b" },
    ]);
  });

  it("sourceId EXPLÍCITO (replay/session-loader) tem precedência sobre stationId", () => {
    const f = buildFusionFrame(
      [],
      [{ mac: "AA", rotulo: null, rssi: -50, sourceId: "gravado", stationId: "vivo" }],
      null,
      0,
    );
    expect(f.readings[0].sourceId).toBe("gravado");
  });

  it("sem sourceId nem stationId (ou stationId vazio) → chave AUSENTE (retrocompat dura, CA-3)", () => {
    const f = buildFusionFrame(
      [],
      [
        { mac: "AA", rotulo: null, rssi: -50 },
        { mac: "BB", rotulo: null, rssi: -60, stationId: "" },
      ],
      null,
      0,
    );
    expect("sourceId" in f.readings[0]).toBe(false);
    expect("sourceId" in f.readings[1]).toBe(false);
  });

  it("CA-2 fim-a-fim: com o elo, o motor (multiSourceFisher ON) VÊ 2 grupos — partição por fonte", () => {
    // (o elo sourceId; a GEOMETRIA por fonte — Fase B — está no describe seguinte)
    // Cenário construído p/ DISCRIMINAR "2 grupos" de "pool único": a fonte A é anti-correlacionada
    // com a distância (o casamento físico) e a fonte B é o ESPELHO exato dela (rssiB = −120 − rssiA
    // ⇒ r_B = −r_A bit-a-bit ⇒ z_B = −z_A). Com a partição, a soma de Fisher-z se cancela em 0 →
    // score 0 → abstenção honesta. SEM o elo (sourceId ausente), o knob ON veria 1 grupo e cairia
    // no pool único — que fala com confiança ~1 (no empate de ts o align() pega a amostra inserida
    // primeiro, a da fonte A). Falar × abster É a prova de que partitionBySource viu 2 grupos.
    const H4: Matrix3 = [4, 0, 0, 0, 4, 0, 0, 0, 1]; // px→mundo ×4: movimento em "metros" (passa o minMovement)
    const run = (stationA?: string, stationB?: string) => {
      const assoc = new TagTrackAssociator({ multiSourceFisher: true });
      for (let k = 0; k < 8; k++) {
        const y = 0.9 - k * 0.1; // pé se afastando da estação (base-centro): dist 0,4 → 3,2
        const rssiA = -40 - 3 * k; // cai enquanto a distância cresce (corr −1)
        const readings = [
          { mac: "AA", rotulo: null, rssi: rssiA, ...(stationA ? { stationId: stationA } : {}) },
          {
            mac: "AA",
            rotulo: null,
            rssi: -120 - rssiA,
            ...(stationB ? { stationId: stationB } : {}),
          },
        ];
        assoc.push(
          buildFusionFrame([{ id: 1, bbox: [0.45, y - 0.3, 0.1, 0.3] }], readings, H4, k * 500),
        );
      }
      return assoc.assign(3500);
    };
    // COM o elo: 2 fontes que se contradizem se cancelam → "não sei" (a partição aconteceu).
    const [withLink] = run("est-a", "est-b");
    expect(withLink).toMatchObject({ trackId: 1, tag: null });
    // SEM stationId (o mundo do bug): 1 grupo implícito → pool único fala com confiança alta.
    const [withoutLink] = run();
    expect(withoutLink.tag).toBe("AA");
    expect(withoutLink.confidence).toBeGreaterThan(0.9);
  });
});

describe("buildFusionFrame — dist POR estação (spec multi-antena F5, Fase B)", () => {
  // H identidade: px 0..1 = mundo 0..1, então a conta de distância é conferível a olho.
  const tracks = [{ id: 1, bbox: [0.4, 0.4, 0.2, 0.1] as const }]; // pé em (0.5, 0.5)

  it("uma distância POR estação calibrada — a geometria que o motor precisa p/ correlacionar por fonte", () => {
    const f = buildFusionFrame(tracks, [], ID, 0, { x: 0.5, y: 1.0 }, undefined, {
      "est-a": { x: 0.5, y: 1.0 }, // a principal (mesmo ponto do stationPx)
      "est-b": { x: 0.1, y: 0.9 },
    });
    const t = f.tracks[0];
    expect(t.dist).toBeCloseTo(0.5, 5); // principal: |(0.5,0.5) − (0.5,1.0)|
    expect(t.metric).toBe(true);
    expect(t.distByStation!["est-a"]).toBeCloseTo(0.5, 5); // idem, pela geometria da estação A
    expect(t.distByStation!["est-b"]).toBeCloseTo(Math.hypot(0.4, 0.4), 5); // |(0.5,0.5) − (0.1,0.9)|
    // As duas distâncias DIFEREM — é exatamente isso que quebra o rival radialmente confundível.
    expect(t.distByStation!["est-a"]).not.toBeCloseTo(t.distByStation!["est-b"], 3);
  });

  it("sem stations → a chave NEM EXISTE (retrocompat dura: mundo de 1 antena, CA-3)", () => {
    const f = buildFusionFrame(tracks, [], ID, 0);
    expect("distByStation" in f.tracks[0]).toBe(false);
    const vazio = buildFusionFrame(tracks, [], ID, 0, undefined, undefined, {});
    expect("distByStation" in vazio.tracks[0]).toBe(false); // stations vazio = ausente
  });

  it("sem homografia (proxy de caixa) → sem distância por estação, mesmo com stations marcadas", () => {
    // O proxy 1/bh não depende de ONDE a estação está: emitir uma "distância por estação" aqui
    // seria inventar geometria. Degradação declarada — o motor cai na dist principal p/ toda fonte.
    const f = buildFusionFrame(tracks, [], null, 0, undefined, undefined, {
      "est-a": { x: 0.5, y: 1.0 },
      "est-b": { x: 0.1, y: 0.9 },
    });
    expect("distByStation" in f.tracks[0]).toBe(false);
  });

  it("estação viva SEM ponto calibrado não aparece — a fonte cai na dist principal no motor", () => {
    const f = buildFusionFrame(tracks, [], ID, 0, undefined, undefined, {
      "est-a": { x: 0.5, y: 1.0 },
    });
    expect(Object.keys(f.tracks[0].distByStation!)).toEqual(["est-a"]); // "est-b" não foi marcada
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FASE C (H3) — O ELO pathLoss → distM. Contrato entre camadas SEM teste = regressão silenciosa
// nº 1 (CLAUDE.md §2.4): `distM` existia no tipo, o associador sabia consumi-lo, o modelo existia
// em floor-plot.ts — e NINGUÉM os ligava. Estes testes travam a ponte.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("buildFusionFrame — distM pelo path-loss calibrado (Fase C)", () => {
  const MODEL: PathLossModel = { rssi0: -45, n: 2.2, source: "anchors", samples: 4 };
  const rssiAt = (d: number) => -45 - 10 * 2.2 * Math.log10(d); // o RSSI que a tag a d m emitiria

  it("SEM modelo: a chave distM nem existe (retrocompat DURA — o frame de antes, byte a byte)", () => {
    const f = buildFusionFrame([], [{ mac: "AA", rotulo: null, rssi: -60 }], null, 0);
    expect("distM" in f.readings[0]).toBe(false);
  });

  it("COM modelo: cada leitura ganha a distância ABSOLUTA tag→estação, em metros", () => {
    const f = buildFusionFrame(
      [],
      [{ mac: "AA", rotulo: null, rssi: rssiAt(3) }],
      null,
      0,
      undefined,
      undefined,
      undefined,
      MODEL,
    );
    expect(f.readings[0].distM).toBeCloseTo(3, 5); // é a inversão do modelo, não um proxy
  });

  it("distM DECLARADO na leitura vence o modelo (replay/sim já mediram — o modelo não sobrescreve)", () => {
    const f = buildFusionFrame(
      [],
      [{ mac: "AA", rotulo: null, rssi: rssiAt(3), distM: 9 }],
      null,
      0,
      undefined,
      undefined,
      undefined,
      MODEL,
    );
    expect(f.readings[0].distM).toBe(9);
  });

  it("a evidência absoluta é INDEPENDENTE de movimento: pessoa PARADA, distM presente e comparável", () => {
    // O par que a correlação NÃO consegue julgar (distância constante ⇒ pearson indefinida) é
    // exatamente o que este frame entrega pronto: dist (câmera, métrica) E distM (rádio), ambos em
    // METROS, no mesmo frame. É o insumo da distance.ts — sem ele, a pessoa parada é invisível.
    const parada = { id: 1, bbox: [0.4, 0.4, 0.2, 0.1] as const }; // pé (0.5,0.5) → 0.5 m da base
    const f = buildFusionFrame(
      [parada],
      [{ mac: "AA", rotulo: null, rssi: rssiAt(0.5) }],
      ID,
      0,
      undefined,
      undefined,
      undefined,
      MODEL,
    );
    expect(f.tracks[0].metric).toBe(true); // câmera em METROS
    expect(f.tracks[0].dist).toBeCloseTo(0.5, 5);
    expect(f.readings[0].distM).toBeCloseTo(0.5, 5); // rádio em METROS — comparáveis
  });

  it("âncora excluída não ganha distM (ela nem chega ao frame — exclusão vem antes)", () => {
    const f = buildFusionFrame(
      [],
      [
        { mac: "AA", rotulo: null, rssi: -60 },
        { mac: "BB", rotulo: null, rssi: -60 },
      ],
      null,
      0,
      undefined,
      new Set(["BB"]),
      undefined,
      MODEL,
    );
    expect(f.readings).toHaveLength(1);
    expect(f.readings[0].tag).toBe("AA");
  });

  it("rssi não-finito com modelo → sem distM (não se inverte modelo sobre lixo)", () => {
    const f = buildFusionFrame(
      [],
      [{ mac: "AA", rotulo: null, rssi: NaN }],
      null,
      0,
      undefined,
      undefined,
      undefined,
      MODEL,
    );
    expect("distM" in f.readings[0]).toBe(false);
  });
});
