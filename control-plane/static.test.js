// Static handler do portal — SEM PG, SEM rede. Dois níveis:
//  (1) resolveSafe/mimeFor PUROS: o path-safety (traversal + dotfile barrados) e o mime por extensão.
//  (2) serveStatic dirigido com req/res mockados sobre um dist FIXTURE em tmp (root injetável) —
//      determinístico independente de o portal estar buildado no CI (web/dist é .gitignored).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { resolveSafe, mimeFor, serveStatic } = require("./static");

// ── (1) resolveSafe — a fronteira do diretório (PURA) ───────────────────────────
describe("resolveSafe (path-safety puro)", () => {
  const root = path.resolve("/srv/portal/dist"); // raiz fictícia; não toca o disco

  it("mapeia um arquivo comum para DENTRO da raiz", () => {
    const abs = resolveSafe(root, "/assets/app.js");
    expect(abs).not.toBeNull();
    expect(abs.startsWith(root + path.sep)).toBe(true);
    expect(abs.endsWith(`assets${path.sep}app.js`)).toBe(true);
  });

  it("a própria raiz ('/') resolve para a raiz", () => {
    expect(resolveSafe(root, "/")).toBe(root);
  });

  it("BARRA traversal com ../", () => {
    expect(resolveSafe(root, "/../secret.txt")).toBeNull();
    expect(resolveSafe(root, "/assets/../../secret.txt")).toBeNull();
    expect(resolveSafe(root, "/../../etc/passwd")).toBeNull();
  });

  it("BARRA traversal com ../ PERCENT-ENCODED (decodifica antes de resolver)", () => {
    expect(resolveSafe(root, "/..%2f..%2fsecret")).toBeNull();
    expect(resolveSafe(root, "/%2e%2e/%2e%2e/secret")).toBeNull();
  });

  it("BARRA traversal com barra invertida (Windows)", () => {
    expect(resolveSafe(root, "/..\\secret")).toBeNull();
  });

  it("BARRA dotfiles (.env, .git) em qualquer segmento", () => {
    expect(resolveSafe(root, "/.env")).toBeNull();
    expect(resolveSafe(root, "/.git/config")).toBeNull();
    expect(resolveSafe(root, "/assets/.secret")).toBeNull();
  });

  it("BARRA %-encoding malformado e NUL byte", () => {
    expect(resolveSafe(root, "/%zz")).toBeNull();
    expect(resolveSafe(root, "/a\0b")).toBeNull();
  });
});

// ── (1b) mimeFor — o content-type por extensão ──────────────────────────────────
describe("mimeFor", () => {
  it("mapeia as extensões da SPA", () => {
    expect(mimeFor("index.html")).toMatch(/text\/html/);
    expect(mimeFor("assets/app.js")).toMatch(/javascript/);
    expect(mimeFor("assets/app.css")).toMatch(/text\/css/);
    expect(mimeFor("logo.svg")).toBe("image/svg+xml");
    expect(mimeFor("data.json")).toMatch(/application\/json/);
    expect(mimeFor("favicon.ico")).toBe("image/x-icon");
    expect(mimeFor("font.woff2")).toBe("font/woff2");
  });
  it("extensão desconhecida → octet-stream", () => {
    expect(mimeFor("blob.bin")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

// ── (2) serveStatic — handler sobre um dist FIXTURE ─────────────────────────────
function makeReq(method, url) {
  return { method, url, headers: {} };
}
function makeRes() {
  const res = { statusCode: 0, headers: null, body: "", ended: false };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res.headers = headers || {};
    return res;
  };
  // serveStatic usa res.end() (arquivo faltando/erro/HEAD) OU pipe(res) (streaming do arquivo).
  res.end = (s) => {
    if (s !== undefined) res.body += s;
    res.ended = true;
  };
  // shim mínimo de Writable p/ o createReadStream().pipe(res) do sendFile.
  res.write = (chunk) => {
    res.body += chunk.toString();
    return true;
  };
  res.on = () => res;
  res.once = () => res;
  res.emit = () => false;
  return res;
}
// pipe(res) é assíncrono; espera o stream terminar (res.ended vira true no end()).
async function drive(req, res) {
  const handled = serveStatic(req, res, req._root);
  for (let i = 0; i < 200 && !res.ended; i++) await new Promise((r) => setTimeout(r, 5));
  return handled;
}

describe("serveStatic (handler sobre dist fixture)", () => {
  let dist = null;
  let outside = null;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cp-static-"));
    dist = path.join(base, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>PORTAL</title>");
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('spa')");
    fs.writeFileSync(path.join(dist, ".env"), "SECRET=nope");
    // um arquivo FORA do dist, alvo do traversal.
    outside = path.join(base, "secret.txt");
    fs.writeFileSync(outside, "TOP SECRET");
  });
  afterAll(() => {
    try {
      fs.rmSync(path.dirname(dist), { recursive: true, force: true });
    } catch {
      /* tmp best-effort */
    }
  });

  function req(method, url) {
    const r = makeReq(method, url);
    r._root = dist;
    return r;
  }

  it("dist AUSENTE → 200 com aviso de build (deploy sem build não some em silêncio)", async () => {
    const r = makeReq("GET", "/");
    r._root = path.join(dist, "..", "nao-existe");
    const res = makeRes();
    await drive(r, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("portal nao buildado");
    expect(res.body).toContain("npm run build");
  });

  it("'/' → serve index.html (200, text/html)", async () => {
    const res = makeRes();
    await drive(req("GET", "/"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("PORTAL");
  });

  it("asset existente → 200 com mime correto", async () => {
    const res = makeRes();
    await drive(req("GET", "/assets/app.js"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body).toContain("spa");
  });

  it("rota SEM extensão (client routing) → SPA fallback = index.html", async () => {
    const res = makeRes();
    await drive(req("GET", "/frota/site/abc"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("PORTAL");
  });

  it("asset COM extensão que não existe → 404 (não cai no fallback)", async () => {
    const res = makeRes();
    await drive(req("GET", "/assets/missing.js"), res);
    expect(res.statusCode).toBe(404);
  });

  it("traversal PERCENT-ENCODED (/..%2f..%2fsecret.txt) → 403 e NÃO vaza o arquivo de fora", async () => {
    // %2f sobrevive ao new URL() (não vira separador nem é decodificado no pathname) → chega
    // ao resolveSafe, que o barra. É o vetor real; o `../` cru já é colapsado pelo próprio URL.
    const res = makeRes();
    await drive(req("GET", "/..%2f..%2fsecret.txt"), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("TOP SECRET");
  });

  it("traversal CRU (/../secret.txt): URL normaliza p/ dentro da raiz → 404, sem vazar", async () => {
    // defesa em profundidade: mesmo o vetor que o WHATWG-URL colapsa nunca serve o arquivo de fora.
    const res = makeRes();
    await drive(req("GET", "/../secret.txt"), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("TOP SECRET");
  });

  it("dotfile (/.env) → 403", async () => {
    const res = makeRes();
    await drive(req("GET", "/.env"), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("SECRET");
  });

  it("método não-GET (POST) → não trata (deixa o 404 do index)", () => {
    const res = makeRes();
    const handled = serveStatic(req("POST", "/"), res, dist);
    expect(handled).toBe(false);
  });
});
