// Testes das derivações puras da view (camera/derive.ts): assinatura do painel (gate de
// re-render), modo predominante (preset) e legenda por modos em uso.
import { describe, it, expect } from "vitest";
import { panelSig, twSig, dominantMode, legendFor } from "./derive";
import type { ZoneResult } from "./draw";
import type { Zone } from "../zones";

function zone(modo: Zone["modo"], selectedClasses: string[] = []): Zone {
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
  };
}

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
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/Exclusão/);
  });
  it("atividade traz os 4 estados", () => {
    expect(legendFor([zone("atividade")]).map((i) => i.label)).toEqual([
      "Ativa",
      "Lenta/Ociosa",
      "Alerta",
      "Pessoa",
    ]);
  });
});
