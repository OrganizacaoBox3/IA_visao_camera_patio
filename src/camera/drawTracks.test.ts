// INVARIANTE DE RENDERIZAÇÃO (decisão do dono, 2026-07-12): a caixa da pessoa NUNCA exibe NÚMERO.
// Nem id de track, nem contagem. Sem tag BLE associada, o rótulo é o genérico "Pessoa".
//
// Por quê (e por que isto é TESTE, não comentário): o id do tracker é detalhe interno — muda a cada
// re-associação, não significa nada para o operador, e o dono relatou duas vezes que "Pessoa 7" lê
// como contagem de pessoas. Contagem vive no PAINEL, nunca sobre a imagem ("a imagem é soberana",
// ADR-003). A regressão é fácil de reintroduzir (uma interpolação de template no rótulo), então o
// gate mora aqui: qualquer dígito no texto desenhado sobre a caixa QUEBRA o build.
//
// O teste captura o que o canvas REALMENTE escreve: um ctx 2D falso registra cada fillText.
import { describe, expect, it } from "vitest";
import { drawTracks, type TrackBox } from "./draw";

/** ctx 2D mínimo: registra os textos escritos e devolve larguras plausíveis. */
function fakeCtx() {
  const texts: string[] = [];
  const ctx = {
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    strokeRect: () => {},
    fillRect: () => {},
    measureText: (s: string) => ({ width: s.length * 6 }),
    fillText: (s: string) => texts.push(s),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const CR = { x: 0, y: 0, w: 640, h: 360 };
const track = (id: number): TrackBox => ({
  id,
  bbox: [0.2, 0.3, 0.1, 0.4],
  score: 0.9,
  firstSeen: 0,
  zone: null,
});

describe("drawTracks — a caixa da pessoa NUNCA mostra número (invariante do dono)", () => {
  it("sem tag associada: o rótulo é 'Pessoa', sem o id do track", () => {
    const { ctx, texts } = fakeCtx();
    drawTracks(ctx, CR, [track(7), track(1234)], 0.5, false);
    expect(texts).toEqual(["Pessoa", "Pessoa"]);
    expect(texts.join(" ")).not.toMatch(/\d/); // nenhum dígito, em nenhuma caixa
  });

  it("com tag associada: mostra o NOME da tag (o que o operador entende)", () => {
    const { ctx, texts } = fakeCtx();
    drawTracks(ctx, CR, [track(7)], 0.5, false, (id) => (id === 7 ? "João" : null));
    expect(texts).toEqual(["João"]);
  });

  it("tag sem confiança (null) cai no genérico — e ainda sem número", () => {
    const { ctx, texts } = fakeCtx();
    drawTracks(ctx, CR, [track(42)], 0.5, false, () => null);
    expect(texts).toEqual(["Pessoa"]);
    expect(texts[0]).not.toMatch(/\d/);
  });

  it("modo inspeção (pausado): agrega permanência/zona, mas o IDENTIFICADOR segue sem número", () => {
    const { ctx, texts } = fakeCtx();
    const t = { ...track(9), zone: "Doca 1" };
    drawTracks(ctx, CR, [t], 0.5, true);
    // A duração é informação legítima (tempo), mas o "quem" nunca carrega id.
    expect(texts[0]).toMatch(/^Pessoa · /);
    expect(texts[0]).not.toMatch(/Pessoa\s*\d/);
  });
});
