#!/usr/bin/env node
// A refTag COMO 5º PONTO DO fitPathLoss — MEDIÇÃO sobre a GRAVAÇÃO DE CAMPO (READ-ONLY —
// server/bt/*.jsonl é artefato imutável, CLAUDE.md §3; este comando SÓ LÊ).
//
//   node eval/reftag-anchor.mjs                          → toda a gravação da cam padrão
//   node eval/reftag-anchor.mjs --camera cam-6da58c2c5e
//   node eval/reftag-anchor.mjs --file server/bt/fusion-session-2026-07-11_21.jsonl
//
// A PERGUNTA (task #67): dar `world` (metros) à refTag e ligá-la ao fitPathLoss como 5º ponto
// MELHORA a identificabilidade do expoente (span de log10(d) cruza 0.4) / o resíduo LOO? Ou é
// insuficiente do mesmo jeito — o problema é a GEOMETRIA das âncoras, não a CONTAGEM? Régua pinada
// a priori no cabeçalho de src/fusion/reftag-anchor.test.ts (achado NEGATIVO conta igual).
//
// Delega ao vitest (o motor é TypeScript; o runner de TS da casa é o vitest) — mesma decisão do
// eval/absolute-distance.mjs. Zero lógica de medição aqui: só escolhe arquivos, injeta env, extrai
// o bloco REFTAG-REPORT-BEGIN/END.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
let camera = "cam-8a95ac6090"; // a câmera com 4 âncoras CADASTRADAS (camcfg) e H — a única com verdade
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--camera" && argv[i + 1]) camera = argv[++i];
  else if (argv[i] === "--file" && argv[i + 1]) files.push(path.resolve(root, argv[++i]));
  else {
    console.error("uso: node eval/reftag-anchor.mjs [--camera <id>] [--file <jsonl>]…");
    process.exit(1);
  }
}

// Sem --file: TODOS os segmentos de sessão (menos os .bak — cópias do mesmo dado; contá-las
// duas vezes inflaria n e violaria a Regra 8 na raiz).
if (files.length === 0) {
  const dir = path.join(root, "server", "bt");
  if (!existsSync(dir)) {
    console.error(`sem gravação em ${dir} — o arquivo é runtime (só existe onde o hub gravou).`);
    process.exit(1);
  }
  for (const f of readdirSync(dir).sort())
    if (/^fusion-session.*\.jsonl$/.test(f) && !f.includes(".bak")) files.push(path.join(dir, f));
}
const missing = files.filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`não encontrado: ${missing.join(", ")}`);
  process.exit(1);
}

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestEntry)) {
  console.error(`vitest não encontrado em ${vitestEntry} — rode \`npm install\` antes.`);
  process.exit(1);
}

console.log(`refTag como 5º ponto · câmera ${camera} · ${files.length} segmento(s)…`);
const res = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/fusion/reftag-anchor.test.ts", "--reporter=verbose"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      REFTAG_FILES: files.join(","),
      REFTAG_CAMERA: camera,
      NO_COLOR: "1",
    },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  },
);

const all = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const m = all.match(/REFTAG-REPORT-BEGIN\n([\s\S]*?)\nREFTAG-REPORT-END/);
if (!m) {
  console.error(all);
  console.error("\n(relatório não saiu — veja a falha do vitest acima)");
  process.exit(res.status ?? 1);
}
console.log(m[1]);
process.exit(res.status ?? 0);
