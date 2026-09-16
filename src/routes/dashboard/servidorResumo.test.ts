// O eixo deste arquivo é o mesmo do engineHealth.test.ts: um estado ruim NUNCA sai como
// normalidade. Por isso quase todo caso tem assert negativo — o nível que NÃO pode aparecer é
// tão contrato quanto o que aparece.
import { describe, it, expect } from "vitest";
import { servidorResumo, CPU_AFOGANDO_PCT } from "./servidorResumo";
import type { AnalysisCamera, AnalysisStatus } from "../../api";

function cam(over: Partial<AnalysisCamera> = {}): AnalysisCamera {
  return {
    fps: 1,
    targetFps: 1,
    focused: false,
    queue: 0,
    skipped1m: 0,
    motion: 0,
    lastMs: 100,
    dets1m: 0,
    excluded1m: 0,
    fadiga: false,
    ...over,
  };
}

function status(over: Partial<AnalysisStatus> = {}): AnalysisStatus {
  return {
    enabled: true,
    model: "dfine_n.onnx",
    targetFps: 1,
    lineFps: 2,
    focusFps: 6,
    focused: [],
    motionGate: {
      enabled: true,
      ratio: 0.005,
      probeMs: 6000,
      probeFocusMs: 2000,
      thumb: "64x36",
      skipped1m: 0,
      skippedTotal: 0,
    },
    worker: {
      ready: true,
      size: 3,
      readyCount: 3,
      cpuPct: 90,
      respawns: 0,
      custo: {
        n: 20,
        rodadasPorS: 0.9,
        decodeMs: { p50: 59, p95: 137 },
        inferMs: { p50: 825, p95: 1196 },
        totalMs: { p50: 884, p95: 1333 },
      },
    },
    perCamera: { "cam-1": cam() },
    ...over,
  };
}

describe("servidorResumo — o que a pílula pode afirmar", () => {
  it("operação normal: neutro, com os números do hub", () => {
    const r = servidorResumo(status(), false);
    expect(r).toMatchObject({ nivel: "ok", cpu: 90, inferMs: 825, analisando: 1, paradas: 0 });
    expect(r?.manchete).toBeNull();
  });

  it("consulta falhada é 'não sei' — e NUNCA número velho na tela", () => {
    const r = servidorResumo(status(), true);
    expect(r?.nivel).toBe("unknown");
    expect(r?.nivel).not.toBe("ok");
    // O contrato aqui é o silêncio numérico: nada de cpu/inferência de uma leitura anterior.
    expect(r?.cpu).toBeNull();
    expect(r?.inferMs).toBeNull();
    expect(r?.manchete).toContain("sem resposta");
  });

  it("primeira carga não renderiza nada em vez de chutar zero", () => {
    // Zero afirmaria "nenhuma câmera analisando" antes de qualquer medição.
    expect(servidorResumo(null, false)).toBeNull();
  });

  it("motor desligado domina a leitura", () => {
    const r = servidorResumo(status({ enabled: false }), false);
    expect(r?.nivel).toBe("down");
    expect(r?.manchete).toContain("DESLIGADA");
    expect(r?.analisando).toBe(0);
  });

  it("câmera SEM TURNO puxa para atenção, mesmo com CPU folgada", () => {
    // O caso que motivou o indicador: CPU baixíssima porque 12 câmeras pararam. Sem esta regra,
    // o cabeçalho ficaria NEUTRO exibindo a economia — com o parque cego.
    const r = servidorResumo(
      status({
        worker: { ready: true, size: 3, readyCount: 3, cpuPct: 15, respawns: 0 },
        shiftGate: { on: true, ativas: 4, foraJanela: 0, semTurno: 12 },
      }),
      false,
    );
    expect(r?.nivel).toBe("warn");
    expect(r?.paradas).toBe(12);
    expect(r?.analisando).toBe(4);
  });

  it("pool afogando puxa para atenção mesmo sem câmera parada", () => {
    const afogado = (cpuPct: number) =>
      servidorResumo(
        status({
          worker: { ready: true, size: 3, readyCount: 3, cpuPct, respawns: 0 },
          shiftGate: { on: true, ativas: 15, foraJanela: 0, semTurno: 0 },
        }),
        false,
      );
    expect(afogado(CPU_AFOGANDO_PCT + 1)?.nivel).toBe("warn");
    expect(afogado(CPU_AFOGANDO_PCT)?.nivel).toBe("ok"); // borda: o limiar não dispara nele mesmo
  });

  it("gate desligado: 'analisando' conta quem produziu inferência, e não há câmera parada", () => {
    const r = servidorResumo(
      status({
        shiftGate: { on: false, ativas: 0, foraJanela: 0, semTurno: 0 },
        perCamera: { a: cam({ fps: 1 }), b: cam({ fps: 0 }), c: cam({ fps: 0.2 }) },
      }),
      false,
    );
    expect(r?.analisando).toBe(2);
    expect(r?.paradas).toBe(0);
    expect(r?.nivel).toBe("ok");
  });

  it("hub antigo sem os campos aditivos não vira normalidade falsa nem quebra", () => {
    const r = servidorResumo(
      status({ worker: undefined, shiftGate: undefined, perCamera: { a: cam({ fps: 0 }) } }),
      false,
    );
    expect(r?.cpu).toBeNull(); // "não medido", não 0%
    expect(r?.inferMs).toBeNull();
    expect(r?.analisando).toBe(0);
  });
});
