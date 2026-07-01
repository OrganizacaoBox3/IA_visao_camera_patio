// SHELVING (ISA-18.2) — silenciar temporariamente uma chave de alarme, com
// expiração automática. Chave: "cameraId|zona|tipo"; cada segmento aceita "*"
// como curinga (ex.: "cam-doca-1|*|*" silencia TODA a câmera na manutenção).
// Segmentos são normalizados (trim + lowercase). Estado em memória, PERSISTIDO
// em disco (ver persist.js) para sobreviver a reinício.
const { log } = require("./config");
const { shelved } = require("./state");
const { normSeg, normShelveKey, segMatch, pickCamera, pickZona } = require("./keys");
const { SHELVE_MAX_MS, SHELVE_DEFAULT_MS } = require("./config");
const { saveShelves } = require("./persist");
const { classify } = require("../dispatch");

// Constrói a chave de shelve (não-curinga) a partir de um payload de alerta,
// usando a MESMA derivação de cameraId/zona/tipo do evaluate(). Útil para a UI
// montar a chave a silenciar a partir de um alerta exibido.
function shelveKeyFor(p) {
  const text = String((p && p.text) || "").trim();
  const cameraId = pickCamera(p || {}, text);
  const zona = pickZona(p || {}, text);
  const tipo = (p && p.tipo) || (text ? classify(text).tipo : "");
  return `${normSeg(cameraId)}|${normSeg(zona)}|${normSeg(tipo)}`;
}

// Verifica se um alarme (cameraId/zona/tipo) está coberto por algum shelve
// ativo. Poda os expirados. Retorna a chave de shelve casada ou null.
function isShelved(cameraId, zona, tipo, now = Date.now()) {
  if (!shelved.size) return null;
  const aCam = normSeg(cameraId);
  const aZona = normSeg(zona);
  const aTipo = normSeg(tipo);
  for (const [k, info] of shelved) {
    if (now >= info.expiresAt) {
      shelved.delete(k);
      continue;
    }
    const [pCam, pZona, pTipo] = k.split("|");
    if (segMatch(pCam, aCam) && segMatch(pZona, aZona) && segMatch(pTipo, aTipo)) return k;
  }
  return null;
}

/**
 * Silencia temporariamente uma chave de alarme. PERSISTIDO em disco
 * (alarm-shelves.json) — sobrevive a reinício do processo.
 * @param {string} key  "cameraId|zona|tipo" (cada segmento aceita "*").
 * @param {number} [ms] Duração; default ALARM_SHELVE_DEFAULT_MS, clamp em
 *                      [1000, ALARM_SHELVE_MAX_MS].
 * @param {{reason?:string, by?:string}} [opts]
 * @returns {{key:string, ms:number, since:number, expiresAt:number, reason:string, by:string}}
 */
function shelve(key, ms, opts = {}) {
  const now = Date.now();
  const k = normShelveKey(key);
  let dur = Number(ms);
  if (!Number.isFinite(dur) || dur <= 0) dur = SHELVE_DEFAULT_MS;
  dur = Math.max(1000, Math.min(dur, SHELVE_MAX_MS));
  const info = {
    expiresAt: now + dur,
    since: now,
    ms: dur,
    reason: String(opts.reason ?? ""),
    by: String(opts.by ?? ""),
  };
  shelved.set(k, info);
  log.info({ key: k, ms: dur, by: info.by, reason: info.reason }, "[alarm] shelve aplicado");
  saveShelves(); // persiste o conjunto alterado (resiliente: nunca lança)
  return Object.assign({ key: k }, info);
}

/** Remove um shelve (cancela o silêncio). @returns {boolean} havia shelve. */
function unshelve(key) {
  const k = normShelveKey(key);
  const had = shelved.delete(k);
  if (had) {
    log.info({ key: k }, "[alarm] unshelve");
    saveShelves();
  } // persiste só se mudou
  return had;
}

/** Lista os shelves ATIVOS (poda expirados). @returns {Array} */
function listShelved() {
  const now = Date.now();
  const out = [];
  for (const [k, info] of shelved) {
    if (now >= info.expiresAt) {
      shelved.delete(k);
      continue;
    }
    out.push({
      key: k,
      since: info.since,
      ms: info.ms,
      expiresAt: info.expiresAt,
      remainingMs: info.expiresAt - now,
      reason: info.reason,
      by: info.by,
    });
  }
  return out;
}

module.exports = { shelveKeyFor, isShelved, shelve, unshelve, listShelved };
