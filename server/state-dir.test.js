// GATE do redirecionamento de ESTADO (state-dir.js). Três invariantes, e a terceira é a razão
// de o módulo existir:
//   1. sem VISAO_STATE_DIR, o comportamento é o de HOJE (estado em server/) — o deploy systemd
//      não pode mudar de lugar por causa de uma feature de container;
//   2. com VISAO_STATE_DIR, TODO o estado vai para lá (e o diretório é criado se faltar);
//   3. o alvo e o seu .tmp caem no MESMO diretório — é isso que preserva a atomicidade do
//      tmp+rename de pgstore.js/alarm/persist.js. Um symlink por ARQUIVO quebraria justamente
//      isso (rename(2) não segue symlink: substitui o link por arquivo real no disco efêmero),
//      e o estado voltaria a morrer calado no redeploy. Falso-OK é pior que erro.
// O módulo lê o env no LOAD e pode lançar, então cada caso roda em processo próprio: mockar
// env com módulo já carregado testaria outra coisa.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

// Roda um snippet num node filho com o env dado. Devolve {ok, out, err}.
function run(code, env) {
  try {
    const out = execFileSync(process.execPath, ["-e", code], {
      env: { ...process.env, ...env },
      cwd: SERVER_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || "") };
  }
}

const LOAD = 'const s = require("./state-dir.js");';

describe("state-dir: onde o estado de runtime vive", () => {
  it("sem VISAO_STATE_DIR, o estado fica em server/ (idêntico ao deploy de hoje)", () => {
    const r = run(`${LOAD} console.log(JSON.stringify([s.stateDir === s.DEFAULT_STATE_DIR, s.statePath("cameras.json")]));`, {
      VISAO_STATE_DIR: "",
    });
    expect(r.ok, r.err).toBe(true);
    const [isDefault, camerasPath] = JSON.parse(r.out);
    expect(isDefault).toBe(true);
    expect(camerasPath).toBe(path.join(SERVER_DIR, "cameras.json"));
  });

  it("com VISAO_STATE_DIR, TODO o estado (arquivo e diretório) vai para lá", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "visao-state-"));
    const r = run(
      `${LOAD} console.log(JSON.stringify([s.statePath("cameras.json"), s.statePath("wa-auth"), s.statePath("models", "dfine.onnx")]));`,
      { VISAO_STATE_DIR: dir },
    );
    expect(r.ok, r.err).toBe(true);
    const [cams, wa, model] = JSON.parse(r.out);
    expect(cams).toBe(path.join(dir, "cameras.json"));
    expect(wa).toBe(path.join(dir, "wa-auth"));
    expect(model).toBe(path.join(dir, "models", "dfine.onnx"));
  });

  it("cria o diretório de estado se ele ainda não existir (1º boot com volume vazio)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "visao-state-"));
    const dir = path.join(base, "nao", "existe", "ainda");
    const r = run(`${LOAD} console.log(s.stateDir);`, { VISAO_STATE_DIR: dir });
    expect(r.ok, r.err).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("o alvo e o .tmp ficam no MESMO diretório — atomicidade do tmp+rename preservada", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "visao-state-"));
    const r = run(
      `${LOAD} const p = s.statePath("data-hist.json");
       const path = require("node:path");
       console.log(JSON.stringify([path.dirname(p), path.dirname(p + ".tmp")]));`,
      { VISAO_STATE_DIR: dir },
    );
    expect(r.ok, r.err).toBe(true);
    const [alvo, tmp] = JSON.parse(r.out);
    expect(alvo).toBe(tmp);
    expect(alvo).toBe(dir);
  });

  // Root ignora bits de permissão: o caso não é observável rodando como root.
  const semPermissao = typeof process.getuid === "function" && process.getuid() === 0 ? it.skip : it;
  semPermissao("diretório de estado não-gravável DERRUBA o boot, em voz alta", () => {
    const base = mkdtempSync(path.join(tmpdir(), "visao-state-"));
    const dir = path.join(base, "somente-leitura");
    mkdirSync(dir);
    chmodSync(dir, 0o500); // r-x: existe, não aceita escrita
    const r = run(`${LOAD} console.log("NAO DEVERIA CHEGAR AQUI");`, { VISAO_STATE_DIR: dir });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/VISAO_STATE_DIR/);
    expect(r.err).toMatch(/volume/i); // a mensagem tem de dizer O QUE conferir
  });
});
