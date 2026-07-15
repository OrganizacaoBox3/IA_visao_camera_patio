// Teste do CANAL de sinalização reverso (site-link.js) — o registro/mux request↔response.
// Sobe um http server em porta efêmera + WSS via handleUpgrade, com authenticate STUB (sem PG):
// o site é lido do ?site=… da query. Um cliente `ws` faz o papel do HUB (responde às req).
// Prova: (a) auth errada recusa o upgrade; (b) auth certa → isLinked true; (c) request casa a
// resposta pelo id; (d) request a site offline rejeita; (e) timeout rejeita; (f) reconexão
// substitui o socket antigo; (g) close → isLinked false.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { createSiteLink } = require("./site-link");

// authenticate stub: siteId = ?site=… ; sem ?site → recusa (simula credencial inválida).
async function authByQuery(req) {
  const site = new URL(req.url || "/", "http://x").searchParams.get("site");
  return site ? { siteId: site } : null;
}

let httpServer;
let sl;
let baseUrl;
const openClients = [];

function serverUrl(server) {
  const { port } = server.address();
  return `ws://127.0.0.1:${port}`;
}

// Cliente que faz o papel do HUB: opcionalmente responde às req com um payload derivado.
function connectHub(query, { onReq } = {}) {
  const ws = new WebSocket(`${baseUrl}/api/site-link${query}`);
  openClients.push(ws);
  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.t === "req" && onReq) {
      const payload = onReq(frame);
      if (payload !== undefined) ws.send(JSON.stringify({ t: "res", id: frame.id, ...payload }));
    }
  });
  return ws;
}

const waitOpen = (ws) => new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
const waitClose = (ws) => new Promise((res) => ws.on("close", res));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  sl = createSiteLink({ authenticate: authByQuery, pingMs: 60_000 });
  httpServer = createServer((_req, res) => res.end("ok"));
  httpServer.on("upgrade", (req, socket, head) => sl.handleUpgrade(req, socket, head));
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = serverUrl(httpServer);
});

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    try {
      c.terminate();
    } catch {
      /* ignore */
    }
  }
  sl.close();
  await new Promise((r) => httpServer.close(r));
});

describe("site-link — canal de sinalização reverso", () => {
  it("(a) auth INVÁLIDA → recusa o upgrade (não vira canal)", async () => {
    const ws = connectHub(""); // sem ?site → authenticate devolve null → 401
    let errored = false;
    await new Promise((res) => {
      ws.on("error", () => {
        errored = true;
        res();
      });
      ws.on("open", () => res()); // não deveria abrir
    });
    expect(errored).toBe(true);
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    expect(sl.count()).toBe(0);
  });

  it("(b) auth VÁLIDA → isLinked true e count=1", async () => {
    const ws = connectHub("?site=s1");
    await waitOpen(ws);
    await tick();
    expect(sl.isLinked("s1")).toBe(true);
    expect(sl.count()).toBe(1);
  });

  it("(c) request casa a resposta pelo id (echo/ping do hub)", async () => {
    const ws = connectHub("?site=s1", {
      onReq: (frame) => (frame.op === "ping" ? { ok: true, ts: 12345 } : { ok: false }),
    });
    await waitOpen(ws);
    await tick();
    const res = await sl.request("s1", { op: "ping" }, 1000);
    expect(res).toEqual({ ok: true, ts: 12345 });
  });

  it("(c2) mux por id: duas req concorrentes recebem a resposta CERTA (sem trocar)", async () => {
    const ws = connectHub("?site=s1", {
      onReq: (frame) => ({ echo: frame.n }), // devolve o n que veio
    });
    await waitOpen(ws);
    await tick();
    const [r1, r2] = await Promise.all([
      sl.request("s1", { op: "e", n: "A" }, 1000),
      sl.request("s1", { op: "e", n: "B" }, 1000),
    ]);
    expect(r1.echo).toBe("A");
    expect(r2.echo).toBe("B");
  });

  it("(d) request a site OFFLINE (não conectado) → rejeita na hora", async () => {
    await expect(sl.request("fantasma", { op: "ping" }, 500)).rejects.toThrow(/não conectado/);
  });

  it("(e) sem resposta em timeoutMs → rejeita timeout", async () => {
    const ws = connectHub("?site=s1", { onReq: () => undefined }); // nunca responde
    await waitOpen(ws);
    await tick();
    await expect(sl.request("s1", { op: "ping" }, 80)).rejects.toThrow(/timeout/);
  });

  it("(f) reconexão: socket NOVO do mesmo site substitui o antigo (o antigo é derrubado)", async () => {
    const oldWs = connectHub("?site=s1");
    await waitOpen(oldWs);
    await tick();
    expect(sl.isLinked("s1")).toBe(true);

    const oldClosed = waitClose(oldWs);
    const newWs = connectHub("?site=s1", { onReq: () => ({ ok: true, via: "novo" }) });
    await waitOpen(newWs);
    await oldClosed; // o antigo foi terminado pelo register do novo
    await tick();

    expect(sl.count()).toBe(1); // continua UM canal para s1
    expect(sl.isLinked("s1")).toBe(true);
    const res = await sl.request("s1", { op: "ping" }, 1000);
    expect(res.via).toBe("novo"); // o request vai pelo socket NOVO
  });

  it("(g) close do canal → isLinked false e pendências rejeitam", async () => {
    const ws = connectHub("?site=s1", { onReq: () => undefined });
    await waitOpen(ws);
    await tick();
    const pending = sl.request("s1", { op: "ping" }, 5000);
    ws.terminate(); // derruba o canal com uma req pendente
    await expect(pending).rejects.toThrow(/fechado/);
    await tick();
    expect(sl.isLinked("s1")).toBe(false);
    expect(sl.count()).toBe(0);
  });
});
