// Descoberta na LAN — o coletor TC22 acha o hub sozinho, sem digitar IP.
// POR QUÊ: a antena BLE (TC22/Android) precisa do endereço do ingest (/api/bt/reading), mas o IP do
// hub muda de rede p/ rede. Em vez de configurar à mão, o coletor faz um BROADCAST UDP e o hub
// responde com a URL certa. Roda no MESMO processo do hub (server/index.js) — sobe junto, sem
// serviço/porta à parte que se esqueça de ligar. Responsabilidade única: responder à descoberta.
//
// CONTRATO (o lado Android fala exatamente isto):
//   • porta UDP de descoberta: 41234
//   • cliente faz BROADCAST 255.255.255.255:41234 com o texto ASCII: "VISAO_HUB_DISCOVER"
//   • hub responde (unicast, de volta ao remetente) com JSON:
//       {"ingest":"http://<IP_LAN_DO_HUB>:<PORT>/api/bt/reading"}
const dgram = require("node:dgram");
const os = require("node:os");

const PROBE = "VISAO_HUB_DISCOVER";

let socket = null;

// Primeiro IPv4 não-interno (o IP da máquina na LAN). Recalculado a cada resposta: se o hub trocar
// de rede/IP em runtime, a próxima resposta já leva o endereço novo. Fallback 127.0.0.1 se nada achado.
function lanIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function start({ port = 4000, ingestPath = "/api/bt/reading", udpPort = 41234, log = console.log } = {}) {
  if (socket) return; // idempotente: um só responder por processo

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  // Erro do socket (ex.: EADDRINUSE) NÃO derruba o hub — a descoberta é acessório. Loga e segue.
  sock.on("error", (err) => {
    log(`[discovery] socket UDP ${udpPort} falhou (${err.code || err.message}) — descoberta OFF, hub segue`);
    try {
      sock.close();
    } catch {
      // já fechado
    }
    if (socket === sock) socket = null;
  });

  sock.on("message", (msg, rinfo) => {
    if (msg.toString("utf8").trim() !== PROBE) return; // datagrama estranho → ignora em silêncio
    const ingest = `http://${lanIPv4()}:${port}${ingestPath}`;
    const reply = Buffer.from(JSON.stringify({ ingest }), "utf8");
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) log(`[discovery] falha ao responder ${rinfo.address}:${rinfo.port} (${err.message})`);
    });
  });

  sock.on("listening", () => {
    sock.setBroadcast(true);
    log(`[discovery] ouvindo descoberta UDP em :${udpPort} — TC22 acha o hub sozinho`);
  });

  sock.bind(udpPort);
  socket = sock;
}

function stop() {
  if (!socket) return; // idempotente
  try {
    socket.close();
  } catch {
    // já fechado
  }
  socket = null;
}

module.exports = { start, stop };
