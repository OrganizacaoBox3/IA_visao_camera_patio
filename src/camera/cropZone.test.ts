// A geometria do recorte saiu do god-component justamente porque era a parte com risco de erro
// (dois arredondamentos + um cap) e nunca teve teste. Contrato: cap de largura, aspecto preservado
// e NENHUM lado zero (canvas 0×0 joga exceção no laço quente).
import { describe, expect, it } from "vitest";
import { cropSize, CROP_MAX_W } from "./cropZone";

const frame = { w: 1920, h: 1080 };

describe("cropSize — ROI da zona → canvas de recorte", () => {
  it("zona pequena: sem cap, o destino é o tamanho da fonte", () => {
    const c = cropSize({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }, frame); // 192×216
    expect([c.sw, c.sh]).toEqual([192, 216]);
    expect([c.cw, c.ch]).toEqual([192, 216]);
    expect([c.sx, c.sy]).toEqual([480, 540]);
  });

  it("zona larga: aplica o cap de largura preservando o aspecto", () => {
    const c = cropSize({ x: 0, y: 0, w: 1, h: 1 }, frame);
    expect(c.sw).toBe(1920);
    expect(c.cw).toBe(CROP_MAX_W);
    expect(c.ch).toBe(Math.round(1080 * (CROP_MAX_W / 1920)));
  });

  it("zona degenerada (w/h = 0): todo lado fica ≥ 1px — canvas 0×0 quebraria o rAF", () => {
    const c = cropSize({ x: 0.5, y: 0.5, w: 0, h: 0 }, frame);
    expect([c.sw, c.sh, c.cw, c.ch]).toEqual([1, 1, 1, 1]);
  });
});
