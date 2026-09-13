// Intervalos de notificação — o que estes testes impedem:
//   1. que "campo em branco" vire 0 ms (0 = renotifica a cada tick = a inundação que a
//      política inteira existe para evitar; e ninguém jamais pediu isso);
//   2. que se prometa uma cadência que o sistema não honra (o tick de saúde é de 30s, então
//      o piso é 1 min — prometer 10s e entregar 30s é mentir para quem configurou);
//   3. que um valor absurdo vindo de um PATCH manual derrube ou trave o hub.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRESETS, MIN_MS, MAX_MS, clampMs, fromMinutes, humanize, isPreset } = require("./intervals");

describe("fromMinutes — o que o usuário digita", () => {
  it("lê minutos e devolve ms", () => {
    expect(fromMinutes(45)).toBe(45 * 60_000);
    expect(fromMinutes("45")).toBe(45 * 60_000);
    expect(fromMinutes("45 min")).toBe(45 * 60_000);
    expect(fromMinutes("1,5")).toBe(90_000); // vírgula decimal pt-BR
  });

  it("campo em BRANCO devolve null, nunca 0", () => {
    for (const v of ["", null, undefined, "   ", "abc"]) expect(fromMinutes(v)).toBeNull();
  });

  it("zero e negativo devolvem null (não existe 'lembrar a cada 0 minutos')", () => {
    expect(fromMinutes(0)).toBeNull();
    expect(fromMinutes(-30)).toBeNull();
    expect(fromMinutes("-5")).toBeNull();
  });

  it("prende nos limites em vez de aceitar absurdo", () => {
    expect(fromMinutes(0.1)).toBe(MIN_MS); // 6s pedido → 1min entregue (o tick é de 30s)
    expect(fromMinutes(60 * 24 * 30)).toBe(MAX_MS); // 30 dias → 24h
  });
});

describe("clampMs — a borda de quem vem de fora (env, PATCH manual, hub antigo)", () => {
  it("valor válido passa inteiro", () => {
    expect(clampMs(30 * 60_000)).toBe(30 * 60_000);
  });

  it("lixo devolve null (quem chama decide o default — o módulo não inventa)", () => {
    for (const v of [null, undefined, "", "x", NaN, Infinity, 0, -1]) expect(clampMs(v)).toBeNull();
  });

  it("prende acima e abaixo", () => {
    expect(clampMs(1)).toBe(MIN_MS);
    expect(clampMs(9e15)).toBe(MAX_MS);
  });
});

describe("humanize — o MESMO texto em tela, log e mensagem", () => {
  it("usa o rótulo do preset quando o valor é um preset", () => {
    expect(humanize(30 * 60_000)).toBe("30 minutos");
    expect(humanize(8 * 3_600_000)).toBe("8 horas (turno)");
  });

  it("valor personalizado sai legível, não em ms", () => {
    expect(humanize(45 * 60_000)).toBe("45 minutos");
    expect(humanize(90 * 60_000)).toBe("1h 30min");
    expect(humanize(3 * 3_600_000)).toBe("3 horas");
  });

  it("valor ilegível vira travessão, não 'NaN'", () => {
    expect(humanize(null)).toBe("—");
    expect(humanize("abc")).toBe("—");
  });
});

describe("a lista de presets", () => {
  it("cobre de 1 minuto a 24 horas, em ordem crescente e sem repetição", () => {
    const ms = PRESETS.map((p) => p.ms);
    expect(ms[0]).toBe(MIN_MS);
    expect(ms[ms.length - 1]).toBe(MAX_MS);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
    expect(new Set(ms).size).toBe(ms.length);
  });

  it("todo preset tem rótulo em pt-BR e é reconhecido como preset", () => {
    for (const p of PRESETS) {
      expect(p.label).toMatch(/minuto|hora/);
      expect(isPreset(p.ms)).toBe(true);
    }
    expect(isPreset(45 * 60_000)).toBe(false); // personalizado
  });
});
