#!/usr/bin/env node
// LINT DE TOKENS (ratchet) — enforcement da constituição visual (spec-padronizacao-interface.md §1
// "gate novo no CI"; doutrina 02-doutrina-casa.md regras 2 e 5): em página (src/routes/** e
// src/components/**) são PROIBIDOS `text-[Npx]` (tipografia fora dos 7 papéis) e cor `#hex` crua
// (fora dos tokens `--state-*`/`--cam-*` do index.css). `src/ui/**` fica FORA do escopo de
// propósito: os átomos são a implementação dos tokens (lá o px é tolerado — regra 6).
//
// MECÂNICA DO RATCHET: a BASELINE abaixo congela as ocorrências ATUAIS (dívida F1/F2 catalogada —
// só pode DIMINUIR). O script conta ocorrências por arquivo e FALHA se algum arquivo passar da
// baseline (ou se um arquivo novo estrear com violação). Quando uma tela é limpa na F1/F2,
// atualiza-se a baseline PARA BAIXO no mesmo PR (o script avisa quando há folga). Mesmo padrão do
// gate estacionário do eval: nasce verde hoje e aperta conforme as frentes fecham.
//
//   node scripts/lint-tokens.mjs             → varre o repo (uso normal + CI)
//   node scripts/lint-tokens.mjs --root <d>  → varre outra raiz (só p/ testar o próprio lint)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ——— args: [--root <dir>] (raiz alternativa, usada apenas no autoteste do lint) ———
const argv = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
  else {
    console.error("uso: node scripts/lint-tokens.mjs [--root <dir>]");
    process.exit(1);
  }
}

// Os dois padrões proibidos em página. `text-[` pega text-[Npx] E text-[color:...] (ambos são
// fuga dos papéis/tokens); o hex exige 3–8 dígitos hexadecimais completos (não casa "#app").
const PATTERNS = [
  { name: "text-[", re: /text-\[/g },
  { name: "#hex", re: /#[0-9a-fA-F]{3,8}\b/g },
];

// BASELINE — dívida F1/F2 catalogada na spec (§0: 33+ text-[Npx], as telas novas lideram; §2 e
// G8). Formato: caminho posix relativo → { "text-[": n, "#hex": n }. SÓ PODE DIMINUIR.
// Snapshot de 2026-07-12 (contado por este próprio script).
const BASELINE = {
  // Telas novas em fluxo (F2 da spec — limpam depois das frentes de produto pousarem)
  "src/routes/BtTagsPage.tsx": { "text-[": 6 },
  "src/routes/TurnosPage.tsx": { "text-[": 4 },
  "src/routes/TagsMapPage.tsx": { "text-[": 4 },
  "src/routes/ReplayPlayerPage.tsx": { "text-[": 11, "#hex": 13 }, // hex em canvas 2D (G8: migrar p/ tokens via getComputedStyle)
  // Telas da varredura F1 (Dashboard/NotFound zeradas na C1; ReportPage/AlarmesPanel/
  // AtividadePanel zeradas na C2 — ratchet apertado: text-[11px] → papel text-label)
  "src/routes/AlarmHealthPage.tsx": { "text-[": 3 },
  // Fallback literal do cssVar() p/ canvas (exceção documentada G8 — contraste de canvas);
  // entra na baseline mesmo assim: se a exceção crescer, a revisão precisa ver.
  "src/routes/dashboard/TrackOverlay.tsx": { "#hex": 2 },
};

// ——— varredura: src/routes/**/*.tsx + src/components/**/*.tsx ———
const SCOPES = ["src/routes", "src/components"];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".tsx")) yield full;
  }
}

function countMatches(text, re) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

const found = new Map(); // caminho posix → { "text-[": n, "#hex": n }
for (const scope of SCOPES) {
  const dir = path.join(root, scope);
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    const counts = {};
    for (const p of PATTERNS) {
      const n = countMatches(text, p.re);
      if (n > 0) counts[p.name] = n;
    }
    if (Object.keys(counts).length > 0)
      found.set(path.relative(root, file).split(path.sep).join("/"), counts);
  }
}

// ——— ratchet: compara found × BASELINE ———
const errors = [];
const slack = [];
const allFiles = new Set([...found.keys(), ...Object.keys(BASELINE)]);
for (const file of [...allFiles].sort()) {
  const base = BASELINE[file] ?? {};
  const cur = found.get(file) ?? {};
  for (const p of PATTERNS) {
    const b = base[p.name] ?? 0;
    const c = cur[p.name] ?? 0;
    if (c > b)
      errors.push(
        `${file}: ${p.name} subiu de ${b} → ${c} (proibido em página — use os papéis text-*/tokens --state-*; doutrina regras 2 e 5)`,
      );
    else if (c < b) slack.push(`${file}: ${p.name} caiu de ${b} → ${c}`);
  }
}

if (slack.length > 0) {
  console.log("[lint-tokens] dívida DIMINUIU (bom!) — aperte a BASELINE no mesmo PR:");
  for (const s of slack) console.log(`  ${s}`);
}
if (errors.length > 0) {
  console.error("[lint-tokens] FALHOU — violação de token acima da baseline:");
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    "[lint-tokens] a baseline é um ratchet: só diminui. Corrija usando os papéis tipográficos " +
      "(text-micro/label/sec/body/title/hero/kpi) e tokens de cor (--state-*/--cam-*).",
  );
  process.exit(1);
}
const total = [...found.values()].reduce(
  (acc, c) => acc + Object.values(c).reduce((a, n) => a + n, 0),
  0,
);
console.log(
  `[lint-tokens] OK — ${found.size} arquivo(s) com dívida catalogada (${total} ocorrência(s), dentro da baseline).`,
);
