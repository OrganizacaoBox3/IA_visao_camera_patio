// PONTE DVR — lógica PURA (validação/normalização). RODA SEMPRE (sem banco), como sitekey.test.js.
// Prova: enrollment exige cliente_id + empresa_id_box3; registro exige consentimento e valida porta;
// e o ponto sensível — a credencial do DVR NUNCA entra no objeto normalizado (allow-list, contratos §3).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dvr = require("./dvr");

describe("dvr — validateEnrollment", () => {
  it("aceita cliente_id + empresa_id_box3 e normaliza os opcionais", () => {
    const r = dvr.validateEnrollment({ cliente_id: "c1", empresa_id_box3: "E-42", nome: "Coletor Doca" });
    expect(r.ok).toBe(true);
    expect(r.value.cliente_id).toBe("c1");
    expect(r.value.empresa_id_box3).toBe("E-42");
    expect(r.value.nome).toBe("Coletor Doca");
    expect(r.value.coletor_id_box3).toBe(null); // ausente → null
  });
  it("exige cliente_id", () => {
    const r = dvr.validateEnrollment({ empresa_id_box3: "E-42" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cliente_id/);
  });
  it("exige empresa_id_box3 (o elo com o box3)", () => {
    const r = dvr.validateEnrollment({ cliente_id: "c1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empresa_id_box3/);
  });
});

describe("dvr — normalizeRegistro", () => {
  it("aceita marca/modelo/ip/porta + consentimento aceito", () => {
    const r = dvr.normalizeRegistro({
      dvr: { marca: "Intelbras", modelo: "MHDX 1108", ip: "192.168.1.108", porta: 80 },
      consentimento: { aceito: true, quando: 1734567890000, versaoTexto: "v1" },
    });
    expect(r.ok).toBe(true);
    expect(r.value.marca).toBe("Intelbras");
    expect(r.value.porta).toBe(80);
    expect(r.value.consentimento).toEqual({ aceito: true, quando: 1734567890000, versaoTexto: "v1" });
  });
  it("SEM consentimento.aceito=true → recusa (contratos §3)", () => {
    expect(dvr.normalizeRegistro({ dvr: { marca: "x" } }).ok).toBe(false);
    expect(dvr.normalizeRegistro({ dvr: { marca: "x" }, consentimento: { aceito: false } }).ok).toBe(false);
  });
  it("porta fora de 1..65535 → recusa; ausente → null", () => {
    expect(dvr.normalizeRegistro({ dvr: { porta: 0 }, consentimento: { aceito: true } }).ok).toBe(false);
    expect(dvr.normalizeRegistro({ dvr: { porta: 70000 }, consentimento: { aceito: true } }).ok).toBe(false);
    expect(dvr.normalizeRegistro({ dvr: { porta: "abc" }, consentimento: { aceito: true } }).ok).toBe(false);
    const semPorta = dvr.normalizeRegistro({ dvr: {}, consentimento: { aceito: true } });
    expect(semPorta.ok).toBe(true);
    expect(semPorta.value.porta).toBe(null);
  });
  it("A CREDENCIAL do DVR NUNCA entra no objeto normalizado (allow-list, contratos §3)", () => {
    const r = dvr.normalizeRegistro({
      dvr: { marca: "Dahua", ip: "10.0.0.9", usuario: "admin", senha: "hunter2", password: "x" },
      consentimento: { aceito: true },
    });
    expect(r.ok).toBe(true);
    // o normalizado só tem os campos allow-listados — nenhuma credencial sobrevive.
    expect(Object.keys(r.value).sort()).toEqual(["consentimento", "ip", "marca", "modelo", "porta"]);
    expect(JSON.stringify(r.value)).not.toContain("hunter2");
    expect(JSON.stringify(r.value)).not.toContain("admin");
  });
});
