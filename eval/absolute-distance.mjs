#!/usr/bin/env node
// TORNEIO DA DISTÂNCIA ABSOLUTA sobre a GRAVAÇÃO DE CAMPO (READ-ONLY — server/bt/*.jsonl é
// artefato imutável, CLAUDE.md §3; este comando SÓ LÊ).
//
//   node eval/absolute-distance.mjs                          → toda a gravação da cam padrão
//   node eval/absolute-distance.mjs --camera cam-6da58c2c5e
//   node eval/absolute-distance.mjs --file server/bt/fusion-session-2026-07-11_21.jsonl
//
// A PERGUNTA (H3, laudo 2026-07-13): o associador correlaciona RSSI × distância; pessoa PARADA ⇒
// distância constante ⇒ correlação INDEFINIDA — e a pessoa parada é 41,9% do corpus (o caso
// DOMINANTE do produto). A distância ABSOLUTA (path-loss calibrado pelas âncoras) não precisa de
// movimento: é a única evidência que enxerga quem fica na mesa. Ela FUNCIONA em campo? Este é o
// torneio, com RÉGUA PINADA A PRIORI (ver o cabeçalho do teste — achado NEGATIVO conta igual).
//
// POR QUE delega ao vitest (mesma decisão de scripts/funnel.mjs e scripts/family.mjs): o motor é
// TypeScript (src/fusion/distance.ts + floor-plot.ts + associate.ts) e o repo não tem transpiler
// standalone — o runner de TS da casa é o vitest. Zero lógica de medição duplicada aqui: este
// script só escolhe os arquivos, injeta env e extrai o bloco DIST-REPORT-BEGIN/END.
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
    console.error("uso: node eval/absolute-distance.mjs [--camera <id>] [--file <jsonl>]…");
    process.exit(1);
  }
}

// Sem --file: TODOS os segmentos de sessão (menos os .bak — são cópias de segurança do mesmo dado;
// contá-las duas vezes inflaria n e violaria a Regra 8 na raiz).
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

console.log(`torneio da distância absoluta · câmera ${camera} · ${files.length} segmento(s)…`);
const res = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/fusion/distance-field.test.ts", "--reporter=verbose"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DIST_FIELD_FILES: files.join(","),
      DIST_FIELD_CAMERA: camera,
      NO_COLOR: "1",
    },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  },
);

const all = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const m = all.match(/DIST-REPORT-BEGIN\n([\s\S]*?)\nDIST-REPORT-END/);
if (!m) {
  console.error(all);
  console.error("\n(relatório não saiu — veja a falha do vitest acima)");
  process.exit(res.status ?? 1);
}
console.log(m[1]);
process.exit(res.status ?? 0);
