// Testes do responder de descoberta na LAN (discovery.js) — comportamento via UDP loopback.
// Sobe o responder numa porta UDP alta livre, manda o probe de um cliente dgram e verifica a
// resposta. Determinístico: sem Date.now()/random; toda espera é Promise + timeout curto que
// rejeita/resolve com clareza. Fecha tudo no afterAll (sem vazar socket/porta).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import dgram from "node:dgram";

const require = createRequire(import.meta.url);
const discovery = require("./discovery");

const UDP_PORT = 42999; // porta alta livre p/ o loopback do teste
const HUB_PORT = 4000;
const PROBE = "VISAO_HUB_DISCOVER";

// Manda um datagrama p/ o responder e resolve com a resposta (string) ou null se nada chegar até `ms`.
function probe(payload, ms = 400) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    let timer = null;
    const done = (fn, arg) => {
      clearTimeout(timer);
      client.close();
      fn(arg);
    };
    client.on("error", (err) => done(reject, err));
    client.on("message", (msg) => done(resolve, msg.toString("utf8")));
    timer = setTimeout(() => done(resolve, null), ms);
    client.send(Buffer.from(payload, "utf8"), UDP_PORT, "127.0.0.1", (err) => {
      if (err) done(reject, err);
    });
  });
}

describe("discovery — responder de descoberta na LAN", () => {
  beforeAll(() => {
    discovery.start({ port: HUB_PORT, udpPort: UDP_PORT });
  });
  afterAll(() => {
    discovery.stop();
  });

  it("responde ao probe com JSON cujo ingest aponta pro ingest do hub na porta certa", async () => {
    const raw = await probe(PROBE);
    expect(raw, "sem resposta ao probe").toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.ingest.endsWith("/api/bt/reading")).toBe(true);
    expect(parsed.ingest).toContain(`:${HUB_PORT}`);
  });

  it("ignora em silêncio datagrama que não é o probe (nenhuma resposta)", async () => {
    const raw = await probe("lixo qualquer", 250);
    expect(raw).toBeNull();
  });
});
