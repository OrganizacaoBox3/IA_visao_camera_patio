// Loader da gravação BLE (recording.ts): round-trip do JSONL gravado → EvidenceBatch[] + skip de linha suja.
import { describe, it, expect } from "vitest";
import { labeledRecording, parseRecording, toRecording } from "./recording";
import { replay } from "./replay";
import { baselineEngine } from "./engine";

// Uma linha JSONL como o server/bt/recorder.js escreve (metadados-only).
const rec = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseRecording", () => {
  it("faz round-trip de linhas gravadas para EvidenceBatch[]", () => {
    const lines = [
      rec({ ts: 1000, lat: -23.5, lon: -46.6, acc: 12, tags: [{ mac: "AA:BB", rssi: -60, rotulo: "carrinho-07" }] }),
      rec({ ts: 2000, lat: -23.51, lon: -46.61, acc: null, tags: [{ mac: "CC:DD", rssi: -70 }] }),
    ];

    const batches = parseRecording(lines);

    expect(batches).toHaveLength(2);
    // Batch completo: acc vira accuracyM; tag com rótulo vira label.
    expect(batches[0]).toEqual({
      ts: 1000,
      collectorPos: { lat: -23.5, lon: -46.6 },
      accuracyM: 12,
      seen: [{ tagId: "AA:BB", rssi: -60, label: "carrinho-07" }],
    });
    // acc null → SEM accuracyM (não vira 0); tag sem rótulo → SEM label.
    expect(batches[1]).toEqual({
      ts: 2000,
      collectorPos: { lat: -23.51, lon: -46.61 },
      seen: [{ tagId: "CC:DD", rssi: -70 }],
    });
  });

  it("pula linhas malformadas/vazias sem lançar", () => {
    const lines = [
      "{ isto nao e json",
      "",
      "   ",
      rec({ ts: 3000, lat: -23.5, lon: -46.6, tags: [] }),
      rec({ ts: 4000, lat: "nao-numero", lon: -46.6, tags: [] }), // lat inválida → linha pulada
    ];

    const batches = parseRecording(lines);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.ts).toBe(3000);
    expect(batches[0]?.seen).toEqual([]);
  });

  it("descarta tag sem MAC ou com RSSI não-finito, mantendo o batch", () => {
    const lines = [
      rec({
        ts: 5000,
        lat: 0,
        lon: 0,
        tags: [{ mac: "", rssi: -50 }, { mac: "EE:FF", rssi: "x" }, { mac: "11:22", rssi: -55 }],
      }),
    ];

    const batches = parseRecording(lines);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.seen).toEqual([{ tagId: "11:22", rssi: -55 }]);
  });

  it("toRecording embrulha com truth vazio (dado real não tem ground truth)", () => {
    const r = toRecording([rec({ ts: 1, lat: 0, lon: 0, tags: [] })]);

    expect(r.truth).toEqual([]);
    expect(r.batches).toHaveLength(1);
  });
});

describe("labeledRecording (RMSE-vs-truth de campo, tags estáticas)", () => {
  it("anexa a posição-verdade fixa a cada instante e fica medível pelo harness", () => {
    // Coletor sempre a ~1 m de leste da tag AA (verdade em 0,0); o baseline estampa o GPS do coletor.
    const dLon1m = 1 / (111_320 * Math.cos(0)); // 1 m em graus de lon no equador
    const lines = [
      rec({ ts: 1000, lat: 0, lon: dLon1m, tags: [{ mac: "AA", rssi: -41 }] }),
      rec({ ts: 2000, lat: 0, lon: dLon1m, tags: [{ mac: "AA", rssi: -41 }] }),
    ];

    const r = labeledRecording(lines, { AA: { lat: 0, lon: 0 } });
    expect(r.batches).toHaveLength(2);
    expect(r.truth).toHaveLength(2);
    expect(r.truth[0]).toEqual({ ts: 1000, positions: { AA: { lat: 0, lon: 0 } } });

    // O harness já computa RMSE real: baseline estampa o coletor (~1 m da verdade) → RMSE ≈ 1 m.
    const m = replay(r, baselineEngine);
    expect(m.coverage).toBe(1);
    expect(m.positionRmseM).toBeGreaterThan(0.5);
    expect(m.positionRmseM).toBeLessThan(1.5);
  });
});
