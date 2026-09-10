// A faixa N1 ("o detector está confiável?") só pode se recolher no SILÊNCIO — nunca em cima de
// movimento. Esta é a decisão pura por trás do colapso; ela decide o que o gestor vê no topo do
// relatório, então mora fora do React e tem teste.
//
// O erro que este teste existe para impedir é o de sempre nesta casa, invertido: aqui o risco
// não é exibir zero como se fosse medição — é ESCONDER medição achando que é zero.
import { describe, it, expect } from "vitest";
import { faixaSemNadaAReportar } from "./AlarmHealthStrip";

const quieto = { inWindow: 0, overTarget: false, shelvedActive: 0, suppressedByShift: 0 };

describe("faixaSemNadaAReportar — o colapso é para o silêncio, não para o movimento", () => {
  it("janela limpa em tudo: recolhe", () => {
    expect(faixaSemNadaAReportar(quieto)).toBe(true);
  });

  it("UM alarme na janela já reabre a faixa", () => {
    expect(faixaSemNadaAReportar({ ...quieto, inWindow: 1 })).toBe(false);
  });

  it("acima do alvo de críticos reabre — mesmo sem alarme contado na janela", () => {
    expect(faixaSemNadaAReportar({ ...quieto, overTarget: true })).toBe(false);
  });

  it("silenciamento ativo reabre: alerta calado é justamente o que não pode ficar escondido", () => {
    expect(faixaSemNadaAReportar({ ...quieto, shelvedActive: 1 })).toBe(false);
  });

  it("supressão por turno reabre (quem cala, mostra que calou)", () => {
    expect(faixaSemNadaAReportar({ ...quieto, suppressedByShift: 3 })).toBe(false);
  });

  it("hub antigo sem o campo de supressão não impede o colapso (ausência ≠ movimento)", () => {
    expect(faixaSemNadaAReportar({ ...quieto, suppressedByShift: null })).toBe(true);
    expect(faixaSemNadaAReportar({ ...quieto, suppressedByShift: undefined })).toBe(true);
  });
});
