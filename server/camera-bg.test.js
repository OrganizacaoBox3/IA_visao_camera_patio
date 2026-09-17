// IMAGEM DE REFERÊNCIA (ADR-021) — a validação é a superfície de ataque deste módulo.
//
// Ela recebe três coisas que vêm de fora e não merecem confiança: o `cameraId` (da URL), o
// `content-type` (declarado por quem envia) e os BYTES. Cada um tem um jeito próprio de
// estragar, e há um bloco de teste para cada:
//   1. cameraId vira NOME DE ARQUIVO — "../../users" escreveria fora do diretório de estado;
//   2. content-type MENTE — um executável renomeado passaria pelo tipo e ficaria servido pelo
//      nosso domínio; por isso os primeiros bytes são conferidos contra a assinatura real;
//   3. tamanho — sem teto, um POST enche a memória do hub.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validar, MAX_BYTES, tipoDe, TIPOS } = require("./camera-bg");

// Cabeçalhos REAIS de cada formato (é o que a assinatura confere).
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(32),
]);

describe("validar — o caminho feliz", () => {
  it("aceita JPEG, PNG e WebP e devolve a extensão", () => {
    expect(validar("cam-1", "image/jpeg", JPG)).toEqual({ ok: true, ext: "jpg" });
    expect(validar("cam-1", "image/png", PNG)).toEqual({ ok: true, ext: "png" });
    expect(validar("cam-1", "image/webp", WEBP)).toEqual({ ok: true, ext: "webp" });
  });

  it("tolera o charset no content-type (o navegador manda) e maiúsculas", () => {
    expect(validar("cam-1", "IMAGE/JPEG; charset=binary", JPG).ok).toBe(true);
  });
});

describe("cameraId vira NOME DE ARQUIVO — traversal não passa", () => {
  it("recusa caminho relativo, barra e nulo", () => {
    for (const id of ["../../users", "a/b", "..", "cam/../x", "cam\\x", "a\0b"])
      expect(validar(id, "image/png", PNG)).toEqual({ ok: false, erro: "câmera inválida" });
  });

  it("recusa vazio e id longo demais", () => {
    expect(validar("", "image/png", PNG).ok).toBe(false);
    expect(validar("c".repeat(65), "image/png", PNG).ok).toBe(false);
  });

  it("aceita o formato real dos ids do produto", () => {
    expect(validar("cam-6a8914b424", "image/png", PNG).ok).toBe(true);
    expect(validar("e2e", "image/png", PNG).ok).toBe(true);
  });
});

describe("o content-type MENTE — os bytes é que decidem", () => {
  it("executável renomeado para .png é recusado", () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0x90)]); // cabeçalho PE
    const r = validar("cam-1", "image/png", exe);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/não confere/);
  });

  it("JPEG declarado com bytes de PNG é recusado (e vice-versa)", () => {
    expect(validar("cam-1", "image/jpeg", PNG).ok).toBe(false);
    expect(validar("cam-1", "image/png", JPG).ok).toBe(false);
  });

  it("SVG não entra — é o formato que executa script dentro", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const r = validar("cam-1", "image/svg+xml", svg);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/formato não aceito/);
  });

  it("formato fora da allowlist é recusado, mesmo sendo imagem de verdade", () => {
    expect(validar("cam-1", "image/gif", JPG).ok).toBe(false);
    expect(validar("cam-1", "", JPG).ok).toBe(false);
    expect(validar("cam-1", undefined, JPG).ok).toBe(false);
  });
});

describe("tamanho", () => {
  it("recusa acima do teto, com a mensagem em MB", () => {
    const gordo = Buffer.concat([JPG, Buffer.alloc(MAX_BYTES)]);
    const r = validar("cam-1", "image/jpeg", gordo);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/2 MB/);
  });

  it("recusa vazio e não-Buffer", () => {
    expect(validar("cam-1", "image/jpeg", Buffer.alloc(0)).ok).toBe(false);
    expect(validar("cam-1", "image/jpeg", "não sou buffer").ok).toBe(false);
    expect(validar("cam-1", "image/jpeg", null).ok).toBe(false);
  });

  it("um arquivo NO limite passa (o teto é inclusivo)", () => {
    const noLimite = Buffer.concat([JPG, Buffer.alloc(MAX_BYTES - JPG.length)]);
    expect(noLimite.length).toBe(MAX_BYTES);
    expect(validar("cam-1", "image/jpeg", noLimite).ok).toBe(true);
  });
});

describe("tipoDe — o content-type da resposta sai da allowlist, não do arquivo", () => {
  it("cada extensão volta ao seu tipo", () => {
    for (const [tipo, ext] of Object.entries(TIPOS)) expect(tipoDe(ext)).toBe(tipo);
  });

  it("extensão desconhecida NÃO vira text/html (seria XSS servido pelo nosso domínio)", () => {
    expect(tipoDe("exe")).toBe("application/octet-stream");
    expect(tipoDe("")).toBe("application/octet-stream");
  });
});
