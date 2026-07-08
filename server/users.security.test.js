// Guarda de boot + compare timing-safe (server/users.js) — auditoria 01, R-A.
// insecureDefaults detecta defaults inseguros ATIVOS (inclui senha default já GRAVADA no store,
// o caso do homolog); constantTimeEqual é a comparação de token de dispositivo. Args injetáveis.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const users = require("./users");

const DEFAULT_SECRET = "dev-inseguro-troque-AUTH_SECRET-em-producao";
const DEFAULT_PWD = "admin@box3";
const su = (pwd, extra = {}) => ({
  papel: "superadmin",
  ativo: true,
  senhaHash: users.hashPassword(pwd),
  ...extra,
});

describe("insecureDefaults — detecção de defaults inseguros ativos", () => {
  it("AUTH_SECRET no default é sinalizado; segredo próprio não", () => {
    expect(users.insecureDefaults({ secret: DEFAULT_SECRET, list: [] }).authSecret).toBe(true);
    expect(users.insecureDefaults({ secret: "um-segredo-forte-proprio", list: [] }).authSecret).toBe(
      false,
    );
  });

  it("superadmin ATIVO com a senha default é detectado (mesmo já gravada no store)", () => {
    const r = users.insecureDefaults({ secret: "x", list: [su(DEFAULT_PWD)] });
    expect(r.adminPassword).toBe(true);
  });

  it("senha rotacionada → não é mais detectada", () => {
    const r = users.insecureDefaults({ secret: "x", list: [su("uma-senha-nova-forte-2026")] });
    expect(r.adminPassword).toBe(false);
  });

  it("só conta superadmin ATIVO: inativo ou papel menor com a senha default NÃO dispara", () => {
    const inativo = su(DEFAULT_PWD, { ativo: false });
    const operador = su(DEFAULT_PWD, { papel: "usuario" });
    expect(users.insecureDefaults({ secret: "x", list: [inativo, operador] }).adminPassword).toBe(
      false,
    );
  });
});

describe("constantTimeEqual — comparação de token de dispositivo", () => {
  it("iguais → true; diferentes de mesmo tamanho → false", () => {
    expect(users.constantTimeEqual("tok-abc-123", "tok-abc-123")).toBe(true);
    expect(users.constantTimeEqual("tok-abc-123", "tok-abc-124")).toBe(false);
  });
  it("comprimentos diferentes → false; não-string → false", () => {
    expect(users.constantTimeEqual("curto", "bem-mais-longo")).toBe(false);
    expect(users.constantTimeEqual(undefined, "x")).toBe(false);
    expect(users.constantTimeEqual("x", null)).toBe(false);
  });
});

describe("bootAbort — só AUTH_SECRET derruba o boot (senha default é deadlock → só avisa)", () => {
  it("produção + AUTH_SECRET default → ABORTA", () => {
    expect(users.bootAbort({ authSecret: true, adminPassword: false }, "production")).toBe(true);
  });
  it("produção + SÓ senha default → NÃO aborta (rotação exige a UI de pé — evita deadlock)", () => {
    expect(users.bootAbort({ authSecret: false, adminPassword: true }, "production")).toBe(false);
  });
  it("fora de produção nunca aborta (nem com AUTH_SECRET default)", () => {
    expect(users.bootAbort({ authSecret: true, adminPassword: true }, "development")).toBe(false);
    expect(users.bootAbort({ authSecret: true, adminPassword: true }, undefined)).toBe(false);
  });
  it("nada inseguro → não aborta", () => {
    expect(users.bootAbort({ authSecret: false, adminPassword: false }, "production")).toBe(false);
  });
});
