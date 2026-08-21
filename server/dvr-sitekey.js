// SITE_KEY — a credencial que o hub silo usa p/ falar com o control-plane (ingest/heartbeat).
// Padrão de API key: nasce na CRIAÇÃO do site (crypto.randomBytes, alta entropia), o plane
// guarda SÓ o HASH e devolve a chave CRUA uma única vez. A verificação é timing-safe.
//
// Por que sha256 (e não scrypt como a senha): a chave é aleatória de 256 bits — não há o que
// "quebrar por dicionário", então o custo alto do scrypt não compra segurança aqui e só onera
// cada ingest/heartbeat. O contrato entre as frentes permite sha256 (timing-safe na verificação).
// Formato do hash guardado: `sha256$<hex>` (auto-descritivo, como o scrypt$ da senha).
const crypto = require("node:crypto");

// 32 bytes = 256 bits. base64url → chave curta, sem caracteres problemáticos em header/env.
function generateSiteKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSiteKey(rawKey) {
  const dk = crypto.createHash("sha256").update(String(rawKey)).digest("hex");
  return `sha256$${dk}`;
}

// timing-safe: comprimento diferente já não casa; iguais → timingSafeEqual sobre os bytes hex.
function verifySiteKey(rawKey, storedHash) {
  try {
    const [scheme, dk] = String(storedHash).split("$");
    if (scheme !== "sha256" || !dk) return false;
    const calc = crypto.createHash("sha256").update(String(rawKey)).digest("hex");
    const a = Buffer.from(dk, "hex");
    const b = Buffer.from(calc, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { generateSiteKey, hashSiteKey, verifySiteKey };
