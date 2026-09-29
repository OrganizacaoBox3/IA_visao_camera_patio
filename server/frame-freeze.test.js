// Câmera conectada mas com a imagem PARADA (frame-freeze.js). O que o teste prova:
//  1. bytes idênticos por ≥ frozenMs COM frame fresco → congelada;
//  2. um único byte diferente zera a contagem (sensor vivo tem ruído — cena parada real NÃO dispara);
//  3. frame que parou de chegar NÃO é "congelada" (isso é sem-video — outro estado, outra causa);
//  4. o limiar é de TEMPO, não de nº de frames (GOP longo repete o quadro por segundos).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFreezeTracker } = require("./frame-freeze");

const T0 = 1_700_000_000_000;
const jpeg = (n) => Buffer.from(`\xff\xd8 frame-${n} \xff\xd9`, "latin1");

describe("frame-freeze — imagem idêntica por minutos = congelada", () => {
  it("mesma imagem por ≥ frozenMs, chegando fresca → congelada", () => {
    const t = createFreezeTracker({ frozenMs: 60_000 });
    for (let s = 0; s <= 70; s += 1) t.observe("cam", jpeg(1), T0 + s * 1000);
    const v = t.statusOf("cam", T0 + 70_000);
    expect(v.congelada).toBe(true);
    expect(v.paradoMs).toBe(70_000);
  });

  it("abaixo do limiar ainda NÃO é congelada (GOP longo repete quadro por segundos)", () => {
    const t = createFreezeTracker({ frozenMs: 60_000 });
    for (let s = 0; s <= 30; s += 1) t.observe("cam", jpeg(1), T0 + s * 1000);
    expect(t.statusOf("cam", T0 + 30_000).congelada).toBe(false);
  });

  it("UM frame diferente zera a contagem — cena parada de sensor vivo não dispara", () => {
    const t = createFreezeTracker({ frozenMs: 60_000 });
    for (let s = 0; s <= 50; s += 1) t.observe("cam", jpeg(1), T0 + s * 1000);
    t.observe("cam", jpeg(2), T0 + 51_000); // ruído do sensor
    for (let s = 52; s <= 90; s += 1) t.observe("cam", jpeg(2), T0 + s * 1000);
    const v = t.statusOf("cam", T0 + 90_000);
    expect(v.congelada).toBe(false);
    expect(v.paradoMs).toBe(39_000); // desde a última MUDANÇA, não desde o boot
  });

  it("frame que PAROU de chegar não é congelada (é sem-video — outra causa)", () => {
    const t = createFreezeTracker({ frozenMs: 60_000, frescoMs: 15_000 });
    for (let s = 0; s <= 70; s += 1) t.observe("cam", jpeg(1), T0 + s * 1000);
    const v = t.statusOf("cam", T0 + 70_000 + 20_000); // 20s sem frame nenhum
    expect(v.fresco).toBe(false);
    expect(v.congelada).toBe(false);
  });

  it("câmeras são independentes", () => {
    const t = createFreezeTracker({ frozenMs: 60_000 });
    for (let s = 0; s <= 70; s += 1) {
      t.observe("parada", jpeg(1), T0 + s * 1000);
      t.observe("viva", jpeg(s), T0 + s * 1000);
    }
    expect(t.statusOf("parada", T0 + 70_000).congelada).toBe(true);
    expect(t.statusOf("viva", T0 + 70_000).congelada).toBe(false);
  });

  it("aceita Uint8Array/ArrayBuffer (payload do socket.io) e ignora lixo sem lançar", () => {
    const t = createFreezeTracker({ frozenMs: 1 });
    const u8 = new Uint8Array([1, 2, 3]);
    t.observe("cam", u8, T0);
    t.observe("cam", u8.buffer, T0 + 5);
    expect(t.statusOf("cam", T0 + 5).iguais).toBe(1);
    expect(() => t.observe("cam", null, T0)).not.toThrow();
    expect(() => t.observe(null, u8, T0)).not.toThrow();
    expect(t.statusOf("desconhecida", T0)).toBeNull();
  });

  it("prune esquece câmera sem frame há muito (não segura Buffer de câmera removida)", () => {
    const t = createFreezeTracker();
    t.observe("velha", jpeg(1), T0);
    t.observe("nova", jpeg(1), T0 + 11 * 60_000);
    t.prune(T0 + 11 * 60_000);
    expect(t.statusOf("velha", T0)).toBeNull();
    expect(t.size()).toBe(1);
  });
});
