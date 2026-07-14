// SITE_KEY — geração/hash/verificação. RODA SEMPRE (cripto pura, sem banco). Prova o contrato:
// a chave CERTA passa; errada/adulterada falha; a verificação é timing-safe (não estoura em
// comprimentos diferentes). Controle negativo COM DENTE: um verify sempre-true passaria a chave
// errada — o assert de negação prova que depende da lógica real.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sitekey = require("./sitekey");

const verifyAlwaysTrue = () => true; // furado, p/ o controle negativo

describe("sitekey — geração", () => {
  it("gera chave não-vazia e ÚNICA a cada chamada (alta entropia)", () => {
    const a = sitekey.generateSiteKey();
    const b = sitekey.generateSiteKey();
    expect(a).toBeTruthy();
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes em base64url
    expect(a).not.toBe(b);
  });
});

describe("sitekey — hash", () => {
  it("é determinístico e no formato sha256$<hex>", () => {
    const raw = sitekey.generateSiteKey();
    const h1 = sitekey.hashSiteKey(raw);
    const h2 = sitekey.hashSiteKey(raw);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256\$[0-9a-f]{64}$/);
  });
  it("NÃO contém a chave crua (só o digest)", () => {
    const raw = sitekey.generateSiteKey();
    expect(sitekey.hashSiteKey(raw)).not.toContain(raw);
  });
});

describe("sitekey — verificação (timing-safe)", () => {
  it("a chave CERTA passa", () => {
    const raw = sitekey.generateSiteKey();
    const hash = sitekey.hashSiteKey(raw);
    expect(sitekey.verifySiteKey(raw, hash)).toBe(true);
  });
  it("a chave ERRADA falha", () => {
    const raw = sitekey.generateSiteKey();
    const hash = sitekey.hashSiteKey(raw);
    const wrong = sitekey.generateSiteKey();
    expect(sitekey.verifySiteKey(wrong, hash)).toBe(false);
    // [controle negativo] com um verify furado (sempre true) a chave errada passaria:
    expect(verifyAlwaysTrue(wrong, hash)).toBe(true);
    expect(sitekey.verifySiteKey(wrong, hash)).not.toBe(verifyAlwaysTrue(wrong, hash));
  });
  it("hash ADULTERADO (1 nibble trocado) falha", () => {
    const raw = sitekey.generateSiteKey();
    const hash = sitekey.hashSiteKey(raw);
    const flip = hash.endsWith("0") ? hash.slice(0, -1) + "1" : hash.slice(0, -1) + "0";
    expect(sitekey.verifySiteKey(raw, flip)).toBe(false);
  });
  it("entradas degeneradas (vazio/null/formato errado) falham sem estourar", () => {
    expect(sitekey.verifySiteKey("", sitekey.hashSiteKey("x"))).toBe(false);
    expect(sitekey.verifySiteKey("x", "")).toBe(false);
    expect(sitekey.verifySiteKey("x", null)).toBe(false);
    expect(sitekey.verifySiteKey("x", "md5$abc")).toBe(false); // scheme errado
    expect(sitekey.verifySiteKey(null, sitekey.hashSiteKey("x"))).toBe(false);
  });
});
