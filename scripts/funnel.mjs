#!/usr/bin/env node
// DIAGNÓSTICO DO FUNIL DE VETOS da fusão tag↔pessoa sobre a GRAVAÇÃO DE CAMPO (READ ONLY —
// server/bt/fusion-session.jsonl é artefato imutável, CLAUDE.md §3; este comando SÓ LÊ).
//
//   npm run funnel                          → resumo por câmera + funil de TODAS as câmeras
//   npm run funnel -- --camera cam-8a95ac6090   → funil só da câmera pedida
//   npm run funnel -- --file server/bt/fusion-session-2026-07-10_17.jsonl
//
// POR QUE delega ao vitest (mesma decisão do scripts/family.mjs): o motor do diagnóstico é
// TypeScript (session-loader.diagnoseFusionSession + associate.diagnoseFunnel) e o repo não tem
// transpiler standalone — o runner de TS da casa é o vitest. Este script o spawna DIRETO pelo
// entry de node_modules (node + vitest.mjs — sem npx/.cmd, que no Windows têm quirks), injeta
// FUNNEL_FILE/FUNNEL_CAMERA via env e extrai o bloco FUNNEL-REPORT-BEGIN/END que o teste gated
// (src/fusion/funnel-session.test.ts) imprime. Sem FUNNEL_FILE o teste é SKIP — o CI nunca o roda
// (o arquivo real é runtime/gitignored). Zero lógica de diagnóstico duplicada aqui.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ——— args: [--camera <id>] [--file <path>] ———
const argv = process.argv.slice(2);
let camera;
let file = path.join(root, "server", "bt", "fusion-session.jsonl");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--camera" && argv[i + 1]) camera = argv[++i];
  else if (argv[i] === "--file" && argv[i + 1]) file = path.resolve(root, argv[++i]);
  else {
    console.error("uso: node scripts/funnel.mjs [--camera <id>] [--file <caminho do jsonl>]");
    process.exit(1);
  }
}
if (!existsSync(file)) {
  console.error(`gravação não encontrada: ${file}\n(o arquivo é runtime — só existe onde o hub gravou com FUSION_RECORD)`);
  process.exit(1);
}

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestEntry)) {
  console.error(`vitest não encontrado em ${vitestEntry} — rode \`npm install\` antes.`);
  process.exit(1);
}

console.log(`funil de vetos sobre ${file}${camera ? ` (câmera ${camera})` : " (todas as câmeras)"}…`);
const res = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/fusion/funnel-session.test.ts", "--reporter=verbose"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FUNNEL_FILE: file,
      ...(camera ? { FUNNEL_CAMERA: camera } : {}),
      NO_COLOR: "1",
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  },
);

const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const lines = out.split(/\r?\n/);
const begin = lines.findIndex((l) => l.includes("FUNNEL-REPORT-BEGIN"));
const end = lines.findIndex((l) => l.includes("FUNNEL-REPORT-END"));
if (res.status === 0 && begin >= 0 && end > begin) {
  console.log(lines.slice(begin + 1, end).join("\n"));
  process.exit(0);
}

// Falhou (ou o bloco não apareceu): mostra a saída inteira — diagnóstico honesto > saída bonita.
console.error(out);
console.error(
  res.status === 0
    ? "bloco FUNNEL-REPORT não encontrado na saída — o contrato com funnel-session.test.ts quebrou?"
    : `vitest saiu com código ${res.status ?? "null"} — veja a saída acima.`,
);
process.exit(res.status || 1);
