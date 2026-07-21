// Uso: node scripts/fetch-mediapipe.mjs   (roda sozinho via predev/prebuild — pula se já existe)
//
// SELF-HOST dos assets do modo FADIGA (MediaPipe Tasks Vision) em public/mediapipe/ — mesmo
// padrão de packaging do fetch-go2rtc.mjs (rodar no build/CI, nunca em runtime):
//  · WASM/JS do runtime: COPIADOS de node_modules/@mediapipe/tasks-vision/wasm (a versão é a do
//    package-lock — elimina o CDN @latest, que podia dessincronizar do JS empacotado pelo Vite);
//  · modelos .task: BAIXADOS 1× do Google Storage com sha256 PINADO (recalcular ao bumpar).
// Motivação (2026-07-21): fadiga dependia 100% de jsdelivr+Google em runtime — rede corporativa
// bloqueando CDN = sensor morto; agora tudo sai da própria origem (CSP 'self' já cobre).
// public/mediapipe/ é gitignored; o Vite copia public/ → dist/ no build.

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WASM_SRC = join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_OUT = join(ROOT, "public", "mediapipe", "wasm");
const MODELS_OUT = join(ROOT, "public", "mediapipe", "models");

// sha256 dos .task (float16/1, publicados pelo Google — estáveis por URL versionada).
const MODELS = [
  {
    out: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
  },
  {
    out: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
  },
];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// 1) WASM: cópia direta do node_modules (sem rede; proveniência = npm + lockfile).
mkdirSync(WASM_OUT, { recursive: true });
let copied = 0;
for (const f of readdirSync(WASM_SRC)) {
  const dst = join(WASM_OUT, f);
  if (!existsSync(dst)) {
    copyFileSync(join(WASM_SRC, f), dst);
    copied++;
  }
}
console.log(`[fetch-mediapipe] wasm: ${copied ? `${copied} arquivo(s) copiado(s)` : "já presentes"} → public/mediapipe/wasm`);

// 2) Modelos .task: download com verificação sha256 e escrita atômica; pula se o hash já confere.
mkdirSync(MODELS_OUT, { recursive: true });
for (const m of MODELS) {
  const dst = join(MODELS_OUT, m.out);
  if (existsSync(dst) && sha256(readFileSync(dst)) === m.sha256) {
    console.log(`[fetch-mediapipe] ${m.out}: já presente (sha256 ok)`);
    continue;
  }
  console.log(`[fetch-mediapipe] baixando ${m.out} …`);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.out}: HTTP ${res.status} de ${m.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== m.sha256) throw new Error(`${m.out}: sha256 divergente (esperado ${m.sha256}, veio ${got})`);
  writeFileSync(`${dst}.part`, buf);
  renameSync(`${dst}.part`, dst);
  console.log(`[fetch-mediapipe] ${m.out}: ok (${buf.length} bytes, sha256 verificado)`);
}
console.log("[fetch-mediapipe] concluído. NÃO versionar public/mediapipe/ no git.");
