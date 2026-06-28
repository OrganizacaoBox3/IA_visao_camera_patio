// Base de usuários (multi-usuário, papéis). Cache em memória → leitura sync rápida (verifyToken/login
// em todo request). Escrita persiste no Postgres (se configurado) OU em users.json (fallback dev/PG off).
// Senha: scrypt. Sessão: token HMAC assinado. Bootstrap do superadmin no 1º boot.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");

const FILE = path.join(__dirname, "users.json");
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-inseguro-troque-AUTH_SECRET-em-producao";
const TOKEN_TTL_MS = Number(process.env.AUTH_TTL_MS ?? 7 * 24 * 3600 * 1000);

let users = [];      // cache
let usingPg = false; // definido no init

// ── hash / token (sync, sobre o cache) ───────────────────────────────────────
function genId() { return "u" + crypto.randomBytes(6).toString("hex"); }
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(String(pwd), salt, 64).toString("hex")}`;
}
function verifyPassword(stored, pwd) {
  try {
    const [scheme, salt, dk] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !dk) return false;
    const calc = crypto.scryptSync(String(pwd), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(dk, "hex"), Buffer.from(calc, "hex"));
  } catch { return false; }
}
function signToken(u) {
  const body = Buffer.from(JSON.stringify({ id: u.id, papel: u.papel, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url")}`;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.exp || p.exp < Date.now()) return null;
    const u = users.find((x) => x.id === p.id && x.ativo);
    return u ? { id: u.id, usuario: u.usuario, papel: u.papel } : null;
  } catch { return null; }
}
function authenticate(usuario, senha) {
  const u = users.find((x) => x.usuario.toLowerCase() === String(usuario || "").toLowerCase() && x.ativo);
  if (!u || !verifyPassword(u.senhaHash, senha)) return null;
  return { token: signToken(u), user: { id: u.id, usuario: u.usuario, papel: u.papel } };
}

// ── persistência (PG ou JSON) ─────────────────────────────────────────────────
function saveFile() { try { fs.writeFileSync(FILE, JSON.stringify(users, null, 2)); } catch (e) { console.error("[users] falha ao salvar:", e.message); } }
async function persist(u) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into users (id,usuario,senha_hash,papel,ativo,whatsapp,filtros,opt_in_em,criado_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set usuario=excluded.usuario, senha_hash=excluded.senha_hash, papel=excluded.papel,
       ativo=excluded.ativo, whatsapp=excluded.whatsapp, filtros=excluded.filtros, opt_in_em=excluded.opt_in_em`,
    [u.id, u.usuario, u.senhaHash, u.papel, u.ativo, u.whatsapp || "", u.filtros == null ? null : JSON.stringify(u.filtros), u.optInEm ?? null, u.criadoEm ?? Date.now()]
  );
}
async function persistDelete(id) { if (!usingPg) return saveFile(); await db.query("delete from users where id=$1", [id]); }

function newSuperadmin() {
  return { id: genId(), usuario: process.env.SUPERADMIN_USER || "admin", senhaHash: hashPassword(process.env.SUPERADMIN_PASSWORD || "admin@box3"), papel: "superadmin", ativo: true, whatsapp: "", filtros: null, optInEm: null, criadoEm: Date.now() };
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(`select id, usuario, senha_hash as "senhaHash", papel, ativo, whatsapp, filtros, opt_in_em as "optInEm", criado_em as "criadoEm" from users order by criado_em asc nulls first`);
      users = r.rows; usingPg = true;
      if (!users.length) { const su = newSuperadmin(); users.push(su); await persist(su); console.log(`[users] superadmin '${su.usuario}' criado no Postgres (bootstrap) — TROQUE a senha.`); }
      console.log(`[users] ${users.length} usuário(s) do Postgres`);
      return;
    } catch (e) { console.error("[users] Postgres indisponível, usando JSON:", e.message); }
  }
  usingPg = false;
  try { const a = JSON.parse(fs.readFileSync(FILE, "utf8")); if (Array.isArray(a)) users = a; } catch { users = []; }
  if (!users.length) { users.push(newSuperadmin()); saveFile(); console.log("[users] superadmin criado em users.json (bootstrap) — TROQUE a senha."); }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
function publicUser(u) { const { senhaHash, ...r } = u; return r; } // eslint-disable-line no-unused-vars
function getById(id) { return users.find((x) => x.id === id) || null; }

async function createUser({ usuario, senha, papel }) {
  usuario = String(usuario || "").trim();
  if (!usuario || !senha) return { error: "usuário e senha são obrigatórios" };
  if (users.some((u) => u.usuario.toLowerCase() === usuario.toLowerCase())) return { error: "usuário já existe" };
  const u = { id: genId(), usuario, senhaHash: hashPassword(senha), papel: papel === "superadmin" ? "superadmin" : "usuario", ativo: true, whatsapp: "", filtros: null, optInEm: null, criadoEm: Date.now() };
  users.push(u); await persist(u);
  return { user: publicUser(u) };
}
async function updateUser(id, patch) {
  const u = getById(id); if (!u) return { error: "usuário não encontrado" };
  const willActive = typeof patch.ativo === "boolean" ? patch.ativo : u.ativo;
  const willPapel = patch.papel === "superadmin" || patch.papel === "usuario" ? patch.papel : u.papel;
  const otherSupers = users.filter((x) => x.id !== id && x.papel === "superadmin" && x.ativo).length;
  if (otherSupers + (willPapel === "superadmin" && willActive ? 1 : 0) < 1) return { error: "precisa de ao menos 1 superadmin ativo" };
  if (typeof patch.ativo === "boolean") u.ativo = patch.ativo;
  u.papel = willPapel;
  if (patch.senha) u.senhaHash = hashPassword(patch.senha);
  await persist(u);
  return { user: publicUser(u) };
}
async function removeUser(id) {
  const u = getById(id); if (!u) return { error: "usuário não encontrado" };
  const rest = users.filter((x) => x.id !== id);
  if (!rest.some((x) => x.papel === "superadmin" && x.ativo)) return { error: "não pode remover o último superadmin ativo" };
  users = rest; await persistDelete(id);
  return { ok: true };
}

// ── Perfil do próprio usuário ─────────────────────────────────────────────────
function normalizePhone(s) { return String(s || "").replace(/\D/g, ""); }
function getProfile(id) { const u = getById(id); return u ? publicUser(u) : null; }
async function updateProfile(id, patch) {
  const u = getById(id); if (!u) return { error: "usuário não encontrado" };
  if (typeof patch.whatsapp === "string") u.whatsapp = normalizePhone(patch.whatsapp);
  if (patch.filtros && typeof patch.filtros === "object") u.filtros = { ativo: !!patch.filtros.ativo, somenteCriticos: !!patch.filtros.somenteCriticos, tipos: Array.isArray(patch.filtros.tipos) ? patch.filtros.tipos : [] };
  if (typeof patch.optIn === "boolean") u.optInEm = patch.optIn ? (u.optInEm || Date.now()) : null;
  await persist(u);
  return { user: publicUser(u) };
}

module.exports = {
  init, authenticate, verifyToken, createUser, updateUser, removeUser, getProfile, updateProfile,
  hashPassword, genId, getById, all: () => users, publicList: () => users.map(publicUser),
};
