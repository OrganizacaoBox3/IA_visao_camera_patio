// server/socket-scope.js — escopo por câmera na camada de socket (RBAC papel "cliente").
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  visibleCameras,
  dashboardSockets,
  hasDashboardViewerForCamera,
  emitScopedByCamera,
  scopeAnalysisStatus,
} = require("./socket-scope");

describe("visibleCameras", () => {
  const list = [
    { id: "cam-1", label: "Doca 1" },
    { id: "cam-2", label: "Doca 2" },
    { id: "cam-3", label: "Pátio" },
  ];

  it("papel de equipe vê a lista inteira, intocada", () => {
    expect(visibleCameras(list, { papel: "superadmin" })).toBe(list); // mesma referência, sem cópia
    expect(visibleCameras(list, { papel: "usuario" })).toEqual(list);
  });

  it("papel cliente vê só as câmeras de cameraIds", () => {
    const out = visibleCameras(list, { papel: "cliente", cameraIds: ["cam-2"] });
    expect(out).toEqual([{ id: "cam-2", label: "Doca 2" }]);
  });

  it("papel cliente sem cameraIds vê lista VAZIA (fail-closed)", () => {
    expect(visibleCameras(list, { papel: "cliente" })).toEqual([]);
    expect(visibleCameras(list, { papel: "cliente", cameraIds: [] })).toEqual([]);
  });
});

function fakeIo(sockets) {
  return { of: () => ({ sockets: new Map(sockets.map((s, i) => [String(i), s])) }) };
}
function fakeSocket(user, inDashboards = true) {
  const emitted = [];
  const volatileEmitted = [];
  return {
    data: { user },
    rooms: new Set(inDashboards ? ["dashboards"] : []),
    emit: (ev, p) => emitted.push({ ev, p }),
    volatile: { emit: (ev, p) => volatileEmitted.push({ ev, p }) },
    emitted,
    volatileEmitted,
  };
}

describe("dashboardSockets", () => {
  it("só devolve sockets que estão na sala dashboards", () => {
    const dentro = fakeSocket({ papel: "usuario" }, true);
    const fora = fakeSocket({ papel: "usuario" }, false); // ex.: socket de câmera/dvr-tunnel
    const io = fakeIo([dentro, fora]);
    expect(dashboardSockets(io)).toEqual([dentro]);
  });
});

describe("emitScopedByCamera", () => {
  it("emite só para os sockets cujo usuário pode ver a câmera", () => {
    const equipe = fakeSocket({ papel: "superadmin" });
    const clienteDentro = fakeSocket({ papel: "cliente", cameraIds: ["cam-1"] });
    const clienteFora = fakeSocket({ papel: "cliente", cameraIds: ["cam-2"] });
    const io = fakeIo([equipe, clienteDentro, clienteFora]);

    emitScopedByCamera(io, "alarm-event", { text: "x" }, "cam-1");

    expect(equipe.emitted).toEqual([{ ev: "alarm-event", p: { text: "x" } }]);
    expect(clienteDentro.emitted).toEqual([{ ev: "alarm-event", p: { text: "x" } }]);
    expect(clienteFora.emitted).toEqual([]);
  });

  it("cameraId ausente: só chega a papéis de equipe, nunca a cliente", () => {
    const equipe = fakeSocket({ papel: "engenheiro" });
    const cliente = fakeSocket({ papel: "cliente", cameraIds: ["cam-1"] });
    const io = fakeIo([equipe, cliente]);

    emitScopedByCamera(io, "camcfg-updated", { kind: "zones" }, undefined);

    expect(equipe.emitted).toHaveLength(1);
    expect(cliente.emitted).toHaveLength(0);
  });

  it("preserva a semântica volatile dos overlays e mantém o escopo", () => {
    const dentro = fakeSocket({ papel: "cliente", cameraIds: ["cam-1"] });
    const fora = fakeSocket({ papel: "cliente", cameraIds: ["cam-2"] });
    const io = fakeIo([dentro, fora]);

    emitScopedByCamera(io, "analysis-tracks", { cameraId: "cam-1" }, "cam-1", {
      volatile: true,
    });

    expect(dentro.volatileEmitted).toHaveLength(1);
    expect(dentro.emitted).toHaveLength(0);
    expect(fora.volatileEmitted).toHaveLength(0);
  });
});

describe("hasDashboardViewerForCamera", () => {
  it("só considera espectadores autorizados para a câmera", () => {
    const io = fakeIo([
      fakeSocket({ papel: "cliente", cameraIds: ["cam-2"] }),
      fakeSocket({ papel: "cliente", cameraIds: [] }),
    ]);
    expect(hasDashboardViewerForCamera(io, "cam-1")).toBe(false);
    expect(hasDashboardViewerForCamera(io, "cam-2")).toBe(true);
  });
});

describe("scopeAnalysisStatus", () => {
  const status = {
    focused: ["cam-1", "cam-2"],
    motionGate: { enabled: true, skipped1m: 13, skippedTotal: 130 },
    perCamera: {
      "cam-1": { skipped1m: 3, skippedTotal: 30 },
      "cam-2": { skipped1m: 10, skippedTotal: 100 },
    },
  };

  it("filtra ids e recalcula agregados para cliente", () => {
    expect(
      scopeAnalysisStatus(status, { papel: "cliente", cameraIds: ["cam-1"] }),
    ).toEqual({
      focused: ["cam-1"],
      motionGate: { enabled: true, skipped1m: 3, skippedTotal: 30 },
      perCamera: { "cam-1": { skipped1m: 3, skippedTotal: 30 } },
    });
  });

  it("preserva o mesmo objeto para papéis de equipe", () => {
    expect(scopeAnalysisStatus(status, { papel: "superadmin" })).toBe(status);
  });
});
