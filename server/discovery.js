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

// "a.b.c.d" -> inteiro 32-bit (ou null se malformado).
function ip2int(s) {
  const p = String(s).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const b = Number(o);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n * 256 + b) >>> 0;
  }
  return n >>> 0;
}
function sameSubnet(a, b, mask) {
  const ia = ip2int(a),
    ib = ip2int(b),
    im = ip2int(mask);
  if (ia == null || ib == null || im == null) return false;
  return ((ia & im) >>> 0) === ((ib & im) >>> 0);
}
// Faixas RFC1918 (LAN de verdade) — usadas p/ preferir um IP roteável a um link-local.
function isPrivate(a) {
  return a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

// Melhor IPv4 do hub PARA responder ao `peer` (o TC22): mesma sub-rede do peer > faixa privada >
// qualquer não-link-local. IGNORA 169.254.x.x (APIPA/link-local de interface sem DHCP — ex.: Ethernet
// desconectada): responder com esse endereço mandava LIXO INALCANÇÁVEL ao TC22 (bug de campo jul/09).
// Recalculado a cada resposta: se o hub trocar de rede/IP em runtime, a próxima resposta já leva o novo.
function lanIPv4(peer) {
  const cands = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !String(a.address).startsWith("169.254.")) cands.push(a);
    }
  }
  if (peer) {
    const m = cands.find((a) => sameSubnet(a.address, peer, a.netmask));
    if (m) return m.address; // interface na MESMA LAN do TC22 → sempre alcançável
  }
  const p = cands.find((a) => isPrivate(a.address));
  if (p) return p.address; // senão, a primeira faixa privada (LAN comum)
  return cands.length ? cands[0].address : "127.0.0.1";
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
    const ingest = `http://${lanIPv4(rinfo.address)}:${port}${ingestPath}`;
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

module.exports = { start, stop, lanIPv4 };
