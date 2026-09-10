// Testes da decomposição de EFICIÊNCIA. O que estes testes protegem, em ordem de gravidade:
//
//   1. NUNCA inventar taxa. Sem turno, sem presença, sem volume ou sem meta, o número não
//      existe — e o módulo tem de dizer QUAL elo faltou, não devolver 0 (falso-OK é pior que
//      erro: "0% de eficiência" manda o gestor cobrar alguém por um dado que não foi medido).
//   2. A IDENTIDADE bruta = efetiva × aproveitamento. É ela que separa "o posto ficou vazio"
//      de "tinha gente e saiu pouco" — duas causas com ações opostas. Se a identidade quebrar,
//      a decomposição perde o sentido e vira dois números soltos.
//   3. Divisão por zero não vira Infinity no relatório de ninguém.
import { describe, it, expect } from "vitest";
import { eficiencia, MOTIVO_TEXTO, type EficienciaEntrada } from "./eficiencia";

const base: EficienciaEntrada = {
  horasTurno: 8,
  ocupacaoPct: 75,
  volume: 120,
  metaPorHora: 20,
  unidade: "caixas",
};

describe("eficiencia — o caminho completo", () => {
  it("calcula a decomposição inteira quando tudo foi medido", () => {
    const r = eficiencia(base);
    expect(r.horasTurno).toBe(8);
    expect(r.horasComPresenca).toBe(6); // 8h × 75%
    expect(r.aproveitamentoPct).toBe(75);
    expect(r.produtividadeBruta).toBe(15); // 120 ÷ 8h de turno
    expect(r.produtividadeEfetiva).toBe(20); // 120 ÷ 6h com gente
    expect(r.taxaPct).toBe(100); // 20 ÷ meta 20
    expect(r.motivo).toBeNull();
  });

  it("a IDENTIDADE se sustenta: bruta = efetiva × aproveitamento", () => {
    for (const [horas, ocup, vol] of [
      [8, 75, 120],
      [6, 50, 90],
      [12, 100, 240],
      [4, 25, 10],
    ]) {
      const r = eficiencia({ ...base, horasTurno: horas, ocupacaoPct: ocup, volume: vol });
      const recomposta = (r.produtividadeEfetiva as number) * ((r.aproveitamentoPct as number) / 100);
      expect(recomposta).toBeCloseTo(r.produtividadeBruta as number, 1);
    }
  });

  it("separa as DUAS causas de resultado ruim (o motivo de existir da decomposição)", () => {
    // Mesmo volume/hora de POSTO (10/h), causas opostas:
    const vazio = eficiencia({ ...base, ocupacaoPct: 50, volume: 80 }); // pouca gente, ritmo bom
    const lento = eficiencia({ ...base, ocupacaoPct: 100, volume: 80 }); // gente o tempo todo, ritmo ruim
    expect(vazio.produtividadeBruta).toBe(lento.produtividadeBruta); // indistinguíveis num número só
    expect(vazio.produtividadeEfetiva).toBe(20); // ritmo BOM
    expect(lento.produtividadeEfetiva).toBe(10); // ritmo RUIM
    expect(vazio.taxaPct).toBe(100);
    expect(lento.taxaPct).toBe(50);
  });
});

describe("eficiencia — cala quando não tem denominador (e diz por quê)", () => {
  it("sem turno carimbado: TUDO null, motivo sem-turno", () => {
    const r = eficiencia({ ...base, horasTurno: 0 });
    expect(r.taxaPct).toBeNull();
    expect(r.produtividadeBruta).toBeNull();
    expect(r.produtividadeEfetiva).toBeNull();
    expect(r.horasComPresenca).toBeNull();
    expect(r.motivo).toBe("sem-turno");
  });

  it("sem volume: mostra o que dá (presença), cala produtividade, motivo sem-volume", () => {
    const r = eficiencia({ ...base, volume: null });
    expect(r.aproveitamentoPct).toBe(75); // isto FOI medido
    expect(r.horasComPresenca).toBe(6);
    expect(r.produtividadeBruta).toBeNull();
    expect(r.taxaPct).toBeNull();
    expect(r.motivo).toBe("sem-volume");
  });

  it("sem presença medida: bruta existe, efetiva e taxa não (motivo sem-presenca)", () => {
    const r = eficiencia({ ...base, ocupacaoPct: null });
    expect(r.produtividadeBruta).toBe(15); // o posto rendeu isto por hora de turno
    expect(r.produtividadeEfetiva).toBeNull(); // sem saber quando havia gente, não dá p/ isolar
    expect(r.taxaPct).toBeNull();
    expect(r.motivo).toBe("sem-presenca");
  });

  it("sem meta: produtividades aparecem, taxa não (motivo sem-meta)", () => {
    for (const meta of [undefined, null, 0, -5, NaN]) {
      const r = eficiencia({ ...base, metaPorHora: meta as number });
      expect(r.produtividadeEfetiva).toBe(20);
      expect(r.taxaPct).toBeNull();
      expect(r.motivo).toBe("sem-meta");
    }
  });

  it("presença ZERO com volume > 0 é contradição de medição — não vira Infinity", () => {
    const r = eficiencia({ ...base, ocupacaoPct: 0, volume: 50 });
    expect(r.horasComPresenca).toBe(0);
    expect(r.produtividadeEfetiva).toBeNull();
    expect(r.taxaPct).toBeNull();
    expect(r.motivo).toBe("sem-presenca");
    expect(r.produtividadeBruta).toBe(6.3); // o posto produziu; a câmera é que não viu quem
  });

  it("volume ZERO é medição válida (produziu nada), não ausência", () => {
    const r = eficiencia({ ...base, volume: 0 });
    expect(r.produtividadeBruta).toBe(0);
    expect(r.produtividadeEfetiva).toBe(0);
    expect(r.taxaPct).toBe(0); // zero% é uma afirmação legítima aqui
    expect(r.motivo).toBeNull();
  });
});

describe("eficiencia — robustez", () => {
  it("ocupação fora de 0..100 é presa na faixa (dado corrompido não vira taxa absurda)", () => {
    expect(eficiencia({ ...base, ocupacaoPct: 150 }).aproveitamentoPct).toBe(100);
    expect(eficiencia({ ...base, ocupacaoPct: -20 }).aproveitamentoPct).toBe(0);
  });

  it("entradas não-numéricas degradam para ausência, não para NaN", () => {
    const r = eficiencia({
      horasTurno: NaN,
      ocupacaoPct: NaN,
      volume: NaN,
      metaPorHora: NaN,
    });
    expect(r.motivo).toBe("sem-turno");
    expect(Number.isNaN(r.taxaPct as number)).toBe(false);
    expect(r.taxaPct).toBeNull();
  });

  it("todo motivo tem texto (a UI nunca fica sem explicação para exibir)", () => {
    for (const m of ["sem-turno", "sem-presenca", "sem-volume", "sem-meta"] as const) {
      expect(MOTIVO_TEXTO[m]).toBeTruthy();
      expect(MOTIVO_TEXTO[m].length).toBeGreaterThan(20);
    }
  });

  it("unidade default não quebra o texto de quem exibe", () => {
    expect(eficiencia({ horasTurno: 8, ocupacaoPct: 50, volume: 10 }).unidade).toBe("itens");
    expect(eficiencia(base).unidade).toBe("caixas");
  });
});
