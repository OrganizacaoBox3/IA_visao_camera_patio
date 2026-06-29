// Canal WhatsApp (Baileys) — NÃO-OFICIAL, uso interno/demo (risco de ban; use número dedicado).
// Conecta via WhatsApp Web (multi-device), persiste a sessão em wa-auth/ e envia texto.
// Ligado por WHATSAPP_ENABLED=1. O QR de pareamento é exposto como data URL p/ o painel mostrar.
// Adaptador isolado: trocar por Cloud API oficial depois mexe só aqui.
const path = require("node:path");

// Node 18: a Web Crypto API não é global por padrão (só virou global no Node 20). O Baileys usa
// `globalThis.crypto` p/ assinar/criptografar → sem isto dá "crypto is not defined" em loop de reconexão.
if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;

const AUTH_DIR = path.join(__dirname, "wa-auth");
const ENABLED = process.env.WHATSAPP_ENABLED === "1" || process.env.WHATSAPP_ENABLED === "true";

let sock = null;
let connected = false;
let qrDataUrl = null;
let starting = false;

async function start() {
  if (!ENABLED || starting || connected) return;
  starting = true;
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = require("@whiskeysockets/baileys");
    const QRCode = require("qrcode");
    const pino = require("pino");
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion(); // casa com a versão atual do WhatsApp Web (evita close-loop)
    console.log(`[whatsapp] usando WA Web version ${version?.join?.(".")}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Visao de Patio", "Chrome", "1.0"],
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        try {
          qrDataUrl = await QRCode.toDataURL(u.qr);
          console.log("[whatsapp] QR gerado — escaneie no painel (Usuários)");
        } catch (e) {
          console.error("[whatsapp] erro ao gerar QR:", e.message);
        }
      }
      if (u.connection === "open") {
        connected = true;
        qrDataUrl = null;
        console.log("[whatsapp] conectado");
      }
      if (u.connection === "close") {
        connected = false;
        sock = null;
        starting = false;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.warn(
          `[whatsapp] fechou (code=${code ?? "?"}: ${u.lastDisconnect?.error?.message ?? ""})` +
            (loggedOut ? " — logout, re-parear" : " — reconectando em 3s"),
        );
        if (loggedOut) qrDataUrl = null;
        else setTimeout(start, 3000);
      }
    });
  } catch (e) {
    console.error("[whatsapp] falha ao iniciar:", e.message);
  } finally {
    starting = false;
  }
}

/** Envia texto p/ um número (só dígitos, com DDI). Lança se desconectado. */
async function sendText(numberDigits, text) {
  if (!ENABLED) throw new Error("WhatsApp desabilitado (defina WHATSAPP_ENABLED=1)");
  if (!sock || !connected) throw new Error("WhatsApp não conectado");
  const digits = String(numberDigits).replace(/\D/g, "");
  if (digits.length < 10) throw new Error("número inválido");
  await sock.sendMessage(`${digits}@s.whatsapp.net`, { text: String(text) });
}

function status() {
  return { enabled: ENABLED, connected, qr: qrDataUrl };
}
function init() {
  if (ENABLED) start();
}

module.exports = { init, start, sendText, status, enabled: () => ENABLED };
