// Teste do ROUND-TRIP da allowlist de zonas (server/camcfg.js cleanZones) — CA-7 da spec
// alerta-por-atividade (armadilha A5: campo fora da allowlist é descartado MUDO no save).
// Usa SÓ a função PURA cleanZones (exportada p/ teste): não toca camcfg.json nem Postgres —
// saveZones/getZones persistem em disco real e ficam fora do unit test de propósito.
// CommonJS (server/ é pacote CJS) via createRequire, como os demais testes de server/.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cleanZones } = require("./camcfg");

// Simula "salvar e reler": allowlist → serialização JSON (Postgres/arquivo) → allowlist de novo.
function roundTrip(zones) {
  return cleanZones(JSON.parse(JSON.stringify(cleanZones(zones))));
}

describe("camcfg — round-trip da zona PROIBIDA (CA-7)", () => {
  it("preserva modo, presencaAlertMs e arming ao salvar e reler", () => {
    const [z] = roundTrip([
      {
        id: "cam-1-z1",
        label: "Cofre",
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.4,
        modo: "proibida",
        presencaAlertMs: 30_000,
        arming: "sempre",
      },
    ]);
    expect(z).toMatchObject({
      id: "cam-1-z1",
      label: "Cofre",
      modo: "proibida", // NÃO rebaixa p/ "atividade" (mesma armadilha da exclusão)
      presencaAlertMs: 30_000,
      arming: "sempre",
    });
  });

  it("aplica defaults sãos: dwell ausente → 10s; inválido/negativo → clamp; arming inválido → sempre", () => {
    const [semCampos] = roundTrip([{ id: "z1", modo: "proibida" }]);
    expect(semCampos.presencaAlertMs).toBe(10_000);
    expect(semCampos.arming).toBe("sempre");

    const [invalido] = roundTrip([
      { id: "z2", modo: "proibida", presencaAlertMs: "trinta", arming: "fora-turnos" },
    ]);
    expect(invalido.presencaAlertMs).toBe(10_000); // não-número → default
    expect(invalido.arming).toBe("sempre"); // valor de onda futura → normalizado

    const [negativo] = roundTrip([{ id: "z3", modo: "proibida", presencaAlertMs: -5 }]);
    expect(negativo.presencaAlertMs).toBe(0); // clamp inferior

    const [gigante] = roundTrip([{ id: "z4", modo: "proibida", presencaAlertMs: 1e12 }]);
    expect(gigante.presencaAlertMs).toBe(86_400_000); // clamp superior (24h)
  });

  it("retrocompat: zona de outro modo não muda de comportamento (campos antigos intactos)", () => {
    const [z] = roundTrip([
      {
        id: "cam-1-za",
        label: "Espera",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        modo: "atividade",
        idleAlertMs: 120_000,
        sensitivity: 7,
        atividade: "Carga",
        mask: "8x8:AAAA",
      },
    ]);
    expect(z).toMatchObject({
      modo: "atividade",
      idleAlertMs: 120_000,
      sensitivity: 7,
      atividade: "Carga",
      mask: "8x8:AAAA",
    });
    // os campos novos existem com default (aditivo) — nenhum consumidor antigo os lê
    expect(z.presencaAlertMs).toBe(10_000);
    expect(z.arming).toBe("sempre");
  });

  it("round-trip é idempotente (limpar 2× = limpar 1×)", () => {
    const uma = cleanZones([
      { id: "z", modo: "proibida", presencaAlertMs: 5_000, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    ]);
    expect(roundTrip(uma)).toEqual(uma);
  });
});
