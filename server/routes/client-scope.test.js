import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const users = require("../users");
const camerasRoute = require("./cameras");
const dataRoute = require("./data");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ticket de vídeo — escopo do papel cliente", () => {
  async function request(url, user) {
    vi.spyOn(users, "verifyToken").mockReturnValue(user);
    const replies = [];
    const handled = await camerasRoute.handle(
      { method: "GET", url, headers: { authorization: "Bearer teste" } },
      {},
      {
        json: (_res, status, body) => replies.push({ status, body }),
      },
    );
    return { handled, replies };
  }

  it("recusa ticket geral para cliente", async () => {
    const r = await request("/api/video-ticket", {
      papel: "cliente",
      cameraIds: ["cam-1"],
    });
    expect(r.handled).toBe(true);
    expect(r.replies).toEqual([
      { status: 403, body: { error: "ticket geral restrito à equipe" } },
    ]);
  });

  it("emite ticket específico somente para câmera alocada", async () => {
    const ok = await request("/api/video-ticket?src=cam-1", {
      papel: "cliente",
      cameraIds: ["cam-1"],
    });
    expect(ok.replies[0].status).toBe(200);
    expect(ok.replies[0].body.ticket).toEqual(expect.any(String));

    const denied = await request("/api/video-ticket?src=cam-2", {
      papel: "cliente",
      cameraIds: ["cam-1"],
    });
    expect(denied.replies).toEqual([
      { status: 403, body: { error: "sem acesso a esta câmera" } },
    ]);
  });

  it("preserva ticket geral para papel de equipe", async () => {
    const r = await request("/api/video-ticket", { papel: "superadmin" });
    expect(r.replies[0].status).toBe(200);
    expect(r.replies[0].body.ticket).toEqual(expect.any(String));
  });
});

describe("ingest de indicadores — cliente é somente leitura", () => {
  it("recusa antes de ler ou persistir o corpo", async () => {
    const json = vi.fn();
    const readBody = vi.fn();
    const handled = await dataRoute.handle(
      { method: "POST", url: "/api/ingest" },
      {},
      {
        json,
        readBody,
        requireAuth: () => ({ papel: "cliente", cameraIds: ["cam-1"] }),
      },
    );
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith({}, 403, { error: "acesso restrito à equipe" });
    expect(readBody).not.toHaveBeenCalled();
  });
});
