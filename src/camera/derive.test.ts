// Testes das derivações puras da view (camera/derive.ts): assinatura do painel (gate de
// re-render), modo predominante (preset) e legenda por modos em uso.
import { describe, it, expect } from "vitest";
import { panelSig, twSig, dominantMode, legendFor, restritaSummary, armingSummary } from "./derive";
import type { ZoneResult } from "./draw";
import type { Zone } from "../zones";

function zone(modo: Zone["modo"], selectedClasses: string[] = [], over: Partial<Zone> = {}): Zone {
  return {
    id: `z-${modo}-${Math.random()}`,
    label: "Z",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    modo,
    idleAlertMs: 0,
    sensitivity: 5,
    atividade: "Indefinida",
    ponto: "P",
    selectedClasses,
    ...over,
  };
}
const labels = (zs: Zone[]) => legendFor(zs).map((i) => i.label);

describe("panelSig / twSig — assinatura estável do que o painel exibe", () => {
  const ativ: ZoneResult = {
    modo: "atividade",
    view: {
      id: "z1",
      label: "Z",
      state: "ATIVA",
      motion: 0.123,
      idleMs: 1500,
      occupied: true,
      alerts: 0,
      people: 2,
      flow: [0.5],
      flowLevel: "Médio",
    },
  };
  it("mesmo conteúdo visível → mesma assinatura (zero re-render)", () => {
    const a = panelSig(new Map([["z1", ativ]]));
    const b = panelSig(new Map([["z1", { ...ativ }]]));
    expect(a).toBe(b);
  });
  it("mudança VISÍVEL (people) muda a assinatura; campo não exibido (occupied) não muda", () => {
    const base = panelSig(new Map([["z1", ativ]]));
    const people = panelSig(
      new Map([["z1", { ...ativ, view: { ...ativ.view, people: 3 } } as ZoneResult]]),
    );
    const occ = panelSig(
      new Map([["z1", { ...ativ, view: { ...ativ.view, occupied: false } } as ZoneResult]]),
    );
    expect(people).not.toBe(base);
    expect(occ).toBe(base);
  });
  it("twSig serializa contadores por linha", () => {
    expect(twSig({ w1: { in: 2, out: 1 } })).toBe("w1:2:1;");
    expect(twSig({})).toBe("");
  });
});

describe("dominantMode — preset pelo modo predominante", () => {
  it("sem zonas → atividade; maioria vence", () => {
    expect(dominantMode([])).toBe("atividade");
    expect(dominantMode([zone("leitura"), zone("leitura"), zone("objetos")])).toBe("leitura");
  });
  it("empate → ordem atividade > leitura > objetos > fadiga", () => {
    expect(dominantMode([zone("fadiga"), zone("leitura")])).toBe("leitura");
  });
});

describe("legendFor — só as cores em uso", () => {
  it("modo exclusao entra como supressão; sem zonas → legenda vazia", () => {
    expect(legendFor([])).toEqual([]);
    const items = legendFor([zone("exclusao")]);
    expect(items[0].label).toMatch(/Exclusão/);
  });
  it("atividade traz os 4 estados", () => {
    expect(labels([zone("atividade")]).slice(0, 4)).toEqual([
      "Ativa",
      "Lenta/Ociosa",
      "Alerta",
      "Pessoa",
    ]);
  });

  // A zona que ALARMA era a única sem verbete: o overlay a desenha em dois estados (hachura
  // neutra ARMADA / vermelho saturado VIOLADA) e a legenda não explicava nenhum dos dois.
  it("zona restrita: entra com os DOIS estados (armada quieta e violada)", () => {
    const items = legendFor([zone("proibida")]);
    const armada = items.find((i) => /ARMADA/.test(i.label));
    const violada = items.find((i) => /VIOLADA/.test(i.label));
    expect(armada).toBeDefined();
    expect(violada).toBeDefined();
    // going-gray: armada é operação normal (neutra + hachura); saturação SÓ na violação.
    expect(armada?.color).toBe("var(--state-neutral)");
    expect(armada?.variant).toBe("hatch");
    expect(violada?.color).toBe("var(--state-critical)");
  });
  it("sem zona restrita, nenhum verbete de área restrita (só as cores em uso)", () => {
    expect(labels([zone("atividade")]).join(" ")).not.toMatch(/restrita/i);
  });

  // Os DOIS canais de incerteza da marcação: tracejado (sem leitura nova) × opacidade (confiança).
  // Sem estes verbetes, "caixa a 45%" seguiria ambígua — e as duas causas exigem AÇÃO diferente.
  it("marcação: verbetes separados para tracejado (coasting) e apagado (confiança)", () => {
    const items = legendFor([zone("atividade")]);
    const dashed = items.find((i) => i.variant === "dashed");
    const dim = items.find((i) => i.variant === "dim");
    expect(dashed?.label).toMatch(/sem leitura nova/i);
    expect(dim?.label).toMatch(/confian/i);
    // são canais DISTINTOS: mesma cor da pessoa, o que muda é o traço/opacidade
    expect(dashed?.color).toBe("var(--state-info)");
    expect(dim?.color).toBe("var(--state-info)");
  });
  it("sem zona nenhuma a legenda não aparece — nem os verbetes da marcação", () => {
    expect(legendFor([])).toEqual([]);
  });
});

// Uma linha no drawer dizendo QUANDO a área restrita alarma — o dwell e a janela de armamento
// viviam só dentro do diálogo de configuração.
describe("restritaSummary / armingSummary — a área restrita diz quando alarma", () => {
  it("dwell configurado + 24/7 (default)", () => {
    expect(restritaSummary({ presencaAlertMs: 30_000, arming: "sempre" })).toBe(
      "Alarma se alguém ficar mais de 30s · armada 24/7",
    );
  });
  it("sem presencaAlertMs cai no default (10s), nunca em 'undefined'", () => {
    expect(restritaSummary({})).toBe("Alarma se alguém ficar mais de 10s · armada 24/7");
  });
  it("dwell longo sai em minutos (fmtLimit), não em milissegundos crus", () => {
    expect(restritaSummary({ presencaAlertMs: 300_000 })).toMatch(/mais de 5min/);
  });
  it("janela por turnos: declara a janela quando há turno atribuído", () => {
    expect(armingSummary({ arming: "dentro-turnos", shiftIds: ["t1"] })).toBe(
      "armada só nos turnos",
    );
    expect(armingSummary({ arming: "fora-turnos", shiftIds: ["t1"] })).toBe(
      "armada só fora dos turnos",
    );
  });
  // FAIL-OPEN (zones.ts/servidor): config incompleta NUNCA cala o alarme — o texto não pode
  // prometer uma janela que não existe, senão o operador acha que a área está desarmada.
  it("turno exigido mas nenhum atribuído → declara 24/7 e o porquê", () => {
    expect(armingSummary({ arming: "fora-turnos", shiftIds: [] })).toBe(
      "armada 24/7 (sem turno atribuído)",
    );
    expect(armingSummary({ arming: "dentro-turnos" })).toMatch(/24\/7 \(sem turno atribuído\)/);
  });
});
