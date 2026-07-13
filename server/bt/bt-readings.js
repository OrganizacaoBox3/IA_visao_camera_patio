// Leituras BLE das estações (TC22 etc.) — EFÊMERAS em memória. Responsabilidade única: guardar a
// ÚLTIMA leitura por FONTE×tag, enriquecer com o rótulo cadastrado (bt-tags.match) e servir o snapshot,
// podando o que ficou velho (tag saiu de alcance). NÃO emite socket (a rota faz o relay) nem persiste
// (LGPD: RSSI de pessoa nunca é gravado — mesma doutrina dos frames, ADR-002).
//
// MULTI-ANTENA (spec-multi-antena-ble F2): a chave é COMPOSTA (stationId|MAC) — duas estações vendo a
// MESMA tag são duas séries de RSSI independentes (o bug antigo: chave só por MAC ⇒ last-writer-wins
// entre estações, as séries colidiam no mesmo slot). A poda por staleness é POR FONTE: estação que
// parou de ver a tag some do snapshot sem apagar a leitura da outra.
const btTags = require("./bt-tags");

const STALE_MS = 15_000; // leitura mais velha que isto some do snapshot

// `${stationId}|${MAC maiúsculo}` -> { mac, rotulo|null, stationId, rssi, ts }
const latest = new Map();

/**
 * Ingere as leituras de uma estação. Casa cada uma com a tag cadastrada (por MAC, senão por nome).
 * @returns {Array} as leituras enriquecidas (o que a rota relaya aos dashboards).
 */
function ingest(stationId, readings, now = Date.now()) {
  const st = String(stationId || "");
  const out = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    const mac = String((r && r.mac) || "").toUpperCase();
    const rssi = Number(r && r.rssi);
    if (!mac || !Number.isFinite(rssi)) continue;
    const tag = btTags.match(mac) || btTags.match((r && r.name) || "");
    const rec = { mac, rotulo: tag ? tag.rotulo : null, stationId: st, rssi, ts: now };
    latest.set(`${st}|${mac}`, rec);
    out.push(rec);
  }
  return out;
}

/** TODAS as fontes vivas — N estações × MAC (poda as velhas POR FONTE como efeito colateral —
 *  o snapshot é sempre "o que dá pra ver agora"). Com UMA estação: 1 rec por MAC, como sempre foi. */
function snapshot(now = Date.now()) {
  const alive = [];
  for (const [key, rec] of latest) {
    if (now - rec.ts > STALE_MS) latest.delete(key);
    else alive.push(rec);
  }
  return alive;
}

/** Visão COLAPSADA por MAC: o rec mais FRESCO de cada tag vence (empate → o ingerido por último,
 *  preservando o last-writer-wins do store antigo). É o formato RETROCOMPAT (CA-3) do
 *  GET /api/bt/readings default — consumidores que fazem merge por MAC seguem intactos; com uma
 *  única estação o resultado é indistinguível do snapshot() antigo. */
function snapshotLatestByMac(now = Date.now()) {
  const byMac = new Map();
  for (const rec of snapshot(now)) {
    const cur = byMac.get(rec.mac);
    if (!cur || rec.ts >= cur.ts) byMac.set(rec.mac, rec);
  }
  return [...byMac.values()];
}

/** Fontes vivas AGRUPADAS por estação — p/ saúde por fonte e UI (Map preserva a ordem de chegada). */
function snapshotByStation(now = Date.now()) {
  const byStation = new Map();
  for (const rec of snapshot(now)) {
    const arr = byStation.get(rec.stationId);
    if (arr) arr.push(rec);
    else byStation.set(rec.stationId, [rec]);
  }
  return byStation;
}

module.exports = { ingest, snapshot, snapshotLatestByMac, snapshotByStation, STALE_MS };
