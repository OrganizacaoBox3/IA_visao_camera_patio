// Rotas de autenticação/perfil: login (público) e /api/me (perfil do próprio usuário).
// handle(req,res,ctx) → true se a requisição foi tratada (resposta enviada), senão false.
const users = require("../users");
const { createLoginThrottle } = require("../loginThrottle");

// Trava de brute-force do /api/login (auditoria 01, R-A). Tunável por env; defaults sensatos.
const loginThrottle = createLoginThrottle({
  max: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 10),
  windowMs: Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60 * 1000),
});

// IP do cliente p/ a chave da trava. Atrás do nginx (homolog) o IP real vem no X-Forwarded-For
// (1º hop); direto, é o remoteAddress do socket. Fallback "unknown" agrupa o que não identifica.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth } = ctx;

  // Login (público) — com trava de tentativas por IP.
  if (req.method === "POST" && req.url === "/api/login") {
    const key = clientIp(req);
    const gate = loginThrottle.check(key);
    if (!gate.allowed) {
      res.setHeader("Retry-After", String(gate.retryAfterSec));
      json(res, 429, { error: "muitas tentativas de login — tente novamente mais tarde" });
      return true;
    }
    const { usuario, senha } = JSON.parse((await readBody(req)) || "{}");
    const r = users.authenticate(usuario, senha);
    if (r) {
      loginThrottle.succeed(key); // acertou → zera o contador do IP
      json(res, 200, r);
    } else {
      loginThrottle.fail(key); // credencial inválida → conta a tentativa
      json(res, 401, { error: "credenciais inválidas" });
    }
    return true;
  }

  // Perfil do próprio usuário (qualquer papel) — WhatsApp + preferências + opt-in
  if (req.url === "/api/me") {
    const me = requireAuth(req, res);
    if (!me) return true;
    if (req.method === "GET") {
      json(res, 200, users.getProfile(me.id));
      return true;
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const r = await users.updateProfile(me.id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, r.status || 400, r); // r.status (503) tem prioridade sobre o 400
      else json(res, 200, r.user);
      return true;
    }
  }

  return false;
}

module.exports = { handle };
