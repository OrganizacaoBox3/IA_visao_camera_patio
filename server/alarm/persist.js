// Persistência das SHELVES (JSON local, resiliente). Só as shelves ATIVAS são
// persistidas: um shelve é uma decisão DELIBERADA do operador (silenciar durante
// manutenção programada) que precisa sobreviver a deploy/restart/crash — do
// contrário um restart no meio da manutenção ressuscitaria a enxurrada de alertas.
// INVARIANTE: uma falha de disco NUNCA derruba a política de alarmes (toda I/O em
// try/catch, apenas loga). Arquivo (server/alarm-shelves.json) é RUNTIME —
// gitignored, nunca versionar (ADR-005).
const fs = require("node:fs");
const { log, SHELVES_FILE } = require("./config");
const { shelved } = require("./state");
const { normShelveKey } = require("./keys");

// Grava as shelves ATIVAS (poda expiradas antes). Atômico: escreve em .tmp e
// renomeia por cima, evitando arquivo parcial/corrompido se o processo morrer
// no meio da escrita.
function saveShelves() {
  try {
    const now = Date.now();
    const arr = [];
    for (const [k, info] of shelved) {
      if (now >= info.expiresAt) {
        shelved.delete(k);
        continue;
      } // poda expiradas
      arr.push({
        key: k,
        expiresAt: info.expiresAt,
        since: info.since,
        ms: info.ms,
        reason: info.reason,
        by: info.by,
      });
    }
    const tmp = `${SHELVES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, SHELVES_FILE);
  } catch (e) {
    log.error(
      { err: e.message, file: SHELVES_FILE },
      "[alarm] falha ao persistir shelves (ignorada)",
    );
  }
}

// Lê o JSON, descarta shelves já expiradas e repovoa o Map. Idempotente: pode
// ser chamada várias vezes (no require e/ou via init()) sem efeito colateral.
function loadShelves() {
  try {
    const raw = fs.readFileSync(SHELVES_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    let restored = 0,
      expired = 0;
    for (const it of arr) {
      if (!it || typeof it.key !== "string") continue;
      const k = normShelveKey(it.key);
      const expiresAt = Number(it.expiresAt);
      if (!Number.isFinite(expiresAt) || now >= expiresAt) {
        expired++;
        continue;
      } // descarta expiradas
      shelved.set(k, {
        expiresAt,
        since: Number(it.since) || now,
        ms: Number(it.ms) || expiresAt - now,
        reason: String(it.reason ?? ""),
        by: String(it.by ?? ""),
      });
      restored++;
    }
    if (restored || expired)
      log.info({ restored, expired, file: SHELVES_FILE }, "[alarm] shelves restauradas do disco");
  } catch (e) {
    // ENOENT (arquivo ainda não existe) é normal no primeiro boot → silencioso.
    if (e.code !== "ENOENT")
      log.error(
        { err: e.message, file: SHELVES_FILE },
        "[alarm] falha ao restaurar shelves (ignorada)",
      );
  }
}

let _loaded = false;
// Restauração preguiçosa/idempotente. Chamada no require de alarmPolicy.js (não
// exige init() em index.js) e também exportada como init() para uso explícito.
function init() {
  if (_loaded) return;
  _loaded = true;
  loadShelves();
}

module.exports = { saveShelves, loadShelves, init };
