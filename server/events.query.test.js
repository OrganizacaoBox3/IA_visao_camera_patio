// GATE ANTI-SUBCONTAGEM SILENCIOSA na fila de alarmes (bug B3).
// O relatório pede `limit:500` sobre uma fila com retenção de 1000: o corte acontece ANTES de
// qualquer filtro do cliente, então KPI/tendência de "últimos 30 dias" subcontavam SEM AVISO.
// Aqui travamos o contrato que torna o corte VISÍVEL — `total`/`truncated` (corte do limit) e
// `retentionClipped` (o corte invisível: o que a retenção já descartou) — e, junto, que o contrato
// ANTIGO (array puro, sem `meta`) segue de pé para quem já consome (Central).
//
// RETENÇÃO fixada em 1200 ANTES do require (RETENTION é lido no load do módulo) para o cenário do
// enunciado (1200 eventos) caber na fila; writeFileSync é NO-OP (nunca toca o alarms.json real).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

process.env.ALARM_EVENTS_RETENTION = "1200";
process.env.ALARM_LOG_LEVEL = "silent"; // 1200 records = 1200 linhas de log no gate; ruído
const require = createRequire(import.meta.url);
const events = require("./events");
const alarmsRoute = require("./routes/alarms");

const N = 1200;
const T0 = 1_700_000_000_000; // base fixa: nada aqui depende do relógio da máquina
const RETENTION = 1200;

let writeSpy;
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});
afterEach(() => {
  writeSpy.mockRestore();
});

// Uma única carga de 1200 eventos (ts crescente ⇒ a fila fica ts desc, como o store promete).
// prioridade alternada p/ provar que o filtro roda ANTES do corte.
beforeAll(async () => {
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  for (let i = 0; i < N; i++) {
    await events.record({
      ts: T0 + i,
      text: `evento ${i}`,
      tipo: "atividade",
      priority: i % 3 === 0 ? "critical" : "advisory",
    });
  }
  spy.mockRestore();
});

describe("events.page — o corte do LIMIT deixa de ser invisível", () => {
  it("1200 eventos com limit 500 ⇒ 500 itens, total 1200, truncated true", () => {
    const p = events.page({ limit: 500, since: T0 - 86_400_000 });
    expect(p.events.length).toBe(500);
    expect(p.total).toBe(N);
    expect(p.truncated).toBe(true);
    expect(p.limit).toBe(500);
  });

  it("página que cabe inteira ⇒ truncated false e total == nº de itens", () => {
    const p = events.page({ limit: 500, since: T0 + 1000 }); // sobram 199 (ts > T0+1000)
    expect(p.total).toBe(199);
    expect(p.events.length).toBe(199);
    expect(p.truncated).toBe(false);
  });

  it("o filtro roda ANTES do corte: `total` é do universo FILTRADO, não da fila inteira", () => {
    const p = events.page({ limit: 500, since: T0 - 1, priority: "critical" });
    expect(p.total).toBe(Math.ceil(N / 3)); // i % 3 === 0
    expect(p.total).toBeLessThan(N);
    expect(p.events.every((e) => e.priority === "critical")).toBe(true);
  });

  it("limit acima da retenção não inventa dado: teto = RETENTION", () => {
    expect(events.page({ limit: 999_999 }).limit).toBe(RETENTION);
  });
});

describe("events.page — o corte INVISÍVEL (retenção) só é acusado quando morde a janela", () => {
  it("fila no teto + janela que começa ANTES do mais antigo guardado ⇒ retentionClipped", () => {
    const p = events.page({ limit: 500, since: T0 - 86_400_000 });
    expect(p.retention).toBe(RETENTION);
    expect(p.oldestTs).toBe(T0);
    expect(p.retentionClipped).toBe(true); // há 30 dias pedidos que a fila não guarda
  });

  it("janela inteiramente DENTRO do que se guarda ⇒ sem aviso (ruído não é informação)", () => {
    expect(events.page({ limit: 500, since: T0 + 500 }).retentionClipped).toBe(false);
  });

  it("sem `since` não se afirma nada sobre cobertura", () => {
    expect(events.page({ limit: 500 }).retentionClipped).toBe(false);
  });
});

describe("GET /api/alarms — contrato ADITIVO (o array antigo continua array)", () => {
  const ctx = () => {
    const cap = {};
    return {
      cap,
      json: (_res, status, body) => {
        cap.status = status;
        cap.body = body;
      },
      readBody: async () => "",
      requireAuth: () => ({ id: "u1", usuario: "op" }),
      requireConfigurer: () => ({ id: "u1", usuario: "op" }),
      io: { to: () => ({ emit: () => {} }) },
    };
  };

  it("sem `meta`: resposta é o ARRAY de eventos (cliente existente intacto)", async () => {
    const c = ctx();
    const handled = await alarmsRoute.handle({ url: "/api/alarms?limit=500", method: "GET" }, {}, c);
    expect(handled).toBe(true);
    expect(c.cap.status).toBe(200);
    expect(Array.isArray(c.cap.body)).toBe(true);
    expect(c.cap.body.length).toBe(500);
  });

  it("com `meta=1`: envelope com total/truncated (1200 eventos, limit 500)", async () => {
    const c = ctx();
    await alarmsRoute.handle(
      { url: `/api/alarms?limit=500&since=${T0 - 86_400_000}&meta=1`, method: "GET" },
      {},
      c,
    );
    expect(c.cap.status).toBe(200);
    expect(Array.isArray(c.cap.body)).toBe(false);
    expect(c.cap.body.total).toBe(N);
    expect(c.cap.body.truncated).toBe(true);
    expect(c.cap.body.events.length).toBe(500);
  });
});
