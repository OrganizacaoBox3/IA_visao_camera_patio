// Rotas da IMAGEM DE REFERÊNCIA por câmera (ADR-021) — o fundo do desenho de zonas que o
// cliente vê. Ver server/camera-bg.js para o que isto é e o que NÃO é.
//
// RBAC, e por que assim:
//   PUT/DELETE → superadmin. Subir imagem que o CLIENTE vai ver é ato de publicação; quem
//                configura câmera é quem responde por ela.
//   GET        → qualquer autenticado, ESCOPADO por câmera. O papel `cliente` só enxerga as
//                câmeras alocadas a ele, e o fundo tem de seguir a mesma regra do resto —
//                senão bastaria adivinhar um id para ver a imagem do vizinho.
"use strict";

const bg = require("../camera-bg");
const users = require("../users");
const videoTicket = require("../video-ticket");

/** Lê o corpo BINÁRIO com teto. O `readBody` do index.js é texto e corta em 10 KB — usá-lo
 *  aqui corromperia a imagem silenciosamente (string ≠ bytes). */
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let fim = false;
    const parar = (fn, arg) => {
      if (fim) return;
      fim = true;
      req.removeAllListeners("data");
      fn(arg);
    };
    req.on("data", (c) => {
      total += c.length;
      // Corta DURANTE a leitura, não depois: aceitar 50 MB para então recusar é deixar alguém
      // encher a memória do hub com um POST.
      if (total > limit) return parar(reject, new Error("limite excedido"));
      partes.push(c);
    });
    req.on("end", () => parar(resolve, Buffer.concat(partes)));
    req.on("error", (e) => parar(reject, e));
  });
}

/** O pedido traz um ticket HMAC válido PARA ESTA câmera? (assinatura + validade + escopo) */
function ticketValido(req, cameraId) {
  try {
    const q = new URLSearchParams((req.url.split("?")[1] || ""));
    const t = q.get("ticket");
    if (!t) return false;
    // `verifyTicket` devolve o PAYLOAD (ou null) — não um booleano. Comparar com `true` daria
    // sempre falso e o fundo nunca carregaria. (Pego ao exercitar a rota.)
    return !!videoTicket.verifyTicket(t, cameraId);
  } catch {
    return false;
  }
}

async function handle(req, res, ctx) {
  const { json, requireAuth, requireSuper } = ctx;
  // A querystring é aceita porque o GET vem de um <image href> — ver a nota do ticket abaixo.
  const m = req.url && req.url.match(/^\/api\/camera-bg\/([\w-]+)(?:\?.*)?$/);
  if (!m) return false;
  const cameraId = m[1];

  if (req.method === "GET") {
    // DUAS CREDENCIAIS, e o ticket não é conveniência: esta URL vai dentro de um <image href>
    // do SVG, e tag de imagem NÃO manda header — o Bearer simplesmente não chega. É o mesmo
    // buraco que o /go2rtc/* já tinha, e a solução é a MESMA (server/video-ticket.js): passe
    // HMAC de curta duração, emitido a quem está autenticado e ESCOPADO na câmera.
    //   · Bearer → chamadas programáticas (a tela de admin conferindo se existe imagem);
    //   · ?ticket= → a tag <image> do painel.
    // O escopo por câmera é checado nos DOIS caminhos: sem isso bastaria trocar o id na URL
    // para ver a imagem de um cliente vizinho.
    if (!ticketValido(req, cameraId)) {
      const me = requireAuth(req, res);
      if (!me) return true;
      if (!users.canSeeCamera(me, cameraId)) {
        json(res, 403, { error: "sem acesso a esta câmera" });
        return true;
      }
    }
    const i = bg.info(cameraId);
    if (!i) {
      json(res, 404, { error: "sem imagem de referência" });
      return true;
    }
    const bytes = bg.ler(cameraId);
    if (!bytes) {
      json(res, 404, { error: "sem imagem de referência" });
      return true;
    }
    res.writeHead(200, {
      "content-type": bg.tipoDe(i.ext),
      "content-length": bytes.length,
      // Imagem ESTÁTICA que só muda por upload: cache curto no cliente + validação por mtime.
      // Sem isso, o painel do cliente rebaixaria a imagem a cada render — o oposto da economia.
      "cache-control": "private, max-age=300",
      etag: `"${i.enviadoEm}-${i.bytes}"`,
    });
    res.end(bytes);
    return true;
  }

  if (req.method === "PUT") {
    if (!requireSuper(req, res)) return true;
    let bytes;
    try {
      // +1 byte de folga para que o estouro seja DETECTADO aqui e vire 413, em vez de passar
      // raspando e falhar na validação com uma mensagem pior.
      bytes = await readBinary(req, bg.MAX_BYTES + 1);
    } catch {
      json(res, 413, { error: "imagem grande demais" });
      return true;
    }
    const r = bg.salvar(cameraId, req.headers["content-type"], bytes);
    if (r.error) {
      json(res, 400, r);
      return true;
    }
    json(res, 200, { cameraId, ext: r.ext, bytes: r.bytes, enviadoEm: r.enviadoEm });
    return true;
  }

  if (req.method === "DELETE") {
    if (!requireSuper(req, res)) return true;
    json(res, 200, bg.remover(cameraId));
    return true;
  }

  return false;
}

module.exports = { handle };
