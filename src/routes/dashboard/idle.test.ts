// Testes da decisão de ociosidade do painel (idle.ts). O que está em jogo: um corte fantasma
// (vídeo sumindo na cara de quem está trabalhando) e o desperdício que a feature existe para
// matar (painel esquecido segurando CPU da análise).
import { describe, it, expect } from "vitest";
import { deveSoltarVideo, IDLE_MS } from "./idle";

const T0 = 1_000_000;

describe("deveSoltarVideo", () => {
  it("segura o vídeo enquanto há atividade recente", () => {
    expect(deveSoltarVideo(T0 + 1000, T0, true)).toBe(false);
    expect(deveSoltarVideo(T0 + IDLE_MS - 1, T0, true)).toBe(false);
  });

  it("solta ao completar o timeout (borda inclusiva)", () => {
    expect(deveSoltarVideo(T0 + IDLE_MS, T0, true)).toBe(true);
  });

  it("aba oculta solta na hora, sem esperar o timeout", () => {
    // Ninguém vendo: esperar 5 min só queima CPU da análise.
    expect(deveSoltarVideo(T0 + 1, T0, false)).toBe(true);
  });

  it("relógio andando para trás NÃO é lido como abandono", () => {
    // Sleep do notebook / ajuste de NTP dão delta negativo. Cortar aqui seria um corte
    // fantasma — o vídeo sumiria na cara de quem acabou de voltar para a máquina.
    expect(deveSoltarVideo(T0 - 60_000, T0, true)).toBe(false);
    expect(deveSoltarVideo(Number.NaN, T0, true)).toBe(false);
  });

  it("timeout customizado é respeitado", () => {
    expect(deveSoltarVideo(T0 + 999, T0, true, 1000)).toBe(false);
    expect(deveSoltarVideo(T0 + 1000, T0, true, 1000)).toBe(true);
  });
});
