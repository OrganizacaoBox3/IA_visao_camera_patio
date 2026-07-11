#!/usr/bin/env node
// Comando ponta-a-ponta da bancada (aceite §9.3 de docs/cientifica/simulador.md: "uma família
// ponta-a-ponta sai por um comando"): roda UMA família paramétrica COMPLETA por nome e imprime a
// curva como tabela texto (pontos do eixo, média, IC 95% bootstrap, decomposição de erro).
//
//   npm run family -- precisao-vs-pessoas        (ou: node scripts/family.mjs precisao-vs-pessoas)
//
// DECISÃO (por que o CLI delega ao vitest em vez de importar families.ts):
// families.ts é TypeScript e o repo NÃO tem tsx/ts-node — e não vai ganhar um transpiler só pra
// isto (sem dependência supérflua, CLAUDE.md §4). O runner de TS que o repo JÁ tem é o vitest;
// este script o spawna DIRETO pelo entry de node_modules (node + vitest.mjs — nada de `npx`/.cmd/
// shell, que no Windows têm quirks de quoting e resolução), com FAMILY_FULL=1 injetado via env do
// child_process (cross-platform, sem cross-env) e `-t` filtrando o teste "curva completa
// <família>" (contrato de nome com families.test.ts). A curva impressa é EXATAMENTE a que o teste
// loga (fmtCurve) — mesmo motor (runFamily → replayFusion → sim), mesma agregação, zero lógica de
// simulação duplicada aqui (o script só orquestra e filtra saída).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// nome da família (CLI) → prefixo do teste de curva completa em families.test.ts (contrato).
const FAMILIES = [
  "precisao-vs-pessoas",
  "precisao-vs-ruido",
  "precisao-vs-vies-corporal",
  "precisao-vs-erro-ancora",
];

const name = process.argv[2];
if (!name || !FAMILIES.includes(name)) {
  console.error(
    `uso: node scripts/family.mjs <familia>\n` +
      `famílias disponíveis:\n${FAMILIES.map((f) => `  - ${f}`).join("\n")}`,
  );
  process.exit(name ? 1 : 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestEntry)) {
  console.error(`vitest não encontrado em ${vitestEntry} — rode \`npm install\` antes.`);
  process.exit(1);
}

console.log(`família ${name} — curva completa (§7.1: eixo cheio, 20 seeds/ponto)…`);
const res = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "src/fusion/families.test.ts",
    // verbose: o reporter default do vitest 4 ESCONDE o stdout de teste que passou — e a curva
    // logada (fmtCurve) é exatamente o que este comando existe pra mostrar.
    "--reporter=verbose",
    // -t é REGEX (parênteses do sufixo "(FAMILY_FULL=1)" não podem entrar crus); o prefixo
    // "curva completa <nome>" já é único por contrato de nome com families.test.ts.
    "-t",
    `curva completa ${name} `,
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FAMILY_FULL: "1", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  },
);

const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;

// Extrai o bloco da curva que o teste logou (fmtCurve): a linha "<nome> (N seeds/ponto):" e as
// linhas de ponto indentadas que a seguem — a "tabela texto" do aceite.
const lines = out.split(/\r?\n/);
const start = lines.findIndex((l) => l.trim().startsWith(`${name} (`) && l.includes("seeds/ponto"));
if (res.status === 0 && start >= 0) {
  const block = [lines[start].trim()];
  for (let i = start + 1; i < lines.length && /^\s{2,}\S/.test(lines[i]); i++)
    block.push(lines[i].trimEnd());
  console.log(`\n${block.join("\n")}\n`);
  console.log("legenda: precisão média [IC 95% bootstrap] | decomposição: wrong (pessoa↔pessoa),");
  console.log("falseLabels (rótulo em quem não tem tag), idSwitches (instabilidade temporal).");
  process.exit(0);
}

// Falhou (ou a curva não apareceu — contrato de nome quebrado?): mostra a saída inteira do vitest,
// sem esconder nada — diagnóstico honesto > saída bonita.
console.error(out);
console.error(
  res.status === 0
    ? `curva de "${name}" não encontrada na saída — o contrato de nome com families.test.ts quebrou?`
    : `vitest saiu com código ${res.status ?? "null"} — veja a saída acima.`,
);
process.exit(res.status || 1);
