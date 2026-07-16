// Testes da PLANTA BAIXA (floorplan.js) — sem Postgres (fallback JSON). Foco: round-trip save→get,
// validação defensiva (dimensões rejeitadas; estações inválidas descartadas) e persistence().
// Efeito colateral: save escreve server/bt/floorplan.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const floorplan = require("./floorplan");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "floorplan.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

describe("floorplan — default vazio antes de qualquer save", () => {
  it("get() devolve o vazio com estações e áreas vazias (o front aplica defaults)", () => {
    expect(floorplan.get()).toEqual({ widthM: 0, heightM: 0, stations: {}, workAreas: [] });
  });

  it("persistence() reporta 'json' sem Postgres configurado", () => {
    expect(floorplan.persistence()).toBe("json");
  });
});

describe("floorplan — round-trip save → get (fallback JSON)", () => {
  it("dimensões + 2 estações → get devolve idêntico", async () => {
    const fp = {
      widthM: 40,
      heightM: 25.5,
      stations: { "tc22-a1b2": { x: 3, y: 4 }, "tc22-c3d4": { x: 38.2, y: 20 } },
      workAreas: [],
    };
    const saved = await floorplan.save(fp);
    expect(saved).toEqual(fp);
    expect(floorplan.get()).toEqual(fp);
  });

  it("posições em metros são NÚMEROS LIVRES: negativas / fora do retângulo NÃO são clampadas", async () => {
    const fp = {
      widthM: 10,
      heightM: 10,
      stations: { "est-borda": { x: -2, y: 0 }, "est-fora": { x: 50, y: 99 } },
    };
    const saved = await floorplan.save(fp);
    expect(saved.stations).toEqual({ "est-borda": { x: -2, y: 0 }, "est-fora": { x: 50, y: 99 } });
  });
});

describe("floorplan — validação defensiva", () => {
  it("widthM <= 0 ou NaN é rejeitado (badRequest → 400)", async () => {
    for (const bad of [0, -5, Number.NaN, Infinity, "trinta", undefined]) {
      await expect(
        floorplan.save({ widthM: bad, heightM: 10, stations: {} }),
      ).rejects.toMatchObject({ badRequest: true });
    }
  });

  it("heightM <= 0 ou NaN é rejeitado (badRequest → 400)", async () => {
    for (const bad of [0, -1, Number.NaN, null]) {
      await expect(
        floorplan.save({ widthM: 10, heightM: bad, stations: {} }),
      ).rejects.toMatchObject({ badRequest: true });
    }
  });

  it("dimensões válidas não são mutadas pelo estado anterior quando o save é rejeitado", async () => {
    await floorplan.save({ widthM: 12, heightM: 8, stations: { ok: { x: 1, y: 1 } } });
    await expect(floorplan.save({ widthM: 0, heightM: 8, stations: {} })).rejects.toBeTruthy();
    // rollback/anterior intacto: o save inválido lança ANTES de mutar
    expect(floorplan.get()).toEqual({
      widthM: 12,
      heightM: 8,
      stations: { ok: { x: 1, y: 1 } },
      workAreas: [],
    });
  });

  it("estação com x/y não-finito é DESCARTADA (silenciosamente); as boas ficam", async () => {
    const saved = await floorplan.save({
      widthM: 20,
      heightM: 20,
      stations: {
        boa: { x: 5, y: 6 },
        "x-nan": { x: Number.NaN, y: 6 },
        "y-inf": { x: 5, y: Infinity },
        "sem-y": { x: 5 },
      },
    });
    expect(saved.stations).toEqual({ boa: { x: 5, y: 6 } });
  });

  it("stationId fora do formato [a-zA-Z0-9_-]{1,32} é DESCARTADO", async () => {
    const saved = await floorplan.save({
      widthM: 20,
      heightM: 20,
      stations: {
        "tc22-ok": { x: 1, y: 2 },
        "com espaço": { x: 1, y: 2 },
        "ponto.virgula": { x: 1, y: 2 },
        "": { x: 1, y: 2 },
        [`${"a".repeat(33)}`]: { x: 1, y: 2 },
      },
    });
    expect(saved.stations).toEqual({ "tc22-ok": { x: 1, y: 2 } });
  });
});

describe("floorplan — áreas de trabalho independentes", () => {
  it("preserva uma área retangular válida sem encaixar tags nela", async () => {
    const saved = await floorplan.save({
      widthM: 5,
      heightM: 3,
      stations: {},
      workAreas: [
        {
          id: "mesa-serigrafia",
          label: "Mesa serigrafia",
          center: { x: 1.5, y: 2.5 },
          widthM: 1.2,
          heightM: 0.8,
        },
      ],
    });
    expect(saved.workAreas).toEqual([
      {
        id: "mesa-serigrafia",
        label: "Mesa serigrafia",
        polygon: [
          { x: 0.9, y: 2.1 },
          { x: 2.1, y: 2.1 },
          { x: 2.1, y: 2.9 },
          { x: 0.9, y: 2.9 },
        ],
        center: { x: 1.5, y: 2.5 },
        widthM: 1.2,
        heightM: 0.8,
      },
    ]);
  });

  it("recusa o save inteiro quando uma área é inválida, duplicada ou está fora", async () => {
    const invalid = floorplan.save({
      widthM: 5,
      heightM: 3,
      stations: {},
      workAreas: [
        { id: "mesa", label: "Mesa", center: { x: 1, y: 1 }, widthM: 1, heightM: 1 },
        { id: "mesa", label: "Duplicada", center: { x: 2, y: 2 }, widthM: 1, heightM: 1 },
        { id: "ruim", label: "Ruim", center: { x: 1, y: 1 }, widthM: 0, heightM: 1 },
        { id: "fora", label: "Fora", center: { x: 4.8, y: 2 }, widthM: 1, heightM: 1 },
      ],
    });
    await expect(invalid).rejects.toMatchObject({ badRequest: true });
  });

  it("preserva polígonos métricos e deriva a bbox sem reduzi-los a retângulos", async () => {
    const polygon = [
      { x: 1, y: 1 },
      { x: 4, y: 1 },
      { x: 3, y: 2.5 },
      { x: 1, y: 2 },
    ];
    const saved = await floorplan.save({
      widthM: 5,
      heightM: 3,
      stations: {},
      workAreas: [{ id: "mesa-poligonal", label: "Mesa poligonal", polygon }],
    });
    expect(saved.workAreas[0]).toMatchObject({
      id: "mesa-poligonal",
      label: "Mesa poligonal",
      polygon,
      center: { x: 2.5, y: 1.75 },
      widthM: 3,
      heightM: 1.5,
    });
  });
});

// GATE ANTI-"PERSISTÊNCIA FALSA": falha de escrita durável não pode deixar a planta só em memória
// (some no restart). O save faz ROLLBACK e lança 503 (a rota faz surface).
describe("floorplan — persistência atômica (durável-primeiro, com rollback)", () => {
  it("escrita falha → ROLLBACK (a planta anterior permanece) + status 503", async () => {
    await floorplan.save({ widthM: 30, heightM: 30, stations: { a: { x: 1, y: 1 } } });
    const antes = floorplan.get();
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const bad = await floorplan.save({ widthM: 99, heightM: 99, stations: {} }).catch((e) => e);
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(floorplan.get()).toEqual(antes); // a memória não mente
  });
});
