// Diagnóstico de UTILIDADE por câmera (camera-diagnostico.js) — "quais câmeras não servem pra nada".
// O que o teste prova: cada motivo dispara pelo sinal que o define; desativada é ESCOLHA (nunca
// defeito); "sem pessoa" é atenção, não inútil (depósito fechado à noite é normal); e sinal
// ausente não inventa diagnóstico.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { diagnosticar } = require("./camera-diagnostico");

const AGORA = 1_700_000_000_000;
const H = 3_600_000;
const util = (over = {}) => ({
  online: true,
  estado: "producao",
  modo: "atividade",
  zonas: 2,
  linhas: 0,
  congelada: false,
  analiseLigada: true,
  analisadaDesde: AGORA - 2 * H,
  ultimaPessoaEm: AGORA - 60_000,
  ...over,
});
const codigos = (d) => d.motivos.map((m) => m.codigo);

describe("diagnosticar — câmera útil", () => {
  it("online, com área, vendo gente → ok e sem motivo", () => {
    const d = diagnosticar(util(), { agora: AGORA });
    expect(d.utilidade).toBe("ok");
    expect(d.motivos).toEqual([]);
  });
});

describe("diagnosticar — INÚTIL (custa e não devolve nada)", () => {
  it("offline", () => {
    const d = diagnosticar(util({ online: false }), { agora: AGORA });
    expect(d.utilidade).toBe("inutil");
    expect(codigos(d)).toContain("offline");
  });

  it("congelada, com os minutos no texto", () => {
    const d = diagnosticar(util({ congelada: true, paradoMs: 7 * 60_000 }), { agora: AGORA });
    expect(d.utilidade).toBe("inutil");
    expect(d.motivos.find((m) => m.codigo === "congelada").texto).toMatch(/7 min/);
  });

  it("câmera de área sem zona nem linha", () => {
    const d = diagnosticar(util({ zonas: 0, linhas: 0 }), { agora: AGORA });
    expect(d.utilidade).toBe("inutil");
    expect(codigos(d)).toEqual(["sem-area"]);
  });

  it("uma linha de contagem já basta (gera indicador de fluxo)", () => {
    expect(diagnosticar(util({ zonas: 0, linhas: 1 }), { agora: AGORA }).utilidade).toBe("ok");
  });

  it("câmera de OPERADOR (fadiga) não precisa de área — não acusa sem-area", () => {
    expect(
      codigos(diagnosticar(util({ modo: "fadiga", zonas: 0 }), { agora: AGORA })),
    ).not.toContain("sem-area");
  });
});

describe("diagnosticar — ATENÇÃO: horas de análise sem ver ninguém", () => {
  it("≥ janela analisando e sem pessoa → atenção (não inútil)", () => {
    const d = diagnosticar(
      util({ analisadaDesde: AGORA - 30 * H, ultimaPessoaEm: AGORA - 26 * H }),
      {
        agora: AGORA,
        horasSemPessoa: 24,
      },
    );
    expect(d.utilidade).toBe("atencao");
    expect(d.motivos[0].texto).toMatch(/26h de análise/);
  });

  it("nunca viu ninguém desde que começou a analisar → conta desde o início da análise", () => {
    const d = diagnosticar(util({ analisadaDesde: AGORA - 25 * H, ultimaPessoaEm: null }), {
      agora: AGORA,
      horasSemPessoa: 24,
    });
    expect(codigos(d)).toContain("sem-pessoa");
  });

  it("analisada há POUCO tempo não acusa (hub acabou de subir — não sabe ainda)", () => {
    const d = diagnosticar(util({ analisadaDesde: AGORA - 2 * H, ultimaPessoaEm: null }), {
      agora: AGORA,
      horasSemPessoa: 24,
    });
    expect(codigos(d)).not.toContain("sem-pessoa");
  });

  it("motor desligado ou câmera congelada não viram 'sem pessoa' (a causa é outra)", () => {
    const base = { analisadaDesde: AGORA - 30 * H, ultimaPessoaEm: null };
    expect(
      codigos(diagnosticar(util({ ...base, analiseLigada: false }), { agora: AGORA })),
    ).not.toContain("sem-pessoa");
    expect(
      codigos(diagnosticar(util({ ...base, congelada: true }), { agora: AGORA })),
    ).not.toContain("sem-pessoa");
  });
});

describe("diagnosticar — estados escolhidos pelo time", () => {
  it("desativada é à parte (utilidade 'desativada'), nunca 'inútil', e não acumula outros motivos", () => {
    const d = diagnosticar(util({ estado: "desativada", online: false, zonas: 0 }), {
      agora: AGORA,
    });
    expect(d.utilidade).toBe("desativada");
    expect(codigos(d)).toEqual(["desativada"]);
  });

  it("teste/manutenção entram como INFO e não pioram a utilidade", () => {
    const d = diagnosticar(util({ estado: "teste" }), { agora: AGORA });
    expect(d.utilidade).toBe("ok");
    expect(d.motivos[0].nivel).toBe("info");
  });
});
