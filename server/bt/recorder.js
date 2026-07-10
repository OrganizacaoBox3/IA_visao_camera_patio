// Recorder OPT-IN de EVENT-SOURCING das leituras do coletor BLE — Fase 1 do motor de localização (ADR-012).
// Grava UMA linha JSON por relatório (JSONL append-only): SÓ metadados (ts/lat/lon/acc/tags[mac,rssi,rotulo]),
// NUNCA frame/imagem (LGPD, ADR-002 — mesma doutrina do bt-readings/frames). É a matéria-prima do harness
// de replay: dado REAL para de-riscar o motor, sem simulação.
//
// OFF por default: só grava com BT_RECORD truthy (opt-in explícito — quem liga sabe que está coletando).
// Fail-safe: JAMAIS lança no caminho da request — erro de disco loga e segue (não pode derrubar o ingest).
// Só node:fs/node:path (padrão da casa: sem dependência nova).
const fs = require("node:fs");
const path = require("node:path");

// Co-locado com os outros json de runtime do domínio BT (bt-locations.json, bt-tags.json). Gitignored.
const FILE = path.join(__dirname, "bt-recording.jsonl");

// Opt-in: liga só quando BT_RECORD é truthy (1/true/yes/on). Lido a CADA chamada — sem estado de boot,
// dá pra ligar/desligar sem reiniciar caso a env mude no processo.
function enabled() {
  const v = String(process.env.BT_RECORD || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Acrescenta UM relatório ao arquivo. Whitelist de campos: escreve SÓ o metadado — mesmo que o report traga
// mais coisa, nada além de ts/lat/lon/acc/tags[mac,rssi,rotulo] vai pro disco. No-op quando desabilitado.
// Nunca lança: try/catch loga e segue.
function record(report) {
  if (!enabled()) return;
  try {
    const r = report || {};
    const tags = (Array.isArray(r.tags) ? r.tags : []).map((t) => {
      const tag = { mac: String((t && t.mac) || ""), rssi: Number(t && t.rssi) };
      const rotulo = t && (t.rotulo ?? t.label);
      if (rotulo != null) tag.rotulo = String(rotulo);
      return tag;
    });
    const line = {
      ts: Number(r.ts) || Date.now(),
      lat: Number(r.lat),
      lon: Number(r.lon),
      acc: Number.isFinite(Number(r.acc)) ? Number(r.acc) : null,
      tags,
    };
    fs.appendFileSync(FILE, JSON.stringify(line) + "\n");
  } catch (e) {
    console.error("[bt-recorder] falha ao gravar (ignorado):", e.message);
  }
}

module.exports = { enabled, record, FILE };
