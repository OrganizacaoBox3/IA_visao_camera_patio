// Rotas de notificação (superadmin): destinatários de WhatsApp, config/preview de notificações
// e status/teste do WhatsApp.
const recipients = require("../recipients");
const settings = require("../settings");
const dispatch = require("../dispatch");
const whatsapp = require("../whatsapp");

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper } = ctx;

  // Destinatários de WhatsApp (superadmin) — lista central
  if (req.url === "/api/recipients") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, recipients.all());
      return true;
    }
    if (req.method === "POST") {
      if (!requireSuper(req, res)) return true;
      const r = await recipients.create(JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 201, r.recipient);
      return true;
    }
  }
  const mr = req.url && req.url.match(/^\/api\/recipients\/([\w-]+)$/);
  if (mr) {
    const id = mr[1];
    if (req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      const r = await recipients.update(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 200, r.recipient);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireSuper(req, res)) return true;
      await recipients.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  // Configuração de notificações (superadmin): GET atual, PUT salva, POST preview (sem salvar)
  if (req.url === "/api/notif-settings") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, settings.get());
      return true;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, await settings.update(JSON.parse((await readBody(req)) || "{}")));
      return true;
    }
  }
  if (req.url === "/api/notif-preview" && req.method === "POST") {
    if (!requireSuper(req, res)) return true;
    const s = settings.normalize(JSON.parse((await readBody(req)) || "{}"));
    const now = Date.now();
    const samples = {
      atividade: "⚠ Doca 2: Doca 2 sem movimentação há 15 min.",
      fadiga: "⚠ Câmera Frente · Posto 1: Fadiga",
      leitura: "⚠ Ponto 1: taxa de leitura 72% (abaixo de 80%)",
      objetos: "📦 caixa entrou em Setor 2",
    };
    const out = {};
    for (const [tipo, txt] of Object.entries(samples))
      out[tipo] = dispatch.formatWhatsApp(txt, dispatch.classify(txt), now, s);
    json(res, 200, out);
    return true;
  }

  // WhatsApp (superadmin): status/QR + envio de teste
  if (req.url === "/api/wa-status" && req.method === "GET") {
    if (!requireSuper(req, res)) return true;
    json(res, 200, whatsapp.status());
    return true;
  }
  if (req.url === "/api/wa-test" && req.method === "POST") {
    if (!requireSuper(req, res)) return true;
    const { numero } = JSON.parse((await readBody(req)) || "{}");
    try {
      await whatsapp.sendText(
        numero,
        "✅ Teste — Visão de Pátio: notificações de WhatsApp funcionando.",
      );
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
