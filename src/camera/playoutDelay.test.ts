// Gate da distinção que motivou a mudança de 2026-08-16: **pedir 0 não é o mesmo que não
// pedir**. A guarda anterior (`ms <= 0`) fazia a função retornar sem tocar em receiver nenhum
// justamente no valor que o produto passou a usar (syncDelayMs = 0), deixando o navegador com o
// jitter buffer adaptativo dele. Se alguém restaurar aquela guarda, o caso "0 aplica" quebra.
// Racional completo: cabeçalho de playoutDelay.ts + comparativo-mvp-maos-2026-08-16.md §7.2.
import { describe, expect, it } from "vitest";
import { applyPlayoutDelay } from "./playoutDelay";

type FakeReceiver = { playoutDelayHint?: number; jitterBufferTarget?: number };

/** Elemento <video-stream> falso: só o que a função toca (pc.getReceivers()). */
function fakeEl(receivers: FakeReceiver[]) {
  return { pc: { getReceivers: () => receivers } as unknown as RTCPeerConnection };
}

describe("applyPlayoutDelay", () => {
  it("0 é PEDIDO EXPLÍCITO de mínimo — aplica nos dois campos", () => {
    const r: FakeReceiver = {};
    expect(applyPlayoutDelay(fakeEl([r]), 0)).toBe(true);
    expect(r.jitterBufferTarget).toBe(0);
    expect(r.playoutDelayHint).toBe(0);
  });

  it("valor positivo mantém o modo síncrono (ms no target, segundos no hint legado)", () => {
    const r: FakeReceiver = {};
    expect(applyPlayoutDelay(fakeEl([r]), 2000)).toBe(true);
    expect(r.jitterBufferTarget).toBe(2000);
    expect(r.playoutDelayHint).toBe(2); // playoutDelayHint é em SEGUNDOS
  });

  it("aplica em TODOS os receivers do pc", () => {
    const a: FakeReceiver = {};
    const b: FakeReceiver = {};
    expect(applyPlayoutDelay(fakeEl([a, b]), 0)).toBe(true);
    expect(a.jitterBufferTarget).toBe(0);
    expect(b.jitterBufferTarget).toBe(0);
  });

  // O NEGATIVO é o que separa "minimize" de "não mexer" — sem ele, 0 e "desligado" voltariam
  // a ser a mesma coisa e a regressão passaria despercebida.
  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "valor inválido (%p) NÃO toca em receiver nenhum",
    (ms) => {
      const r: FakeReceiver = {};
      expect(applyPlayoutDelay(fakeEl([r]), ms as number)).toBe(false);
      expect(r.jitterBufferTarget).toBeUndefined();
      expect(r.playoutDelayHint).toBeUndefined();
    },
  );

  it("sem pc / sem elemento devolve false sem lançar", () => {
    expect(applyPlayoutDelay(null, 0)).toBe(false);
    expect(applyPlayoutDelay(undefined, 0)).toBe(false);
    expect(applyPlayoutDelay({ pc: null }, 0)).toBe(false);
  });

  it("pc sem receiver nenhum devolve false (não havia o que tocar)", () => {
    expect(applyPlayoutDelay(fakeEl([]), 0)).toBe(false);
  });

  // Receiver que rejeita a propriedade não pode derrubar os outros: navegador antigo/parcial é
  // caso REAL, e o overlay ainda casa pelo knob mesmo sem o hint.
  it("receiver que lança não impede os demais de receberem o alvo", () => {
    const ruim = {} as FakeReceiver;
    Object.defineProperty(ruim, "jitterBufferTarget", {
      set() {
        throw new Error("sem suporte");
      },
    });
    const bom: FakeReceiver = {};
    expect(applyPlayoutDelay(fakeEl([ruim, bom]), 0)).toBe(true);
    expect(bom.jitterBufferTarget).toBe(0);
  });
});
