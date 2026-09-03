// S3 (spec-multitenancy §4): o handler `watch({ids})` NÃO pode confiar no cliente — o servidor
// filtra os ids pedidos contra as câmeras que o hub REALMENTE conhece (o Map `cameras`, mesmo
// estado do evento `cameras`). Um id inexistente/forjado é ignorado (não faz join em `cam:<id>`).
// Contrato ADITIVO preservado: `usesWatch`, saída da `dash-legacy` e replace idempotente do
// conjunto assistido seguem iguais para os ids VÁLIDOS.
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { attach } = require("./dashboard");

// io chainable (to().to().volatile.emit()) — o watch não emite, mas o attach usa io em outros pontos.
function makeIo() {
  const chain = () => ({
    to: () => chain(),
    get volatile() {
      return chain();
    },
    emit: () => {},
  });
  return { to: () => chain() };
}

// papel de EQUIPE por default (sem restrição de câmera) — este arquivo testa o filtro de ids
// FORJADOS/inexistentes (S3), não o RBAC por papel (isso é escopo de dashboard.scope.test.js).
function fakeDashSocket(user = { id: "u1", papel: "superadmin" }) {
  const rooms = new Set();
  const listeners = new Map();
  return {
    id: "dash-1",
    data: { user },
    rooms,
    join: vi.fn((r) => rooms.add(r)),
    leave: vi.fn((r) => rooms.delete(r)),
    emit: vi.fn(),
    on: vi.fn((ev, fn) => listeners.set(ev, fn)),
    fire: (ev, p) => listeners.get(ev) && listeners.get(ev)(p),
  };
}

function setup(cameraEntries, user) {
  const cameras = new Map(cameraEntries);
  const shed = { sweepShed: vi.fn(), onCameraConnected: vi.fn() };
  const analysis = { snapshotTo: vi.fn(), setFocus: vi.fn(), clearFocus: vi.fn() };
  const rtsp = { statuses: () => [] };
  const cameraList = () => [...cameras.values()];
  const socket = fakeDashSocket(user);
  attach(socket, { io: makeIo(), cameras, cameraList, shed, analysis, rtsp });
  return { socket, cameras, shed, analysis };
}

describe("dashboard watch — S3: filtra ids contra as câmeras conhecidas", () => {
  it("junta só os ids que o hub conhece; ignora o forjado (não faz join arbitrário)", () => {
    const { socket } = setup([
      ["cam-A", { id: "cam-A" }],
      ["cam-B", { id: "cam-B" }],
    ]);
    socket.fire("watch", { ids: ["cam-A", "evil-cam"] });
    expect(socket.rooms.has("cam:cam-A")).toBe(true);
    // CONTROLE do S3: o id forjado NÃO entra na room (a linha do vazamento).
    expect(socket.rooms.has("cam:evil-cam")).toBe(false);
  });

  it("watch só com id forjado: nenhuma room cam:, mas SAI da dash-legacy e marca usesWatch", () => {
    const { socket } = setup([["cam-A", { id: "cam-A" }]]);
    socket.fire("watch", { ids: ["nope-1", "nope-2"] });
    expect([...socket.rooms].some((r) => r.startsWith("cam:"))).toBe(false);
    expect(socket.rooms.has("dash-legacy")).toBe(false);
    expect(socket.data.usesWatch).toBe(true);
  });

  it("replace idempotente: novo watch substitui o conjunto, mantendo só ids válidos", () => {
    const { socket } = setup([
      ["cam-A", { id: "cam-A" }],
      ["cam-B", { id: "cam-B" }],
      ["cam-C", { id: "cam-C" }],
    ]);
    socket.fire("watch", { ids: ["cam-A", "cam-B"] });
    expect(socket.rooms.has("cam:cam-A")).toBe(true);
    expect(socket.rooms.has("cam:cam-B")).toBe(true);
    // Substitui por {cam-C, forjado}: sai de A e B, entra só em C.
    socket.fire("watch", { ids: ["cam-C", "ghost"] });
    expect(socket.rooms.has("cam:cam-A")).toBe(false);
    expect(socket.rooms.has("cam:cam-B")).toBe(false);
    expect(socket.rooms.has("cam:cam-C")).toBe(true);
    expect(socket.rooms.has("cam:ghost")).toBe(false);
  });

  it("payload sem ids (undefined) não quebra e não deixa room cam:", () => {
    const { socket } = setup([["cam-A", { id: "cam-A" }]]);
    expect(() => socket.fire("watch", {})).not.toThrow();
    expect([...socket.rooms].some((r) => r.startsWith("cam:"))).toBe(false);
  });
});

describe("dashboard analysis-focus — valida câmera e escopo", () => {
  it("cliente não consegue focar câmera fora da própria alocação", () => {
    const { socket, analysis } = setup(
      [
        ["cam-A", { id: "cam-A" }],
        ["cam-B", { id: "cam-B" }],
      ],
      { id: "u-cliente", papel: "cliente", cameraIds: ["cam-A"] },
    );

    socket.fire("analysis-focus", { id: "cam-B" });
    expect(analysis.setFocus).toHaveBeenCalledWith("dash-1", null);
    expect(socket.data.focusId).toBeNull();
  });

  it("aceita a câmera alocada e rejeita id inexistente para qualquer papel", () => {
    const { socket, analysis } = setup([["cam-A", { id: "cam-A" }]], {
      id: "u-cliente",
      papel: "cliente",
      cameraIds: ["cam-A"],
    });

    socket.fire("analysis-focus", { id: "cam-A" });
    expect(analysis.setFocus).toHaveBeenLastCalledWith("dash-1", "cam-A");
    socket.fire("analysis-focus", { id: "fantasma" });
    expect(analysis.setFocus).toHaveBeenLastCalledWith("dash-1", null);
  });
});
