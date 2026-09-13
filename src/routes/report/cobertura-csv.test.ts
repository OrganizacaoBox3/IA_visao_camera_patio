// Gate da seção de COBERTURA no CSV/PDF exportado.
//
// POR QUE ESTE TESTE EXISTE: a planilha sai da empresa e é aberta numa reunião sem quem a
// gerou por perto. "0 alertas" numa linha é lido como operação tranquila — e é EXATAMENTE
// isso que não se pode afirmar quando a análise cobriu 30% do período. O número da cobertura
// sozinho também não basta: quem lê a planilha não sabe o que fazer com "30%". Por isso o
// veredito viaja por extenso, ao lado do número, em português.
import { describe, expect, it } from "vitest";
import { coberturaSection } from "./csv";
import type { Cobertura } from "../../report/calc";

const texto = (s: ReturnType<typeof coberturaSection>) =>
  s.rows.map((r) => r.join(" | ")).join("\n");

const cob = (over: Partial<Cobertura> = {}): Cobertura => ({
  pct: 95,
  observadoMs: 19 * 3_600_000,
  esperadoMs: 20 * 3_600_000,
  horasSemDado: 0,
  horasEsperadas: 20,
  cameras: 2,
  motivo: null,
  ...over,
});

describe("coberturaSection — o que viaja no artefato exportado", () => {
  it("leva o número E o denominador inteiro (analisado, esperado, câmeras, horas)", () => {
    const t = texto(coberturaSection(cob()));
    expect(t).toContain("Cobertura da análise (%) | 95");
    expect(t).toContain("19h"); // tempo analisado
    expect(t).toContain("20h"); // denominador
    expect(t).toContain("Câmeras consideradas | 2");
    expect(t).toContain("Horas esperadas | 20");
  });

  it("cobertura BOA: diz explicitamente que os zeros são medição", () => {
    expect(texto(coberturaSection(cob({ pct: 95 })))).toMatch(/como MEDIÇÃO/);
  });

  it("cobertura BAIXA: o veredito por extenso avisa que um zero pode ser ausência de medição", () => {
    const t = texto(coberturaSection(cob({ pct: 30, horasSemDado: 14 })));
    expect(t).toMatch(/com RESSALVA/);
    expect(t).toMatch(/ausência de medição, não ausência de ocorrência/);
    expect(t).toContain("Horas sem dado nenhum | 14");
  });

  it("sem medição: 'não medido' com o motivo — NUNCA 0%", () => {
    const t = texto(coberturaSection(cob({ pct: null, motivo: "sem-medicao-de-tempo" })));
    expect(t).toContain("Cobertura da análise | não medido");
    expect(t).not.toMatch(/\| 0$/m);
    expect(t).toMatch(/Motivo \|.+/);
  });

  it("o ESCOPO viaja junto (período, não turno; desativada fora da conta)", () => {
    const t = texto(coberturaSection(cob()));
    expect(t).toMatch(/sem recorte de turno/);
    expect(t).toMatch(/desativada fora da conta/);
  });

  it("a seção tem título próprio — não some no meio de outra", () => {
    expect(coberturaSection(cob()).title).toBe("COBERTURA DA ANÁLISE");
  });
});
