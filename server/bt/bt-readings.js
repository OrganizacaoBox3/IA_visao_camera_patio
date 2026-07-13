// Leituras BLE das estações (TC22 etc.) — EFÊMERAS em memória. Responsabilidade única: guardar a
// ÚLTIMA leitura por FONTE×tag, enriquecer com o rótulo cadastrado (bt-tags.match) e servir o snapshot,
// podando o que ficou velho (tag saiu de alcance). NÃO emite socket (a rota faz o relay) nem persiste
// (LGPD: RSSI de pessoa nunca é gravado — mesma doutrina dos frames, ADR-002).
//
// MULTI-ANTENA (spec-multi-antena-ble F2): a chave é COMPOSTA (stationId|MAC) — duas estações vendo a
// MESMA tag são duas séries de RSSI independentes (o bug antigo: chave só por MAC ⇒ last-writer-wins
// entre estações, as séries colidiam no mesmo slot). A poda por staleness é POR FONTE: estação que
// parou de ver a tag some do snapshot sem apagar a leitura da outra.
//
// QUANDO O RÁDIO MEDIU ≠ QUANDO O HUB RECEBEU (`measuredAt`, ADITIVO 2026-07-13 — bug B1 do laudo
// `docs/analises/tags-bluetooth/laudo-2026-07-13-por-que-nao-associa.md`): a estação carimba `ageMs`
// (idade da medição pelo relógio MONOTÔNICO dela) em cada leitura, e o hub reconstrói o instante com
// o SEU relógio: `measuredAt = now − ageMs`. Não aceitamos epoch do device de propósito — o relógio
// de parede do celular pode estar torto em minutos e um `measuredAt` no futuro/passado quebraria a
// poda. `ageMs` ausente (estação antiga) → `measuredAt = now` (a chegada É a medição): retrocompat
// dura, comportamento byte-idêntico ao de sempre.
// POR QUE ISSO EXISTE: o pool serve a ÚLTIMA leitura por até STALE_MS, e o navegador reamostra o
// snapshot a cada tick — a MESMA medição física entra 4-5× na janela do associador. Sem `measuredAt`
// o motor não consegue distinguir cópia de medição fresca e conta POST como se fosse evidência
// (Regra 8; medido: 83,3% do que o hub recebia era cópia). Com ele, o motor deduplica na entrada.
const btTags = require("./bt-tags");

const STALE_MS = 15_000; // leitura mais velha que isto some do snapshot

// `${stationId}|${MAC maiúsculo}` -> { mac, rotulo|null, stationId, rssi, ts, measuredAt }
const latest = new Map();

/** Instante da MEDIÇÃO no relógio do HUB (ver cabeçalho): now − ageMs, clampado a [now−STALE_MS, now].
 *  Sem `ageMs` válido → `now` (retrocompat). O clamp existe porque leitura mais velha que o pool não
 *  existe para nenhum consumidor: deixá-la entrar só criaria um rec que nasce podado. */
function measuredAtOf(r, now) {
  const age = Number(r && r.ageMs);
  if (!Number.isFinite(age) || age < 0) return now;
  return now - Math.min(age, STALE_MS);
}

/**
 * Ingere as leituras de uma estação. Casa cada uma com a tag cadastrada (por MAC, senão por nome).
 * `ts` = quando o hub RECEBEU; `measuredAt` = quando o rádio MEDIU (ver cabeçalho).
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
    const rec = {
      mac,
      rotulo: tag ? tag.rotulo : null,
      stationId: st,
      rssi,
      ts: now,
      measuredAt: measuredAtOf(r, now),
    };
    latest.set(`${st}|${mac}`, rec);
    out.push(rec);
  }
  return out;
}

/** TODAS as fontes vivas — N estações × MAC (poda as velhas POR FONTE como efeito colateral —
 *  o snapshot é sempre "o que dá pra ver agora"). Com UMA estação: 1 rec por MAC, como sempre foi.
 *  A poda é pela idade da MEDIÇÃO (`measuredAt`), não pela da chegada: uma estação que reenvia a
 *  mesma leitura velha não pode ressuscitar uma tag que SAIU DE CENA (o "fantasma de 35 s" do laudo
 *  — app segurava 20 s + pool 15 s). Sem `measuredAt` (estação antiga) os dois coincidem. */
function snapshot(now = Date.now()) {
  const alive = [];
  for (const [key, rec] of latest) {
    if (now - (rec.measuredAt ?? rec.ts) > STALE_MS) latest.delete(key);
    else alive.push(rec);
  }
  return alive;
}

/** Visão COLAPSADA por MAC: o rec mais FRESCO de cada tag vence (empate → o ingerido por último,
 *  preservando o last-writer-wins do store antigo). "Mais fresco" = MEDIÇÃO mais recente
 *  (`measuredAt`), não chegada mais recente: entre duas estações, vence quem MEDIU por último, não
 *  quem postou por último. Com `measuredAt` ausente os dois critérios coincidem (retrocompat).
 *  É o formato RETROCOMPAT (CA-3) do GET /api/bt/readings default — consumidores que fazem merge por
 *  MAC seguem intactos; com uma única estação o resultado é indistinguível do snapshot() antigo. */
function snapshotLatestByMac(now = Date.now()) {
  const byMac = new Map();
  for (const rec of snapshot(now)) {
    const cur = byMac.get(rec.mac);
    if (!cur || (rec.measuredAt ?? rec.ts) >= (cur.measuredAt ?? cur.ts)) byMac.set(rec.mac, rec);
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
