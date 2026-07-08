// ─────────────────────────────────────────────────────────────────────────────
// eval/persons-cftv.mjs — SENSOR de reconhecimento de pessoas em CFTV com GROUND-TRUTH.
//
// Mede os 2 sintomas do teste real (analises/reconhecimento-pessoas/00-diagnostico-atual.md)
// contra rótulo à mão, no pipeline REAL (worker.js + bytetrack.js — via lib.mjs, sem reimplementar):
//   • "perde pessoa andando"  → recall (detector E emitido) + ID-SWITCHES
//   • "inventa pessoa"         → precisão / FP
//   • custo da cadência        → varre 1 / 4 / 8 fps e mostra como recall/IDSW mudam
//
// DATASETS (loader plugável; tudo vira [{id, box:[x,y,w,h] 0..1}]):
//   • MOT (padrão da indústria): env MOT_SEQ=<dir da sequência> (img1/ + gt/gt.txt + seqinfo.ini).
//       gt.txt = frame,id,x,y,w,h,conf,class,vis → filtra class=1 (pedestre) & conf=1. Frames 1-indexados.
//   • CAVIAR (fallback): sem MOT_SEQ → usa bench-visao/WalkByShop1cor.mpg + cwbs1gt.xml (384×288).
//
// PARIDADE (lição 02.3): worker de produção (lib) + tracker de produção (bytetrack) + knobs (precision.js,
// os MESMOS do engine.js createState). O eval NÃO roda o gate de movimento (alimenta todo frame amostrado
// = produção COM gente presente, o gate sempre dispara). TTL derivado com gateOn:false.
//
// Uso: ANALYSIS_MODEL=s MOT_SEQ=C:/…/MOT20/train/MOT20-01 node eval/persons-cftv.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startWorker, resolveModelPath, matchGreedy, IOU_MATCH, ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createByteTracker } = require(path.join(ROOT, "server", "analysis", "bytetrack.js"));
const { PRECISION, trackTtlMs } = require(path.join(ROOT, "server", "analysis", "precision.js"));

const CADENCES = [1, 4, 8]; // fps de análise a varrer
const HIGH_SCORE = PRECISION.detector.highScore;
const BENCH = "C:/Users/crist/bench-visao";

// ── Loader MOT: img1/ + gt/gt.txt + seqinfo.ini → {frameNums, framePath, gtByFrame, W,H,fps} ──
function loadMOT(seqDir) {
  const ini = fs.readFileSync(path.join(seqDir, "seqinfo.ini"), "utf8");
  const get = (k) => (ini.match(new RegExp(`${k}=(.+)`)) || [])[1]?.trim();
  const W = +get("imWidth"), H = +get("imHeight"), fps = +get("frameRate"), len = +get("seqLength");
  const imDir = path.join(seqDir, get("imDir") || "img1");
  const ext = get("imExt") || ".jpg";
  const gtByFrame = new Map();
  for (const line of fs.readFileSync(path.join(seqDir, "gt", "gt.txt"), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [f, id, x, y, w, h, conf, cls] = line.split(",").map(Number);
    if (conf !== 1 || cls !== 1) continue; // só pedestre (class 1) considerado (conf 1)
    if (!gtByFrame.has(f)) gtByFrame.set(f, []);
    gtByFrame.get(f).push({ id, box: [x / W, y / H, w / W, h / H] });
  }
  const frameNums = Array.from({ length: len }, (_, i) => i + 1); // MOT: 1-indexado
  return {
    name: path.basename(seqDir), W, H, fps, frameNums, gtByFrame,
    framePath: (f) => path.join(imDir, String(f).padStart(6, "0") + ext),
  };
}

// ── Loader CAVIAR (fallback): .mpg + cwbs1gt.xml ─────────────────────────────
function loadCAVIAR() {
  const W = 384, H = 288, fps = 25;
  const VIDEO = path.join(BENCH, "WalkByShop1cor.mpg");
  const GT_XML = path.join(BENCH, "cwbs1gt.xml");
  const FRAMES_DIR = path.join(BENCH, "caviar-frames");
  if (!fs.existsSync(path.join(FRAMES_DIR, "000001.jpg"))) {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", VIDEO, "-qscale:v", "2", path.join(FRAMES_DIR, "%06d.jpg")]);
  }
  const gtByFrame = new Map();
  const xml = fs.readFileSync(GT_XML, "utf8");
  for (const fchunk of xml.split(/<frame\s+number="/).slice(1)) {
    const fnum = parseInt(fchunk, 10);
    const objs = [];
    for (const oc of fchunk.split(/<object\s+id="/).slice(1)) {
      const id = parseInt(oc, 10);
      const bm = oc.match(/<box\s+([^/>]+)\//);
      if (!bm) continue;
      const at = {};
      for (const a of bm[1].matchAll(/(\w+)="(-?[\d.]+)"/g)) at[a[1]] = Number(a[2]);
      if (["h", "w", "xc", "yc"].some((k) => !Number.isFinite(at[k]))) continue;
      objs.push({ id, box: [(at.xc - at.w / 2) / W, (at.yc - at.h / 2) / H, at.w / W, at.h / H] });
    }
    gtByFrame.set(fnum, objs);
  }
  const frameNums = [...gtByFrame.keys()].sort((a, b) => a - b); // CAVIAR: 0-indexado
  return {
    name: "CAVIAR-WalkByShop1cor", W, H, fps, frameNums, gtByFrame,
    framePath: (f) => path.join(FRAMES_DIR, String(f + 1).padStart(6, "0") + ".jpg"), // ffmpeg 1-indexado
  };
}

function makeTracker(roundMs) {
  return createByteTracker({
    highScore: HIGH_SCORE,
    iouThreshold: PRECISION.tracker.iouThreshold,
    birthIouThreshold: PRECISION.tracker.birthIouThreshold,
    ttlMs: trackTtlMs({ roundMs, gateOn: false }),
    reassocDist: PRECISION.tracker.reassocDist,
    reassocMaxGapMs: PRECISION.tracker.reassocMaxGapMs,
    lostAfterMisses: PRECISION.tracker.lostAfterMisses,
  });
}

const acc = () => ({ tp: 0, fp: 0, fn: 0 });
const prf = (a) => ({ p: a.tp + a.fp ? a.tp / (a.tp + a.fp) : 1, r: a.tp + a.fn ? a.tp / (a.tp + a.fn) : 0 });
const pct = (x) => (100 * x).toFixed(1) + "%";

async function runCadence(worker, ds, fps) {
  const step = Math.max(1, Math.round(ds.fps / fps));
  const roundMs = Math.round((1000 * step) / ds.fps);
  const tracker = makeTracker(roundMs);
  const det = acc(), trk = acc();
  const gtLastTrack = new Map();
  let idsw = 0, rounds = 0, reqId = 0, gtSeen = 0;

  for (let i = 0; i < ds.frameNums.length; i += step) {
    const f = ds.frameNums[i];
    const file = ds.framePath(f);
    if (!fs.existsSync(file)) continue;
    const resp = await worker.detect(++reqId, fs.readFileSync(file));
    const persons = (resp.dets || [])
      .filter((d) => d.class === "person" && Array.isArray(d.bbox))
      .map((d) => ({ box: d.bbox, score: d.score, bbox: d.bbox }));
    const gts = ds.gtByFrame.get(f) || [];
    const gtBoxes = gts.map((g) => g.box);
    gtSeen += gtBoxes.length;
    const now = rounds * roundMs;
    rounds++;

    const md = matchGreedy(persons, gtBoxes, IOU_MATCH);
    for (let k = 0; k < persons.length; k++) md.det[k] >= 0 ? det.tp++ : det.fp++;
    for (let g = 0; g < gtBoxes.length; g++) if (!md.gt[g]) det.fn++;

    const emitted = tracker.update(persons.map((p) => ({ score: p.score, bbox: p.bbox })), now, HIGH_SCORE);
    const trkDets = emitted.map((t) => ({ box: t.bbox, score: t.score, trackId: t.id }));
    const mt = matchGreedy(trkDets, gtBoxes, IOU_MATCH);
    for (let k = 0; k < trkDets.length; k++) {
      if (mt.det[k] >= 0) {
        trk.tp++;
        const gtId = gts[mt.det[k]].id;
        const prev = gtLastTrack.get(gtId);
        if (prev !== undefined && prev !== trkDets[k].trackId) idsw++;
        gtLastTrack.set(gtId, trkDets[k].trackId);
      } else trk.fp++;
    }
    for (let g = 0; g < gtBoxes.length; g++) if (!mt.gt[g]) trk.fn++;
  }
  const durS = (rounds * roundMs) / 1000;
  return { fps, rounds, det: prf(det), trk: prf(trk), idsw, idswPerS: durS ? idsw / durS : 0, gtSeen };
}

(async () => {
  const seqDir = process.env.MOT_SEQ;
  const ds = seqDir ? loadMOT(seqDir) : loadCAVIAR();
  const nGtTracks = new Set([...ds.gtByFrame.values()].flat().map((o) => o.id)).size;
  const nGtObj = [...ds.gtByFrame.values()].reduce((s, a) => s + a.length, 0);
  console.log(`[eval] ${ds.name} · ${ds.W}×${ds.H} @${ds.fps}fps · ${ds.frameNums.length} frames · ${nGtObj} objetos · ${nGtTracks} identidades`);

  const modelPath = resolveModelPath();
  const worker = startWorker(modelPath, { scoreMin: PRECISION.detector.scoreMin });
  const info = await worker.ready;
  console.log(`[eval] modelo ${info.model} (input ${info.input}) · cadências ${CADENCES.join("/")} fps\n`);

  const rows = [];
  for (const fps of CADENCES) {
    process.stdout.write(`  @${fps}fps… `);
    rows.push(await runCadence(worker, ds, fps));
    console.log(`ok (${rows[rows.length - 1].rounds} rodadas)`);
  }
  worker.kill();

  console.log(`\n═══ RECONHECIMENTO DE PESSOAS — ${ds.name} (GT à mão) ═══`);
  console.log("fps | detector R/P     | emitido (track) R/P | ID-sw (tot/seg) | rodadas");
  console.log("----+------------------+---------------------+-----------------+--------");
  for (const r of rows)
    console.log(
      `${String(r.fps).padStart(3)} | ${pct(r.det.r).padStart(6)}/${pct(r.det.p).padStart(6)}   | ` +
        `${pct(r.trk.r).padStart(6)}/${pct(r.trk.p).padStart(6)}      | ${String(r.idsw).padStart(5)}/${r.idswPerS.toFixed(2).padStart(5)} | ${r.rounds}`,
    );
  console.log(`\n${nGtTracks} identidades GT. detector R = teto do D-FINE; queda p/ emitido = perda do tracker; precisão<100% = FP ("inventa pessoa").`);
})();
