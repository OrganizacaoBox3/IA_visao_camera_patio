// Medição END-TO-END do boost de foco: sobe o MOTOR REAL (worker + D-FINE) com um `io` falso
// que CONTA os `analysis-tracks` emitidos de verdade, e compara a cadência de uma câmera ANTES
// e DEPOIS do analysis-focus. Prova o claim "câmera focada ~6fps vs fundo ~1fps" com inferência
// real — sem precisar de hub/HTTP/câmera live. Uso: node scripts/measure-focus.cjs
process.env.ANALYSIS_ENABLED = "1";
process.env.ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "n"; // N = mais rápido, garante que a
// cadência é limitada pelo ALVO (1/6fps), não pela velocidade de inferência.
process.env.ANALYSIS_FPS = "1";
process.env.ANALYSIS_FPS_FOCUS = "6";
process.env.ANALYSIS_GO2RTC_PULL = "0"; // sem go2rtc; alimentamos por onFrame (relé)

const fs = require("node:fs");
const path = require("node:path");
const engine = require("../server/analysis/engine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_MS = 6000;

// io falso: captura os emits de analysis-tracks por câmera; finge 1 dashboard na room.
let counts = Object.create(null);
const cap = (event, payload) => {
  if (event === "analysis-tracks" && payload && payload.cameraId)
    counts[payload.cameraId] = (counts[payload.cameraId] || 0) + 1;
};
const room = { emit: cap, volatile: { emit: cap } };
const io = {
  to: () => room,
  sockets: { adapter: { rooms: new Map([["dashboards", new Set(["dash-1"])]]) } },
};

(async () => {
  const jpg = fs.readFileSync(path.join(__dirname, "..", "eval", "data", "images", "000000000139.jpg"));
  console.log("[medida] subindo o motor (worker + modelo)…");
  await engine.init({ io, cameras: new Map() });

  // Alimenta 2 câmeras a ~10fps de FRAMES (bem acima do alvo de análise → o alvo é o limitante).
  const feed = setInterval(() => {
    const ts = Date.now();
    engine.onFrame("camA", jpg, ts);
    engine.onFrame("camB", jpg, ts);
  }, 100);

  console.log("[medida] aquecendo o worker (3s)…");
  await sleep(3000);

  // FASE 1 — nenhuma câmera focada
  counts = Object.create(null);
  await sleep(WIN_MS);
  const p1 = { ...counts };

  // FASE 2 — foca camA
  engine.setFocus("dash-1", "camA");
  counts = Object.create(null);
  await sleep(WIN_MS);
  const p2 = { ...counts };

  clearInterval(feed);

  const fps = (n) => ((n || 0) / (WIN_MS / 1000)).toFixed(1);
  console.log("\n  RESULTADO (analysis-tracks emitidos / s — cadência REAL do overlay)");
  console.log("  ─────────────────────────────────────────────────────────────");
  console.log(`  camA (a focar)   : fundo ${fps(p1.camA)} fps  →  FOCADA ${fps(p2.camA)} fps`);
  console.log(`  camB (controle)  : fundo ${fps(p1.camB)} fps  →  fundo  ${fps(p2.camB)} fps`);
  console.log("  ─────────────────────────────────────────────────────────────");
  const ok = (p2.camA || 0) > (p1.camA || 0) * 2 && Math.abs((p2.camB || 0) - (p1.camB || 0)) <= 2;
  console.log(ok ? "  ✅ boost confirmado: camA subiu, camB (controle) ficou igual." : "  ⚠ ver números acima.");
  try {
    const r = engine.stop();
    if (r && typeof r.then === "function") await r;
  } catch {
    /* best-effort */
  }
  process.exit(0);
})().catch((e) => {
  console.error("[medida] falhou:", e.message);
  process.exit(1);
});
