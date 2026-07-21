// Gate do bug de SUPERCONTAGEM do modo objetos (2026-07-21): a classe "caixa" tem 3 prompts
// OWL-ViT e cada prompt podia disparar na MESMA caixa física → 2-3 dets sobrepostas com a
// mesma key inflavam counts. finalizeOwlDets é o pós-processamento puro: label→key, piso de
// score do CHAMADOR e dedup por classe (NMS IoU+contenção).
import { describe, it, expect } from "vitest";
import { finalizeOwlDets } from "./detector";

const toKey = new Map([
  ["cardboard box", "caixa"],
  ["box", "caixa"],
  ["caixa de papelão", "caixa"],
  ["person", "pessoa"],
]);

const box = (xmin: number, ymin: number, xmax: number, ymax: number) => ({ xmin, ymin, xmax, ymax });

describe("finalizeOwlDets", () => {
  it("3 prompts disparando na MESMA caixa física viram 1 det (a de maior score)", () => {
    const dets = [
      { label: "cardboard box", score: 0.6, box: box(100, 100, 200, 200) },
      { label: "box", score: 0.5, box: box(102, 98, 198, 204) }, // IoU alto com a 1ª
      { label: "caixa de papelão", score: 0.4, box: box(110, 110, 195, 195) }, // contida na 1ª
    ];
    const out = finalizeOwlDets(dets, toKey, 640, 480, 0.2);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("caixa");
    expect(out[0].score).toBe(0.6); // guloso: mantém a mais forte
  });

  it("duas caixas físicas SEPARADAS permanecem duas", () => {
    const dets = [
      { label: "box", score: 0.6, box: box(0, 0, 100, 100) },
      { label: "cardboard box", score: 0.5, box: box(400, 300, 560, 420) },
    ];
    const out = finalizeOwlDets(dets, toKey, 640, 480, 0.2);
    expect(out).toHaveLength(2);
  });

  it("dedup é POR CLASSE: caixa e pessoa sobrepostas não se suprimem", () => {
    const dets = [
      { label: "box", score: 0.6, box: box(100, 100, 200, 200) },
      { label: "person", score: 0.5, box: box(100, 100, 200, 200) },
    ];
    const out = finalizeOwlDets(dets, toKey, 640, 480, 0.2);
    expect(out.map((d) => d.key).sort()).toEqual(["caixa", "pessoa"]);
  });

  it("piso de score do chamador é honrado (antes só o threshold do worker filtrava)", () => {
    const dets = [
      { label: "box", score: 0.15, box: box(0, 0, 100, 100) },
      { label: "box", score: 0.3, box: box(400, 300, 560, 420) },
    ];
    const out = finalizeOwlDets(dets, toKey, 640, 480, 0.2);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0.3);
  });

  it("labels fora do catálogo caem; bbox sai normalizada 0..1", () => {
    const dets = [{ label: "desconhecido", score: 0.9, box: box(0, 0, 10, 10) }];
    expect(finalizeOwlDets(dets, toKey, 640, 480, 0.1)).toHaveLength(0);
    const [d] = finalizeOwlDets(
      [{ label: "box", score: 0.9, box: box(64, 48, 128, 96) }],
      toKey,
      640,
      480,
      0.1,
    );
    expect(d.bbox[0]).toBeCloseTo(0.1);
    expect(d.bbox[1]).toBeCloseTo(0.1);
    expect(d.bbox[2]).toBeCloseTo(0.1);
    expect(d.bbox[3]).toBeCloseTo(0.1);
  });
});
