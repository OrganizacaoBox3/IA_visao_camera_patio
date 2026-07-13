// Testes da rota de ingest/snapshot BLE (bt-station.js) — o contrato HTTP da frente multi-antena (F2):
//   • CA-1: dois POSTs de estações DISTINTAS p/ o mesmo MAC → as duas séries coexistem e o socket
//     entrega um envelope por POST, cada um com seu stationId;
//   • CA-3: GET /api/bt/readings DEFAULT colapsa por MAC (retrocompat — 1 estação é indistinguível
//     do formato de sempre); `?all=1` (aditivo) devolve todas as fontes.
// Sem servidor real: handle(req,res,ctx) é função pura de roteamento — ctx mockado (padrão vitest).
// Auth de device: sem BT_STATION_TOKEN e fora de produção o endpoint é aberto (MVP em LAN).
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const route = require("./bt-station");

// ── mocks mínimos do ctx (espelham o contrato do index.js: json/readBody/requireAuth/io) ──────────
function makeCtx() {
  const responses = []; // cada json(res, code, data) vira {code, data}
  const emits = []; // cada io.to(...).volatile.emit(ev, payload) vira {ev, payload}
  const ctx = {
    json: (_res, code, data) => responses.push({ code, data }),
    readBody: (req) => Promise.resolve(req._body || ""),
    requireAuth: () => ({ id: "u1", papel: "usuario" }), // autenticado (o GET só exige sessão)
    io: { to: () => ({ volatile: { emit: (ev, payload) => emits.push({ ev, payload }) } }) },
  };
  return { ctx, responses, emits };
}

const post = (stationId, readings) => ({
  url: "/api/bt/reading",
  method: "POST",
  headers: {},
  _body: JSON.stringify({ stationId, readings }),
});
const get = (url) => ({ url, method: "GET", headers: {} });

describe("bt-station — ingest multi-antena (CA-1)", () => {
  let ctx, responses, emits;
  beforeEach(() => {
    ({ ctx, responses, emits } = makeCtx());
  });

  it("dois POSTs de estações distintas p/ o MESMO MAC → coexistem; socket leva um envelope por POST", async () => {
    const MAC = "EE:EE:EE:00:00:01";
    expect(await route.handle(post("rota-a", [{ mac: MAC, rssi: -48 }]), {}, ctx)).toBe(true);
    expect(await route.handle(post("rota-b", [{ mac: MAC, rssi: -72 }]), {}, ctx)).toBe(true);
    expect(responses.map((r) => r.code)).toEqual([200, 200]);

    // O relay preserva a FONTE: um envelope por POST, cada um com seu stationId.
    const envs = emits.filter((e) => e.ev === "bt-readings");
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => e.payload.stationId)).toEqual(["rota-a", "rota-b"]);
    expect(envs[0].payload.readings[0]).toMatchObject({ mac: MAC, rssi: -48, stationId: "rota-a" });
    expect(envs[1].payload.readings[0]).toMatchObject({ mac: MAC, rssi: -72, stationId: "rota-b" });

    // GET ?all=1 (formato novo): as DUAS séries vivas, nenhuma sobrescrita.
    await route.handle(get("/api/bt/readings?all=1"), {}, ctx);
    const all = responses[2].data.filter((r) => r.mac === MAC);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.stationId).sort()).toEqual(["rota-a", "rota-b"]);
  });

  it("CA-3: GET default colapsa por MAC (o mais fresco) — retrocompat dos consumidores por MAC", async () => {
    const MAC = "EE:EE:EE:00:00:02";
    await route.handle(post("rota-a", [{ mac: MAC, rssi: -50 }]), {}, ctx);
    await route.handle(post("rota-b", [{ mac: MAC, rssi: -66 }]), {}, ctx);
    await route.handle(get("/api/bt/readings"), {}, ctx);
    const recs = responses[2].data.filter((r) => r.mac === MAC);
    expect(recs).toHaveLength(1); // 1 rec/MAC, como o formato de sempre
    expect(recs[0].rssi).toBe(-66); // o mais fresco vence (last-writer-wins preservado)
  });

  it("GET com querystring desconhecida segue roteado (split em '?' não quebra o match)", async () => {
    await route.handle(get("/api/bt/readings?x=1"), {}, ctx);
    expect(responses).toHaveLength(1);
    expect(responses[0].code).toBe(200);
    expect(Array.isArray(responses[0].data)).toBe(true);
  });
});
