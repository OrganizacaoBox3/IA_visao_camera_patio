// Gravador OPT-IN da SESSÃO DE FUSÃO INDOOR (câmera + BLE) — matéria-prima do harness de replay do
// motor de localização (ADR-012). O recorder.js grava só relatórios COM lat/lon (modelo AirTag/GPS);
// indoor NÃO tem GPS — este grava o par bruto que o motor consome: tracks do `analysis-tracks`
// (caixas normalizadas) + leituras BLE do ingest, cada um com seu relógio (ts do hub).
//
// FORMATO (JSONL append-only, 1 evento/linha — contrato fixo com o loader de replay):
//   {"t":"cal","ts":<ms>,"cameraId":"<id>","H":[9 números]|null,"station":{"x":0..1,"y":0..1}|null}
//   {"t":"trk","ts":<ms>,"cameraId":"<id>","tracks":[{"id":<num>,"bbox":[x,y,w,h]}]}  // bbox 0..1
//   {"t":"ble","ts":<ms>,"stationId":"<id>","readings":[{"mac":"<MAC>","rssi":<int>}]}
//
// LGPD (ADR-002): SÓ metadados (caixas/MAC/RSSI/matriz H) — JAMAIS frame/imagem. Whitelist de campos:
// mesmo que track/leitura traga mais coisa, nada além do contrato acima vai pro disco. Minimização
// DELIBERADA: a leitura BLE grava só {mac, rssi} — o `rotulo` (nome dado pelo usuário, PII potencial)
// fica FORA; o mapeamento mac→rotulo vive em bt-tags p/ anotação humana pós-coleta.
//
// I/O: appendFileSync no caminho quente é ACEITO para este escopo (opt-in, teste de campo de minutos,
// linhas pequenas) — simplicidade > throughput aqui. Se virar uso recorrente/24-7, trocar por
// fs.createWriteStream({ flags: "a" }).
//
// OFF por default: só grava com FUSION_RECORD truthy (opt-in explícito — quem liga sabe que está
// coletando). Fail-safe: JAMAIS lança no caminho quente (pipeline de análise / ingest BLE) — erro de
// disco loga UMA vez e segue mudo. Só node:fs/node:path + camcfg (padrão da casa: sem dependência nova).
//
// CADÊNCIA (documentada, sem throttle — KISS, o loader resample): `analysis-tracks` emite ~1-20 Hz por
// câmera (FPS/FPS_LINE/FPS_FOCUS do engine). Num teste de campo de minutos isso dá um JSONL de alguns
// MB — ok. NÃO deixe FUSION_RECORD ligado 24/7 sem rotação.
//
// OPERAÇÃO: a linha "cal" é escrita na PRIMEIRA rodada de tracks gravada da câmera (H/station null se
// não calibrada) e RE-EMITIDA sempre que o `updatedAt` da calibração no camcfg mudar — calibrar ou
// recalibrar durante a sessão entra no JSONL (o loader aplica "último cal vence").
const fs = require("node:fs");
const path = require("node:path");
const camcfg = require("../camcfg");

// Co-locado com os outros artefatos de runtime do domínio BT (bt-recording.jsonl etc.). Gitignored.
const FILE = path.join(__dirname, "fusion-session.jsonl");

// Opt-in: liga só quando FUSION_RECORD é truthy (1/true/yes/on). Lido a CADA chamada — sem estado de
// boot, dá pra ligar/desligar sem reiniciar caso a env mude no processo.
function enabled() {
  const v = String(process.env.FUSION_RECORD || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Última calibração gravada por câmera NESTE processo: cameraId → `updatedAt` do camcfg (null =
// "gravada como não-calibrada"). Se o updatedAt corrente divergir, a linha "cal" é re-emitida.
const calStamp = new Map();
// Fail-safe "loga 1x": o pipeline chama a ~10-20 Hz — um disco cheio não pode virar spam de log.
let warned = false;

function append(line) {
  fs.appendFileSync(FILE, JSON.stringify(line) + "\n");
}

function fail(e) {
  if (warned) return;
  warned = true;
  console.error("[fusion-recorder] falha ao gravar (ignorado; não loga de novo):", String((e && e.message) || e));
}

/**
 * Grava UMA rodada de tracks de uma câmera (chamado no ponto de emissão do `analysis-tracks`).
 * Whitelist: só {id, bbox} de cada track (bbox normalizado 0..1, como veio do tracker).
 * Escreve antes a linha "cal" na primeira gravação da câmera E sempre que a calibração mudar
 * (comparação por `updatedAt` do camcfg — o loader aplica "último cal vence").
 * No-op quando desabilitado. Nunca lança (fail-safe — caminho quente do pipeline).
 */
function recordTracks(cameraId, ts, tracks) {
  if (!enabled()) return;
  try {
    const id = String(cameraId || "");
    const when = Number(ts) || Date.now();
    const cal = camcfg.getCalibration(id); // null quando a câmera nunca foi calibrada
    const stamp = cal ? Number(cal.updatedAt) || 0 : null; // null distingue "sem calibração" de updatedAt=0
    if (!calStamp.has(id) || calStamp.get(id) !== stamp) {
      const H = cal && Array.isArray(cal.H) && cal.H.length === 9 ? cal.H.map(Number) : null;
      const station = cal && cal.station ? { x: Number(cal.station.x), y: Number(cal.station.y) } : null;
      append({ t: "cal", ts: when, cameraId: id, H, station });
      calStamp.set(id, stamp); // só marca após escrever — falha transitória tenta de novo na próxima rodada
    }
    const clean = (Array.isArray(tracks) ? tracks : []).map((t) => ({
      id: Number(t && t.id),
      bbox: Array.isArray(t && t.bbox) ? t.bbox.slice(0, 4).map(Number) : [],
    }));
    append({ t: "trk", ts: when, cameraId: id, tracks: clean });
  } catch (e) {
    fail(e);
  }
}

/**
 * Grava UM batch de leituras BLE de uma estação (chamado no ingest /api/bt/reading — SEMPRE,
 * com ou sem lat/lon). Whitelist MINIMIZADA (LGPD): só {mac, rssi} — sem `rotulo` (ver header).
 * No-op quando desabilitado. Nunca lança (fail-safe — caminho quente do ingest).
 */
function recordReadings(stationId, ts, readings) {
  if (!enabled()) return;
  try {
    const clean = (Array.isArray(readings) ? readings : []).map((r) => ({
      mac: String((r && r.mac) || ""),
      rssi: Number(r && r.rssi),
    }));
    append({ t: "ble", ts: Number(ts) || Date.now(), stationId: String(stationId || ""), readings: clean });
  } catch (e) {
    fail(e);
  }
}

module.exports = { enabled, recordTracks, recordReadings, FILE };
