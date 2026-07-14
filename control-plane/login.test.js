// Login — seleção de escopo (a parte PURA). RODA SEMPRE (sem banco). Prova a regra desta fase:
// >1 membership → token com a de MAIOR privilégio (platform > partner > cliente > site).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const login = require("./login");

const m = (scope_type, scope_id, role) => ({ scope_type, scope_id, role });

describe("login.selectScope — maior privilégio na árvore", () => {
  it("sem memberships → null (o handler vira 403)", () => {
    expect(login.selectScope([])).toBe(null);
    expect(login.selectScope(null)).toBe(null);
    expect(login.selectScope(undefined)).toBe(null);
  });

  it("uma só membership → ela mesma", () => {
    const only = m("cliente", "C1", "tenant-admin");
    expect(login.selectScope([only])).toBe(only);
  });

  it("platform vence partner/cliente/site", () => {
    const memberships = [m("site", "S1", "site-operator"), m("platform", null, "platform-admin"), m("cliente", "C1", "tenant-admin")];
    expect(login.selectScope(memberships).scope_type).toBe("platform");
  });

  it("partner vence cliente e site (sem platform presente)", () => {
    const memberships = [m("site", "S1", "site-operator"), m("cliente", "C1", "tenant-admin"), m("partner", "P1", "partner-admin")];
    expect(login.selectScope(memberships).scope_type).toBe("partner");
  });

  it("cliente vence site", () => {
    const memberships = [m("site", "S1", "site-operator"), m("cliente", "C1", "tenant-admin")];
    expect(login.selectScope(memberships).scope_type).toBe("cliente");
  });

  it("empate no mesmo nível → a PRIMEIRA (ordem estável)", () => {
    const first = m("site", "S1", "site-operator");
    const second = m("site", "S2", "site-operator");
    expect(login.selectScope([first, second])).toBe(first);
  });

  it("scope_type desconhecido perde para qualquer conhecido", () => {
    const memberships = [m("marciano", "X", "?"), m("site", "S1", "site-operator")];
    expect(login.selectScope(memberships).scope_type).toBe("site");
  });
});

describe("login.rankOf — ordem de privilégio", () => {
  it("platform < partner < cliente < site (menor rank = mais poder)", () => {
    expect(login.rankOf("platform")).toBeLessThan(login.rankOf("partner"));
    expect(login.rankOf("partner")).toBeLessThan(login.rankOf("cliente"));
    expect(login.rankOf("cliente")).toBeLessThan(login.rankOf("site"));
  });
  it("desconhecido → infinito (menos privilégio)", () => {
    expect(login.rankOf("nada")).toBe(Number.POSITIVE_INFINITY);
  });
});
