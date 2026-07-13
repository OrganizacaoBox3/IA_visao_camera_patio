// Testes da MÁQUINA DE ESTADOS de presença em zona proibida (presence-alert.js)
// — o produtor server-side do alarme tipo "presenca" (spec-alerta-por-atividade
// F2). Aqui a máquina roda com tracks sintéticos e observações ESPARSAS (a
// semântica do gate de movimento: rodada pulada = sem observação = dwell segue).
// vitest é ESM; os módulos são CommonJS → createRequire (padrão da pasta).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPresenceAlert, offDelayMs, dwellMsOf, DWELL_DEFAULT_MS } = require("./presence-alert");

// Zona proibida ocupando a metade ESQUERDA do frame (centro do bbox decide).
const zone = (over = {}) => ({
  id: "p1",
  label: "Área Restrita",
  modo: "proibida",
  presencaAlertMs: 10_000,
  x: 0,
  y: 0,
  w: 0.5,
  h: 1,
  ...over,
});

// Estado mínimo por câmera (os campos que o observe usa do createState do engine).
const makeSt = (zonesProib) => ({ id: "cam1", zonesProib, presence: new Map() });

// Track com CENTRO do bbox em (cx, cy) — a âncora do attributeZone.
const track = (cx, cy) => ({ id: 1, bbox: [cx - 0.05, cy - 0.2, 0.1, 0.4] });
const inside = () => [track(0.25, 0.5)]; // centro na zona (x<0.5)
const outside = () => [track(0.75, 0.5)]; // centro fora da zona

let raiseAlarm;
let presence;
beforeEach(() => {
  raiseAlarm = vi.fn();
  presence = createPresenceAlert({ raiseAlarm, cameraLabelOf: () => "Câmera 1" });
});

describe("dwell — ARMADA → VIOLADA (CA-1/CA-2 da spec)", () => {
  it("permanência 12s ≥ dwell 10s → UM alerta com payload estruturado (tipo presenca)", () => {
    const st = makeSt([zone()]);
    // Observações esparsas (0/6s/12s), como o probe do gate entrega: o dwell conta
    // de presentSince — as rodadas PULADAS no meio não observam e NÃO resetam.
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 6000);
    expect(raiseAlarm).not.toHaveBeenCalled(); // 6s < 10s
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(raiseAlarm.mock.calls[0][0]).toEqual({
      text: "⚠ Câmera 1: presença em área proibida (Área Restrita) há 12s",
      ts: 12_000,
      cameraId: "cam1",
      cameraLabel: "Câmera 1",
      zona: "Área Restrita",
      tipo: "presenca",
    });
    expect(st.presence.get("p1").state).toBe("violada");
  });

  it("travessia 4s < dwell → NENHUM alerta; a saída reseta o contador", () => {
    const st = makeSt([zone()]);
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 4000);
    presence.observe(st, outside(), 6000); // saiu antes do dwell → reset
    presence.observe(st, inside(), 8000); // voltou — âncora nova em 8s
    presence.observe(st, inside(), 17_000); // 9s de permanência NOVA < 10s
    expect(raiseAlarm).not.toHaveBeenCalled();
    presence.observe(st, inside(), 18_000); // 10s → agora sim
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });

  it("zona sem presencaAlertMs usa o default 10s (contrato pinado)", () => {
    const st = makeSt([zone({ presencaAlertMs: undefined })]);
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 9999);
    expect(raiseAlarm).not.toHaveBeenCalled();
    presence.observe(st, inside(), 10_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });

  it("dwell configurado da zona é respeitado (2s alerta aos 2s)", () => {
    const st = makeSt([zone({ presencaAlertMs: 2000 })]);
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 2000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  });
});

describe("VIOLADA — um evento por violação + off-delay/histerese (CA-6)", () => {
  // Leva a máquina até VIOLADA em t=12s (dwell 10s, off-delay = max(5000, 5000) = 5s).
  function violate(st) {
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
  }

  it("permanência contínua NÃO re-alerta — só a duração interna atualiza", () => {
    const st = makeSt([zone()]);
    violate(st);
    presence.observe(st, inside(), 60_000);
    presence.observe(st, inside(), 600_000); // 10min depois — MESMO evento (CA-1)
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(st.presence.get("p1").durationMs).toBe(600_000); // violatedAt=0 → duração honesta
  });

  it("piscada (vazia 3s < off-delay 5s) não fecha nem reabre o evento", () => {
    const st = makeSt([zone()]);
    violate(st);
    presence.observe(st, outside(), 20_000); // esvaziou
    presence.observe(st, inside(), 23_000); // voltou em 3s < 5s → segue VIOLADA
    expect(st.presence.get("p1").state).toBe("violada");
    expect(raiseAlarm).toHaveBeenCalledTimes(1); // sem novo alerta (histerese)
  });

  it("vazia contínua ≥ off-delay re-arma; nova permanência = NOVA violação (novo alerta)", () => {
    const st = makeSt([zone()]);
    violate(st);
    presence.observe(st, outside(), 20_000);
    presence.observe(st, outside(), 26_000); // 6s ≥ 5s → ARMADA
    expect(st.presence.get("p1").state).toBe("armada");
    presence.observe(st, inside(), 30_000);
    presence.observe(st, inside(), 41_000); // 11s ≥ dwell → 2ª violação
    expect(raiseAlarm).toHaveBeenCalledTimes(2);
  });

  it("off-delay escala com o dwell: max(5000, dwell/2)", () => {
    expect(offDelayMs(10_000)).toBe(5000);
    expect(offDelayMs(2000)).toBe(5000); // piso de 5s (flicker nunca fecha/reabre)
    expect(offDelayMs(60_000)).toBe(30_000);
  });
});

describe("recarga de zonas (camcfg-updated kind:'zones')", () => {
  it("zona REMOVIDA da config leva o estado junto (poda por id)", () => {
    const st = makeSt([zone()]);
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 12_000); // violada
    st.zonesProib = [zone({ id: "p2", label: "Outra" })]; // recarga: p1 saiu, p2 entrou
    presence.observe(st, outside(), 13_000);
    expect(st.presence.has("p1")).toBe(false); // estado órfão podado
    expect(st.presence.get("p2").state).toBe("armada");
  });

  it("zona que PERMANECE (mesmo id) preserva dwell/violação através da recarga", () => {
    const st = makeSt([zone()]);
    presence.observe(st, inside(), 0);
    st.zonesProib = [zone()]; // recarga sem mudança de id
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1); // dwell contado de t=0 sobreviveu
  });

  it("sem zonas proibidas: no-op e o estado residual é limpo", () => {
    const st = makeSt([zone()]);
    presence.observe(st, inside(), 0);
    st.zonesProib = [];
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).not.toHaveBeenCalled();
    expect(st.presence.size).toBe(0);
  });
});

describe("zonas múltiplas e independência", () => {
  it("cada zona proibida tem máquina própria — só a ocupada alerta", () => {
    const left = zone(); // metade esquerda
    const right = zone({ id: "p2", label: "Depósito", x: 0.5 }); // metade direita
    const st = makeSt([left, right]);
    presence.observe(st, inside(), 0); // só na esquerda
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(raiseAlarm.mock.calls[0][0].zona).toBe("Área Restrita");
    expect(st.presence.get("p2").state).toBe("armada"); // a outra segue armada
  });

  it("zonas SOBREPOSTAS veem a mesma pessoa cada uma (violação é por zona)", () => {
    const a = zone();
    const b = zone({ id: "p2", label: "Sobreposta", w: 0.6 }); // cobre a mesma área
    const st = makeSt([a, b]);
    presence.observe(st, inside(), 0);
    presence.observe(st, inside(), 12_000);
    expect(raiseAlarm).toHaveBeenCalledTimes(2); // uma violação POR zona
    const zonas = raiseAlarm.mock.calls.map((c) => c[0].zona).sort();
    expect(zonas).toEqual(["Sobreposta", "Área Restrita"].sort());
  });
});

describe("helpers puros", () => {
  it("dwellMsOf: número finito ≥0 vale; ausente/inválido cai no default", () => {
    expect(dwellMsOf(zone({ presencaAlertMs: 3000 }))).toBe(3000);
    expect(dwellMsOf(zone({ presencaAlertMs: 0 }))).toBe(0); // 0 explícito = alerta imediato
    expect(dwellMsOf(zone({ presencaAlertMs: undefined }))).toBe(DWELL_DEFAULT_MS);
    expect(dwellMsOf(zone({ presencaAlertMs: NaN }))).toBe(DWELL_DEFAULT_MS);
    expect(dwellMsOf(zone({ presencaAlertMs: -5 }))).toBe(DWELL_DEFAULT_MS);
    expect(dwellMsOf(null)).toBe(DWELL_DEFAULT_MS);
  });

  it("st sem presence (estado de teste/legado) é criado sob demanda", () => {
    const st = { id: "cam1", zonesProib: [zone({ presencaAlertMs: 0 })] };
    presence.observe(st, inside(), 1000); // dwell 0 → viola na 1ª observação
    expect(st.presence).toBeInstanceOf(Map);
    expect(raiseAlarm).toHaveBeenCalledTimes(1);
    expect(raiseAlarm.mock.calls[0][0].text).toContain("há 0s");
  });
});
