import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const recipients = require("../recipients");
const authRoute = require("./auth");

afterEach(() => vi.restoreAllMocks());

describe("/api/me — destinatário principal canônico", () => {
  it("GET lê o perfil composto a partir de recipients", async () => {
    const profile = { id: "u1", usuario: "cliente", whatsapp: "5588999999999" };
    const read = vi.spyOn(recipients, "profileForUser").mockReturnValue(profile);
    const replies = [];
    const handled = await authRoute.handle(
      { method: "GET", url: "/api/me" },
      {},
      {
        json: (_res, status, body) => replies.push({ status, body }),
        requireAuth: () => ({ id: "u1" }),
      },
    );
    expect(handled).toBe(true);
    expect(read).toHaveBeenCalledWith("u1");
    expect(replies).toEqual([{ status: 200, body: profile }]);
  });

  it("PATCH edita o mesmo destinatário principal via recipients", async () => {
    const patch = { whatsapp: "5588999990000", optIn: true };
    const save = vi.spyOn(recipients, "updateProfile").mockResolvedValue({
      user: { id: "u1", whatsapp: patch.whatsapp },
    });
    const replies = [];
    await authRoute.handle(
      { method: "PATCH", url: "/api/me" },
      {},
      {
        json: (_res, status, body) => replies.push({ status, body }),
        readBody: async () => JSON.stringify(patch),
        requireAuth: () => ({ id: "u1" }),
      },
    );
    expect(save).toHaveBeenCalledWith("u1", patch);
    expect(replies).toEqual([{ status: 200, body: { id: "u1", whatsapp: patch.whatsapp } }]);
  });
});
