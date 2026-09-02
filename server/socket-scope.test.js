// server/socket-scope.js — escopo por câmera na camada de socket (RBAC papel "cliente").
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { visibleCameras, dashboardSockets, emitScopedByCamera } = require("./socket-scope");

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
  return { data: { user }, rooms: new Set(inDashboards ? ["dashboards"] : []), emit: (ev, p) => emitted.push({ ev, p }), emitted };
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
});
