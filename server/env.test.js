// Sensor do carregador de .env (server/env.js): o parser é PURO e a PRECEDÊNCIA é o invariante
// que não pode soltar — ambiente real (terminal/systemd/CI) NUNCA é sobrescrito pelo arquivo.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseEnv, load } = require("./env");

describe("parseEnv — subconjunto POSIX, tolerante a linha torta", () => {
  it("KEY=valor básico + linhas vazias + comentários", () => {
    expect(parseEnv("A=1\n\n# comentário\nB=dois\n")).toEqual({ A: "1", B: "dois" });
  });

  it("aspas caem e protegem espaços e '#' (dentro de aspas não é comentário)", () => {
    const p = parseEnv(`A="com espaço" \nB='literal # não-comentário'\nC=solto # comentário inline`);
    expect(p).toEqual({ A: "com espaço", B: "literal # não-comentário", C: "solto" });
  });

  it("prefixo `export`, chave inválida e linha sem `=` são tratados sem explodir", () => {
    const p = parseEnv("export A=1\n=semchave\nlinha-torta\n2B=começa-com-dígito\n");
    expect(p).toEqual({ A: "1" });
  });

  it("valor vazio é permitido (KEY= limpa/define vazio de propósito)", () => {
    expect(parseEnv("A=\n")).toEqual({ A: "" });
  });
});

describe("load — precedência e arquivo ausente", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  afterEach(() => {
    delete process.env.ENVTEST_NOVA;
    delete process.env.ENVTEST_JA_SETADA;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("aplica var nova; NUNCA sobrescreve o ambiente real (o invariante)", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "ENVTEST_NOVA=do-arquivo\nENVTEST_JA_SETADA=do-arquivo\n");
    process.env.ENVTEST_JA_SETADA = "do-terminal";
    const r = load(file);
    expect(r).toMatchObject({ loaded: true, applied: 1, skipped: 1 });
    expect(process.env.ENVTEST_NOVA).toBe("do-arquivo");
    expect(process.env.ENVTEST_JA_SETADA).toBe("do-terminal"); // terminal/systemd manda
  });

  it("arquivo ausente = no-op silencioso (o .env é opcional por contrato)", () => {
    const r = load(join(dir, "nao-existe.env"));
    expect(r.loaded).toBe(false);
    expect(r.applied).toBe(0);
  });
});
