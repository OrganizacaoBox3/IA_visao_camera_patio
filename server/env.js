// ─────────────────────────────────────────────────────────────────────────────
// env.js — carregador de `.env` do hub, SEM dependência (a casa prova que o
// nativo basta — CLAUDE.md §4). Lê `<raiz>/.env` (o MESMO arquivo que o Vite já
// lê p/ as VITE_*) e aplica no process.env ANTES dos módulos que leem env na
// carga (precision.js, rtsp.js, motion.js…) — por isso o require dele é a
// PRIMEIRA linha do index.js.
//
// PRECEDÊNCIA (invariante): variável JÁ setada no ambiente real (terminal,
// systemd EnvironmentFile, CI) NUNCA é sobrescrita pelo arquivo — o .env é o
// piso de conveniência do dev/ops local, não a autoridade. Workers forkados
// (D-FINE/fadiga) herdam o env do hub já resolvido — nada muda p/ eles.
//
// SEGURANÇA: o log NUNCA imprime chave/valor (o .env carrega AUTH_SECRET/PG*);
// só contagens. O arquivo é gitignored (invariante de segredos); o mapa
// documentado vive em `.env.example` (versionado, sem valores reais).
//
// Formato aceito (subconjunto POSIX, deliberadamente simples):
//   KEY=valor · KEY="com espaços" · KEY='literal' · export KEY=v ·
//   linhas vazias e `# comentário` (inclusive inline, fora de aspas).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Parser PURO (testável): texto do .env → { KEY: valor }. Linha inválida é ignorada em silêncio
 *  (arquivo de conveniência — não pode derrubar o hub por causa de uma linha torta). */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const quoted =
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")));
    if (quoted) {
      val = val.slice(1, -1); // aspas caem; o conteúdo é literal (# dentro delas NÃO é comentário)
    } else {
      const hash = val.indexOf("#");
      if (hash >= 0) val = val.slice(0, hash).trim(); // comentário inline fora de aspas
    }
    out[key] = val;
  }
  return out;
}

/**
 * Carrega o .env (default: raiz do repo — server/../.env, independente do cwd) no process.env,
 * SEM sobrescrever o que já veio do ambiente real. Arquivo ausente = no-op silencioso (o .env é
 * opcional por contrato). Devolve { loaded, applied, skipped, file } p/ log/teste.
 */
function load(file = path.join(__dirname, "..", ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { loaded: false, applied: 0, skipped: 0, file };
  }
  const vars = parseEnv(text);
  let applied = 0;
  let skipped = 0;
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied += 1;
    } else {
      skipped += 1; // ambiente real manda (terminal/systemd/CI) — precedência do cabeçalho
    }
  }
  // Só contagens — NUNCA chaves/valores (segredos).
  console.log(
    `[env] ${path.basename(file)} carregado: ${applied} var(s) aplicada(s)` +
      (skipped ? `, ${skipped} já vinha(m) do ambiente (precedência mantida)` : ""),
  );
  return { loaded: true, applied, skipped, file };
}

module.exports = { load, parseEnv };
