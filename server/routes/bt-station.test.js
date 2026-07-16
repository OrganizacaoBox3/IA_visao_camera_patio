// Testes da rota de ingest/snapshot BLE (bt-station.js) — o contrato HTTP da frente multi-antena (F2):
//   • CA-1: dois POSTs de estações DISTINTAS p/ o mesmo MAC → as duas séries coexistem e o socket
//     entrega um envelope por POST, cada um com seu stationId;
//   • CA-3: GET /api/bt/readings DEFAULT colapsa por MAC (retrocompat — 1 estação é indistinguível
//     do formato de sempre); `?all=1` (aditivo) devolve todas as fontes.
// Sem servidor real: handle(req,res,ctx) é função pura de roteamento — ctx mockado (padrão vitest).
// Auth de device: sem BT_STATION_TOKEN e fora de produção o endpoint é aberto (MVP em LAN).
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const route = require("./bt-station");
const stations = require("../bt/stations"); // registry real (auto-descoberta acontece no POST)

// A auto-descoberta escreve server/bt/stations.json (fallback JSON, gitignored) → limpo no afterAll.
const STATIONS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bt/stations.json");
afterAll(() => {
  try {
    fs.unlinkSync(STATIONS_FILE);
  } catch {
    /* pode não existir */
  }
});

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

const post = (stationId, readings, extra = {}) => ({
  url: "/api/bt/reading",
  method: "POST",
  headers: {},
  _body: JSON.stringify({ stationId, readings, ...extra }),
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

// DETECÇÃO DE ESTAÇÃO CEGA (causa C1/bug B6): o POST repassa ao registry `hadReadings` (o batch
// trouxe ≥1 leitura?) e `scanning` (se o app mandar boolean). TUDO ADITIVO — o payload antigo
// (sem os campos) segue bit-idêntico na resposta E no registro.
describe("bt-station — repasse ao registry p/ detecção de estação CEGA", () => {
  let ctx, responses;
  beforeEach(() => {
    ({ ctx, responses } = makeCtx());
  });

  it("POST com leituras + scanning: true → seen carimba ultimaLeituraEm e grava scanning", async () => {
    await route.handle(
      post("cega-a", [{ mac: "EE:EE:EE:00:00:10", rssi: -50 }], { scanning: true }),
      {},
      ctx,
    );
    expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 1 } });
    const s = stations.get("cega-a");
    expect(s.ultimaLeituraEm).toBeGreaterThan(0);
    expect(s.scanning).toBe(true);
  });

  it("POST vazio (readings: []) → viva pelo POST, mas ultimaLeituraEm segue null (o caso das 22 h)", async () => {
    await route.handle(post("cega-b", [], { scanning: false }), {}, ctx);
    expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 0 } });
    const s = stations.get("cega-b");
    expect(s.ultimaVezEm).toBeGreaterThan(0); // "viva" pelo POST…
    expect(s.ultimaLeituraEm).toBeNull(); // …sem NUNCA ter lido uma tag
    expect(s.scanning).toBe(false); // e o app confessa: scan desligado
  });

  it("scanning inválido (string) → ignorado em silêncio; a resposta não muda", async () => {
    await route.handle(post("cega-c", [], { scanning: "sim" }), {}, ctx);
    expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 0 } });
    expect(stations.get("cega-c").scanning).toBeNull();
  });

  it("payload ANTIGO (sem scanning) → intacto: resposta {ok,n}, leitura carimbada, scanning null", async () => {
    await route.handle(post("legado-1", [{ mac: "EE:EE:EE:00:00:11", rssi: -60 }]), {}, ctx);
    expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 1 } });
    const s = stations.get("legado-1");
    expect(s.ultimaLeituraEm).toBeGreaterThan(0); // trouxe leitura → carimba
    expect(s.scanning).toBeNull(); // app antigo não reporta → null, nunca inventado
  });
});
