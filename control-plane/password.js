// Senha do CONTROL-PLANE — MESMO esquema scrypt do hub (server/users.js:30-43).
// Copiado ao pé da letra de propósito: não inventamos outro algoritmo. O
// app_user.senha_hash guarda exatamente este formato: `scrypt$<salt>$<derivedKeyHex>`.
const crypto = require("node:crypto");

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
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
