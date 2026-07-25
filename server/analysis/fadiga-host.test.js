// Gates dos PUROS do fadiga-host (Onda 4 da spec-overlay-tempo-real): a emissão do
// "analysis-fatigue" segue o padrão do analysis-tracks — room "dashboards" + payload
// só nasce com espectador. Este arquivo trava DUAS coisas:
//   1. o gate de espectador (hasDashboardViewers) é defensivo — io capenga → false, nunca throw;
//   2. o SHAPE do payload é contrato socket ADITIVO — chave a mais/menos aqui é quebra
//      de contrato entre camadas (a regressão silenciosa nº 1, CLAUDE.md §2.4).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hasDashboardViewers, buildFatiguePayload } = require("./fadiga-host");

// io fake mínimo: só o caminho sockets.adapter.rooms que o gate lê (mesmo do engine.js:116)
function ioWithRoom(size) {
  const rooms = new Map();
  if (size !== undefined) rooms.set("dashboards", { size });
  return { sockets: { adapter: { rooms } } };
}

describe("hasDashboardViewers", () => {
  it("room 'dashboards' com ≥1 socket → true", () => {
    expect(hasDashboardViewers(ioWithRoom(1))).toBe(true);
    expect(hasDashboardViewers(ioWithRoom(3))).toBe(true);
  });

  it("room vazia (size 0) ou ausente → false", () => {
    expect(hasDashboardViewers(ioWithRoom(0))).toBe(false);
    expect(hasDashboardViewers(ioWithRoom(undefined))).toBe(false); // room nunca criada
  });

  it("defensivo: io sem adapter/sockets, ou io ausente → false, sem throw", () => {
    expect(hasDashboardViewers({ sockets: {} })).toBe(false);
    expect(hasDashboardViewers({})).toBe(false);
    expect(hasDashboardViewers(null)).toBe(false);
    expect(hasDashboardViewers(undefined)).toBe(false);
  });
});

// snapshot() como o FadigaRisk devolve (fadiga-risk.js:184) — fixture, não a classe:
// o payload só PROJETA esses campos, não os calcula.
const SNAP = { risk: "amarelo", ear: 0.21, mar: 0.4, counters: { microsleeps: 1, yawns: 2 } };

describe("buildFatiguePayload", () => {
  it("face ok: mask com os pares [x,y] dos índices do maskIdx; latencyMs = now - ts", () => {
    // pts sintético: pts[i*2] = i, pts[i*2+1] = i + 0.5 → verificável ponto a ponto
    const pts = new Float32Array(20);
    for (let i = 0; i < 10; i++) {
      pts[i * 2] = i;
      pts[i * 2 + 1] = i + 0.5;
    }
    const face = { ok: true, score: 0.9, box: [0.1, 0.2, 0.3, 0.4], pts };
    const p = buildFatiguePayload({ cameraId: "cam1", ts: 1000, now: 1250, face, snap: SNAP, maskIdx: [1, 3, 7] });

    expect(p.cameraId).toBe("cam1");
    expect(p.ts).toBe(1000);
    expect(p.latencyMs).toBe(250);
    expect(p.fatigue.ok).toBe(true);
    expect(p.fatigue.score).toBe(0.9);
    expect(p.fatigue.box).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(p.fatigue.mask).toEqual([
      [1, 1.5],
      [3, 3.5],
      [7, 7.5],
    ]);
    expect(p.fatigue.risk).toBe("amarelo");
    expect(p.fatigue.ear).toBe(0.21);
    expect(p.fatigue.mar).toBe(0.4);
    expect(p.fatigue.counters).toEqual({ microsleeps: 1, yawns: 2 });
  });

  it("latencyMs nunca negativo (clock skew nó→hub → clampa em 0, como o pipeline)", () => {
    const p = buildFatiguePayload({ cameraId: "c", ts: 2000, now: 1900, face: { ok: false }, snap: SNAP, maskIdx: [] });
    expect(p.latencyMs).toBe(0);
  });

  it("face.ok=false → mask null, box null, score 0", () => {
    const p = buildFatiguePayload({ cameraId: "c", ts: 1, now: 2, face: { ok: false }, snap: SNAP, maskIdx: [1] });
    expect(p.fatigue.ok).toBe(false);
    expect(p.fatigue.mask).toBeNull();
    expect(p.fatigue.box).toBeNull();
    expect(p.fatigue.score).toBe(0);
  });

  it("CONTRATO: chaves EXATAS do payload e do fatigue (aditivo — mudança aqui é quebra)", () => {
    const p = buildFatiguePayload({ cameraId: "c", ts: 1, now: 2, face: { ok: false }, snap: SNAP, maskIdx: [] });
    expect(Object.keys(p).sort()).toEqual(["cameraId", "fatigue", "latencyMs", "ts"]);
    expect(Object.keys(p.fatigue).sort()).toEqual(["box", "counters", "ear", "mar", "mask", "ok", "risk", "score"]);
  });
});
