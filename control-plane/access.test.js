// access.scopeInTree — o guard de ESCOPO (usado no filtro de listas e espelhando guardScope),
// PURO (a árvore entra por argumento). RODA SEMPRE. Prova a negação cross-partner/cross-cliente
// e a regra de que membership de escopo 'platform' só é vista por platform. Controle negativo
// COM DENTE: um guard sempre-true deixaria a negação passar.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const access = require("./access");

// Mesma fixtura de auth.test.js: P1{C1[S1,S2],C2[S3,S4]}, P2{C3[S5,S6],C4[S7,S8]}.
const tree = {
  partner: { P1: true, P2: true },
  cliente: { C1: { partnerId: "P1" }, C2: { partnerId: "P1" }, C3: { partnerId: "P2" }, C4: { partnerId: "P2" } },
  site: {
    S1: { clienteId: "C1", partnerId: "P1" },
    S2: { clienteId: "C1", partnerId: "P1" },
    S3: { clienteId: "C2", partnerId: "P1" },
    S5: { clienteId: "C3", partnerId: "P2" },
  },
};

const alwaysTrue = () => true; // furado, p/ o controle negativo

describe("scopeInTree — platform vê todo escopo (inclusive membership platform)", () => {
  const claims = { scope_type: "platform", scope_id: null };
  it("vê partner/cliente/site e a própria membership platform", () => {
    expect(access.scopeInTree(claims, "site", "S5", tree)).toBe(true);
    expect(access.scopeInTree(claims, "cliente", "C3", tree)).toBe(true);
    expect(access.scopeInTree(claims, "partner", "P2", tree)).toBe(true);
    expect(access.scopeInTree(claims, "platform", null, tree)).toBe(true);
  });
});

describe("scopeInTree — partner-admin: só a sua subárvore", () => {
  const claims = { scope_type: "partner", scope_id: "P1" };
  it("vê memberships de site/cliente sob P1", () => {
    expect(access.scopeInTree(claims, "site", "S1", tree)).toBe(true);
    expect(access.scopeInTree(claims, "site", "S3", tree)).toBe(true);
    expect(access.scopeInTree(claims, "cliente", "C1", tree)).toBe(true);
    expect(access.scopeInTree(claims, "partner", "P1", tree)).toBe(true);
  });
  it("NÃO vê o outro partner nem membership de escopo platform", () => {
    expect(access.scopeInTree(claims, "site", "S5", tree)).toBe(false);
    expect(access.scopeInTree(claims, "cliente", "C3", tree)).toBe(false);
    expect(access.scopeInTree(claims, "partner", "P2", tree)).toBe(false);
    expect(access.scopeInTree(claims, "platform", null, tree)).toBe(false); // ninguém abaixo vê platform
  });
  it("[controle negativo COM DENTE] guard sempre-true deixaria S5 (do vizinho) passar", () => {
    expect(alwaysTrue(claims, "site", "S5", tree)).toBe(true);
    expect(access.scopeInTree(claims, "site", "S5", tree)).not.toBe(alwaysTrue());
  });
});

describe("scopeInTree — tenant-admin (cliente): só os próprios sites", () => {
  const claims = { scope_type: "cliente", scope_id: "C1" };
  it("vê C1 e seus sites", () => {
    expect(access.scopeInTree(claims, "cliente", "C1", tree)).toBe(true);
    expect(access.scopeInTree(claims, "site", "S1", tree)).toBe(true);
    expect(access.scopeInTree(claims, "site", "S2", tree)).toBe(true);
  });
  it("NÃO vê cliente irmão do MESMO partner, nem para cima, nem lateralmente", () => {
    expect(access.scopeInTree(claims, "cliente", "C2", tree)).toBe(false);
    expect(access.scopeInTree(claims, "site", "S3", tree)).toBe(false); // site do irmão C2
    expect(access.scopeInTree(claims, "partner", "P1", tree)).toBe(false);
    expect(access.scopeInTree(claims, "site", "S5", tree)).toBe(false);
  });
});

describe("scopeInTree — site-operator: só o próprio site", () => {
  const claims = { scope_type: "site", scope_id: "S1" };
  it("vê S1 e nada mais", () => {
    expect(access.scopeInTree(claims, "site", "S1", tree)).toBe(true);
    expect(access.scopeInTree(claims, "site", "S2", tree)).toBe(false);
    expect(access.scopeInTree(claims, "cliente", "C1", tree)).toBe(false);
  });
});

describe("scopeInTree — arestas fail-closed", () => {
  it("sem claims → nega", () => {
    expect(access.scopeInTree(null, "site", "S1", tree)).toBe(false);
  });
  it("recurso fora da árvore → nega (mas platform ainda vê)", () => {
    expect(access.scopeInTree({ scope_type: "partner", scope_id: "P1" }, "site", "SXX", tree)).toBe(false);
    expect(access.scopeInTree({ scope_type: "platform", scope_id: null }, "site", "SXX", tree)).toBe(true);
  });
});
