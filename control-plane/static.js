// Static file server MÍNIMO para a SPA buildada do portal (control-plane/web/dist).
// A casa prova que node:http basta — nada de express/serve-static. Só node:fs + node:path.
//
// Contrato: serveStatic(req,res) devolve true se PRODUZIU a resposta. index.js o chama SÓ para
// o que NÃO é /api/* nem /health. Regras:
//   - dist/ ausente        → 200 texto avisando como buildar (deploy sem build não some em silêncio).
//   - arquivo existe        → 200 + mime por extensão.
//   - rota sem extensão     → SPA fallback: devolve index.html (client-side routing).
//   - path traversal/dotfile → 403 (barrado na função PURA resolveSafe, testável sem fs/rede).
//   - arquivo com extensão que não existe → 404 (asset faltando não vira index.html).
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.resolve(__dirname, "web", "dist");

// mime só do que a SPA emite (Vite: html/js/css/svg/json/ico/woff2). Desconhecido → octet-stream.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function mimeFor(p) {
  return MIME[path.extname(String(p)).toLowerCase()] || "application/octet-stream";
}

// resolveSafe: mapeia um pathname de URL para um caminho absoluto DENTRO de `root`, ou null se
// escapar (path traversal) ou tocar um dotfile. PURA (só lógica de path — sem fs, sem rede) para
// ser testável e ser o ÚNICO ponto onde a fronteira do diretório é decidida.
// A decodificação vem ANTES do resolve — senão "..%2f.." passaria batido.
function resolveSafe(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname));
  } catch {
    return null; // %-encoding malformado
  }
  if (decoded.includes("\0")) return null; // NUL byte
  const rel = decoded.replace(/^[/\\]+/, ""); // tira barras iniciais (evita virar caminho absoluto)
  const abs = path.resolve(root, rel);
  // dentro de root? (o próprio root, ou algo sob root + separador)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  // nenhum segmento pode ser dotfile (.env, .git, .gitignore…)
  const relFromRoot = path.relative(root, abs);
  if (relFromRoot.split(/[/\\]/).some((s) => s.startsWith("."))) return null;
  return abs;
}

function sendFile(req, res, absPath) {
  res.writeHead(200, { "content-type": mimeFor(absPath) });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(absPath).pipe(res);
  return true;
}

// serveStatic — `root` é injetável para teste (default = DIST real).
function serveStatic(req, res, root = DIST) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  if (!fs.existsSync(root)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("portal nao buildado: rode `cd control-plane/web && npm run build`");
    return true;
  }

  const pathname = new URL(req.url, "http://x").pathname;
  const safe = resolveSafe(root, pathname);
  if (safe === null) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("acesso negado");
    return true;
  }

  let st;
  try {
    st = fs.statSync(safe);
  } catch {
    st = undefined;
  }
  if (st && st.isFile()) return sendFile(req, res, safe);

  // SPA fallback: rota de client-routing (sem extensão) → index.html. Asset com extensão que
  // não existe NÃO cai no fallback (senão um .js faltando viria como HTML e quebraria mudo).
  if (path.extname(pathname) === "") {
    const index = path.join(root, "index.html");
    if (fs.existsSync(index)) return sendFile(req, res, index);
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("não encontrado");
  return true;
}

module.exports = { serveStatic, resolveSafe, mimeFor, MIME, DIST };
