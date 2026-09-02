// Testes da MÁQUINA DE ESTADOS de lotação em zona de atividade (occupancy-alert.js)
// — o produtor server-side do alarme tipo "objetos" por meta de pessoas
// (targetOccupancy/occupancyToleranceMs). Espelha presence-alert.test.js na forma;
// aqui observe() recebe perZone (Map zoneId→contagem) direto, como pipeline.js
// já calcula — não precisa de tracks/resolveZone aqui (isso já é testado em
// pipeline.test.js/zones.test.js do lado da contagem).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOccupancyAlert, stateOf, offDelayMs, toleranceMsOf, TOLERANCE_DEFAULT_MS } = require("./occupancy-alert");

const zone = (over = {}) => ({
  id: "z1",
  label: "Sala",
  modo: "atividade",
  targetOccupancy: 4,
  occupancyToleranceMs: 10_000,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  ...over,
});

// Estado mínimo por câmera (os campos que observe/stateOf usam do createState do engine).
const makeSt = (zonesAtiv) => ({ id: "cam1", zonesAtiv, occupancy: new Map() });
const perZone = (n) => new Map([["z1", n]]);

let raiseAlarm;
let occupancy;
beforeEach(() => {
  raiseAlarm = vi.fn();
  occupancy = createOccupancyAlert({ raiseAlarm, cameraLabelOf: () => "Câmera 1" });
});

describe("desvio sustentado — OK → VIOLADA", () => {
  it("desvio 12s ≥ tolerância 10s → UM alerta com payload estruturado (tipo objetos)", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0); // 2 ≠ 4, desvia
    occupancy.observe(st, st.zonesAtiv, perZone(2), 6000);
    expect(raiseAlarm).not.toHaveBeenCalled(); // 6s < 10s
    occupancy.observe(st, st.zonesAtiv, perZone(2), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(raiseAlarm.mock.calls[0][0]).toEqual({
      text: "⚠ Câmera 1 · Sala: lotação abaixo do esperado — 2 pessoa(s) (esperado 4)",
      ts: 12_000,
      cameraId: "cam1",
      cameraLabel: "Câmera 1",
      zona: "Sala",
      tipo: "objetos",
    });
    expect(st.occupancy.get("z1").state).toBe("violada");
  });

  it("acima da meta usa 'acima do esperado' na mensagem", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(6), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(6), 10_000);
    expect(raiseAlarm.mock.calls[0][0].text).toContain("acima do esperado");
  });

  it("desvio breve (4s < tolerância) NÃO alerta; voltar à meta reseta o contador", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 4000);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 6000); // voltou à meta antes do prazo → reset
    occupancy.observe(st, st.zonesAtiv, perZone(2), 8000); // desviou de novo — âncora nova em 8s
    occupancy.observe(st, st.zonesAtiv, perZone(2), 17_000); // 9s < 10s
    expect(raiseAlarm).not.toHaveBeenCalled();
    occupancy.observe(st, st.zonesAtiv, perZone(2), 18_000); // 10s → agora sim
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });

  it("zona sem occupancyToleranceMs usa o default 30s (mesmo default do cliente, zones.ts)", () => {
    const st = makeSt([zone({ occupancyToleranceMs: undefined })]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 29_999);
    expect(raiseAlarm).not.toHaveBeenCalled();
    occupancy.observe(st, st.zonesAtiv, perZone(2), 30_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });

  it("contagem IGUAL à meta nunca desvia, mesmo observada por muito tempo", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 100_000);
    expect(raiseAlarm).not.toHaveBeenCalled();
    expect(st.occupancy.get("z1").state).toBe("ok");
  });
});

describe("VIOLADA — um evento por violação + off-delay/histerese", () => {
  function violate(st) {
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 10_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  }

  it("desvio contínuo NÃO re-alerta — só a duração interna atualiza", () => {
    const st = makeSt([zone()]);
    violate(st);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 60_000);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 600_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(st.occupancy.get("z1").durationMs).toBe(600_000);
  });

  it("piscada na meta (3s < off-delay 5s) não fecha nem reabre o evento", () => {
    const st = makeSt([zone()]);
    violate(st);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 15_000); // bateu a meta por 1 rodada
    occupancy.observe(st, st.zonesAtiv, perZone(2), 18_000); // voltou a desviar em 3s < 5s
    expect(st.occupancy.get("z1").state).toBe("violada");
    expect(raiseAlarm).toHaveBeenCalledTimes(1); // sem novo alerta (histerese)
  });

  it("na meta contínua ≥ off-delay fecha; novo desvio = NOVA violação (novo alerta)", () => {
    const st = makeSt([zone()]);
    violate(st);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 15_000);
    occupancy.observe(st, st.zonesAtiv, perZone(4), 21_000); // 6s ≥ off-delay 5s → OK
    expect(st.occupancy.get("z1").state).toBe("ok");
    occupancy.observe(st, st.zonesAtiv, perZone(2), 25_000);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 36_000); // 11s ≥ 10s → 2ª violação
    expect(raiseAlarm).toHaveBeenCalledTimes(2);
  });

  it("off-delay escala com a tolerância: max(5000, tolerância/2)", () => {
    expect(offDelayMs(10_000)).toBe(5000);
    expect(offDelayMs(2000)).toBe(5000);
    expect(offDelayMs(60_000)).toBe(30_000);
  });
});

describe("recarga de zonas (camcfg-updated kind:'zones')", () => {
  it("zona que PERDEU a meta (targetOccupancy removido) para de ser vigiada e o estado é podado", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 10_000); // violada
    st.zonesAtiv = [zone({ targetOccupancy: undefined })]; // recarga: perdeu a meta
    occupancy.observe(st, st.zonesAtiv, perZone(2), 11_000);
    expect(st.occupancy.has("z1")).toBe(false);
  });

  it("zona REMOVIDA da config leva o estado junto (poda por id)", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 10_000); // violada
    st.zonesAtiv = [zone({ id: "z2", label: "Outra" })];
    occupancy.observe(st, st.zonesAtiv, perZone(4), 11_000);
    expect(st.occupancy.has("z1")).toBe(false);
    expect(st.occupancy.get("z2").state).toBe("ok");
  });

  it("sem zonas com meta: no-op e o estado residual é limpo", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    st.zonesAtiv = [];
    occupancy.observe(st, st.zonesAtiv, perZone(2), 10_000);
    expect(raiseAlarm).not.toHaveBeenCalled();
    expect(st.occupancy.size).toBe(0);
  });
});

describe("zonas múltiplas e independência", () => {
  it("cada zona de lotação tem máquina própria — só a desviada alerta", () => {
    const a = zone();
    const b = zone({ id: "z2", label: "Depósito", targetOccupancy: 1 });
    const st = makeSt([a, b]);
    const two = new Map([
      ["z1", 2], // desvia (meta 4)
      ["z2", 1], // na meta
    ]);
    occupancy.observe(st, st.zonesAtiv, two, 0);
    occupancy.observe(st, st.zonesAtiv, two, 10_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(raiseAlarm.mock.calls[0][0].zona).toBe("Sala");
    expect(st.occupancy.get("z2").state).toBe("ok");
  });
});

describe("stateOf — getter puro", () => {
  it("zona nunca observada nasce OK com 0 pessoas e a meta/tolerância do config", () => {
    const st = makeSt([zone(), zone({ id: "z2", label: "Sem tolerância", occupancyToleranceMs: undefined, targetOccupancy: 2 })]);
    const s = stateOf(st);
    expect(s.get("z1")).toEqual({ violada: false, people: 0, target: 4, toleranceMs: 10_000 });
    expect(s.get("z2")).toEqual({ violada: false, people: 0, target: 2, toleranceMs: TOLERANCE_DEFAULT_MS });
  });

  it("zona SEM targetOccupancy não aparece na projeção", () => {
    const st = makeSt([zone({ targetOccupancy: undefined })]);
    expect(stateOf(st).size).toBe(0);
  });

  it("é PURO: não cria st.occupancy nem avança a máquina; sem zonas → mapa vazio", () => {
    const st = { id: "cam1", zonesAtiv: [zone()] }; // sem st.occupancy (estado legado)
    stateOf(st);
    expect(st.occupancy).toBeUndefined();
    expect(stateOf({ id: "cam1" }).size).toBe(0);
  });

  it("desvio aquém da tolerância projeta ok COM a contagem (violada ≠ people!=target cru)", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 4000); // 4s < 10s — ainda ok
    expect(stateOf(st).get("z1")).toMatchObject({ violada: false, people: 2 });
  });

  it("violada com a meta batida dentro da histerese: violada true e people=target (o estado manda)", () => {
    const st = makeSt([zone()]);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 0);
    occupancy.observe(st, st.zonesAtiv, perZone(2), 10_000); // violada
    occupancy.observe(st, st.zonesAtiv, perZone(4), 12_000); // bateu a meta há 2s < off-delay 5s
    expect(stateOf(st).get("z1")).toMatchObject({ violada: true, people: 4 });
  });
});

describe("helpers puros", () => {
  it("toleranceMsOf: número finito ≥0 vale; ausente/inválido cai no default", () => {
    expect(toleranceMsOf(zone({ occupancyToleranceMs: 3000 }))).toBe(3000);
    expect(toleranceMsOf(zone({ occupancyToleranceMs: 0 }))).toBe(0);
    expect(toleranceMsOf(zone({ occupancyToleranceMs: undefined }))).toBe(TOLERANCE_DEFAULT_MS);
    expect(toleranceMsOf(zone({ occupancyToleranceMs: NaN }))).toBe(TOLERANCE_DEFAULT_MS);
    expect(toleranceMsOf(zone({ occupancyToleranceMs: -5 }))).toBe(TOLERANCE_DEFAULT_MS);
    expect(toleranceMsOf(null)).toBe(TOLERANCE_DEFAULT_MS);
  });

  it("st sem occupancy (estado de teste/legado) é criado sob demanda", () => {
    const st = { id: "cam1", zonesAtiv: [zone({ occupancyToleranceMs: 0 })] };
    occupancy.observe(st, st.zonesAtiv, perZone(2), 1000); // tolerância 0 → viola na 1ª observação
    expect(st.occupancy).toBeInstanceOf(Map);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });
});
