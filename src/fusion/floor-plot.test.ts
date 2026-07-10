// Testes do módulo PURO de plotagem de tags no chão (src/fusion/floor-plot.ts).
// Determinístico: dados sintéticos sem ruído (o fit exato TEM que recuperar rssi0/n) e uma
// homografia REAL (computeHomography de 4 cantos) para validar o anel por round-trip.
import { describe, it, expect } from "vitest";
import { fitPathLoss, distFromRssi, ringPixels, type AnchorObs } from "./floor-plot";
import {
  computeHomography,
  invertMatrix3,
  pixelToWorld,
  type Correspondence,
  type Matrix3,
  type Vec2,
} from "../vision/homography";

const STATION: Vec2 = { x: 0, y: 0 };

/** RSSI sintético SEM ruído pelo modelo log-distância — o que o fit deve recuperar. */
const rssiAt = (rssi0: number, n: number, d: number): number => rssi0 - 10 * n * Math.log10(d);

/** Âncora a distância d da estação (no eixo x, com mundo real qualquer serviria igual). */
const anchorAt = (d: number, rssi: number, mac = `AA:${d}`): AnchorObs => ({
  mac,
  world: { x: STATION.x + d, y: STATION.y },
  rssi,
});

describe("fitPathLoss — recuperação exata com dados sintéticos", () => {
  it("4 âncoras sem ruído → recupera rssi0 e n exatos, source anchors", () => {
    const rssi0 = -40;
    const n = 2.0;
    const obs = [1, 2, 4, 8].map((d) => anchorAt(d, rssiAt(rssi0, n, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors");
    expect(model.samples).toBe(4);
    expect(model.rssi0).toBeCloseTo(rssi0, 8);
    expect(model.n).toBeCloseTo(n, 8);
  });

  it("âncora colada na estação (d ≤ 0.3 m) fica FORA do fit e não conta em samples", () => {
    const rssi0 = -42;
    const n = 2.5;
    const obs = [0.5, 2, 5, 9].map((d) => anchorAt(d, rssiAt(rssi0, n, d)));
    obs.push({ mac: "NEAR", world: { ...STATION }, rssi: -10 }); // d = 0 → excluída
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors");
    expect(model.samples).toBe(4);
    expect(model.rssi0).toBeCloseTo(rssi0, 8);
    expect(model.n).toBeCloseTo(n, 8);
  });
});

describe("fitPathLoss — fallback default", () => {
  it("0 âncoras → default declarado", () => {
    const model = fitPathLoss([], STATION);
    expect(model).toEqual({ rssi0: -45, n: 2.2, source: "default", samples: 0 });
  });

  it("1 âncora válida só → default (2+ é o mínimo para uma reta)", () => {
    const model = fitPathLoss([anchorAt(3, -60)], STATION);
    expect(model.source).toBe("default");
    expect(model.samples).toBe(1);
  });

  it("2 âncoras mas 1 dentro de 0.3 m → só 1 válida → default", () => {
    const model = fitPathLoss([anchorAt(0.2, -30), anchorAt(4, -62)], STATION);
    expect(model.source).toBe("default");
    expect(model.samples).toBe(1);
  });

  it("coordenadas/rssi inválidos (NaN/Infinity) são descartados sem contaminar o fit", () => {
    const rssi0 = -40;
    const n = 2.0;
    const obs = [1, 2, 4].map((d) => anchorAt(d, rssiAt(rssi0, n, d)));
    obs.push({ mac: "BAD1", world: { x: NaN, y: 0 }, rssi: -50 });
    obs.push({ mac: "BAD2", world: { x: 5, y: 0 }, rssi: Infinity });
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors");
    expect(model.samples).toBe(3);
    expect(model.rssi0).toBeCloseTo(rssi0, 8);
    expect(model.n).toBeCloseTo(n, 8);
  });
});

describe("fitPathLoss — gate de identificabilidade (span de log10(d) < 0.4 década)", () => {
  it("geometria REAL do campo (âncoras a 1.2–1.6 m, span ≈ 0.12) → anchors-offset: n fixo 2.2, rssi0 recuperado", () => {
    // Cenário que motivou o gate: no campo as âncoras ficam quase equidistantes da estação
    // (razão dmax/dmin ≈ 1.33 < 2.5). O fit completo "passaria" no teste de Sxx≈0 com n =
    // ruído puro; o regime honesto fixa n e calibra SÓ o offset do ambiente.
    const rssi0 = -48;
    const obs = [1.2, 1.3, 1.5, 1.6].map((d) => anchorAt(d, rssiAt(rssi0, 2.2, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors-offset");
    expect(model.samples).toBe(4);
    expect(model.n).toBe(2.2); // default fixado — NÃO estimado desses dados
    // Dados gerados com o MESMO n do default → o offset recupera o rssi0 exato.
    expect(model.rssi0).toBeCloseTo(rssi0, 8);
  });

  it("âncoras todas à MESMA distância → span zero → anchors-offset (n fixo, rssi0 medido)", () => {
    // INTENÇÃO ATUALIZADA: antes este caso caía em "default" via teste numérico de Sxx≈0.
    // O gate por span o subsume — mesmo sem espalhamento, o RSSI na distância única É medição
    // do offset do ambiente: melhor que o default cru, e declarado como regime distinto.
    const obs: AnchorObs[] = [
      { mac: "A", world: { x: 1, y: 0 }, rssi: -50 },
      { mac: "B", world: { x: -1, y: 0 }, rssi: -55 },
      { mac: "C", world: { x: 0, y: 1 }, rssi: -52 },
    ];
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors-offset");
    expect(model.samples).toBe(3);
    expect(model.n).toBe(2.2);
    // d = 1 → log10(d) = 0 → rssi0 = média simples dos RSSI.
    expect(model.rssi0).toBeCloseTo((-50 - 55 - 52) / 3, 8);
  });

  it("clamp de plausibilidade vale também no regime offset (ambiente quente → rssi0 = -20)", () => {
    const obs = [1.2, 1.4, 1.6].map((d) => anchorAt(d, rssiAt(-10, 2.2, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors-offset");
    expect(model.rssi0).toBe(-20);
  });

  it("span ≥ 0.4 década (1 m e 3 m, razão 3 > 2.5) → fit completo como antes", () => {
    const rssi0 = -44;
    const n = 2.8;
    const obs = [1, 3].map((d) => anchorAt(d, rssiAt(rssi0, n, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors");
    expect(model.rssi0).toBeCloseTo(rssi0, 8);
    expect(model.n).toBeCloseTo(n, 8);
  });
});

describe("fitPathLoss — clamps de plausibilidade", () => {
  it("n absurdo alto (dados com n=6) → clampado a 4.5, ainda source anchors", () => {
    const obs = [1, 2, 4, 8].map((d) => anchorAt(d, rssiAt(-40, 6.0, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.source).toBe("anchors");
    expect(model.n).toBe(4.5);
  });

  it("n absurdo baixo (dados quase planos, n=0.5) → clampado a 1.2", () => {
    const obs = [1, 2, 4, 8].map((d) => anchorAt(d, rssiAt(-40, 0.5, d)));
    const model = fitPathLoss(obs, STATION);
    expect(model.n).toBe(1.2);
  });

  it("rssi0 fora da faixa → clampado a [-70, -20]", () => {
    const quente = fitPathLoss(
      [1, 2, 4].map((d) => anchorAt(d, rssiAt(-10, 2.0, d))),
      STATION,
    );
    expect(quente.rssi0).toBe(-20);
    const frio = fitPathLoss(
      [1, 2, 4].map((d) => anchorAt(d, rssiAt(-90, 2.0, d))),
      STATION,
    );
    expect(frio.rssi0).toBe(-70);
  });
});

describe("distFromRssi — inversão e clamps", () => {
  it("round-trip: inverte exatamente o modelo ajustado por fitPathLoss", () => {
    const rssi0 = -42;
    const n = 2.5;
    const model = fitPathLoss(
      [0.5, 2, 5, 9].map((d) => anchorAt(d, rssiAt(rssi0, n, d))),
      STATION,
    );
    for (const d of [0.5, 1, 3.7, 9, 25]) {
      expect(distFromRssi(model, rssiAt(rssi0, n, d))).toBeCloseTo(d, 6);
    }
  });

  it("clamps: sinal fortíssimo → piso 0.1 m; sinal fraquíssimo → teto 100 m", () => {
    const model = fitPathLoss([], STATION); // default {rssi0:-45, n:2.2}
    expect(distFromRssi(model, 0)).toBe(0.1);
    expect(distFromRssi(model, -200)).toBe(100);
  });

  it("nunca NaN: modelo/rssi corrompidos ainda devolvem número finito em [0.1, 100]", () => {
    const junk = { rssi0: NaN, n: NaN, source: "default" as const, samples: 0 };
    for (const rssi of [NaN, Infinity, -Infinity, -60]) {
      const d = distFromRssi(junk, rssi);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0.1);
      expect(d).toBeLessThanOrEqual(100);
    }
  });
});

describe("ringPixels — anel projetado com homografia REAL", () => {
  // Calibração tipo câmera real: 4 cantos px (trapezoide de perspectiva) → chão 10 × 8 m.
  const PAIRS: Correspondence[] = [
    { px: { x: 0.1, y: 0.9 }, world: { x: 0, y: 0 } },
    { px: { x: 0.9, y: 0.9 }, world: { x: 10, y: 0 } },
    { px: { x: 0.65, y: 0.4 }, world: { x: 10, y: 8 } },
    { px: { x: 0.35, y: 0.4 }, world: { x: 0, y: 8 } },
  ];
  const res = computeHomography(PAIRS);
  if (!res.ok) throw new Error(`fixture inválida: ${res.error}`);
  const H = res.H;
  const station: Vec2 = { x: 5, y: 4 }; // centro da área calibrada

  it("raio 1 m → todos os pontos re-projetados (pixelToWorld) ficam a ~1 m da estação", () => {
    const ring = ringPixels(H, station, 1);
    expect(ring.length).toBe(48); // default de segments; nada cai no horizonte aqui
    for (const px of ring) {
      expect(Number.isFinite(px.x)).toBe(true);
      expect(Number.isFinite(px.y)).toBe(true);
      const w = pixelToWorld(H, px);
      expect(w).not.toBeNull();
      if (w) expect(Math.hypot(w.x - station.x, w.y - station.y)).toBeCloseTo(1, 6);
    }
  });

  it("raio 100 m cruza o horizonte → ZERO pontos espelhados: só entra quem tem w do mesmo sinal da estação", () => {
    // Bug original (cheirality): applyMatrix3 só devolve null com |w| < 1e-12; ponto com w
    // NEGATIVO (além do horizonte) projeta um pixel FINITO espelhado — 13/48 caíam DENTRO do
    // quadro como traço fantasma. O anel deve conter EXATAMENTE as projeções dos pontos do
    // lado da estação (mesmo sinal do w homogêneo) — nem um a mais, nem um a menos.
    const inv = invertMatrix3(H);
    expect(inv).not.toBeNull();
    if (!inv) return;
    const wOf = (p: Vec2): number => inv[6] * p.x + inv[7] * p.y + inv[8];
    const wStation = wOf(station);
    const radius = 100;
    // Recria os MESMOS 48 pontos-mundo do contrato (ângulos determinísticos).
    const worldPts: Vec2[] = [];
    for (let i = 0; i < 48; i++) {
      const th = (2 * Math.PI * i) / 48;
      worldPts.push({ x: station.x + radius * Math.cos(th), y: station.y + radius * Math.sin(th) });
    }
    const sameSide = worldPts.filter((p) => Math.abs(wOf(p)) > 1e-12 && wOf(p) * wStation > 0);
    // A fixture DE FATO cruza o horizonte — senão este teste não provaria nada.
    expect(sameSide.length).toBeGreaterThan(0);
    expect(sameSide.length).toBeLessThan(48);

    const ring = ringPixels(H, station, radius);
    expect(ring.length).toBe(sameSide.length); // descartou exatamente os do lado errado
    for (const px of ring) {
      // Round-trip: cada pixel devolvido reprojeta num ponto do lado CERTO, a ~100 m da estação.
      const w = pixelToWorld(H, px);
      expect(w).not.toBeNull();
      if (!w) continue;
      expect(wOf(w) * wStation).toBeGreaterThan(0); // sinal de w validado — sem espelhados
      expect(Math.hypot(w.x - station.x, w.y - station.y)).toBeCloseTo(radius, 3);
    }
    // E o anel pequeno (1 m, todo do lado certo) segue ÍNTEGRO — o filtro não corta ninguém.
    expect(ringPixels(H, station, 1).length).toBe(48);
  });

  it("segments custom → devolve exatamente essa quantidade (quando tudo projeta)", () => {
    expect(ringPixels(H, station, 2, 12).length).toBe(12);
  });

  it("determinístico: duas chamadas idênticas → mesmo resultado", () => {
    expect(ringPixels(H, station, 1.5)).toEqual(ringPixels(H, station, 1.5));
  });

  it("entradas inválidas → anel vazio, nunca NaN", () => {
    expect(ringPixels(H, station, NaN)).toEqual([]);
    expect(ringPixels(H, station, 0)).toEqual([]);
    expect(ringPixels(H, station, -1)).toEqual([]);
    expect(ringPixels(H, { x: NaN, y: 4 }, 1)).toEqual([]);
    // H singular → worldToPixel devolve null para todo ponto → anel vazio (sem NaN mudo).
    const singular: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(ringPixels(singular, station, 1)).toEqual([]);
  });
});
