// Testes dos FINGERPRINTS de RSSI (fingerprints.js) — sem Postgres (fallback JSON). Foco: round-trip
// add→list, validação defensiva (label/vec rejeitados; entradas de vec inválidas descartadas), remove
// por id e o fato de NÃO deduplicar por label. Efeito colateral: add/remove escrevem
// server/bt/fingerprints.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fingerprints = require("./fingerprints");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fingerprints.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

const vec3 = () => ({
  "ant-a": { mean: -60, std: 3, n: 10 },
  "ant-b": { mean: -72.5, std: 4.1, n: 8 },
  "ant-c": { mean: -80, std: 6, n: 12 },
});

describe("fingerprints — lista vazia e persistence antes de qualquer add", () => {
  it("list() devolve [] e persistence() reporta 'json' sem Postgres configurado", () => {
    expect(fingerprints.list()).toEqual([]);
    expect(fingerprints.persistence()).toBe("json");
  });
});

describe("fingerprints — round-trip add → list (fallback JSON)", () => {
  it("2 fingerprints (labels diferentes, vec de 3 antenas) aparecem na lista com id do server", async () => {
    const a = await fingerprints.add({ label: "Doca 3", x: 3, y: 4, vec: vec3(), createdAt: 111 });
    const b = await fingerprints.add({ label: "Corredor A", vec: vec3(), createdAt: 222 });

    expect(a.id).toMatch(/^fp-/);
    expect(b.id).toMatch(/^fp-/);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ label: "Doca 3", x: 3, y: 4, createdAt: 111, vec: vec3() });
    expect(b).toMatchObject({ label: "Corredor A", createdAt: 222, vec: vec3() });
    expect(b.x).toBeUndefined(); // x/y ausentes → não aparecem

    const labels = fingerprints.list().map((f) => f.label);
    expect(labels).toContain("Doca 3");
    expect(labels).toContain("Corredor A");
  });

  it("RSSI negativo e coordenadas livres NÃO são clampados", async () => {
    const saved = await fingerprints.add({
      label: "Borda",
      x: -2,
      y: 99,
      vec: { "ant-x": { mean: -95, std: 0, n: 1 } },
    });
    expect(saved.x).toBe(-2);
    expect(saved.y).toBe(99);
    expect(saved.vec).toEqual({ "ant-x": { mean: -95, std: 0, n: 1 } });
  });
});

describe("fingerprints — validação defensiva", () => {
  it("label vazio/ausente é rejeitado (badRequest → 400)", async () => {
    for (const bad of ["", "   ", undefined, null]) {
      await expect(fingerprints.add({ label: bad, vec: vec3() })).rejects.toMatchObject({
        badRequest: true,
      });
    }
  });

  it("vec vazio (ou sem NENHUMA antena válida) é rejeitado com 'fingerprint sem antenas'", async () => {
    await expect(fingerprints.add({ label: "X", vec: {} })).rejects.toMatchObject({
      badRequest: true,
      message: "fingerprint sem antenas",
    });
    // todas as entradas inválidas → vec fica vazio → mesmo erro
    await expect(
      fingerprints.add({ label: "X", vec: { "ant-a": { mean: Number.NaN, std: 1, n: 1 } } }),
    ).rejects.toMatchObject({ badRequest: true, message: "fingerprint sem antenas" });
  });

  it("entrada de vec com mean não-finito é DESCARTADA; as boas ficam", async () => {
    const saved = await fingerprints.add({
      label: "Mista",
      vec: {
        boa: { mean: -55, std: 2, n: 5 },
        "mean-nan": { mean: Number.NaN, std: 2, n: 5 },
        "std-inf": { mean: -55, std: Infinity, n: 5 },
        "n-zero": { mean: -55, std: 2, n: 0 },
      },
    });
    expect(saved.vec).toEqual({ boa: { mean: -55, std: 2, n: 5 } });
  });

  it("stationId da antena fora do formato [a-zA-Z0-9_-]{1,32} é DESCARTADO", async () => {
    const saved = await fingerprints.add({
      label: "Formato",
      vec: {
        "ant-ok": { mean: -60, std: 3, n: 4 },
        "com espaço": { mean: -60, std: 3, n: 4 },
        "ponto.virgula": { mean: -60, std: 3, n: 4 },
        [`${"a".repeat(33)}`]: { mean: -60, std: 3, n: 4 },
      },
    });
    expect(saved.vec).toEqual({ "ant-ok": { mean: -60, std: 3, n: 4 } });
  });

  it("x/y inválidos são DESCARTADOS (campo some) sem rejeitar o item; createdAt inválido vira 0", async () => {
    const saved = await fingerprints.add({
      label: "SemCoord",
      x: Number.NaN,
      y: "longe",
      vec: vec3(),
      createdAt: "ontem",
    });
    expect(saved.x).toBeUndefined();
    expect(saved.y).toBeUndefined();
    expect(saved.createdAt).toBe(0);
  });
});

describe("fingerprints — NÃO deduplica por label", () => {
  it("dois add com o mesmo label → a lista contém 2 (o survey tem várias amostras do mesmo ponto)", async () => {
    const before = fingerprints.list().filter((f) => f.label === "Ponto Repetido").length;
    await fingerprints.add({ label: "Ponto Repetido", vec: vec3() });
    await fingerprints.add({ label: "Ponto Repetido", vec: vec3() });
    const after = fingerprints.list().filter((f) => f.label === "Ponto Repetido").length;
    expect(after - before).toBe(2);
  });
});

describe("fingerprints — remove por id", () => {
  it("remove existente → { ok:true } e some da lista; id inexistente → { ok:false }", async () => {
    const fp = await fingerprints.add({ label: "Remover", vec: vec3() });
    expect(await fingerprints.remove(fp.id)).toEqual({ ok: true });
    expect(fingerprints.list().some((f) => f.id === fp.id)).toBe(false);
    expect(await fingerprints.remove(fp.id)).toEqual({ ok: false }); // idempotente
    expect(await fingerprints.remove("fp-nao-existe")).toEqual({ ok: false });
  });
});

// GATE ANTI-"PERSISTÊNCIA FALSA": falha de escrita durável não pode deixar o fingerprint só em memória
// (some no restart). add faz ROLLBACK e lança 503 (a rota faz surface).
describe("fingerprints — persistência atômica (durável-primeiro, com rollback)", () => {
  it("add: escrita falha → NENHUM fingerprint-fantasma + erro 503", async () => {
    const antes = fingerprints.list().length;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const bad = await fingerprints.add({ label: "Fantasma", vec: vec3() }).catch((e) => e);
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(fingerprints.list().length).toBe(antes); // a memória não mente
  });
});
