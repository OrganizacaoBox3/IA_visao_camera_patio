// Gates de DESENHO do overlay (complementam drawTracks.test.ts, que trava o "sem número"):
//
//  1. A caixa em COASTING — marcação sustentada SEM observação nova — tem de sair VISUALMENTE
//     distinguível da observada. O interpolador entrega isso como `opacity` reduzida; o desenho
//     só precisa NÃO A PERDER. É exatamente o tipo de regressão silenciosa que passa em revisão
//     (basta alguém "limpar" o globalAlpha) e produz uma marcação com cara de certeza.
//  2. As RÉGUAS do HUD (`exato`/`coast`). Sem elas o RAMO que desenha a caixa é invisível: no modo
//     síncrono a marcação deveria ser 100% interpolação EXATA e a volta à extrapolação (= arrasto)
//     não teria sensor nenhum. Going-gray: `exato` satura SÓ sob modo síncrono; `coast` nunca.
import { describe, expect, it } from "vitest";
import { drawTracks, drawTelemetryHud, type HudStats, type TrackBox } from "./draw";

const CR = { x: 0, y: 0, w: 640, h: 360 };

/** ctx 2D mínimo que registra o globalAlpha e o DASH vigentes em cada primitiva pintada. */
function alphaCtx() {
  const strokes: number[] = [];
  const texts: number[] = [];
  const dashes: number[][] = []; // dash vigente em cada strokeRect (1 por caixa)
  let dash: number[] = [];
  const ctx = {
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    setLineDash: (d: number[]) => {
      dash = d;
    },
    strokeRect: () => {
      strokes.push(ctx.globalAlpha);
      dashes.push(dash);
    },
    fillRect: () => {},
    measureText: (s: string) => ({ width: s.length * 6 }),
    fillText: () => texts.push(ctx.globalAlpha),
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    strokes,
    texts,
    dashes,
    raw: ctx,
    dashNow: () => dash,
  };
}

const track = (over: Partial<TrackBox> = {}): TrackBox => ({
  id: 1,
  bbox: [0.2, 0.3, 0.1, 0.4],
  score: 0.9,
  firstSeen: 0,
  zone: null,
  ...over,
});

describe("drawTracks — a caixa incerta (coasting/fade) desenha ESMAECIDA", () => {
  it("opacity do interpolador chega ao canvas (piso de coasting 0.45)", () => {
    const { ctx, strokes } = alphaCtx();
    drawTracks(ctx, CR, [track({ opacity: 0.45 })], 0.5, false);
    expect(strokes).toEqual([0.45]);
  });

  it("a atenuação vale para o CONJUNTO: o rótulo não fica opaco desmentindo a caixa", () => {
    const { ctx, strokes, texts } = alphaCtx();
    drawTracks(ctx, CR, [track({ opacity: 0.45 })], 0.5, false);
    expect(texts).toEqual(strokes);
  });

  it("sem opacity (pipeline local / chamador antigo) segue opaca — retrocompat", () => {
    const { ctx, strokes } = alphaCtx();
    drawTracks(ctx, CR, [track()], 0.5, false);
    expect(strokes).toEqual([1]);
  });

  it("compõe com o slider de confiança (score<conf) em vez de um sobrescrever o outro", () => {
    const { ctx, strokes } = alphaCtx();
    drawTracks(ctx, CR, [track({ score: 0.2, opacity: 0.45 })], 0.5, false);
    expect(strokes[0]).toBeCloseTo(0.3 * 0.45, 6);
  });

  it("restaura o globalAlpha ao sair (o resto do palco assume 1)", () => {
    const { ctx, raw } = alphaCtx();
    drawTracks(ctx, CR, [track({ opacity: 0.45 })], 0.5, false);
    expect(raw.globalAlpha).toBe(1);
  });
});

// CANAIS SEPARADOS (a causa-raiz da ambiguidade): a opacidade sozinha significava DUAS coisas que
// pedem AÇÕES diferentes do operador — score abaixo do slider (calibrar) × marcação sem observação
// nova (investigar câmera/CPU/rede). O contorno TRACEJADO passou a ser o canal do coasting; a
// opacidade segue sendo o da confiança. Verbete de ambos na legenda (derive.legendFor).
describe("drawTracks — coasting tem canal PRÓPRIO: contorno tracejado", () => {
  it("coasting:true desenha TRACEJADO", () => {
    const { ctx, dashes } = alphaCtx();
    drawTracks(ctx, CR, [track({ coasting: true })], 0.5, false);
    expect(dashes).toHaveLength(1);
    expect(dashes[0].length).toBeGreaterThan(0);
  });

  it("coasting:false (e ausente) desenha SÓLIDO — nada regride p/ o chamador antigo", () => {
    const { ctx, dashes } = alphaCtx();
    drawTracks(ctx, CR, [track({ coasting: false }), track({ id: 2 })], 0.5, false);
    expect(dashes).toEqual([[], []]);
  });

  it("os canais são INDEPENDENTES: a opacidade segue chegando ao canvas com tracejado", () => {
    const { ctx, strokes, dashes } = alphaCtx();
    drawTracks(ctx, CR, [track({ coasting: true, opacity: 0.45 })], 0.5, false);
    expect(strokes).toEqual([0.45]);
    expect(dashes[0].length).toBeGreaterThan(0);
    // e o tracejado NÃO depende da opacidade: caixa opaca em coasting também sai tracejada
    const b = alphaCtx();
    drawTracks(b.ctx, CR, [track({ coasting: true })], 0.5, false);
    expect(b.dashes[0].length).toBeGreaterThan(0);
  });

  it("caixa a caixa: tracejada só a que está em coasting (o dash não vaza p/ a vizinha)", () => {
    const { ctx, dashes } = alphaCtx();
    drawTracks(
      ctx,
      CR,
      [track({ id: 1, coasting: true }), track({ id: 2 }), track({ id: 3, coasting: true })],
      0.5,
      false,
    );
    expect(dashes.map((d) => d.length > 0)).toEqual([true, false, true]);
  });

  it("restaura o contorno SÓLIDO ao sair (o resto do palco desenha linha cheia)", () => {
    const { ctx, dashNow } = alphaCtx();
    drawTracks(ctx, CR, [track({ coasting: true })], 0.5, false);
    expect(dashNow()).toEqual([]);
  });
});

/** ctx 2D mínimo que registra (texto, cor) de cada linha escrita pelo HUD. */
function hudCtx() {
  const lines: Array<{ text: string; fill: string }> = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textBaseline: "alphabetic",
    fillRect: () => {},
    measureText: (s: string) => ({ width: s.length * 6 }),
    fillText: (s: string) => lines.push({ text: s, fill: ctx.fillStyle }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, lines };
}

const BASE: HudStats = { fps: 30, msFrame: 4, pipeline: "hub", overlayAgeMs: null };
const textsOf = (l: Array<{ text: string }>) => l.map((x) => x.text);
const WARN = "#eab308"; // fallback de --state-warn (ambiente de teste sem CSS)
// UNIDADE (o bug que este gate existe para não deixar voltar): stats() emite FRAÇÕES 0..1 apesar do
// sufixo `Pct`; quem converte para percentual é o desenho. Sem isto o HUD mostraria "exato 1%" com
// a marcação PERFEITA — uma régua mentindo, pior que régua nenhuma.
const interp = (exactFrac: number, coastFrac = 0) => ({ exactFrac, coastFrac });

describe("drawTelemetryHud — as réguas do interpolador (ramo do desenho + coasting)", () => {
  it("mostra o RAMO do desenho e o COASTING como PERCENTUAL (stats() emite fração 0..1)", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, { ...BASE, interp: interp(1, 0.25) });
    expect(textsOf(lines)).toContain("exato 100%"); // 1.0 é 100%, não 1%
    expect(textsOf(lines)).toContain("coast 25%");
  });

  it("ausente (pipeline local / sem interpolador) → linha nenhuma, sem inventar zero", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, BASE);
    expect(textsOf(lines).join(" ")).not.toMatch(/exato|coast/);
  });

  it("modo SÍNCRONO: exato abaixo de 100% é ANOMALIA (o arrasto voltou) → satura", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, { ...BASE, interp: interp(0.42), syncActive: true });
    expect(lines.find((l) => l.text.startsWith("exato"))?.fill).toBe(WARN);
  });

  it("modo síncrono com 100%: neutro (medir não é anormalidade — going-gray)", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, { ...BASE, interp: interp(1), syncActive: true });
    expect(lines.find((l) => l.text.startsWith("exato"))?.fill).not.toBe(WARN);
  });

  it("FORA do modo síncrono extrapolar é o PROJETO, não defeito → exato baixo fica neutro", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, { ...BASE, interp: interp(0), syncActive: false });
    expect(lines.find((l) => l.text.startsWith("exato"))?.fill).not.toBe(WARN);
  });

  it("coast NUNCA satura: cena parada faz o gate pular rodada — é o desenho, não o defeito", () => {
    const { ctx, lines } = hudCtx();
    drawTelemetryHud(ctx, CR, { ...BASE, interp: interp(1, 1) });
    expect(lines.find((l) => l.text.startsWith("coast"))?.fill).not.toBe(WARN);
  });
});
