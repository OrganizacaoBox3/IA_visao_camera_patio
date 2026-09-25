// Testes do automask-store.js — persistência das decisões do operador ("Está correto" / "É
// falso positivo") sobre uma célula da auto-máscara. Superfície de ataque: `cameraId` e `cell`
// vêm de fora (rota HTTP) — precisam ser validados ANTES de tocar o disco, mesmo padrão de
// camera-bg.js. Diretório de estado isolado (mkdtemp) — nunca toca o server/ real.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "automask-store-"));
process.env.VISAO_STATE_DIR = DIR;
const require = createRequire(import.meta.url);
const store = require("./automask-store");

const CAM = "cam-teste";
beforeEach(() => {
  try {
    fs.unlinkSync(store.FILE);
  } catch {
    /* ainda não existe */
  }
});
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("decisionsFor — sem arquivo/câmera é `{}`, nunca lança", () => {
  it("arquivo ainda não existe", () => {
    expect(store.decisionsFor(CAM)).toEqual({});
  });
  it("câmera sem decisão gravada", () => {
    store.setDecision(CAM, 5, "correto");
    expect(store.decisionsFor("outra-cam")).toEqual({});
  });
  it("cameraId ausente/vazio não lança", () => {
    expect(store.decisionsFor(undefined)).toEqual({});
    expect(store.decisionsFor("")).toEqual({});
  });
});

describe("setDecision — grava e sobrevive a uma segunda leitura (round-trip)", () => {
  it("persiste 'correto' e 'falsoPositivo' independentemente por célula", () => {
    expect(store.setDecision(CAM, 10, "correto")).toEqual({ ok: true });
    expect(store.setDecision(CAM, 20, "falsoPositivo")).toEqual({ ok: true });
    const d = store.decisionsFor(CAM);
    expect(d["10"].decision).toBe("correto");
    expect(d["20"].decision).toBe("falsoPositivo");
    expect(typeof d["10"].em).toBe("number");
  });

  it("gravar de novo na MESMA célula substitui a decisão anterior", () => {
    store.setDecision(CAM, 7, "correto");
    store.setDecision(CAM, 7, "falsoPositivo");
    expect(store.decisionsFor(CAM)["7"].decision).toBe("falsoPositivo");
  });

  it("duas câmeras não se atropelam", () => {
    store.setDecision("cam-a", 1, "correto");
    store.setDecision("cam-b", 1, "falsoPositivo");
    expect(store.decisionsFor("cam-a")["1"].decision).toBe("correto");
    expect(store.decisionsFor("cam-b")["1"].decision).toBe("falsoPositivo");
  });
});

describe("setDecision — validação ANTES de tocar o disco", () => {
  it("célula não-inteira/negativa é recusada", () => {
    for (const ruim of [-1, 1.5, NaN, "abc", null, undefined]) {
      expect(store.setDecision(CAM, ruim, "correto").error).toMatch(/célula inválida/);
    }
    expect(store.decisionsFor(CAM)).toEqual({});
  });

  it("decisão fora do enum é recusada", () => {
    for (const ruim of ["talvez", "", null, undefined, "CORRETO"]) {
      expect(store.setDecision(CAM, 1, ruim).error).toMatch(/decisão inválida/);
    }
    expect(store.decisionsFor(CAM)).toEqual({});
  });

  it("cameraId ausente/não-string é recusado", () => {
    expect(store.setDecision("", 1, "correto").error).toMatch(/câmera inválida/);
    expect(store.setDecision(undefined, 1, "correto").error).toMatch(/câmera inválida/);
  });
});

describe("clearDecision — desfaz sem lançar mesmo sem nada gravado", () => {
  it("remove só a célula pedida, preserva as outras", () => {
    store.setDecision(CAM, 1, "correto");
    store.setDecision(CAM, 2, "falsoPositivo");
    store.clearDecision(CAM, 1);
    const d = store.decisionsFor(CAM);
    expect(d["1"]).toBeUndefined();
    expect(d["2"].decision).toBe("falsoPositivo");
  });

  it("câmera/célula inexistente não lança", () => {
    expect(() => store.clearDecision("cam-fantasma", 99)).not.toThrow();
  });
});
