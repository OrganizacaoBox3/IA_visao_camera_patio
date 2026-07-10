#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/make-jumpy-clip.mjs — BANCADA VISUAL do fix-rastro (docs/analises/
// fix-rastro-tracking.md): gera, a partir de um clipe de CFTV, um clipe com
// SALTOS DE STREAM determinísticos — remove `--cut` s de conteúdo a cada
// `--window` s, no offset sorteado por PRNG com SEED FIXA (mesmo seed = mesmos
// cortes, sempre). Reproduz no painel o bug do stream que engasga/salta (mesma
// pessoa vira vários ids + rastro de máscaras coasting) e valida o fix a olho.
//
// Os frames mantidos são re-estampados contíguos (setpts): o clipe toca fluido
// e o CONTEÚDO teleporta a cada ~3s — exatamente o perfil do salto de campo.
//
// Uso:  node scripts/make-jumpy-clip.mjs [--in C:\Users\crist\bench-visao\clipe.mp4]
//         [--out <dir do in>\clipe-jumpy.mp4] [--seed 42] [--window 4] [--cut 1]
// Requer ffmpeg/ffprobe no PATH. Ao final VALIDA o resultado com ffprobe
// (codec/duração esperada/frames) — exit 0 só com clipe válido.
//
// Publicação na bancada (MediaMTX na porta 8556 — convenção de
// docs/analises/plano-teste-camera-real.md, a 8554 é do go2rtc). No mediamtx-bench.yml:
//   paths:
//     bench-jumpy:
//       runOnInit: ffmpeg -re -stream_loop -1 -i C:\Users\crist\bench-visao\clipe-jumpy.mp4 -c copy -f rtsp rtsp://localhost:8556/bench-jumpy
//       runOnInitRestart: yes
// → cadastrar rtsp://127.0.0.1:8556/bench-jumpy em /cameras e observar o overlay.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const IN = arg("in", "C:\\Users\\crist\\bench-visao\\clipe.mp4");
const OUT = arg("out", path.join(path.dirname(IN), "clipe-jumpy.mp4"));
const SEED = Number(arg("seed", 42));
const WINDOW = Number(arg("window", 4)); // s por janela
const CUT = Number(arg("cut", 1)); // s removidos por janela (o "salto")

function die(msg) {
  console.error(`[make-jumpy-clip] ERRO: ${msg}`);
  process.exit(1);
}
if (!fs.existsSync(IN)) die(`clipe de entrada não existe: ${IN}`);
if (!(WINDOW > 0) || !(CUT > 0) || CUT >= WINDOW)
  die(`parâmetros inválidos: exige 0 < cut < window (window=${WINDOW}, cut=${CUT})`);

// ── PRNG determinístico (mulberry32) — mesmo seed → mesmos cortes ────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── ffprobe helper ───────────────────────────────────────────────────────────
function probe(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8" },
  );
  if (r.error) die(`ffprobe indisponível (${r.error.message}) — instale o ffmpeg no PATH`);
  if (r.status !== 0) die(`ffprobe falhou em ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ── plano de cortes (determinístico dado o seed) ─────────────────────────────
const src = probe(IN);
const srcVideo = src.streams.find((s) => s.codec_type === "video");
if (!srcVideo) die(`sem stream de vídeo em ${IN}`);
const duration = Number(src.format.duration);
const rnd = mulberry32(SEED);
const cuts = [];
for (let w = 0; (w + 1) * WINDOW <= duration; w++) {
  const off = rnd() * (WINDOW - CUT); // offset do corte dentro da janela
  const a = w * WINDOW + off;
  cuts.push([Math.round(a * 1000) / 1000, Math.round((a + CUT) * 1000) / 1000]);
}
if (!cuts.length) die(`clipe curto demais (${duration}s) para janela de ${WINDOW}s`);
const removed = cuts.length * CUT;
const expectedDur = duration - removed;

console.log(`[make-jumpy-clip] in : ${IN} (${duration.toFixed(1)}s, ${srcVideo.width}x${srcVideo.height} @${srcVideo.avg_frame_rate})`);
console.log(`[make-jumpy-clip] plano: seed ${SEED} · remove ${CUT}s a cada ${WINDOW}s → ${cuts.length} saltos, -${removed.toFixed(1)}s (esperado ~${expectedDur.toFixed(1)}s)`);
console.log(`[make-jumpy-clip] cortes: ${cuts.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(" ")}`);

// ── ffmpeg: descarta os trechos cortados e re-estampa contíguo ───────────────
// select='not(between(t,a,b)+...)' mantém só os frames fora dos cortes;
// setpts=N/FRAME_RATE/TB re-estampa → reprodução fluida com o conteúdo saltando.
const expr = `not(${cuts.map(([a, b]) => `between(t,${a},${b})`).join("+")})`;
const vf = `select='${expr}',setpts=N/FRAME_RATE/TB`;
const enc = spawnSync(
  "ffmpeg",
  ["-hide_banner", "-loglevel", "error", "-y", "-i", IN, "-vf", vf, "-an",
   "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
   "-movflags", "+faststart", OUT],
  { encoding: "utf8" },
);
if (enc.error) die(`ffmpeg indisponível (${enc.error.message})`);
if (enc.status !== 0) die(`ffmpeg falhou: ${enc.stderr}`);

// ── validação (ffprobe no resultado) — sem evidência não há "pronto" ─────────
const out = probe(OUT);
const outVideo = out.streams.find((s) => s.codec_type === "video");
const outDur = Number(out.format.duration);
const frames = Number(outVideo?.nb_frames ?? 0);
const problems = [];
if (!outVideo || outVideo.codec_name !== "h264") problems.push(`codec ${outVideo?.codec_name} ≠ h264`);
if (!(frames > 0)) problems.push("0 frames");
if (Math.abs(outDur - expectedDur) > 1.5)
  problems.push(`duração ${outDur.toFixed(1)}s fora do esperado ~${expectedDur.toFixed(1)}s (±1.5s)`);
if (problems.length) die(`clipe gerado NÃO validou: ${problems.join("; ")}`);

console.log(`[make-jumpy-clip] out: ${OUT}`);
console.log(`[make-jumpy-clip] VALIDADO — ${outDur.toFixed(1)}s (esperado ~${expectedDur.toFixed(1)}s), ${frames} frames, ${outVideo.codec_name} ${outVideo.width}x${outVideo.height}`);
console.log(`
Publicar na bancada (MediaMTX na 8556 — docs/analises/plano-teste-camera-real.md):
  paths:
    bench-jumpy:
      runOnInit: ffmpeg -re -stream_loop -1 -i ${OUT} -c copy -f rtsp rtsp://localhost:8556/bench-jumpy
      runOnInitRestart: yes
Cadastrar em /cameras: rtsp://127.0.0.1:8556/bench-jumpy`);
