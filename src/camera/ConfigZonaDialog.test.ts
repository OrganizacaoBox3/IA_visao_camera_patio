// GATE DO SELETOR DE MODO DA ZONA — o texto do ponto de escolha é contrato, não decoração.
//
// PORQUÊ ESTE ARQUIVO EXISTE: o pedido que originou o rename veio do DONO do produto descrevendo
// a exclusão como "a função que impede o operador de entrar na área". Ela não faz isso — ela
// SUPRIME detecção e não alarma NUNCA; quem impede é a proibida. Se o dono troca os dois, o
// operador troca também. O rótulo passou a carregar o efeito (alarma / não alarma) e as
// descrições passaram a declarar ONDE cada modo roda. Este gate impede que o próximo modo nasça
// mudo (sem dizer onde roda) ou que o rótulo volte a ser ambíguo por "simplificação".
//
// Dado puro (sem render): o "abre e mostra no browser" é do e2e (app.spec.ts, mesmo par de nomes).
import { describe, it, expect } from "vitest";
import { MODO_OPTS, MODO_DESC, zoneFrameCoverage } from "./ConfigZonaDialog";
import type { ZoneMode } from "../zones";

// CT-A: os VALORES gravados (camcfg + motor do hub) NUNCA mudam — só o texto exibido.
const VALORES: ZoneMode[] = ["atividade", "leitura", "objetos", "fadiga", "exclusao", "proibida"];

// CT-B: rótulos fixos, iguais em TODA superfície do produto (select, drawer, legenda).
const ROTULOS: Record<ZoneMode, string> = {
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Fadiga",
  exclusao: "Ignorar área (sem alarme)",
  proibida: "Área restrita (gera alarme)",
};

// Onde o modo roda. O hub é 24/7 e não depende de espectador; o navegador só processa a câmera
// que está aberta na tela (o motor do hub descarta o que não é `person`).
const DECLARA_HUB = /hub|24\/7/i;
const DECLARA_NAVEGADOR = /aberta na tela/i;
const SO_NO_NAVEGADOR: ZoneMode[] = ["leitura", "objetos", "fadiga"];

describe("MODO_OPTS — valor é contrato (CT-A), rótulo diz o efeito (CT-B)", () => {
  it("grava exatamente os 6 valores do camcfg/motor, na mesma ordem", () => {
    expect(MODO_OPTS.map((o) => o.value)).toEqual(VALORES);
  });

  it("exibe os rótulos acordados com o produto", () => {
    expect(Object.fromEntries(MODO_OPTS.map((o) => [o.value, o.label]))).toEqual(ROTULOS);
  });

  // O CORAÇÃO DO ACHADO: "Exclusão"/"Proibida" não distinguiam nada no ponto da escolha.
  it("os dois modos confundíveis dizem no PRÓPRIO rótulo se alarmam ou não", () => {
    const rotulo = (m: ZoneMode) => MODO_OPTS.find((o) => o.value === m)?.label ?? "";
    expect(rotulo("exclusao")).toMatch(/sem alarme/i);
    expect(rotulo("proibida")).toMatch(/gera alarme/i);
    expect(rotulo("exclusao")).not.toBe(rotulo("proibida"));
  });
});

describe("MODO_DESC — nenhum modo nasce mudo sobre ONDE roda", () => {
  it("cobre os 6 modos com texto de verdade (não placeholder)", () => {
    expect(Object.keys(MODO_DESC).sort()).toEqual([...VALORES].sort());
    for (const m of VALORES) expect(MODO_DESC[m].length).toBeGreaterThan(40);
  });

  it("toda descrição declara o local de execução (hub/24-7 ou câmera aberta na tela)", () => {
    for (const m of VALORES)
      expect(
        DECLARA_HUB.test(MODO_DESC[m]) || DECLARA_NAVEGADOR.test(MODO_DESC[m]),
        `MODO_DESC.${m} não diz onde roda`,
      ).toBe(true);
  });

  it("leitura/objetos/fadiga declaram o navegador e NÃO prometem 24/7", () => {
    for (const m of SO_NO_NAVEGADOR) {
      expect(MODO_DESC[m], `MODO_DESC.${m}`).toMatch(DECLARA_NAVEGADOR);
      expect(MODO_DESC[m], `MODO_DESC.${m} promete hub/24-7 que não existe`).not.toMatch(
        DECLARA_HUB,
      );
    }
  });

  it("atividade/exclusao/proibida declaram o motor do hub", () => {
    for (const m of ["atividade", "exclusao", "proibida"] as ZoneMode[])
      expect(MODO_DESC[m], `MODO_DESC.${m}`).toMatch(DECLARA_HUB);
  });

  it("a descrição repete o efeito do rótulo (a explicação não pode contradizer a escolha)", () => {
    expect(MODO_DESC.exclusao).toMatch(/não\s+(conta|dispara)/i);
    expect(MODO_DESC.exclusao).toMatch(/não\s+dispara\s+alarme|não\s+alarma|em nenhum dos dois/i);
    expect(MODO_DESC.proibida).toMatch(/alarme/i);
  });
});

// A geometria da zona É a máscara de ignore do gate de movimento do hub (buildMotionIgnore):
// polígono quando existe, bbox inteira quando não. O medidor mede a área ignorada de fato.
describe("zoneFrameCoverage — fração do quadro que a zona subtrai", () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it("bbox cheia = 100% do quadro; metade = 50%", () => {
    expect(zoneFrameCoverage(rect(0, 0, 1, 1))).toBe(1);
    expect(zoneFrameCoverage(rect(0, 0, 0.5, 1))).toBeCloseTo(0.5, 6);
    expect(zoneFrameCoverage(rect(0.25, 0.25, 0.5, 0.5))).toBeCloseTo(0.25, 6);
  });

  it("com polígono, vence o polígono (é o que o hub rasteriza) — não a bbox", () => {
    // Triângulo dentro de uma bbox de área 1: metade dela.
    const tri = {
      ...rect(0, 0, 1, 1),
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    };
    expect(zoneFrameCoverage(tri)).toBeCloseTo(0.5, 6);
  });

  it("a ordem dos vértices (horário/anti-horário) não muda a área", () => {
    const pts = [
      { x: 0.2, y: 0.2 },
      { x: 0.6, y: 0.2 },
      { x: 0.6, y: 0.7 },
      { x: 0.2, y: 0.7 },
    ];
    const base = { ...rect(0.2, 0.2, 0.4, 0.5), points: pts };
    expect(zoneFrameCoverage(base)).toBeCloseTo(0.2, 6);
    expect(zoneFrameCoverage({ ...base, points: [...pts].reverse() })).toBeCloseTo(0.2, 6);
  });

  it("degenera com segurança: polígono curto cai na bbox; lixo vira 0; resultado em 0..1", () => {
    const doisPontos = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(zoneFrameCoverage({ ...rect(0, 0, 0.3, 0.3), points: doisPontos })).toBeCloseTo(0.09, 6);
    expect(zoneFrameCoverage(rect(0, 0, Number.NaN, 0.5))).toBe(0);
    expect(zoneFrameCoverage(rect(0, 0, -0.5, 0.5))).toBeCloseTo(0.25, 6); // largura negativa = |w·h|
    expect(zoneFrameCoverage(rect(0, 0, 4, 4))).toBe(1); // nunca passa de "o quadro inteiro"
  });
});
