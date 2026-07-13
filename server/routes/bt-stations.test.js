// Testes do CONTRATO HTTP do registro de estações BLE:
//   • AUTO-DESCOBERTA fim-a-fim: POST /api/bt/reading de uma estação DESCONHECIDA (routes/bt-station)
//     → ela APARECE no GET /api/bt-stations, pendente de nome. POST repetido só atualiza ultimaVezEm.
//   • FAIL-SAFE: falha do registry NÃO derruba o POST de leitura (a leitura é o que importa).
//   • RBAC: GET exige sessão (requireAuth); PATCH/DELETE exigem perfil de configuração.
//   • NÃO há POST manual de cadastro (a estação nasce postando) → 404 do dispatch (handle → false).
// Sem servidor real: handle(req,res,ctx) é função pura de roteamento — ctx mockado (padrão da casa,
// espelha routes/bt-station.test.js). Efeito colateral: escreve server/bt/stations.json (gitignored).
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const routeStations = require("./bt-stations"); // CRUD (nome/ativo)
const routeStation = require("./bt-station"); // ingest (device-facing) — onde mora a auto-descoberta
const stations = require("../bt/stations");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bt", "stations.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

// ── ctx mockado (contrato do index.js: json/readBody/requireAuth/requireConfigurer/io) ──────────
function makeCtx({ configurer = true } = {}) {
  const responses = [];
  const ctx = {
    json: (_res, code, data) => responses.push({ code, data }),
    readBody: (req) => Promise.resolve(req._body || ""),
    requireAuth: () => ({ id: "u1", papel: "usuario" }),
    requireConfigurer: (_req, res) => {
      if (configurer) return { id: "u2", papel: "engenheiro" };
      ctx.json(res, 403, { error: "sem permissão" });
      return false;
    },
    io: { to: () => ({ volatile: { emit: () => {} } }) },
  };
  return { ctx, responses };
}
const postReading = (stationId, readings) => ({
  url: "/api/bt/reading",
  method: "POST",
  headers: {},
  _body: JSON.stringify({ stationId, readings }),
});
const req = (url, method, body) => ({
  url,
  method,
  headers: {},
  _body: body === undefined ? "" : JSON.stringify(body),
});

describe("estações BLE — AUTO-DESCOBERTA (o cadastro nasce do POST, não de um formulário)", () => {
  let ctx, responses;
  beforeEach(() => {
    ({ ctx, responses } = makeCtx());
  });

  it("POST de estação DESCONHECIDA → aparece no GET /api/bt-stations, pendente de nome", async () => {
    expect(await routeStation.handle(postReading("tc22-novo", [{ mac: "AA:01", rssi: -55 }]), {}, ctx)).toBe(true);
    expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 1 } });

    await routeStations.handle(req("/api/bt-stations", "GET"), {}, ctx);
    const nova = responses[1].data.find((s) => s.id === "tc22-novo");
    expect(nova).toBeTruthy();
    expect(nova.nome).toBe("tc22-novo"); // pendente: o operador batiza na tela /estacoes
    expect(nova.ativo).toBe(true);
    expect(nova.primeiraVezEm).toBeGreaterThan(0);
  });

  it("POST repetido NÃO duplica nem renomeia — só atualiza ultimaVezEm", async () => {
    await routeStation.handle(postReading("tc22-repeat", [{ mac: "AA:02", rssi: -60 }]), {}, ctx);
    await routeStations.handle(req("/api/bt-stations/tc22-repeat", "PATCH", { nome: "Doca 3" }), {}, ctx);
    const antes = stations.get("tc22-repeat");
    const primeira = antes.primeiraVezEm;
    const ultimaAntes = antes.ultimaVezEm;

    await new Promise((r) => setTimeout(r, 5)); // relógio real avança (ultimaVezEm = Date.now())
    await routeStation.handle(postReading("tc22-repeat", [{ mac: "AA:02", rssi: -61 }]), {}, ctx);

    const depois = stations.get("tc22-repeat");
    expect(stations.all().filter((s) => s.id === "tc22-repeat")).toHaveLength(1);
    expect(depois.nome).toBe("Doca 3"); // o nome do operador sobrevive ao POST
    expect(depois.primeiraVezEm).toBe(primeira);
    expect(depois.ultimaVezEm).toBeGreaterThanOrEqual(ultimaAntes);
  });

  it("FAIL-SAFE: registry quebrado NÃO derruba o POST — a leitura é o que importa", async () => {
    const original = stations.seen;
    stations.seen = () => Promise.reject(new Error("Postgres fora do ar"));
    try {
      const ok = await routeStation.handle(postReading("tc22-falha", [{ mac: "AA:03", rssi: -70 }]), {}, ctx);
      expect(ok).toBe(true);
      expect(responses[0]).toMatchObject({ code: 200, data: { ok: true, n: 1 } }); // leitura ingerida
    } finally {
      stations.seen = original;
    }
    expect(stations.get("tc22-falha")).toBeNull(); // não registrou (era o que estava quebrado)
  });

  it("stationId fora do formato do app não vira estação — e a leitura segue 200", async () => {
    await routeStation.handle(postReading("id inválido!", [{ mac: "AA:04", rssi: -66 }]), {}, ctx);
    expect(responses[0].code).toBe(200);
    expect(stations.all().some((s) => s.id === "id inválido!")).toBe(false);
  });
});

describe("estações BLE — CRUD + RBAC (lógica no BACK)", () => {
  it("PATCH renomeia/desativa; DELETE remove; erro do store vira 400 (400/404 corretos)", async () => {
    const { ctx, responses } = makeCtx();
    await routeStation.handle(postReading("est-crud", [{ mac: "AA:05", rssi: -50 }]), {}, ctx);

    await routeStations.handle(req("/api/bt-stations/est-crud", "PATCH", { nome: "Portaria" }), {}, ctx);
    expect(responses[1]).toMatchObject({ code: 200, data: { id: "est-crud", nome: "Portaria" } });

    await routeStations.handle(req("/api/bt-stations/est-crud", "PATCH", { ativo: false }), {}, ctx);
    expect(responses[2].data.ativo).toBe(false);

    await routeStations.handle(req("/api/bt-stations/est-crud", "PATCH", { nome: "" }), {}, ctx);
    expect(responses[3].code).toBe(400); // validação no servidor

    await routeStations.handle(req("/api/bt-stations/nao-existe", "PATCH", { nome: "X" }), {}, ctx);
    expect(responses[4].code).toBe(404);

    await routeStations.handle(req("/api/bt-stations/est-crud", "DELETE"), {}, ctx);
    expect(responses[5]).toMatchObject({ code: 200, data: { ok: true } });
    expect(stations.get("est-crud")).toBeNull();
  });

  it("escrita exige canConfigure (PATCH/DELETE → 403 sem permissão); leitura é de qualquer autenticado", async () => {
    const { ctx, responses } = makeCtx({ configurer: false });
    await routeStation.handle(postReading("est-rbac", [{ mac: "AA:06", rssi: -50 }]), {}, ctx);

    await routeStations.handle(req("/api/bt-stations/est-rbac", "PATCH", { nome: "Hack" }), {}, ctx);
    expect(responses[1].code).toBe(403);
    await routeStations.handle(req("/api/bt-stations/est-rbac", "DELETE"), {}, ctx);
    expect(responses[2].code).toBe(403);
    expect(stations.get("est-rbac").nome).toBe("est-rbac"); // intacta

    await routeStations.handle(req("/api/bt-stations", "GET"), {}, ctx); // GET: requireAuth basta
    expect(responses[3].code).toBe(200);
    expect(Array.isArray(responses[3].data)).toBe(true);
  });

  it("NÃO existe POST manual de cadastro — a estação nasce postando (rota não trata → 404 no dispatch)", async () => {
    const { ctx, responses } = makeCtx();
    const tratou = await routeStations.handle(req("/api/bt-stations", "POST", { id: "manual" }), {}, ctx);
    expect(tratou).toBe(false);
    expect(responses).toHaveLength(0);
    expect(stations.get("manual")).toBeNull();
  });
});
