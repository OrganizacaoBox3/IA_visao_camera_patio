// Teste da ponta HUB do canal (control-plane-link.js). Pura onde dá: o handler de req (echo/ping)
// e a disciplina inerte-sem-env. A discagem/reconexão real é provada no SMOKE de 2 processos
// (control-plane-link.smoke.mjs) — aqui não abrimos socket.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("control-plane-link — inerte sem env", () => {
  it("enabled()=false e startSiteLink() não disca nem agenda timer (retorna null)", () => {
    // sem CP_URL/SITE_ID/SITE_KEY no ambiente do teste.
    const cp = require("./control-plane-link.js");
    expect(cp.enabled()).toBe(false);
    expect(cp.startSiteLink()).toBe(null);
  });
});

describe("control-plane-link — handleReq (echo/ping que prova o canal)", () => {
  const cp = require("./control-plane-link.js");

  it("op:ping → {ok:true, ts} com ts numérico recente", () => {
    const before = Date.now();
    const r = cp.handleReq({ t: "req", id: "q1", op: "ping" });
    expect(r.ok).toBe(true);
    expect(typeof r.ts).toBe("number");
    expect(r.ts).toBeGreaterThanOrEqual(before);
  });

  it("op desconhecida → {ok:false, error}", () => {
    const r = cp.handleReq({ t: "req", id: "q2", op: "voar" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/desconhecida/);
  });

  it("frame sem op → {ok:false} (não estoura)", () => {
    expect(cp.handleReq({}).ok).toBe(false);
    expect(cp.handleReq(null).ok).toBe(false);
  });
});
