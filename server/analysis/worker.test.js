// Unit do pós-processamento PURO do worker (postprocess/NMS/contenção/fusão/tiling)
// — até aqui só o gêmeo do front (src/vision/nms.test.ts) e o eval (lento, manual)
// cobriam este caminho no hub. Requer worker.js SEM boot (guard require.main): nada
// de ORT/sharp/IPC no processo do teste. Thresholds = defaults do painel
// (precision.js): scoreMin 0.25, nmsIou 0.6, containment 0.7.
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão da pasta).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { iouXYWH, nmsPerClass, postprocess, containment, fuseTiles, tileGrid } = require("./worker");

// inverso do sigmoid: score desejado → logit do fixture.
const logit = (p) => Math.log(p / (1 - p));

/** Fixture de saída do modelo: queries [{cls, score, cxcywh:[cx,cy,w,h]}] →
 *  { logits:{dims,data}, pred_boxes:{dims,data} } no shape [1,nq,80]/[1,nq,4]. */
function makeOutputs(queries) {
  const nq = queries.length;
  const nc = 80;
  const L = new Float32Array(nq * nc).fill(-10); // sigmoid(-10) ≈ 0 p/ as demais classes
  const B = new Float32Array(nq * 4);
  queries.forEach((q, i) => {
    L[i * nc + q.cls] = logit(q.score);
    B.set(q.cxcywh, i * 4);
  });
  return {
    logits: { dims: [1, nq, nc], data: L },
    pred_boxes: { dims: [1, nq, 4], data: B },
  };
}

describe("iouXYWH", () => {
  it("caixas idênticas → 1; disjuntas → 0", () => {
    expect(iouXYWH([0.1, 0.1, 0.2, 0.2], [0.1, 0.1, 0.2, 0.2])).toBeCloseTo(1, 9);
    expect(iouXYWH([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
  });
  it("metade deslocada → IoU 1/3 (inter 0.5A / união 1.5A)", () => {
    expect(iouXYWH([0, 0, 0.2, 0.2], [0.1, 0, 0.2, 0.2])).toBeCloseTo(1 / 3, 6);
  });
});

describe("postprocess — logits+pred_boxes → dets normalizadas", () => {
  it("converte cxcywh → [x,y,w,h] e mapeia a classe COCO", () => {
    const dets = postprocess(makeOutputs([{ cls: 0, score: 0.9, cxcywh: [0.5, 0.5, 0.2, 0.4] }]));
    expect(dets).toHaveLength(1);
    expect(dets[0].class).toBe("person");
    expect(dets[0].score).toBeCloseTo(0.9, 5);
    expect(dets[0].bbox[0]).toBeCloseTo(0.4, 6); // cx - w/2
    expect(dets[0].bbox[1]).toBeCloseTo(0.3, 6); // cy - h/2
    expect(dets[0].bbox[2]).toBeCloseTo(0.2, 6);
    expect(dets[0].bbox[3]).toBeCloseTo(0.4, 6);
  });

  it("corta abaixo do piso (scoreMin 0.25): 0.2 sai, 0.26 fica", () => {
    const dets = postprocess(
      makeOutputs([
        { cls: 0, score: 0.2, cxcywh: [0.2, 0.2, 0.1, 0.1] },
        { cls: 0, score: 0.26, cxcywh: [0.7, 0.7, 0.1, 0.1] },
      ]),
    );
    expect(dets).toHaveLength(1);
    expect(dets[0].score).toBeCloseTo(0.26, 5);
  });

  it("argmax por query: vence a classe de maior logit", () => {
    const out = makeOutputs([{ cls: 2, score: 0.8, cxcywh: [0.5, 0.5, 0.3, 0.3] }]); // 2 = car
    expect(postprocess(out)[0].class).toBe("car");
  });

  it("queries DUPLICADAS no mesmo alvo (comportamento real do D-FINE) → NMS deixa 1, o de maior score", () => {
    const dets = postprocess(
      makeOutputs([
        { cls: 0, score: 0.6, cxcywh: [0.5, 0.5, 0.2, 0.4] },
        { cls: 0, score: 0.45, cxcywh: [0.505, 0.5, 0.2, 0.4] }, // quase idêntica (IoU ≫ 0.6)
      ]),
    );
    expect(dets).toHaveLength(1);
    expect(dets[0].score).toBeCloseTo(0.6, 5);
  });
});

describe("nmsPerClass — supressão POR classe", () => {
  const d = (cls, score, bbox) => ({ class: cls, score, bbox });

  it("mesma classe, IoU acima do limiar → mantém só a de maior score", () => {
    const kept = nmsPerClass([d("person", 0.9, [0.1, 0.1, 0.2, 0.4]), d("person", 0.5, [0.11, 0.1, 0.2, 0.4])]);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.9);
  });

  it("pessoas LADO A LADO (IoU baixo) sobrevivem — o NMS não mata recall de pares", () => {
    const kept = nmsPerClass([d("person", 0.9, [0.1, 0.1, 0.1, 0.4]), d("person", 0.8, [0.25, 0.1, 0.1, 0.4])]);
    expect(kept).toHaveLength(2);
  });

  it("classes DIFERENTES não se suprimem mesmo sobrepostas", () => {
    const kept = nmsPerClass([d("person", 0.9, [0.1, 0.1, 0.2, 0.4]), d("chair", 0.8, [0.1, 0.1, 0.2, 0.4])]);
    expect(kept).toHaveLength(2);
  });

  // DECISÃO MEDIDA (2026-07-25, gate): a caixa PARCIAL contida SOBREVIVE ao NMS do squash.
  // Deduplicá-la aqui (contenção 0.7, como no fuseTiles) derrubou recall_all@0.25 em 4,4pp —
  // em cena densa a pessoa parcialmente contida é gente REAL. O "2 tracks na mesma pessoa"
  // é tratado na guarda de NASCIMENTO do tracker (bytetrack birthContainment), não aqui.
  // Este teste TRAVA a decisão: se alguém reintroduzir contenção no squash, ele acusa.
  it("caixa PARCIAL contida (IoU < limiar) NÃO é suprimida no squash — recall protegido", () => {
    const inteira = d("person", 0.8, [0.1, 0.1, 0.2, 0.6]); // corpo inteiro
    const parcial = d("person", 0.4, [0.14, 0.12, 0.1, 0.15]); // caixa contida (IoU baixo)
    expect(iouXYWH(inteira.bbox, parcial.bbox)).toBeLessThan(0.6);
    expect(nmsPerClass([inteira, parcial])).toHaveLength(2);
  });
});

describe("containment — interseção / área da caixa MENOR", () => {
  it("caixa totalmente contida → 1; disjuntas → 0", () => {
    expect(containment([0, 0, 1, 1], [0.2, 0.2, 0.1, 0.1])).toBeCloseTo(1, 9);
    expect(containment([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
  });
  it("meia caixa dentro → 0.5 (simétrico na ordem dos argumentos)", () => {
    expect(containment([0, 0, 0.4, 0.4], [0.2, 0, 0.4, 0.4])).toBeCloseTo(0.5, 6);
    expect(containment([0.2, 0, 0.4, 0.4], [0, 0, 0.4, 0.4])).toBeCloseTo(0.5, 6);
  });
});

describe("fuseTiles — fusão pós-reprojeção (o caso que o NMS clássico NÃO pega)", () => {
  const d = (cls, score, bbox) => ({ class: cls, score, bbox });

  it("caixa PARCIAL do tile vizinho (IoU baixo, contenção ≥0.7) é fundida na inteira", () => {
    const whole = d("person", 0.9, [0.4, 0.3, 0.2, 0.4]); // pessoa inteira
    const partial = d("person", 0.5, [0.4, 0.3, 0.2, 0.15]); // topo cortado pela borda do tile
    // pré-condição do cenário: o NMS clássico NÃO suprimiria (IoU ≤ 0.6), a contenção sim.
    expect(iouXYWH(whole.bbox, partial.bbox)).toBeLessThanOrEqual(0.6);
    expect(containment(whole.bbox, partial.bbox)).toBeGreaterThanOrEqual(0.7);
    const kept = fuseTiles([whole, partial]);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.9); // fica a de maior score
  });

  it("duas pessoas realmente LADO A LADO (contenção < 0.7) não são fundidas", () => {
    const a = d("person", 0.9, [0.1, 0.1, 0.1, 0.4]);
    const b = d("person", 0.8, [0.19, 0.1, 0.1, 0.4]); // encostadas, mas corpos distintos
    expect(containment(a.bbox, b.bbox)).toBeLessThan(0.7);
    expect(fuseTiles([a, b])).toHaveLength(2);
  });

  it("classes diferentes nunca se fundem", () => {
    const kept = fuseTiles([d("person", 0.9, [0.1, 0.1, 0.2, 0.4]), d("chair", 0.3, [0.1, 0.1, 0.2, 0.4])]);
    expect(kept).toHaveLength(2);
  });

  it("IoU alto (mesmo sem contenção ≥0.7) também funde — o OU das duas regras", () => {
    const kept = fuseTiles([d("person", 0.9, [0.1, 0.1, 0.2, 0.4]), d("person", 0.7, [0.11, 0.1, 0.2, 0.4])]);
    expect(kept).toHaveLength(1);
  });
});

describe("tileGrid — grid em frações do frame (mesma conta do front)", () => {
  it("2×2 overlap 0.1: 4 tiles, bordas clampeadas em [0,1], vizinhos se sobrepõem", () => {
    const g = tileGrid(2, 2, 0.1);
    expect(g).toHaveLength(4);
    expect(g[0]).toEqual({ x0: 0, y0: 0, x1: 0.55, y1: 0.55 }); // -0.05 clampeado a 0
    expect(g[3].x0).toBeCloseTo(0.45, 9);
    expect(g[3].x1).toBe(1); // 1.05 clampeado a 1
    expect(g[0].x1).toBeGreaterThan(g[1].x0); // overlap real entre vizinhos
  });

  it("1×1 overlap 0 → frame inteiro", () => {
    expect(tileGrid(1, 1, 0)).toEqual([{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
  });
});
