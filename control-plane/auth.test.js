// canAccess PURO + token round-trip — RODA SEMPRE (sem banco). O coração da Fase 0 no
// que tange ao RBAC-com-escopo (spec §3). Controle negativo: um canAccess que sempre
// devolve true DEVE deixar os testes de NEGAÇÃO vermelhos (prova que o teste tem dente).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("./auth");

// ── Árvore de fixtura: 2 partners, cada um com 2 clientes, cada cliente com 2 sites ──
//   P1 ─ C1 ─ S1, S2      P2 ─ C3 ─ S5, S6
//      └ C2 ─ S3, S4         └ C4 ─ S7, S8
const tree = {
  partner: { P1: true, P2: true },
  cliente: {
    C1: { partnerId: "P1" },
    C2: { partnerId: "P1" },
    C3: { partnerId: "P2" },
    C4: { partnerId: "P2" },
  },
  site: {
    S1: { clienteId: "C1", partnerId: "P1" },
    S2: { clienteId: "C1", partnerId: "P1" },
    S3: { clienteId: "C2", partnerId: "P1" },
    S4: { clienteId: "C2", partnerId: "P1" },
    S5: { clienteId: "C3", partnerId: "P2" },
    S6: { clienteId: "C3", partnerId: "P2" },
    S7: { clienteId: "C4", partnerId: "P2" },
    S8: { clienteId: "C4", partnerId: "P2" },
  },
};

const site = (id) => ({ type: "site", id });
const cliente = (id) => ({ type: "cliente", id });
const partner = (id) => ({ type: "partner", id });

// controle negativo: injeta um canAccess "furado" (sempre true). Usamos p/ provar que os
// casos de NEGAÇÃO abaixo realmente dependem da lógica — com o furado, eles falhariam.
const canAlwaysTrue = () => true;

describe("canAccess — platform vê tudo", () => {
  const claims = { scope_type: "platform", scope_id: null };
  it("vê qualquer site, cliente e partner", () => {
    expect(auth.canAccess(claims, site("S1"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S8"), tree)).toBe(true);
    expect(auth.canAccess(claims, cliente("C3"), tree)).toBe(true);
    expect(auth.canAccess(claims, partner("P2"), tree)).toBe(true);
  });
});

describe("canAccess — partner vê SÓ a sua subárvore", () => {
  const claims = { scope_type: "partner", scope_id: "P1" };
  it("vê seus clientes e sites", () => {
    expect(auth.canAccess(claims, partner("P1"), tree)).toBe(true);
    expect(auth.canAccess(claims, cliente("C1"), tree)).toBe(true);
    expect(auth.canAccess(claims, cliente("C2"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S1"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S4"), tree)).toBe(true);
  });
  it("NÃO vê o outro partner nem os clientes/sites dele", () => {
    expect(auth.canAccess(claims, partner("P2"), tree)).toBe(false);
    expect(auth.canAccess(claims, cliente("C3"), tree)).toBe(false);
    expect(auth.canAccess(claims, site("S5"), tree)).toBe(false);
    expect(auth.canAccess(claims, site("S8"), tree)).toBe(false);
  });
  it("[controle negativo] um canAccess sempre-true QUEBRARIA a negação acima", () => {
    // prova que o assert de negação tem dente: com o furado, S5 (do vizinho) passaria.
    expect(canAlwaysTrue(claims, site("S5"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S5"), tree)).not.toBe(canAlwaysTrue(claims, site("S5"), tree));
  });
});

describe("canAccess — cliente (tenant-admin) vê seus sites, e NÃO os de outro cliente", () => {
  const claims = { scope_type: "cliente", scope_id: "C1" };
  it("vê o próprio cliente e seus sites", () => {
    expect(auth.canAccess(claims, cliente("C1"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S1"), tree)).toBe(true);
    expect(auth.canAccess(claims, site("S2"), tree)).toBe(true);
  });
  it("NÃO vê outro cliente do MESMO partner, nem os sites dele", () => {
    expect(auth.canAccess(claims, cliente("C2"), tree)).toBe(false);
    expect(auth.canAccess(claims, site("S3"), tree)).toBe(false);
  });
  it("NÃO vê para CIMA (o partner) nem lateralmente (outro partner)", () => {
    expect(auth.canAccess(claims, partner("P1"), tree)).toBe(false);
    expect(auth.canAccess(claims, cliente("C3"), tree)).toBe(false);
    expect(auth.canAccess(claims, site("S5"), tree)).toBe(false);
  });
});

describe("canAccess — site (operator) vê SÓ o próprio site", () => {
  const claims = { scope_type: "site", scope_id: "S1" };
  it("vê o próprio site", () => {
    expect(auth.canAccess(claims, site("S1"), tree)).toBe(true);
  });
  it("NÃO vê outro site (nem irmão do mesmo cliente), nem para cima", () => {
    expect(auth.canAccess(claims, site("S2"), tree)).toBe(false);
    expect(auth.canAccess(claims, site("S3"), tree)).toBe(false);
    expect(auth.canAccess(claims, cliente("C1"), tree)).toBe(false);
    expect(auth.canAccess(claims, partner("P1"), tree)).toBe(false);
  });
});

describe("canAccess — arestas de fail-closed", () => {
  it("claims sem escopo → nega", () => {
    expect(auth.canAccess(null, site("S1"), tree)).toBe(false);
    expect(auth.canAccess({}, site("S1"), tree)).toBe(false);
  });
  it("escopo não-platform sem scope_id → nega", () => {
    expect(auth.canAccess({ scope_type: "partner", scope_id: null }, site("S1"), tree)).toBe(false);
  });
  it("recurso desconhecido (fora da árvore) → nega escopo (mas platform ainda vê)", () => {
    const partnerClaims = { scope_type: "partner", scope_id: "P1" };
    expect(auth.canAccess(partnerClaims, site("SXX"), tree)).toBe(false);
    expect(auth.canAccess({ scope_type: "platform", scope_id: null }, site("SXX"), tree)).toBe(true);
  });
});

describe("token — signToken / verifyToken round-trip com ESCOPO", () => {
  it("round-trip preserva id/papel/scope_type/scope_id", () => {
    const claims = { id: "u1", papel: "partner-admin", scope_type: "partner", scope_id: "P1" };
    const token = auth.signToken(claims);
    const out = auth.verifyToken(token);
    expect(out).toBeTruthy();
    expect(out.id).toBe("u1");
    expect(out.papel).toBe("partner-admin");
    expect(out.scope_type).toBe("partner");
    expect(out.scope_id).toBe("P1");
    expect(out.exp).toBeGreaterThan(Date.now());
  });
  it("platform round-trip com scope_id null", () => {
    const out = auth.verifyToken(auth.signToken({ id: "u0", papel: "platform-admin", scope_type: "platform" }));
    expect(out.scope_type).toBe("platform");
    expect(out.scope_id).toBe(null);
  });
  it("assinatura ADULTERADA → rejeita", () => {
    const token = auth.signToken({ id: "u1", papel: "site-operator", scope_type: "site", scope_id: "S1" });
    const [body] = token.split(".");
    const forged = `${body}.${"A".repeat(43)}`; // assinatura trocada
    expect(auth.verifyToken(forged)).toBe(null);
  });
  it("PAYLOAD adulterado (escalar escopo) sem re-assinar → rejeita", () => {
    const token = auth.signToken({ id: "u1", papel: "site-operator", scope_type: "site", scope_id: "S1" });
    const sig = token.split(".")[1];
    const evil = Buffer.from(
      JSON.stringify({ id: "u1", papel: "platform-admin", scope_type: "platform", scope_id: null, exp: Date.now() + 1e6 }),
    ).toString("base64url");
    expect(auth.verifyToken(`${evil}.${sig}`)).toBe(null);
  });
  it("token EXPIRADO → rejeita", () => {
    const token = auth.signToken({ id: "u1", papel: "site-operator", scope_type: "site", scope_id: "S1" }, -1000);
    expect(auth.verifyToken(token)).toBe(null);
  });
  it("lixo / formato inválido → rejeita (não estoura)", () => {
    expect(auth.verifyToken("")).toBe(null);
    expect(auth.verifyToken("sem-ponto")).toBe(null);
    expect(auth.verifyToken(null)).toBe(null);
  });
});
