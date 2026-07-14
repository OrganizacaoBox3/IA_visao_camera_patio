import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { summarize, report } = require("./persistence-health");

describe("persistence-health — o guardião da armadilha 'PG configurado + store no JSON'", () => {
  it("PG configurado + todos no PG → sem perigo", () => {
    const s = summarize(true, { shifts: "pg", users: "pg" });
    expect(s.danger).toBe(false);
    expect(s.onJson).toEqual([]);
  });

  it("PG configurado + um store no JSON → PERIGO (é o caso dos turnos do dono)", () => {
    const s = summarize(true, { shifts: "json", users: "pg", "bt-tags": "pg" });
    expect(s.danger).toBe(true);
    expect(s.onJson).toEqual(["shifts"]);
  });

  it("SEM PG (dev/homolog em JSON) → NÃO é perigo (JSON é o esperado ali)", () => {
    const s = summarize(false, { shifts: "json", users: "json" });
    expect(s.danger).toBe(false); // sem PG, o JSON é o backend legítimo, não uma queda silenciosa
  });

  it("lista os stores em JSON ordenados (mensagem estável)", () => {
    const s = summarize(true, { shifts: "json", users: "pg", events: "json", camcfg: "pg" });
    expect(s.onJson).toEqual(["events", "shifts"]);
  });
});

describe("persistence-health — report() loga o resumo e GRITA só no perigo", () => {
  function fakeLog() {
    const logs = [];
    const warns = [];
    return { log: (m) => logs.push(m), warn: (m) => warns.push(m), _logs: logs, _warns: warns };
  }

  it("perigo → emite o banner de ALERTA (com os stores culpados)", () => {
    const lg = fakeLog();
    report(true, { shifts: "json", users: "pg" }, lg);
    expect(lg._logs.join("\n")).toContain("shifts=json");
    const banner = lg._warns.join("\n");
    expect(banner).toContain("ALERTA DE PERSISTÊNCIA");
    expect(banner).toContain("shifts");
  });

  it("tudo no PG → resumo, mas NENHUM alerta (warn não é chamado)", () => {
    const lg = fakeLog();
    report(true, { shifts: "pg", users: "pg" }, lg);
    expect(lg._warns).toHaveLength(0);
  });
});
