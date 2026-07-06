// Testes do kernel de luma + ping-pong (vision/luma.ts). Provam que a matemática é a MESMA das
// 3 cópias que o módulo substituiu (0.299/0.587/0.114) e que o par de buffers recicla sem alocar
// por frame e invalida ao mudar de tamanho (sem diff entre resoluções distintas).
import { describe, it, expect } from "vitest";
import { rgbaToLuma, createLumaPingPong } from "./luma";

describe("rgbaToLuma — kernel BT.601 byte-a-byte", () => {
  it("aplica exatamente 0.299R + 0.587G + 0.114B por pixel (alpha ignorado)", () => {
    // 3 pixels: vermelho puro, verde puro, azul puro (alpha variado — não pode pesar).
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]);
    const out = new Float32Array(3);
    rgbaToLuma(rgba, out);
    // fround: o buffer é Float32 — o valor armazenado é o double arredondado p/ 32 bits.
    expect(out[0]).toBe(Math.fround(0.299 * 255));
    expect(out[1]).toBe(Math.fround(0.587 * 255));
    expect(out[2]).toBe(Math.fround(0.114 * 255));
  });

  it("pixel cinza (r=g=b) vira o próprio valor; preto vira 0", () => {
    const rgba = new Uint8ClampedArray([100, 100, 100, 255, 0, 0, 0, 255]);
    const out = new Float32Array(2);
    rgbaToLuma(rgba, out);
    expect(out[0]).toBeCloseTo(100, 6); // 0.299+0.587+0.114 = 1.0
    expect(out[1]).toBe(0);
  });

  it("resultado idêntico ao loop original (mesma expressão, mesma ordem de operações)", () => {
    const rgba = new Uint8ClampedArray(16 * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
    const out = new Float32Array(16);
    rgbaToLuma(rgba, out);
    // réplica literal do loop que vivia em CameraWorkspace/atividade/leitura
    const ref = new Float32Array(16);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++)
      ref[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    expect([...out]).toEqual([...ref]);
  });
});

describe("createLumaPingPong — reciclagem e invalidação", () => {
  it("1º frame: prev é null; após swap, prev é a luma do frame anterior", () => {
    const pp = createLumaPingPong();
    expect(pp.prev()).toBeNull();
    const a = pp.acquire(4);
    a.fill(1);
    pp.swap(a);
    expect(pp.prev()).toBe(a);
    const b = pp.acquire(4);
    b.fill(2);
    pp.swap(b);
    expect(pp.prev()).toBe(b);
  });

  it("recicla o buffer de 2 frames atrás (zero alocação em regime)", () => {
    const pp = createLumaPingPong();
    const a = pp.acquire(8);
    pp.swap(a);
    const b = pp.acquire(8);
    pp.swap(b);
    const c = pp.acquire(8); // deve ser o buffer `a`, reciclado
    expect(c).toBe(a);
  });

  it("mudança de tamanho invalida: prev vira null e realoca", () => {
    const pp = createLumaPingPong();
    const a = pp.acquire(8);
    pp.swap(a);
    expect(pp.prev()).toBe(a);
    const b = pp.acquire(16); // tamanho mudou
    expect(pp.prev()).toBeNull(); // sem diff entre resoluções distintas
    expect(b).not.toBe(a);
    expect(b.length).toBe(16);
  });

  it("reset limpa o par (próximo frame começa sem prev)", () => {
    const pp = createLumaPingPong();
    pp.swap(pp.acquire(4));
    pp.reset();
    expect(pp.prev()).toBeNull();
  });
});
