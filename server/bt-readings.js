// Leituras BLE das estações (TC22 etc.) — EFÊMERAS em memória. Responsabilidade única: guardar a
// ÚLTIMA leitura por tag, enriquecer com o rótulo cadastrado (bt-tags.match) e servir o snapshot,
// podando o que ficou velho (tag saiu de alcance). NÃO emite socket (a rota faz o relay) nem persiste
// (LGPD: RSSI de pessoa nunca é gravado — mesma doutrina dos frames, ADR-002).
const btTags = require("./bt-tags");

const STALE_MS = 15_000; // leitura mais velha que isto some do snapshot

// MAC(maiúsculo) -> { mac, rotulo|null, stationId, rssi, ts }
const latest = new Map();

/**
 * Ingere as leituras de uma estação. Casa cada uma com a tag cadastrada (por MAC, senão por nome).
 * @returns {Array} as leituras enriquecidas (o que a rota relaya aos dashboards).
 */
function ingest(stationId, readings, now = Date.now()) {
  const out = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    const mac = String((r && r.mac) || "").toUpperCase();
    const rssi = Number(r && r.rssi);
    if (!mac || !Number.isFinite(rssi)) continue;
    const tag = btTags.match(mac) || btTags.match((r && r.name) || "");
    const rec = { mac, rotulo: tag ? tag.rotulo : null, stationId: String(stationId || ""), rssi, ts: now };
    latest.set(mac, rec);
    out.push(rec);
  }
  return out;
}

/** Leituras vivas (poda as velhas como efeito colateral — o snapshot é sempre "o que dá pra ver agora"). */
function snapshot(now = Date.now()) {
  const alive = [];
  for (const [mac, rec] of latest) {
    if (now - rec.ts > STALE_MS) latest.delete(mac);
    else alive.push(rec);
  }
  return alive;
}

module.exports = { ingest, snapshot, STALE_MS };
