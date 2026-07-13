// GATE DE TURNO (server/alarm/shift.js) — os critérios de aceite da spec-turnos-por-zona que
// viram teste: CA-2 (gate de ociosidade), CA-3 (pausa), CA-5 (default seguro + arming da zona
// proibida, E4 da spec irmã) e a borda D4. As FONTES (camcfg/shifts/SITE_TZ) são injetadas —
// o teste é puro: não toca camcfg.json, Postgres nem o relógio do processo.
// CommonJS (server/ é pacote CJS) via createRequire, como os demais testes de server/.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gate = require("./shift");

// Quarta-feira, 15/07/2026, no fuso do site (America/Sao_Paulo = UTC-3).
// at(10) = 10:00 local daquela quarta (o overflow de hora vira o dia UTC corretamente).
const at = (h, m = 0) => Date.UTC(2026, 6, 15, h + 3, m);
const SEG_A_SEX = [1, 2, 3, 4, 5]; // 0=dom..6=sáb (a data acima é uma QUARTA = 3)

const T1 = { id: "sh1", nome: "Turno 1", dias: SEG_A_SEX, inicio: "06:00", fim: "14:00", pausas: [], ativo: true };
const T2 = { id: "sh2", nome: "Turno 2", dias: SEG_A_SEX, inicio: "14:00", fim: "22:00", pausas: [], ativo: true };
// Mesmo turno, com a pausa de almoço 12:00–13:00 (CA-3).
const T1_PAUSA = { ...T1, pausas: [{ inicio: "12:00", duracaoMin: 60 }] };

// Fontes injetadas: uma câmera "cam-1" com as zonas dadas + o cadastro de turnos dado.
function sources(zones, shifts = [T1, T2]) {
  return {
    getZones: (cameraId) => (cameraId === "cam-1" ? zones : []),
    allShifts: () => shifts,
    tz: () => "America/Sao_Paulo", // fuso do SITE, não o do processo (D6/CA-6)
  };
}
const zonaAtiv = (patch) => ({ id: "z1", label: "Expedição", modo: "atividade", arming: "sempre", shiftIds: [], ...patch });
const zonaProib = (patch) => ({ id: "z9", label: "Cofre", modo: "proibida", arming: "sempre", shiftIds: [], ...patch });

// Alerta de INATIVIDADE como a política o entrega (cameraId + zona + tipo já derivados).
const inatividade = { cameraId: "cam-1", zona: "expedição", tipo: "atividade", text: "⚠ Doca: Expedição sem movimentação há 11m." };
const presenca = { cameraId: "cam-1", zona: "cofre", tipo: "presenca", text: "⚠ Doca: presença em área proibida (Cofre) há 12s" };

const suprimido = (p, ts, src) => gate.suppressedByShift(p, ts, src);

beforeEach(() => gate._resetMetrics());

describe("CA-2 — gate de ociosidade (alerta de inatividade só dentro do turno)", () => {
  const src = sources([zonaAtiv({ shiftIds: ["sh1"] })]); // Turno 1: 06:00–14:00 seg–sex

  it("zona vazia às 10:00 (DENTRO do turno) → o alerta PASSA", () => {
    expect(suprimido(inatividade, at(10), src)).toBe(false);
    expect(gate.shiftMetrics(at(10)).total).toBe(0);
  });

  it("zona vazia às 15:00 e às 05:00 (FORA do turno) → NENHUM alerta + contador incrementa", () => {
    expect(suprimido(inatividade, at(15), src)).toBe(true);
    expect(suprimido(inatividade, at(5), src)).toBe(true);
    const m = gate.shiftMetrics(at(15));
    expect(m.total).toBe(2);
    expect(m.byReason["fora-do-turno"]).toBe(2);
  });

  it("borda (D4): 14:00 pertence ao turno que INICIA — com os dois turnos atribuídos, passa", () => {
    const dois = sources([zonaAtiv({ shiftIds: ["sh1", "sh2"] })]);
    expect(suprimido(inatividade, at(14), dois)).toBe(false); // 14:00 = início do Turno 2
    expect(suprimido(inatividade, at(22), dois)).toBe(true); // 22:00 = fim do Turno 2 (janela [ini,fim))
  });

  it("dia SEM turno (sábado 10:00) → suprimido (a área não deveria estar trabalhando)", () => {
    const sabado = Date.UTC(2026, 6, 18, 13); // sáb 10:00 local
    expect(suprimido(inatividade, sabado, src)).toBe(true);
  });

  it("zona reconhecida pelo TEXTO do emissor legado (sem `zona` no payload)", () => {
    // O alerta de ociosidade do cliente só carrega o texto "⚠ <câmera>: <ZONA> sem movimentação…"
    const legado = { cameraId: "cam-1", tipo: "atividade", text: "⚠ Doca: Expedição sem movimentação há 11m." };
    expect(suprimido(legado, at(15), src)).toBe(true); // resolve a zona pelo prefixo do corpo
    expect(suprimido(legado, at(10), src)).toBe(false);
  });
});

describe("CA-3 — pausa (vazio ESPERADO no almoço)", () => {
  const src = sources([zonaAtiv({ shiftIds: ["sh1"] })], [T1_PAUSA, T2]);

  it("vazia das 12:10 às 12:50 (dentro da pausa 12:00–13:00) → nenhum alerta", () => {
    expect(suprimido(inatividade, at(12, 10), src)).toBe(true);
    expect(suprimido(inatividade, at(12, 50), src)).toBe(true);
    expect(gate.shiftMetrics(at(13)).byReason["em-pausa"]).toBe(2);
  });

  it("13:00 (fim da pausa, ainda no turno) → volta a alertar", () => {
    expect(suprimido(inatividade, at(13), src)).toBe(false);
    expect(suprimido(inatividade, at(11, 59), src)).toBe(false);
  });
});

describe("CA-5 — default seguro: zona SEM turnos = comportamento de hoje (24/7)", () => {
  const src = sources([zonaAtiv({ shiftIds: [] })]);

  it("inatividade passa em QUALQUER hora (sem shiftIds nada é suprimido)", () => {
    for (const h of [0, 3, 10, 15, 23]) expect(suprimido(inatividade, at(h), src)).toBe(false);
    expect(gate.shiftMetrics(at(10)).total).toBe(0);
  });

  it("shiftIds ÓRFÃO (turno excluído do cadastro) → fail-open: passa (não cala o alarme)", () => {
    const orfa = sources([zonaAtiv({ shiftIds: ["sh-que-nao-existe"] })]);
    expect(suprimido(inatividade, at(3), orfa)).toBe(false);
  });

  it("zona não identificável (outra câmera / zona inexistente) → passa", () => {
    expect(suprimido({ ...inatividade, cameraId: "cam-outra" }, at(3), src)).toBe(false);
    expect(suprimido({ ...inatividade, zona: "sala x", text: "⚠ Doca: sala x parada" }, at(3), src)).toBe(false);
  });

  it("tipos fora do escopo do gate (fadiga/leitura/objetos) nunca são suprimidos", () => {
    const zf = sources([zonaAtiv({ shiftIds: ["sh1"] })]);
    expect(suprimido({ ...inatividade, tipo: "fadiga" }, at(3), zf)).toBe(false);
    expect(suprimido({ ...inatividade, tipo: "objetos" }, at(3), zf)).toBe(false);
  });

  it("tipo × modo cruzados não se gateiam com a config um do outro", () => {
    // alarme de INATIVIDADE apontando uma zona PROIBIDA (com turnos) → sem janela definida, passa
    const proib = sources([zonaProib({ label: "Expedição", shiftIds: ["sh1"] })]);
    expect(suprimido(inatividade, at(3), proib)).toBe(false);
    // alarme de PRESENÇA apontando uma zona de ATIVIDADE → o arming dela não vale, passa
    const ativ = sources([zonaAtiv({ label: "Cofre", arming: "fora-turnos", shiftIds: ["sh1"] })]);
    expect(suprimido(presenca, at(10), ativ)).toBe(false);
  });
});

describe("CA-5/E4 — arming da zona PROIBIDA (presença)", () => {
  it('"sempre" (default): alerta 24/7, com ou sem turnos atribuídos', () => {
    const src = sources([zonaProib({ arming: "sempre", shiftIds: ["sh1"] })]);
    expect(suprimido(presenca, at(23), src)).toBe(false);
    expect(suprimido(presenca, at(10), src)).toBe(false);
  });

  it('"fora-turnos": 23h → ALERTA; 10h (dentro do Turno 1) → silêncio + contador', () => {
    const src = sources([zonaProib({ arming: "fora-turnos", shiftIds: ["sh1"] })]);
    expect(suprimido(presenca, at(23), src)).toBe(false); // fora do turno → área proibida ARMADA
    expect(suprimido(presenca, at(10), src)).toBe(true); // dentro do turno → área liberada
    const m = gate.shiftMetrics(at(10));
    expect(m.total).toBe(1);
    expect(m.byReason["presenca-dentro-do-turno"]).toBe(1);
  });

  it('"dentro-turnos": 10h → ALERTA; 23h → silêncio + contador', () => {
    const src = sources([zonaProib({ arming: "dentro-turnos", shiftIds: ["sh1"] })]);
    expect(suprimido(presenca, at(10), src)).toBe(false);
    expect(suprimido(presenca, at(23), src)).toBe(true);
    expect(gate.shiftMetrics(at(23)).byReason["presenca-fora-do-turno"]).toBe(1);
  });

  it("a PAUSA não desarma a vigilância (área proibida no almoço segue proibida)", () => {
    const src = sources([zonaProib({ arming: "dentro-turnos", shiftIds: ["sh1"] })], [T1_PAUSA, T2]);
    expect(suprimido(presenca, at(12, 30), src)).toBe(false); // dentro do turno (mesmo em pausa) → armada
  });

  it('arming sem turno atribuído → 24/7 (config incompleta NUNCA cala um alarme)', () => {
    const src = sources([zonaProib({ arming: "dentro-turnos", shiftIds: [] })]);
    expect(suprimido(presenca, at(3), src)).toBe(false);
  });
});
