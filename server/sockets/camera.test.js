// S4 (spec-multitenancy §4): o nó DECLARA o próprio id no handshake e o CAMERA_TOKEN é GLOBAL —
// sem proteção, um segundo nó autenticado sobrescreve o registro de OUTRA câmera (sequestro de id).
// Regra: se um OUTRO socket AINDA VIVO já ocupa o id, recusa o INTRUSO (o incumbente permanece).
// Reconexão legítima (o socket anterior CAIU) deve funcionar — não pode ser recusada.
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { attach } = require("./camera");

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

let seq = 0;
function fakeCameraSocket(id, { connected = true } = {}) {
  const listeners = new Map();
  return {
    id: `sock-${++seq}`,
    connected,
    data: {},
    handshake: { query: { id, label: `L-${id}` } },
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((ev, fn) => listeners.set(ev, fn)),
    hasListener: (ev) => listeners.has(ev),
    fire: (ev, p) => listeners.get(ev) && listeners.get(ev)(p),
  };
}

function makeCtx() {
  const cameras = new Map();
  const socketById = new Map();
  const shed = { onCameraConnected: vi.fn() };
  const cameraList = () => [...cameras.values()];
  return { io: makeIo(), cameras, cameraList, socketById, shed };
}

describe("camera attach — S4: anti-sequestro de id", () => {
  it("recusa o INTRUSO quando o incumbente segue conectado; o incumbente é mantido", () => {
    const ctx = makeCtx();
    const s1 = fakeCameraSocket("cam-A", { connected: true });
    attach(s1, ctx);
    expect(ctx.socketById.get("cam-A")).toBe(s1);
    expect(ctx.cameras.get("cam-A")).toBeTruthy();
    expect(s1.hasListener("frame")).toBe(true); // incumbente ativo

    const intruder = fakeCameraSocket("cam-A", { connected: true });
    attach(intruder, ctx);
    // CONTROLE do S4: o intruso é desconectado e NÃO assume o id.
    expect(intruder.disconnect).toHaveBeenCalled();
    expect(ctx.socketById.get("cam-A")).toBe(s1); // incumbente intacto
    // O intruso NÃO registra handlers (senão seu disconnect apagaria o registro do incumbente).
    expect(intruder.hasListener("frame")).toBe(false);
    expect(intruder.hasListener("disconnect")).toBe(false);
  });

  it("reconexão legítima: incumbente já saiu (disconnect rodou) → newcomer assume o id", () => {
    const ctx = makeCtx();
    const s1 = fakeCameraSocket("cam-A", { connected: true });
    attach(s1, ctx);
    s1.fire("disconnect"); // o nó caiu: limpa cameras/socketById (comportamento normal)
    expect(ctx.socketById.has("cam-A")).toBe(false);

    const s2 = fakeCameraSocket("cam-A", { connected: true });
    attach(s2, ctx);
    expect(s2.disconnect).not.toHaveBeenCalled();
    expect(ctx.socketById.get("cam-A")).toBe(s2);
    expect(s2.hasListener("frame")).toBe(true);
  });

  it("reconexão em CORRIDA: incumbente ainda no Map mas connected:false → newcomer assume", () => {
    const ctx = makeCtx();
    const s1 = fakeCameraSocket("cam-A", { connected: true });
    attach(s1, ctx);
    // O socket caiu mas o `disconnect` do socket.io ainda não chegou (ping timeout): registro
    // permanece, porém `connected` já é false. O newcomer NÃO pode ser recusado.
    s1.connected = false;
    const s2 = fakeCameraSocket("cam-A", { connected: true });
    attach(s2, ctx);
    expect(s2.disconnect).not.toHaveBeenCalled();
    expect(ctx.socketById.get("cam-A")).toBe(s2);
    expect(s2.hasListener("frame")).toBe(true);
  });

  it("ids distintos coexistem (sem falso positivo de colisão)", () => {
    const ctx = makeCtx();
    const a = fakeCameraSocket("cam-A");
    const b = fakeCameraSocket("cam-B");
    attach(a, ctx);
    attach(b, ctx);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(ctx.cameras.size).toBe(2);
  });
});
