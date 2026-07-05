// Testes de unidade da lógica PURA do auto-surface (autoSurface.ts). Determinísticos: o relógio
// (`now`) entra por parâmetro. Cobre os limites documentados: janela de 10min, peso por prioridade,
// decaimento de recência, afundamento de offline/erro e o colsFor do layout.
import { describe, it, expect } from "vitest";
import {
  colsFor,
  activityScore,
  orderedCameras,
  AUTOSURFACE_WINDOW_MS,
} from "./autoSurface";
import { type Camera, type CameraStatus } from "./types";
import { type AlarmEvent } from "../../api";

const NOW = 10_000_000;

function alarm(over: Partial<AlarmEvent>): AlarmEvent {
  return {
    id: "a",
    ts: NOW,
    cameraId: "cam",
    tipo: "atividade",
    priority: "high",
    text: "",
    state: "new",
    ...over,
  };
}

function status(over: Partial<CameraStatus>): CameraStatus {
  return { id: "cam", state: "online", ...over };
}

describe("colsFor", () => {
  it("mapeia a contagem de tiles em colunas (1,2,3,4)", () => {
    expect(colsFor(0)).toBe(1);
    expect(colsFor(1)).toBe(1);
    expect(colsFor(2)).toBe(2);
    expect(colsFor(3)).toBe(3);
    expect(colsFor(6)).toBe(3);
    expect(colsFor(7)).toBe(4);
    expect(colsFor(16)).toBe(4);
  });
});

describe("activityScore", () => {
  it("câmera em erro afunda (base -1000 + fps)", () => {
    const s = { cam: status({ state: "error", fps: 3 }) };
    expect(activityScore("cam", s, [], NOW)).toBe(-1000 + 3);
  });

  it("câmera parada afunda igual à em erro", () => {
    const s = { cam: status({ state: "stopped", fps: 0 }) };
    expect(activityScore("cam", s, [], NOW)).toBe(-1000);
  });

  it("sem alarmes, pontua só pelo fps (peso 0.5)", () => {
    const s = { cam: status({ fps: 10 }) };
    expect(activityScore("cam", s, [], NOW)).toBe(5);
  });

  it("câmera sem status assume 'online' e pontua 0 sem alarmes/fps", () => {
    expect(activityScore("cam", {}, [], NOW)).toBe(0);
  });

  it("alarme AGORA (recência=1) vale o peso cheio da prioridade", () => {
    // recency=1 → 100 * (0.5 + 0.5*1) = 100 (crítico); sem fps.
    expect(activityScore("cam", {}, [alarm({ priority: "critical", ts: NOW })], NOW)).toBe(100);
  });

  it("prioridade pondera: critical(100) > high(40) > advisory(15)", () => {
    const at = (p: AlarmEvent["priority"]) =>
      activityScore("cam", {}, [alarm({ priority: p, ts: NOW })], NOW);
    expect(at("critical")).toBe(100);
    expect(at("high")).toBe(40);
    expect(at("advisory")).toBe(15);
  });

  it("recência decai: alarme na METADE da janela vale 0.75 do peso", () => {
    const half = NOW - AUTOSURFACE_WINDOW_MS / 2;
    // recency=0.5 → 40 * (0.5 + 0.5*0.5) = 40 * 0.75 = 30
    expect(activityScore("cam", {}, [alarm({ priority: "high", ts: half })], NOW)).toBe(30);
  });

  it("alarme FORA da janela (mais velho que 10min) é ignorado", () => {
    const old = NOW - AUTOSURFACE_WINDOW_MS - 1;
    expect(activityScore("cam", {}, [alarm({ priority: "critical", ts: old })], NOW)).toBe(0);
  });

  it("alarme no LIMITE exato da janela (age === windowMs) ainda conta (recência=0 → metade do peso)", () => {
    const edge = NOW - AUTOSURFACE_WINDOW_MS;
    // recency=0 → 40 * (0.5 + 0) = 20
    expect(activityScore("cam", {}, [alarm({ priority: "high", ts: edge })], NOW)).toBe(20);
  });

  it("alarme no FUTURO (age < 0) é ignorado", () => {
    expect(activityScore("cam", {}, [alarm({ ts: NOW + 1000 })], NOW)).toBe(0);
  });

  it("alarme de OUTRA câmera não conta", () => {
    expect(activityScore("cam", {}, [alarm({ cameraId: "outra" })], NOW)).toBe(0);
  });
});

describe("orderedCameras", () => {
  const cams: Camera[] = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];

  it("com auto-surface OFF preserva a ordem da view (identidade do array)", () => {
    const out = orderedCameras(cams, false, {}, [], NOW);
    expect(out).toBe(cams);
  });

  it("com auto-surface ON ordena por atividade decrescente", () => {
    const alarms = [
      alarm({ cameraId: "c", priority: "critical", ts: NOW }),
      alarm({ cameraId: "b", priority: "advisory", ts: NOW }),
    ];
    const out = orderedCameras(cams, true, {}, alarms, NOW).map((c) => c.id);
    expect(out).toEqual(["c", "b", "a"]);
  });

  it("com auto-surface ON, câmeras em erro afundam para o fim", () => {
    const statuses = { a: status({ state: "error" }) };
    const out = orderedCameras(cams, true, statuses, [], NOW).map((c) => c.id);
    expect(out[out.length - 1]).toBe("a");
  });

  it("não muta o array de entrada", () => {
    const alarms = [alarm({ cameraId: "c", priority: "critical", ts: NOW })];
    const before = cams.map((c) => c.id);
    orderedCameras(cams, true, {}, alarms, NOW);
    expect(cams.map((c) => c.id)).toEqual(before);
  });
});
