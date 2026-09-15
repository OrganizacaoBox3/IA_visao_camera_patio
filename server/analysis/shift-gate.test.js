// Testes do gate de turno do MOTOR (shift-gate.js). O que está em jogo é assimétrico: errar
// para "fica acordada" custa dinheiro; errar para "dorme" custa CEGUEIRA — o motor parado
// enquanto o alarme se acha armado.
//
// Regra do dono (15/09/2026): sem turno declarado, não processa. Isso inverte o fail-open da
// spec DENTRO do motor, e por isso os testes abaixo separam com rigor os dois motivos de sono:
// `fora-janela` (economia funcionando) × `sem-config` (parque cego esperando configuração).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cameraPodeDormir } = require("./shift-gate");

const NOW = 1_800_000_000_000;
const TURNOS = [{ id: "t-manha", ativo: true }, { id: "t-noite", ativo: true }];
// gate fake: suprime as zonas listadas, deixa passar as demais.
const gateQueSuprime = (ids) => (p) =>
  ids.includes(p.zona) ? { reason: "fora-do-turno", zoneId: p.zona } : null;
const comTurno = (id) => ({ id, shiftIds: ["t-manha"] });

describe("cameraPodeDormir — zonas COM turno declarado", () => {
  it("dorme quando todas as zonas estão fora de janela", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [comTurno("z1"), comTurno("z2")],
      allShifts: () => TURNOS,
      gate: gateQueSuprime(["z1", "z2"]),
    });
    expect(r).toEqual({ dorme: true, motivo: "fora-janela" });
  });

  it("UMA zona ainda ativa segura a câmera acordada", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [comTurno("z1"), comTurno("z2")],
      allShifts: () => TURNOS,
      gate: gateQueSuprime(["z1"]),
    });
    expect(r.dorme).toBe(false);
    expect(r.motivo).toBe("zona-ativa:z2");
  });

  it("zona proibida armada FORA do turno mantém a câmera acordada de madrugada", () => {
    // Regressão do erro que um gate ingênuo cometeria ("fora do turno, desliga"): esta zona
    // existe para pegar invasão fora do expediente. O gate de alarme não a suprime lá fora,
    // então o motor não pode dormir — senão a vigilância noturna morre em silêncio.
    const gateReal = (p) =>
      p.tipo === "presenca" ? null : { reason: "fora-do-turno", zoneId: p.zona };
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [
        comTurno("z-atividade"),
        { id: "z-proibida", modo: "proibida", shiftIds: ["t-noite"] },
      ],
      allShifts: () => TURNOS,
      gate: gateReal,
    });
    expect(r.dorme).toBe(false);
  });

  it("consulta o gate com o tipo da zona (atividade x presenca)", () => {
    const vistos = [];
    cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [comTurno("z1"), { id: "z2", modo: "proibida", shiftIds: ["t-manha"] }],
      allShifts: () => TURNOS,
      gate: (p) => {
        vistos.push(p.tipo);
        return { reason: "fora-do-turno", zoneId: p.zona };
      },
    });
    expect(vistos).toEqual(["atividade", "presenca"]);
  });
});

describe("cameraPodeDormir — SEM turno declarado (a inversão pedida pelo dono)", () => {
  it("zona sem shiftIds não justifica processar", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1" }],
      allShifts: () => TURNOS,
      gate: () => null, // o gate de ALARME deixaria passar (fail-open) — o motor, não.
    });
    expect(r).toEqual({ dorme: true, motivo: "sem-config" });
  });

  it("câmera sem zona nenhuma também dorme", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [],
      allShifts: () => TURNOS,
      gate: () => null,
    });
    expect(r).toEqual({ dorme: true, motivo: "sem-config" });
  });

  it("shiftIds ÓRFÃO (turno excluído) conta como sem turno", () => {
    // Senão uma zona com ids mortos passaria por configurada e o motor rodaria 24/7 achando
    // que havia janela — o pior dos dois mundos: gasta e não vigia direito.
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1", shiftIds: ["t-que-foi-excluido"] }],
      allShifts: () => TURNOS,
      gate: () => null,
    });
    expect(r.motivo).toBe("sem-config");
  });

  it("turno INATIVO conta como sem turno", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1", shiftIds: ["t-off"] }],
      allShifts: () => [{ id: "t-off", ativo: false }],
      gate: () => null,
    });
    expect(r.motivo).toBe("sem-config");
  });

  it("uma zona COM turno acorda a câmera mesmo com as outras sem configuração", () => {
    // O laço não pode parar na primeira zona sem turno: a vigilância viva pode estar na segunda.
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z-sem" }, comTurno("z-com")],
      allShifts: () => TURNOS,
      gate: gateQueSuprime([]), // z-com passaria → acorda
    });
    expect(r.dorme).toBe(false);
    expect(r.motivo).toBe("zona-ativa:z-com");
  });
});

describe("cameraPodeDormir — chave desligada", () => {
  it("não muda o que o motor processa sem opt-in explícito", () => {
    // Com a inversão acima, ligar sem configurar turno cega o parque inteiro. O default
    // desligado é o que impede isso de chegar de carona num deploy.
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: false,
      getZones: () => [],
      allShifts: () => [],
      gate: () => ({ reason: "fora-do-turno", zoneId: "x" }),
    });
    expect(r).toEqual({ dorme: false, motivo: "gate-desligado" });
  });
});
