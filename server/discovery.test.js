// Testes do responder de descoberta na LAN (discovery.js) — comportamento via UDP loopback.
// Sobe o responder numa porta UDP alta livre, manda o probe de um cliente dgram e verifica a
// resposta. Determinístico: sem Date.now()/random; toda espera é Promise + timeout curto que
// rejeita/resolve com clareza. Fecha tudo no afterAll (sem vazar socket/porta).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import dgram from "node:dgram";

const require = createRequire(import.meta.url);
const discovery = require("./discovery");
const os = require("node:os"); // mesmo objeto que o discovery.js usa (ambos require("node:os")) → mockável

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

// lanIPv4 — escolha do IP que o hub advertisa. Regressão do bug de campo (jul/09): o responder mandava
// um 169.254 (APIPA/link-local da Ethernet desconectada) ao TC22 → endereço inalcançável.
describe("discovery — lanIPv4 (nunca advertisa link-local)", () => {
  afterEach(() => vi.restoreAllMocks());

  const IFACES = {
    Ethernet: [{ family: "IPv4", internal: false, address: "169.254.72.33", netmask: "255.255.0.0" }],
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.68.50", netmask: "255.255.255.0" }],
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  };

  it("ignora 169.254 e escolhe a interface na MESMA sub-rede do peer (TC22)", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(IFACES);
    expect(discovery.lanIPv4("192.168.68.111")).toBe("192.168.68.50");
  });

  it("sem casar a sub-rede, prefere faixa privada a link-local", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(IFACES);
    expect(discovery.lanIPv4("10.9.9.9")).toBe("192.168.68.50");
  });

  it("só link-local disponível → 127.0.0.1 (NUNCA devolve 169.254)", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      Ethernet: [{ family: "IPv4", internal: false, address: "169.254.72.33", netmask: "255.255.0.0" }],
    });
    expect(discovery.lanIPv4("192.168.1.5")).toBe("127.0.0.1");
  });
});
