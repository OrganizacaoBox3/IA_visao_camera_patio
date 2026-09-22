// TIER DE MODELO POR CÂMERA — `tier` na allowlist do camcfg.
//
// POR QUE ESTE ARQUIVO EXISTE: o próprio camcfg.js documenta a armadilha A5 — campo novo que
// não entra na allowlist é descartado MUDO no save. O operador escolhe "tier N" na tela, a UI
// diz "salvo", e a câmera continua no tier pesado para sempre. Falha silenciosa que só aparece
// na fatura, meses depois.
//
// O segundo bloco é o que impede o oposto: valor corrompido no arquivo (edição manual, hub
// antigo, config de outra versão) não pode cegar a câmera nem derrubar o boot.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "camcfg-custo-"));
process.env.VISAO_STATE_DIR = DIR;
const require = createRequire(import.meta.url);
const camcfg = require("./camcfg");

const CAM = "cam-teste";
beforeEach(() => camcfg.saveCamConfig(CAM, { modo: "atividade" }));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("tier por câmera — sobrevive ao save (armadilha A5)", () => {
  it("cada tier do catálogo persiste", () => {
    for (const t of ["n", "s", "m", "auto"]) {
      camcfg.saveCamConfig(CAM, { modo: "atividade", tier: t });
      expect(camcfg.getCamConfig(CAM).tier).toBe(t);
    }
  });

  it("default é 'auto' — não fixar nada é o comportamento de sempre", () => {
    camcfg.saveCamConfig(CAM, { modo: "atividade" });
    expect(camcfg.getCamConfig(CAM).tier).toBe("auto");
  });

  it("tier fora do enum cai em 'auto', não derruba nem cega a câmera", () => {
    for (const ruim of ["xl", "", null, 7, "N; DROP TABLE", undefined]) {
      camcfg.saveCamConfig(CAM, { modo: "atividade", tier: ruim });
      expect(camcfg.getCamConfig(CAM).tier).toBe("auto");
    }
  });
});

describe("o campo não se atropela nem apaga o resto da config", () => {
  it("salvar tier preserva modo, longRange e transport", () => {
    camcfg.saveCamConfig(CAM, {
      modo: "fadiga",
      longRange: true,
      transport: "mjpeg",
      tier: "n",
    });
    const c = camcfg.getCamConfig(CAM);
    expect(c).toMatchObject({
      modo: "fadiga",
      longRange: true,
      transport: "mjpeg",
      tier: "n",
    });
  });
});
