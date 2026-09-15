// Testes do gate de turno do MOTOR (shift-gate.js). O que está em jogo é assimétrico: errar
// para "fica acordada" custa dinheiro; errar para "dorme" custa CEGUEIRA — o motor parado
// enquanto o alarme se acha armado. Por isso a maioria dos casos aqui trava o fail-open.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cameraPodeDormir } = require("./shift-gate");

const NOW = 1_800_000_000_000;
// gate fake: devolve supressão para as zonas listadas, null (passa) para as demais.
const gateQueSuprime = (ids) => (p) =>
  ids.includes(p.zona) ? { reason: "fora-do-turno", zoneId: p.zona } : null;

describe("cameraPodeDormir", () => {
  it("dorme quando TODAS as zonas estão fora de janela", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1" }, { id: "z2" }],
      gate: gateQueSuprime(["z1", "z2"]),
    });
    expect(r.dorme).toBe(true);
  });

  it("UMA zona ainda ativa segura a câmera acordada", () => {
    // O caso que impede o buraco de vigilância: basta uma zona viva para o motor continuar.
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1" }, { id: "z2" }],
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
      getZones: () => [{ id: "z-atividade" }, { id: "z-proibida", modo: "proibida" }],
      gate: gateReal,
    });
    expect(r.dorme).toBe(false);
  });

  it("câmera SEM zonas nunca dorme (pode estar ali por linha de contagem ou foco)", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [],
      gate: () => ({ reason: "fora-do-turno", zoneId: "x" }),
    });
    expect(r.dorme).toBe(false);
    expect(r.motivo).toBe("sem-zonas");
  });

  it("desligado por default: não muda o que o motor processa sem opt-in explícito", () => {
    const r = cameraPodeDormir("cam-1", NOW, {
      ligado: false,
      getZones: () => [{ id: "z1" }],
      gate: gateQueSuprime(["z1"]),
    });
    expect(r.dorme).toBe(false);
    expect(r.motivo).toBe("gate-desligado");
  });

  it("consulta o gate com o tipo da zona (atividade x presenca)", () => {
    // Ler a janela errada calaria o alarme com a config de outro mecanismo — o mesmo cuidado
    // que alarm/shift.js toma ao casar tipo × modo.
    const vistos = [];
    cameraPodeDormir("cam-1", NOW, {
      ligado: true,
      getZones: () => [{ id: "z1" }, { id: "z2", modo: "proibida" }],
      gate: (p) => {
        vistos.push(p.tipo);
        return { reason: "fora-do-turno", zoneId: p.zona };
      },
    });
    expect(vistos).toEqual(["atividade", "presenca"]);
  });
});
