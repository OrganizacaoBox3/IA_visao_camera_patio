// PONTE DVR (F4 backend) — /_dvr_auth + cookie de sessão: lógica PURA (C-be-6/C-be-7).
// RODA SEMPRE (sem banco), como dvr.test.js/frplogin.test.js. Prova:
//   • cookie: parse do header Cookie · Set-Cookie com HttpOnly/Secure/SameSite + Domain pai
//   • throttle da auditoria de acesso (não inundar a auditoria_dvr no auth_request por asset).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cookie = require("./cookie");
const dvr = require("./dvr");

describe("cookie — parse do header Cookie", () => {
  it("parseia pares e decodifica valor url-encoded", () => {
    expect(cookie.parseCookies("cp_session=abc.def; outro=1")).toEqual({ cp_session: "abc.def", outro: "1" });
    expect(cookie.parseCookies("t=a%2Eb%3Dc")).toEqual({ t: "a.b=c" });
  });
  it("header vazio/ausente → objeto vazio (não estoura)", () => {
    expect(cookie.parseCookies("")).toEqual({});
    expect(cookie.parseCookies(undefined)).toEqual({});
  });
  it("tokenDoCookie lê o cookie nomeado do request", () => {
    const req = { headers: { cookie: "cp_session=T0KEN; x=y" } };
    expect(cookie.tokenDoCookie(req)).toBe("T0KEN");
    expect(cookie.tokenDoCookie({ headers: {} })).toBe("");
  });
});

describe("cookie — montarSetCookie (C-be-7: HttpOnly+Secure+SameSite, domínio pai)", () => {
  it("escopa ao domínio pai .box3.software e marca HttpOnly/Secure/SameSite/Path", () => {
    const c = cookie.montarSetCookie("TOK", { dominio: ".box3.software", maxAgeMs: 3600_000, secure: true, sameSite: "Lax" });
    expect(c).toContain("cp_session=TOK");
    expect(c).toContain("Domain=.box3.software");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=3600");
  });
  it("dev/local: domínio vazio → SEM atributo Domain (cookie host-only)", () => {
    const c = cookie.montarSetCookie("TOK", { dominio: "", secure: false });
    expect(c).not.toContain("Domain=");
    expect(c).not.toContain("Secure");
  });
  it("o valor do token é url-encoded (defesa contra ; e , no valor)", () => {
    const c = cookie.montarSetCookie("a b;c", { dominio: "" });
    expect(c).toContain("cp_session=a%20b%3Bc");
  });
});

describe("/_dvr_auth — throttle da auditoria de acesso (deveAuditarAcesso)", () => {
  const agora = 1_000_000_000;
  it("throttle desligado (<=0) → audita SEMPRE (fiel ao 'cada acesso')", () => {
    expect(dvr.deveAuditarAcesso({ ultima_atividade: agora }, agora, 0)).toBe(true);
  });
  it("acesso dentro da janela → NÃO audita (evita inundar por asset)", () => {
    expect(dvr.deveAuditarAcesso({ ultima_atividade: agora - 10 }, agora, 60_000)).toBe(false);
  });
  it("acesso além da janela → audita (1×/janela por sessão)", () => {
    expect(dvr.deveAuditarAcesso({ ultima_atividade: agora - 61_000 }, agora, 60_000)).toBe(true);
  });
  it("sem ultima_atividade cai para aberta_em; sem nenhum → audita", () => {
    expect(dvr.deveAuditarAcesso({ aberta_em: agora - 61_000 }, agora, 60_000)).toBe(true);
    expect(dvr.deveAuditarAcesso({}, agora, 60_000)).toBe(true);
  });
});
