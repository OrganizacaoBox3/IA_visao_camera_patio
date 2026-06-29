// Testes do agregador por PONTO DE LEITURA (cluster.ts): dedup por (ponto, código) na janela,
// confirmação multi-câmera, passagens físicas e taxa de leitura. Determinístico: todos os
// timestamps são explícitos (ts). O store é singleton de módulo → resetCluster() entre testes.
import { describe, it, expect, beforeEach } from "vitest";
import { pushRead, pushPass, snapshot, resetCluster, type ReadEvent } from "./cluster";
import { APP_CONFIG } from "../config";

const W = APP_CONFIG.reading.dedupWindowMs; // 1500
const REC = APP_CONFIG.reading.recentWindowMs; // 60000

function read(over: Partial<ReadEvent>): ReadEvent {
  return {
    cameraId: "c1",
    cameraLabel: "Câmera 1",
    ponto: "P",
    code: "X",
    format: "ean_13",
    ts: 1000,
    ...over,
  };
}

beforeEach(() => resetCluster());

describe("pushRead — agregação de caixas", () => {
  it("primeira leitura abre uma caixa nova", () => {
    const r = pushRead(read({ ts: 1000 }));
    expect(r.newBox).toBe(true);
    expect(r.becameMulti).toBe(false);
  });

  it("mesmo código + 2ª câmera dentro da janela confirma a MESMA caixa (multi-read)", () => {
    pushRead(read({ cameraId: "c1", ts: 1000 }));
    const r = pushRead(read({ cameraId: "c2", cameraLabel: "Câmera 2", ts: 1000 + W })); // dentro da janela (<=)
    expect(r.newBox).toBe(false);
    expect(r.becameMulti).toBe(true);

    const snap = snapshot(
      "P",
      [
        { cameraId: "c1", cameraLabel: "Câmera 1" },
        { cameraId: "c2", cameraLabel: "Câmera 2" },
      ],
      1000 + W + 10,
    );
    expect(snap.boxesRecent).toBe(1);
    expect(snap.multiReads).toBe(1);
    const byCam = Object.fromEntries(snap.perCamera.map((p) => [p.cameraId, p.reads]));
    expect(byCam.c1).toBe(1);
    expect(byCam.c2).toBe(1);
  });

  it("mesmo código além da janela de dedup = caixa nova (proximidade temporal não agrupa)", () => {
    pushRead(read({ ts: 1000 }));
    const r = pushRead(read({ ts: 1000 + W + 1 })); // > janela → outra caixa
    expect(r.newBox).toBe(true);
    expect(r.becameMulti).toBe(false);
    const snap = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], 1000 + W + 10);
    expect(snap.boxesRecent).toBe(2);
  });

  it("códigos distintos no mesmo ponto = caixas distintas, sem multi-read", () => {
    pushRead(read({ code: "A", ts: 1000 }));
    pushRead(read({ code: "B", ts: 1100 }));
    const snap = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], 1200);
    expect(snap.boxesRecent).toBe(2);
    expect(snap.multiReads).toBe(0);
  });

  it("câmera membro que não leu aparece com contribuição 0", () => {
    pushRead(read({ cameraId: "c1", code: "A", ts: 1000 }));
    const snap = snapshot(
      "P",
      [
        { cameraId: "c1", cameraLabel: "Câmera 1" },
        { cameraId: "c2", cameraLabel: "Câmera 2" },
      ],
      1100,
    );
    const byCam = Object.fromEntries(snap.perCamera.map((p) => [p.cameraId, p.reads]));
    expect(byCam.c1).toBe(1);
    expect(byCam.c2).toBe(0);
  });
});

describe("pushPass — passagens físicas dedup por janela", () => {
  it("passagens dentro da janela colapsam em uma; além da janela contam separadas", () => {
    const p1 = pushPass({ cameraId: "c1", ponto: "P", ts: 1000 });
    const p2 = pushPass({ cameraId: "c2", ponto: "P", ts: 1000 + W }); // 1500-1000=1500, não > 1500 → mesma
    const p3 = pushPass({ cameraId: "c1", ponto: "P", ts: 1000 + 2 * W + 1 }); // > janela → nova
    expect(p1.newPassage).toBe(true);
    expect(p2.newPassage).toBe(false);
    expect(p3.newPassage).toBe(true);
    const snap = snapshot("P", [], 1000 + 2 * W + 10);
    expect(snap.passages).toBe(2);
  });
});

describe("snapshot — taxa de leitura / no-reads", () => {
  it("calcula readRatePct e noReads a partir de passagens × caixas", () => {
    // 4 passagens (cada uma > janela da anterior) e 2 caixas lidas
    pushPass({ cameraId: "c1", ponto: "P", ts: 0 });
    pushPass({ cameraId: "c1", ponto: "P", ts: 2 * W });
    pushPass({ cameraId: "c1", ponto: "P", ts: 4 * W });
    pushPass({ cameraId: "c1", ponto: "P", ts: 6 * W });
    pushRead(read({ code: "A", ts: 100 }));
    pushRead(read({ code: "B", ts: 200 }));
    const now = 6 * W + 100; // tudo dentro da janela recente
    expect(now).toBeLessThan(REC); // sanidade: nada foi podado
    const snap = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], now);
    expect(snap.passages).toBe(4);
    expect(snap.boxesRecent).toBe(2);
    expect(snap.noReads).toBe(2); // 4 - 2
    expect(snap.readRatePct).toBe(50); // 2/4
  });

  it("sem passagens registradas, readRatePct é 100 (não penaliza)", () => {
    pushRead(read({ code: "A", ts: 100 }));
    const snap = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], 200);
    expect(snap.passages).toBe(0);
    expect(snap.readRatePct).toBe(100);
    expect(snap.noReads).toBe(0);
  });

  it("poda o que saiu da janela recente", () => {
    pushRead(read({ code: "A", ts: 1000 })); // bem antigo
    pushRead(read({ code: "B", ts: REC + 1000 })); // recente
    const snap = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], REC + 1000);
    // a leitura em ts=1000 saiu da janela (cutoff = now - REC = 1000, mantém >= cutoff)
    expect(snap.boxesRecent).toBe(2);
    const later = snapshot("P", [{ cameraId: "c1", cameraLabel: "Câmera 1" }], REC + 2000);
    expect(later.boxesRecent).toBe(1); // a antiga foi podada
  });
});
