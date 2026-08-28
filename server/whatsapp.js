// Canal WhatsApp (Baileys) — NÃO-OFICIAL, uso interno/demo (risco de ban; use número dedicado).
//
// Conecta via WhatsApp Web (multi-device), persiste a sessão em wa-auth/ e envia texto.
// Ligado por WHATSAPP_ENABLED=1.
// O QR de pareamento é exposto como data URL para o painel mostrar.
//
// Comportamento:
// - primeira conexão -> gera QR;
// - conectado -> mantém sessão;
// - queda temporária -> reconecta usando a sessão existente;
// - logout/desvinculação -> remove a sessão inválida e gera um QR novo.
//
// Adaptador isolado: trocar por Cloud API oficial depois mexe só aqui.

const { statePath } = require("./state-dir");
const fs = require("node:fs");

// Node 18: a Web Crypto API não é global por padrão.
// O Baileys usa globalThis.crypto.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

const AUTH_DIR = statePath("wa-auth");

const ENABLED =
  process.env.WHATSAPP_ENABLED === "1" ||
  process.env.WHATSAPP_ENABLED === "true";

let sock = null;
let connected = false;
let qrDataUrl = null;
let starting = false;

let reconnectTimer = null;

/**
 * Cancela uma tentativa de reconexão já agendada.
 *
 * Isso evita que múltiplos eventos "close" criem vários sockets
 * simultaneamente.
 */
function clearReconnectTimer() {
  if (!reconnectTimer) return;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Agenda uma nova inicialização do WhatsApp.
 */
function scheduleStart(delay = 3000) {
  clearReconnectTimer();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((err) => {
      console.error(
        "[whatsapp] erro na tentativa agendada:",
        err?.message || err,
      );
    });
  }, delay);
}

/**
 * Remove a sessão persistida.
 *
 * IMPORTANTE:
 * só usamos isso quando o WhatsApp/Baileys informa que houve
 * um logout real.
 *
 * Uma simples queda de internet NÃO remove as credenciais.
 */
function clearAuthSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      console.log(
        "[whatsapp] diretório de sessão já não existe",
      );

      return;
    }

    fs.rmSync(AUTH_DIR, {
      recursive: true,
      force: true,
    });

    console.log(
      "[whatsapp] sessão antiga removida; novo pareamento será iniciado",
    );
  } catch (err) {
    console.error(
      "[whatsapp] erro ao remover sessão:",
      err?.message || err,
    );
  }
}

/**
 * Inicia a conexão do WhatsApp.
 */
async function start() {
  if (!ENABLED) {
    console.log("[whatsapp] desabilitado");
    return;
  }

  if (connected) {
    return;
  }

  if (starting) {
    return;
  }

  clearReconnectTimer();

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

    /**
     * Cria ou lê as credenciais existentes.
     *
     * Quando AUTH_DIR estiver vazio/inexistente,
     * o Baileys inicia um novo pareamento.
     */
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    /**
     * Obtém uma versão compatível do WhatsApp Web.
     */
    const { version } =
      await fetchLatestBaileysVersion();

    console.log(
      `[whatsapp] usando WA Web version ${version?.join?.(".")}`,
    );

    sock = makeWASocket({
      version,

      auth: state,

      logger: pino({
        level: "silent",
      }),

      browser: [
        "Visao de Patio",
        "Chrome",
        "1.0",
      ],

      printQRInTerminal: false,
    });

    /**
     * Sempre salva alterações das credenciais.
     */
    sock.ev.on("creds.update", saveCreds);

    /**
     * Estado da conexão.
     */
    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          qr,
          lastDisconnect,
        } = update;

        /**
         * QR NOVO.
         *
         * Transforma o código recebido do Baileys
         * em uma imagem data URL para o frontend.
         */
        if (qr) {
          try {
            qrDataUrl =
              await QRCode.toDataURL(qr);

            console.log(
              "[whatsapp] QR gerado — escaneie no painel (Usuários)",
            );
          } catch (err) {
            console.error(
              "[whatsapp] erro ao gerar QR:",
              err?.message || err,
            );
          }
        }

        /**
         * CONECTOU.
         */
        if (connection === "open") {
          connected = true;
          starting = false;

          /**
           * Depois que conectou,
           * não precisamos mais exibir o QR anterior.
           */
          qrDataUrl = null;

          clearReconnectTimer();

          console.log(
            "[whatsapp] conectado",
          );

          return;
        }

        /**
         * CONEXÃO FECHOU.
         */
        if (connection === "close") {
          connected = false;
          starting = false;

          sock = null;

          const code =
            lastDisconnect?.error?.output
              ?.statusCode;

          const message =
            lastDisconnect?.error?.message ??
            "";

          const loggedOut =
            code ===
            DisconnectReason.loggedOut;

          console.warn(
            `[whatsapp] fechou ` +
              `(code=${code ?? "?"}: ${message})`,
          );

          /**
           * LOGOUT / DISPOSITIVO DESVINCULADO.
           *
           * A sessão não pode mais ser reutilizada.
           *
           * É exatamente o caso que antes deixava
           * a interface eternamente esperando.
           */
          if (loggedOut) {
            console.warn(
              "[whatsapp] logout detectado — iniciando novo pareamento",
            );

            /**
             * Remove qualquer QR anterior.
             */
            qrDataUrl = null;

            /**
             * Apaga somente a sessão inválida do WhatsApp.
             */
            clearAuthSession();

            /**
             * Dá um pequeno intervalo para o socket anterior
             * finalizar completamente.
             *
             * Depois start() cria uma sessão nova,
             * fazendo o Baileys emitir outro QR.
             */
            scheduleStart(2000);

            return;
          }

          /**
           * QUEDA TEMPORÁRIA.
           *
           * Internet, websocket, timeout etc.
           *
           * Mantemos wa-auth intacto para recuperar
           * a conexão sem obrigar o usuário a ler QR novamente.
           */
          console.log(
            "[whatsapp] queda temporária — reconectando em 3s",
          );

          scheduleStart(3000);
        }
      },
    );
  } catch (err) {
    console.error(
      "[whatsapp] falha ao iniciar:",
      err?.message || err,
    );

    connected = false;
    sock = null;

    /**
     * Também recupera erros durante a inicialização.
     *
     * O código anterior apenas logava esse erro,
     * podendo deixar o serviço parado.
     */
    console.log(
      "[whatsapp] nova tentativa em 5s",
    );

    scheduleStart(5000);
  } finally {
    starting = false;
  }
}

/**
 * Envia texto para um número.
 *
 * numberDigits deve conter somente o número,
 * incluindo DDI.
 *
 * Exemplo:
 * 5588999999999
 */
async function sendText(
  numberDigits,
  text,
) {
  if (!ENABLED) {
    throw new Error(
      "WhatsApp desabilitado (defina WHATSAPP_ENABLED=1)",
    );
  }

  if (!sock || !connected) {
    throw new Error(
      "WhatsApp não conectado",
    );
  }

  const digits = String(
    numberDigits,
  ).replace(/\D/g, "");

  if (digits.length < 10) {
    throw new Error(
      "número inválido",
    );
  }

  await sock.sendMessage(
    `${digits}@s.whatsapp.net`,
    {
      text: String(text),
    },
  );
}

/**
 * Estado retornado para o frontend.
 */
function status() {
  return {
    enabled: ENABLED,
    connected,
    qr: qrDataUrl,
  };
}

/**
 * Inicialização do módulo.
 */
function init() {
  if (ENABLED) {
    start().catch((err) => {
      console.error(
        "[whatsapp] erro no init:",
        err?.message || err,
      );
    });
  }
}

module.exports = {
  init,
  start,
  sendText,
  status,
  enabled: () => ENABLED,
};
