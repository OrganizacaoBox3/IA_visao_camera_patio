// Gates das partes PURAS do worker de fadiga (decode do YuNet, crop quadrado, mapeamento de
// landmarks) e da extração de tar.gz do catálogo — tudo com fixtures sintéticas, sem ORT/sharp.
import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeYunet, squareCrop, meshToFramePts, sigmoid, MESH_POINTS } from "./worker-fadiga";
import { extractFromTarGz } from "./model-fadiga";

// Monta outputs sintéticos do YuNet: tudo zerado, com UMA célula ativada por stride pedido.
function yunetOutputs(activations) {
  const out = {};
  for (const s of [8, 16, 32]) {
    const n = (640 / s) * (640 / s);
    out[`cls_${s}`] = { data: new Float32Array(n) };
    out[`obj_${s}`] = { data: new Float32Array(n) };
    out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
  }
  for (const a of activations) {
    const cols = 640 / a.stride;
    const i = a.row * cols + a.col;
    out[`cls_${a.stride}`].data[i] = a.cls ?? 1;
    out[`obj_${a.stride}`].data[i] = a.obj ?? 1;
    out[`bbox_${a.stride}`].data.set(a.bbox ?? [0.5, 0.5, Math.log(4), Math.log(4)], i * 4);
  }
  return out;
}

describe("decodeYunet", () => {
  it("decodifica célula ativada: centro=(col+dx)·s, tamanho=e^dw·s, normalizado 0..1", () => {
    // stride 32, célula (10,10), dx=dy=0.5, w=h=e^ln4·32=128px → box centrado em 336px
    const dets = decodeYunet(yunetOutputs([{ stride: 32, row: 10, col: 10 }]));
    expect(dets).toHaveLength(1);
    const [d] = dets;
    expect(d.score).toBeCloseTo(1, 5);
    expect(d.box[0]).toBeCloseTo((336 - 64) / 640, 4);
    expect(d.box[1]).toBeCloseTo((336 - 64) / 640, 4);
    expect(d.box[2]).toBeCloseTo(128 / 640, 4);
    expect(d.box[3]).toBeCloseTo(128 / 640, 4);
  });

  it("score = sqrt(cls·obj); abaixo do limiar cai", () => {
    const dets = decodeYunet(yunetOutputs([{ stride: 16, row: 5, col: 5, cls: 0.3, obj: 0.3 }]));
    expect(dets).toHaveLength(0); // sqrt(0.09)=0.3 < 0.5
    const dets2 = decodeYunet(
      yunetOutputs([{ stride: 16, row: 5, col: 5, cls: 0.8, obj: 0.8 }]),
      0.5,
    );
    expect(dets2).toHaveLength(1);
    expect(dets2[0].score).toBeCloseTo(0.8, 5);
  });

  it("NMS: duas células vizinhas sobre o MESMO rosto viram 1 det (a de maior score)", () => {
    const dets = decodeYunet(
      yunetOutputs([
        { stride: 32, row: 10, col: 10, cls: 1, obj: 1 },
        { stride: 32, row: 10, col: 11, cls: 0.7, obj: 0.7, bbox: [-0.5, 0.5, Math.log(4), Math.log(4)] },
      ]),
    );
    expect(dets).toHaveLength(1);
    expect(dets[0].score).toBeCloseTo(1, 5);
  });
});

describe("squareCrop", () => {
  it("quadrado com margem 1.6× o maior lado, clampado ao frame", () => {
    const c = squareCrop([0.4, 0.4, 0.2, 0.1], 1000, 1000);
    expect(c.size).toBe(320); // maior lado 200px × 1.6
    expect(c.left).toBe(340); // centro (500,450) − 160
    expect(c.top).toBe(290);
  });
  it("rosto na borda: crop desliza p/ dentro (nunca sai do frame)", () => {
    const c = squareCrop([0.9, 0.9, 0.2, 0.2], 1000, 1000);
    expect(c.left + c.size).toBeLessThanOrEqual(1000);
    expect(c.top + c.size).toBeLessThanOrEqual(1000);
    expect(c.left).toBeGreaterThanOrEqual(0);
  });
});

describe("meshToFramePts", () => {
  it("mapeia px do crop 256 → coordenadas normalizadas do frame", () => {
    const raw = new Float32Array(MESH_POINTS * 3);
    raw[0] = 128; // ponto 0 no centro do crop
    raw[1] = 128;
    const pts = meshToFramePts(raw, { left: 100, top: 200, size: 400 }, 1000, 1000);
    expect(pts[0]).toBeCloseTo((100 + 200) / 1000, 5);
    expect(pts[1]).toBeCloseTo((200 + 200) / 1000, 5);
  });
});

describe("extractFromTarGz (catálogo)", () => {
  function tarEntry(name, content) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
    header[156] = 48; // '0' = arquivo comum
    const data = Buffer.alloc(Math.ceil(content.length / 512) * 512);
    content.copy(data);
    return Buffer.concat([header, data]);
  }
  it("extrai o arquivo certo por basename (com prefixo de diretório no tar)", () => {
    const payload = Buffer.from("conteudo-do-onnx");
    const tar = Buffer.concat([
      tarEntry("./outro.txt", Buffer.from("x")),
      tarEntry("./sub/modelo.onnx", payload),
      Buffer.alloc(1024), // fim
    ]);
    const out = extractFromTarGz(zlib.gzipSync(tar), "modelo.onnx");
    expect(out).not.toBeNull();
    expect(out.toString()).toBe("conteudo-do-onnx");
  });
  it("ausente → null", () => {
    const tar = Buffer.concat([tarEntry("a.txt", Buffer.from("x")), Buffer.alloc(1024)]);
    expect(extractFromTarGz(zlib.gzipSync(tar), "nao-existe.onnx")).toBeNull();
  });
});

describe("sigmoid", () => {
  it("logits do spike: −0.159→0.46 (crop ok), −21.6→~0 (crop ruim)", () => {
    expect(sigmoid(-0.159)).toBeCloseTo(0.46, 2);
    expect(sigmoid(-21.6)).toBeLessThan(0.001);
  });
});
