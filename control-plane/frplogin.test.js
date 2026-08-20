// PONTE DVR (F3 backend) — LOGIN-PLUGIN do frps: lógica PURA do protocolo (C-be-4).
// RODA SEMPRE (sem banco), como dvr.test.js. Prova o contrato do server-plugin do frp:
//   • aceitar = { reject:false, unchange:true } · barrar = { reject:true, reject_reason }
//   • identidade do coletor: Login → content.metas · NewProxy → content.user.metas (metadatas.*)
//   • menor privilégio do NewProxy: só proxy TCP (contratos §2).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dvr = require("./dvr");

describe("frp login-plugin — respostas do protocolo", () => {
  it("frpAccept = unchange:true (aceita sem mudança)", () => {
    expect(dvr.frpAccept()).toEqual({ reject: false, unchange: true });
  });
  it("frpReject = reject:true + reject_reason (barra a conexão no CORPO, HTTP 200)", () => {
    expect(dvr.frpReject("site_key inválida")).toEqual({ reject: true, reject_reason: "site_key inválida" });
    expect(dvr.frpReject()).toEqual({ reject: true, reject_reason: "recusado" });
  });
});

describe("frp login-plugin — identidade (metas do frp = metadatas.* do frpc.toml)", () => {
  it("Login: coletorId + siteKey vêm de content.metas", () => {
    const id = dvr.frpIdentidade("Login", { user: "col_x", metas: { coletorId: "col_abc", siteKey: "K123" } });
    expect(id).toEqual({ coletorId: "col_abc", siteKey: "K123" });
  });
  it("Login: sem metas.coletorId cai para content.user", () => {
    const id = dvr.frpIdentidade("Login", { user: "col_fallback", metas: { siteKey: "K" } });
    expect(id.coletorId).toBe("col_fallback");
    expect(id.siteKey).toBe("K");
  });
  it("NewProxy: coletorId + siteKey vêm de content.user.metas", () => {
    const id = dvr.frpIdentidade("NewProxy", { user: { user: "col_x", metas: { coletorId: "col_np", siteKey: "K9" } } });
    expect(id).toEqual({ coletorId: "col_np", siteKey: "K9" });
  });
  it("sem metas → coletorId/siteKey null (não estoura)", () => {
    expect(dvr.frpIdentidade("Login", {})).toEqual({ coletorId: null, siteKey: null });
    expect(dvr.frpIdentidade("NewProxy", {})).toEqual({ coletorId: null, siteKey: null });
  });
});

describe("frp login-plugin — menor privilégio no NewProxy (só TCP, contratos §2)", () => {
  it("proxy tcp é permitido", () => {
    expect(dvr.frpProxyPermitido({ proxy_type: "tcp", remote_port: 20007 }).ok).toBe(true);
  });
  it("tipo ausente é tolerado (a checagem forte é a porta da sessão, no routes)", () => {
    expect(dvr.frpProxyPermitido({}).ok).toBe(true);
  });
  it("qualquer tipo != tcp é recusado (http/https/stcp/xtcp/udp)", () => {
    for (const t of ["http", "https", "stcp", "xtcp", "udp"]) {
      const r = dvr.frpProxyPermitido({ proxy_type: t });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(new RegExp(t));
    }
  });
});
