// GATE de arquitetura: "a API que o coletor (TC22) usa é a MESMA do sistema — sobe um, sobe tudo."
//
// POR QUÊ (pedido do usuário, jul/2026): o ingest BLE (/api/bt/reading) NÃO pode virar um serviço/porta
// à parte que se esquece de subir. Ele tem que ser servido pelo ÚNICO hub (server/index.js), no mesmo
// processo/porta que serve o resto. Hoje isso é verdade por construção; este teste torna a garantia um
// GATE — se alguém amanhã separar o BLE num segundo servidor, esquecer de despachar a rota, criar um
// entrypoint paralelo, ou deixar o TC22 apontar p/ outro caminho/porta, ISTO fica vermelho.
//
// É teste de FONTE (grep no código), no mesmo idioma do ratchet de CameraWorkspace.size — proporcional
// e sem subir servidor de verdade (que puxaria DB/socket).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const indexSrc = read("./index.js");
const btStationSrc = read("./routes/bt-station.js");
const pkg = JSON.parse(read("../package.json"));
const tc22Src = read("../tc22-scanner/src/com/grendene/btscan/MainActivity.java");

// A rota que a estação POSTa + a porta-padrão do hub. Fonte única: se mudar, o TC22 tem que acompanhar.
const INGEST_PATH = "/api/bt/reading";
const HUB_PORT = "4000";

describe("hub único — o coletor usa a MESMA API do sistema (sobe um, sobe tudo)", () => {
  it("existe UM só servidor http (um createServer, um listen) em server/index.js", () => {
    expect(indexSrc.match(/createServer\(/g) ?? []).toHaveLength(1);
    expect(indexSrc.match(/\.listen\(/g) ?? []).toHaveLength(1);
  });

  it("o ingest BLE é despachado NO MESMO handler que as demais rotas (co-localizado, não à parte)", () => {
    expect(indexSrc).toContain('require("./routes/bt-station")');
    expect(indexSrc).toContain("routeBtStation.handle(");
    // âncora: uma rota central do sistema mora no MESMO arquivo/handler → co-localização garantida
    expect(indexSrc).toContain("routeData.handle(");
  });

  it("a descoberta UDP (o que faz o TC22 achar o hub) roda no MESMO processo do hub", () => {
    expect(indexSrc).toContain('require("./discovery")');
    expect(indexSrc).toContain("discovery.start(");
  });

  it("o contrato de descoberta (porta UDP + probe) é IDÊNTICO no hub e no TC22", () => {
    const discSrc = read("./discovery.js");
    for (const src of [discSrc, tc22Src]) {
      expect(src).toContain("41234"); // porta UDP do beacon
      expect(src).toContain("VISAO_HUB_DISCOVER"); // payload do broadcast
    }
  });

  it("a rota do coletor é exatamente a que o servidor registra", () => {
    expect(btStationSrc).toContain(INGEST_PATH);
  });

  it("há UM só entrypoint — start e hub apontam pro mesmo server/index.js; sem launcher BLE separado", () => {
    expect(pkg.scripts.start).toBe("node server/index.js");
    expect(pkg.scripts.hub).toBe("node server/index.js");
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(`${name} ${cmd}`).not.toMatch(/bt[-/](station|reading)/i); // nada que suba só o BLE
    }
  });

  it("o TC22 aponta pro MESMO caminho e porta do hub (não uma API divergente)", () => {
    const m = tc22Src.match(/DEFAULT_HUB_URL\s*=\s*"([^"]+)"/);
    expect(m, "DEFAULT_HUB_URL não encontrado no MainActivity").toBeTruthy();
    const url = m[1];
    expect(url.endsWith(INGEST_PATH)).toBe(true); // mesmo caminho da rota do hub
    expect(url).toContain(`:${HUB_PORT}`); // mesma porta-padrão do hub
    // e a porta-padrão do hub é essa mesma (se o default do index.js mudar, este gate cobra o TC22)
    expect(indexSrc).toMatch(new RegExp(`PORT\\s*\\?\\?\\s*${HUB_PORT}`));
  });
});
