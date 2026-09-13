// COBERTURA DA ANÁLISE — o teste que importa é o do DENOMINADOR.
//
// O erro que este módulo existe para impedir tem uma forma específica e traiçoeira: a câmera
// que morre no meio do período simplesmente SOME do dado. Ela não deixa uma linha de zeros —
// ela não deixa linha nenhuma. Qualquer cálculo feito sobre "as horas que existem no dado"
// daria 100% de cobertura justamente para o período em que ninguém estava vendo nada.
//
// Por isso o denominador vem da LINHA DO TEMPO, e não do dado. E por isso o primeiro bloco de
// testes abaixo é o das câmeras que somem.
import { describe, it, expect } from "vitest";
import {
  cobertura,
  coberturaConfiavel,
  textoDeZero,
  duracaoHumana,
  COBERTURA_OK_PCT,
  MOTIVO_COBERTURA_TEXTO,
} from "./cobertura";
import type { Cell, Dataset } from "./atividade";

const H = 3_600_000;
const D = 86_400_000;
// Janela de referência: começa num limite de dia UTC, 2 dias de histórico.
const START = Math.floor(1_757_000_000_000 / D) * D;

const cel = (over: Partial<Cell> & { cameraId: string; hourStart: number }): Cell => ({
  area: "Doca",
  dayIndex: Math.floor((over.hourStart - START) / D),
  hour: new Date(over.hourStart).getHours(),
  idleMin: 0,
  alerts: 0,
  activePct: 0,
  ...over,
});

const ds = (cells: Cell[], days = 1): Dataset => ({
  days,
  areas: ["Doca"],
  cameraOf: {},
  cells,
  startMs: START,
});

/** Uma câmera observando `obsMs` em cada uma das `n` horas a partir de `de`. */
const horas = (cameraId: string, de: number, n: number, obsMs: number): Cell[] =>
  Array.from({ length: n }, (_, i) => cel({ cameraId, hourStart: de + i * H, observedMs: obsMs }));

describe("o buraco INVISÍVEL: a câmera que some do dado", () => {
  it("câmera que morre no meio do período NÃO dá 100% — as horas ausentes contam", () => {
    // 10h de janela; a câmera observa perfeitamente as 5 primeiras e some nas 5 últimas.
    const agora = START + 10 * H;
    const c = cobertura(ds(horas("cam-1", START, 5, H)), "hoje", new Set(), agora);
    expect(c.pct).toBe(50); // e NÃO 100
    expect(c.horasSemDado).toBe(5);
    expect(c.horasEsperadas).toBe(10);
  });

  it("câmera cega o período inteiro (buckets existem, observedMs zerado) dá 0%, não 'sem dado'", () => {
    const agora = START + 4 * H;
    const c = cobertura(ds(horas("cam-1", START, 4, 0)), "hoje", new Set(), agora);
    expect(c.pct).toBe(0);
    expect(c.motivo).toBeNull(); // MEDIMOS: deu zero. Diferente de "não medimos".
    expect(c.horasSemDado).toBe(0); // os buckets existiam — o buraco é de tempo, não de dado
  });

  it("hora com meia observação conta meia — não é tudo ou nada", () => {
    const agora = START + 2 * H;
    const c = cobertura(ds(horas("cam-1", START, 2, H / 2)), "hoje", new Set(), agora);
    expect(c.pct).toBe(50);
    expect(c.observadoMs).toBe(H);
    expect(c.esperadoMs).toBe(2 * H);
  });
});

describe("o denominador: o que entra e o que NÃO entra", () => {
  it("hora ANTERIOR à 1ª aparição da câmera não conta (ela não existia)", () => {
    // A câmera só aparece na 3ª hora da janela e observa as 2 horas restantes por inteiro.
    const agora = START + 5 * H;
    const c = cobertura(ds(horas("cam-1", START + 3 * H, 2, H)), "hoje", new Set(), agora);
    expect(c.pct).toBe(100); // as 3 horas anteriores não são buraco: não havia câmera
    expect(c.horasEsperadas).toBe(2);
  });

  it("a hora CORRENTE é parcial — não vira buraco só porque ainda não terminou", () => {
    // 1h cheia observada + 15min da hora seguinte, e "agora" é 15min depois da virada.
    const agora = START + H + 15 * 60_000;
    const cells = [
      ...horas("cam-1", START, 1, H),
      cel({ cameraId: "cam-1", hourStart: START + H, observedMs: 15 * 60_000 }),
    ];
    const c = cobertura(ds(cells), "hoje", new Set(), agora);
    expect(c.pct).toBe(100); // observou tudo que havia para observar
    expect(c.esperadoMs).toBe(H + 15 * 60_000);
  });

  it("câmera DESATIVADA fica fora do denominador (não era para medir)", () => {
    const agora = START + 4 * H;
    const cells = [...horas("cam-1", START, 4, H), ...horas("cam-morta", START, 1, 0)];
    const comTodas = cobertura(ds(cells), "hoje", new Set(), agora);
    const semMorta = cobertura(ds(cells), "hoje", new Set(["cam-morta"]), agora);
    expect(comTodas.pct).toBeLessThan(100); // a desativada afundava a métrica da frota
    expect(semMorta.pct).toBe(100);
    expect(semMorta.cameras).toBe(1);
  });

  it("cada câmera tem a PRÓPRIA linha do tempo (uma cega não some na média da outra)", () => {
    const agora = START + 4 * H;
    const cells = [...horas("cam-1", START, 4, H), ...horas("cam-2", START, 2, H)]; // cam-2 sumiu
    const c = cobertura(ds(cells), "hoje", new Set(), agora);
    expect(c.cameras).toBe(2);
    expect(c.horasEsperadas).toBe(8); // 4 de cada
    expect(c.horasSemDado).toBe(2); // as 2 horas em que a cam-2 sumiu
    expect(c.pct).toBe(75);
  });

  it("não se observa mais do que a hora dura (observedMs inflado é preso no teto)", () => {
    const agora = START + 2 * H;
    const c = cobertura(ds(horas("cam-1", START, 2, 10 * H)), "hoje", new Set(), agora);
    expect(c.pct).toBe(100); // e não 1000%
  });
});

describe("zonas da MESMA câmera não multiplicam o tempo observado", () => {
  it("3 zonas na mesma hora contam UMA hora observada, não três", () => {
    // O hub replica o mesmo observedMs em cada zona (pipeline.flushWindows). Somar as zonas
    // daria 3h de observação numa janela de 1h — cobertura de 300%.
    const agora = START + H;
    const cells = [
      cel({ cameraId: "cam-1", hourStart: START, observedMs: H, area: "Doca" }),
      cel({ cameraId: "cam-1", hourStart: START, observedMs: H, area: "Expedição" }),
      cel({ cameraId: "cam-1", hourStart: START, observedMs: H, area: "Recebimento" }),
    ];
    const c = cobertura(ds(cells), "hoje", new Set(), agora);
    expect(c.pct).toBe(100);
    expect(c.observadoMs).toBe(H);
  });
});

describe("cala quando não tem como medir (e diz por quê)", () => {
  it("sem histórico nenhum: pct null, motivo sem-dado", () => {
    const c = cobertura(ds([]), "hoje");
    expect(c.pct).toBeNull();
    expect(c.motivo).toBe("sem-dado");
  });

  it("hub ANTIGO (buckets sem observedMs) não vira 0% — seria acusar sem ter medido", () => {
    const agora = START + 3 * H;
    const cells = [
      cel({ cameraId: "cam-1", hourStart: START }),
      cel({ cameraId: "cam-1", hourStart: START + H }),
    ];
    const c = cobertura(ds(cells), "hoje", new Set(), agora);
    expect(c.pct).toBeNull();
    expect(c.motivo).toBe("sem-medicao-de-tempo");
  });

  it("célula sem cameraId/hourStart é ignorada sem derrubar o cálculo", () => {
    const agora = START + 2 * H;
    const cells = [
      { area: "X", dayIndex: 0, hour: 0, idleMin: 0, alerts: 0, activePct: 0 } as Cell,
      ...horas("cam-1", START, 2, H),
    ];
    expect(cobertura(ds(cells), "hoje", new Set(), agora).pct).toBe(100);
  });

  it("todo motivo tem texto (a UI nunca fica sem explicação)", () => {
    for (const m of ["sem-dado", "sem-medicao-de-tempo"] as const)
      expect(MOTIVO_COBERTURA_TEXTO[m].length).toBeGreaterThan(20);
  });
});

describe("o uso que justifica o módulo: qualificar um ZERO", () => {
  const comPct = (pct: number) => ({
    pct,
    observadoMs: 0,
    esperadoMs: 0,
    horasSemDado: 0,
    horasEsperadas: 0,
    cameras: 1,
    motivo: null,
  });

  it("acima do piso, o zero é AFIRMAÇÃO e vem com a cobertura que o sustenta", () => {
    expect(coberturaConfiavel(comPct(COBERTURA_OK_PCT))).toBe(true);
    expect(textoDeZero(comPct(95))).toBe("95% do período analisado");
  });

  it("abaixo do piso, o zero vem com o aviso — ausência não é evidência", () => {
    expect(coberturaConfiavel(comPct(COBERTURA_OK_PCT - 1))).toBe(false);
    expect(textoDeZero(comPct(30))).toMatch(/ausência não é evidência/);
    expect(textoDeZero(comPct(30))).toContain("30%");
  });

  it("sem cobertura medida, o texto NÃO afirma ausência nem a nega", () => {
    expect(textoDeZero({ ...comPct(0), pct: null })).toMatch(/não é possível afirmar/);
  });
});

describe("duracaoHumana — o mesmo texto na tela e no CSV", () => {
  it("minutos, horas cheias e horas quebradas", () => {
    expect(duracaoHumana(30 * 60_000)).toBe("30min");
    expect(duracaoHumana(2 * H)).toBe("2h");
    expect(duracaoHumana(2 * H + 30 * 60_000)).toBe("2h 30min");
  });
});
