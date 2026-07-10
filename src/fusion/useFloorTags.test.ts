// Testes das partes PURAS do plot de tags no chão (useFloorTags): ingestão com EMA (o anel não
// treme) e derivação da visão (âncoras exatas, estação, anéis — com as supressões do contrato:
// âncora e tag já associada a pessoa NÃO ganham anel). A matemática de path-loss/anel em si é
// coberta por floor-plot.test.ts; aqui validamos a COMPOSIÇÃO e as regras de negócio da camada.
import { describe, it, expect } from "vitest";
import { ingestReadings, deriveFloorView, type TagSignal } from "./useFloorTags";
import type { BtReading, CalibrationPoint } from "../api";
import type { Matrix3, Vec2 } from "../vision/homography";

// Homografia IDENTIDADE: px (0..1) == mundo — projeção transparente, geometria conferível no olho.
const H_ID: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const STATION: Vec2 = { x: 0.5, y: 0.5 };
const EMA_TAU_MS = 4000; // espelho do knob do hook (mudou lá → o teste TEM que acusar)

const reading = (mac: string, rssi: number, rotulo: string | null = null): BtReading => ({
  mac,
  rotulo,
  rssi,
});
// Âncora nos "cantos": mundo == px (H identidade). Nos testes só 1 âncora fica fresca (<2 válidas)
// → o fit cai no modelo DEFAULT declarado e o raio do anel fica previsível. (Com 2+ equidistantes o
// gate de identificabilidade daria "anchors-offset": n fixo + offset calibrado — ver floor-plot.ts.)
const anchor = (mac: string, x: number, y: number): CalibrationPoint & { mac: string } => ({
  mac,
  px: { x, y },
  world: { x, y },
});
const CORNERS = [anchor("AA:00", 0, 0), anchor("AA:01", 1, 0), anchor("AA:02", 0, 1)];

describe("ingestReadings — EMA por MAC (tau real entre leituras)", () => {
  it("1ª leitura semeia o EMA com o valor cru; leitura seguinte move por alpha=1−e^(−dt/tau)", () => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(tags, [reading("aa:bb:cc:dd:ee:ff", -50)], 0);
    expect(tags.get("AA:BB:CC:DD:EE:FF")?.ema).toBe(-50); // chave normalizada MAIÚSCULA

    ingestReadings(tags, [reading("AA:BB:CC:DD:EE:FF", -40)], EMA_TAU_MS); // dt = tau
    const s = tags.get("AA:BB:CC:DD:EE:FF")!;
    expect(s.ema).toBeCloseTo(-50 + (1 - Math.exp(-1)) * 10, 10);
    expect(s.t).toBe(EMA_TAU_MS);
    expect(s.mac).toBe("aa:bb:cc:dd:ee:ff"); // grafia original preservada (chave da produção)
  });

  it("poda tag calada há mais de 60 s; leitura inválida (rssi não-finito) é ignorada", () => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(tags, [reading("AA:01", -50)], 0);
    ingestReadings(tags, [reading("AA:02", -55), reading("AA:03", NaN)], 61_000);
    expect(tags.has("AA:01")).toBe(false); // podada
    expect(tags.has("AA:02")).toBe(true);
    expect(tags.has("AA:03")).toBe(false); // NaN nunca entra
  });

  it("rotulo chega depois (tag cadastrada no meio da sessão) → atualiza sem perder o EMA", () => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(tags, [reading("AA:01", -50)], 0);
    ingestReadings(tags, [reading("AA:01", -50, "Empilhadeira 3")], 1000);
    expect(tags.get("AA:01")?.rotulo).toBe("Empilhadeira 3");
  });

  it("DESCADASTRO no meio da sessão: rotulo volta a null → a chave de supressão vira o MAC", () => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(tags, [reading("BB:BB:BB:BB:BB:B1", -45, "João")], 0);
    ingestReadings(tags, [reading("BB:BB:BB:BB:BB:B1", -45, null)], 1000); // tag descadastrada
    expect(tags.get("BB:BB:BB:BB:BB:B1")?.rotulo).toBeNull();
    // A fusão (frame.ts) usa a leitura CORRENTE → assigned agora carrega o MAC. Com rotulo stale
    // ("João") a chave divergiria e o anel da tag já associada a pessoa sairia DUPLICADO.
    const v = deriveFloorView({
      now: 1000,
      tags,
      anchorPoints: [],
      H: H_ID,
      station: STATION,
      assigned: new Set(["BB:BB:BB:BB:BB:B1"]),
    });
    expect(v.rings).toHaveLength(0);
  });
});

describe("deriveFloorView — âncoras, estação e anéis com as supressões do contrato", () => {
  const freshTags = (now: number): Map<string, TagSignal> => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(
      tags,
      [
        reading("AA:00", -60), // âncora
        reading("BB:BB:BB:BB:BB:B1", -45, "João"), // tag livre COM nome (anel rotulado)
        reading("CC:CC:CC:CC:CC:C2", -45, "Maria"), // tag JÁ associada a pessoa (sem anel)
      ],
      now,
    );
    return tags;
  };

  it("âncora fresca = fresh:true no px EXATO; âncora sem leitura = fresh:false (atenção)", () => {
    const v = deriveFloorView({
      now: 1000,
      tags: freshTags(1000),
      anchorPoints: CORNERS,
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    expect(v.anchors).toHaveLength(3);
    // `label` sai PRÉ-computado na derivação (2 Hz) — o hot-path do desenho não refaz regex.
    // Só 1 âncora fresca aqui → fit cai no default (residualM null: comparar contra um chute
    // não diagnostica nada — ver descrição de FloorAnchor.residualM).
    expect(v.anchors[0]).toEqual({
      mac: "AA:00",
      px: { x: 0, y: 0 },
      fresh: true,
      label: "AA00",
      residualM: null,
    });
    expect(v.anchors[1].fresh).toBe(false); // AA:01 nunca foi ouvida
    expect(v.station).toEqual({ px: STATION });
  });

  it("leitura com 15+ s vira âncora fresh:false e a tag livre perde o anel (não inventa)", () => {
    const tags = freshTags(0);
    const v = deriveFloorView({
      now: 15_000, // exatamente o limiar — fresh exige < 15 s
      tags,
      anchorPoints: CORNERS,
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    expect(v.anchors[0].fresh).toBe(false);
    expect(v.rings).toHaveLength(0);
  });

  it("anel SÓ p/ tag livre: âncora e tag associada (chave rotulo||mac) ficam sem anel", () => {
    const v = deriveFloorView({
      now: 1000,
      tags: freshTags(1000),
      anchorPoints: CORNERS,
      H: H_ID,
      station: STATION,
      assigned: new Set(["Maria"]), // a MESMA chave que a fusão produz (rotulo||mac)
    });
    expect(v.rings).toHaveLength(1);
    const ring = v.rings[0];
    expect(ring.mac).toBe("BB:BB:BB:BB:BB:B1");
    expect(ring.label).toBe("João"); // rotulo vence o sufixo do MAC
    // Só 1 âncora fresca (fit exige 2+ pares) → modelo default DECLARADO: rssi0 −45, n 2.2.
    // EMA −45 ⇒ d = 10^((−45−(−45))/22) = 1 m — anel de raio 1 ao redor da estação-mundo.
    expect(ring.radiusM).toBeCloseTo(1, 10);
    expect(ring.pixels).toHaveLength(48); // H identidade projeta o círculo inteiro
    expect(ring.pixels[0].x).toBeCloseTo(STATION.x + 1, 10); // θ=0 → (cx+r, cy)
    expect(ring.pixels[0].y).toBeCloseTo(STATION.y, 10);
  });

  it("tag sem rotulo ganha rótulo = 4 últimos hex do MAC", () => {
    const tags = new Map<string, TagSignal>();
    ingestReadings(tags, [reading("DD:DD:DD:DD:DE:AD", -45)], 0);
    const v = deriveFloorView({
      now: 0,
      tags,
      anchorPoints: [],
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    expect(v.rings[0]?.label).toBe("DEAD");
  });

  it("raio SATURADO no teto do clamp (100 m) não vira anel — teto é 'fora de alcance', não medição", () => {
    const tags = new Map<string, TagSignal>();
    // RSSI fraquíssimo: modelo default (rssi0 −45, n 2.2) ⇒ d = 10^(75/22) ≈ 2560 m → clampa em 100.
    ingestReadings(tags, [reading("EE:EE:EE:EE:EE:E1", -120)], 0);
    const v = deriveFloorView({
      now: 0,
      tags,
      anchorPoints: [],
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    expect(v.rings).toHaveLength(0);
  });

  it("sem H/station não há anel nem estação — mas as âncoras (px exato) permanecem", () => {
    const v = deriveFloorView({
      now: 1000,
      tags: freshTags(1000),
      anchorPoints: CORNERS,
      H: null,
      station: null,
      assigned: new Set(),
    });
    expect(v.rings).toHaveLength(0);
    expect(v.station).toBeNull();
    expect(v.anchors).toHaveLength(3);
  });
});

describe("deriveFloorView — auto-diagnóstico por âncora (residualM, backlog científico A4)", () => {
  // 4 âncoras com span suficiente (dmax/dmin = 8 ≥ 2.5 → fit completo "anchors", não
  // "anchors-offset"/"default") — só com calibração própria o resíduo diagnostica algo
  // (ver floor-plot.ts fitPathLoss). RSSI sintético SEM ruído pelo modelo log-distância.
  const RSSI0 = -40;
  const N = 2.0;
  const rssiAt = (d: number): number => RSSI0 - 10 * N * Math.log10(d);
  const ANCHOR_DEFS = [
    { mac: "A1:00", d: 1 },
    { mac: "A1:01", d: 2 },
    { mac: "A1:02", d: 4 },
    { mac: "A1:03", d: 8 },
  ];
  const anchorPointsFor = (defs: typeof ANCHOR_DEFS) =>
    defs.map(({ mac, d }) => anchor(mac, STATION.x + d, STATION.y));

  it("todas as âncoras consistentes com o modelo → resíduo baixo em todas (fit exato, sem ruído)", () => {
    const tags = new Map<string, TagSignal>();
    for (const { mac, d } of ANCHOR_DEFS) ingestReadings(tags, [reading(mac, rssiAt(d))], 0);
    const v = deriveFloorView({
      now: 0,
      tags,
      anchorPoints: anchorPointsFor(ANCHOR_DEFS),
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    expect(v.anchors).toHaveLength(4);
    for (const a of v.anchors) {
      expect(a.residualM).not.toBeNull();
      expect(a.residualM!).toBeLessThan(0.1);
    }
  });

  it("1 âncora 'mentindo' (RSSI muito fora da curva das outras 3) → resíduo alto SÓ nela", () => {
    const tags = new Map<string, TagSignal>();
    for (const { mac, d } of ANCHOR_DEFS) {
      // A1:03 está de fato a 8 m mas reporta RSSI de perto (-30 dBm) — multipath/obstrução
      // simulado: "sensor mentindo" sobre a própria distância à estação.
      const rssi = mac === "A1:03" ? -30 : rssiAt(d);
      ingestReadings(tags, [reading(mac, rssi)], 0);
    }
    const v = deriveFloorView({
      now: 0,
      tags,
      anchorPoints: anchorPointsFor(ANCHOR_DEFS),
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    const liar = v.anchors.find((a) => a.mac === "A1:03")!;
    const others = v.anchors.filter((a) => a.mac !== "A1:03");
    expect(liar.residualM).not.toBeNull();
    expect(liar.residualM!).toBeGreaterThan(1.5); // limiar de anomalia (camera/draw.ts RESIDUAL_ANOMALY_M)
    for (const a of others) {
      expect(a.residualM).not.toBeNull();
      expect(a.residualM!).toBeLessThan(1.5);
      expect(a.residualM!).toBeLessThan(liar.residualM!);
    }
  });

  it("âncora sem leitura viva (não fresca) → residualM null mesmo com modelo calibrado pelas demais", () => {
    const tags = new Map<string, TagSignal>();
    for (const { mac, d } of ANCHOR_DEFS.slice(0, 3)) ingestReadings(tags, [reading(mac, rssiAt(d))], 0);
    // A1:03 nunca reportou — sem base honesta pra comparar previsão × realidade.
    const v = deriveFloorView({
      now: 0,
      tags,
      anchorPoints: anchorPointsFor(ANCHOR_DEFS),
      H: H_ID,
      station: STATION,
      assigned: new Set(),
    });
    const missing = v.anchors.find((a) => a.mac === "A1:03")!;
    expect(missing.fresh).toBe(false);
    expect(missing.residualM).toBeNull();
  });
});
