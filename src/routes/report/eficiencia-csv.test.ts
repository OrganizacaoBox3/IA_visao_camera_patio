// Gate da seção de EFICIÊNCIA no CSV/PDF exportado.
//
// POR QUE ESTE TESTE EXISTE: o CSV e o PDF saem da empresa e circulam sozinhos — vão ser abertos
// numa reunião sem quem os gerou por perto. Uma taxa de eficiência sem o DENOMINADOR ao lado é
// indefensável (e é exatamente o denominador que alguém vai querer contestar). Estes testes
// travam três coisas que o artefato exportado NUNCA pode perder:
//   1. o denominador viaja junto (horas de turno, horas com presença, meta, fórmula);
//   2. "não medido" nunca vira "0" — falso-OK num relatório de produtividade cobra alguém por
//      um número que ninguém mediu;
//   3. o escopo declarado: mede o POSTO, não a pessoa (o sistema não identifica ninguém).
import { describe, expect, it } from "vitest";
import { eficienciaSection } from "./csv";
import { eficiencia } from "../../report/calc/eficiencia";

const texto = (s: ReturnType<typeof eficienciaSection>) =>
  s.rows.map((r) => r.join(" | ")).join("\n");

describe("eficienciaSection — o que viaja no artefato exportado", () => {
  const completa = eficiencia({
    horasTurno: 8,
    ocupacaoPct: 75,
    volume: 120,
    metaPorHora: 20,
    unidade: "caixas",
  });

  it("leva a taxa E o denominador inteiro (horas, presença, meta, fórmula)", () => {
    const t = texto(eficienciaSection({ ef: completa, metaPorHora: 20 }));
    expect(t).toContain("100%"); // a taxa
    expect(t).toContain("8 h"); // horas de turno
    expect(t).toContain("6 h"); // horas com presença
    expect(t).toContain("20 caixas/hora"); // a meta informada
    expect(t).toMatch(/taxa = ritmo ÷ meta/); // como o número foi feito
  });

  it("declara o ESCOPO: posto, não pessoa (o PDF circula sem quem o gerou)", () => {
    const t = texto(eficienciaSection({ ef: completa, metaPorHora: 20 }));
    expect(t).toMatch(/POSTO, n[ãa]o a pessoa/i);
    expect(t).toMatch(/sem identifica/i);
  });

  it("sem meta: diz 'não informada' e NÃO inventa taxa", () => {
    const semMeta = eficiencia({ horasTurno: 8, ocupacaoPct: 75, volume: 120, unidade: "caixas" });
    const t = texto(eficienciaSection({ ef: semMeta, metaPorHora: null }));
    expect(t).toContain("não informada");
    expect(t).toMatch(/Taxa de efici[êe]ncia \| não medido/);
    expect(t).toContain("20"); // o ritmo medido continua lá — o que falta é só o percentual
  });

  it("sem volume: nada de 0 caixas/hora — sai 'não medido' e a observação explica", () => {
    const semVol = eficiencia({ horasTurno: 8, ocupacaoPct: 75, volume: null, unidade: "caixas" });
    const t = texto(eficienciaSection({ ef: semVol, metaPorHora: 20 }));
    expect(t).not.toMatch(/\| 0$/m); // nenhuma linha termina em zero
    expect(t).toMatch(/Ritmo.*\| não medido/);
    expect(t).toMatch(/Observação \|.*volume/i);
  });

  it("sem turno carimbado: tudo 'não medido' e a observação aponta o elo que faltou", () => {
    const semTurno = eficiencia({ horasTurno: 0, ocupacaoPct: null, volume: null });
    const t = texto(eficienciaSection({ ef: semTurno, metaPorHora: null }));
    expect(t).toMatch(/Taxa de efici[êe]ncia \| não medido/);
    expect(t).toMatch(/Observação \|.*turno/i);
  });
});
