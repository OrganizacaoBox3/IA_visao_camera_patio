// Testes do TÚNEL DVR por WebSocket (server/dvr-tunnel.js): o reescritor de URLs da web do DVR
// (parte frágil — cobre os casos comuns), a montagem da resposta (texto reescrito × binário intacto,
// headers removidos) e o relay `requisitar` com um socket.io FAKE (ack + timeout + sem túnel).
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tunnel = require("./dvr-tunnel.js");

const PREFIXO = "/api/dvr/web/dvr-1";
const DVR = "192.168.1.108";

describe("reescreverCorpo — caminhos absolutos e IP do DVR", () => {
  it("prefixa href/src/action absolutos, mas não mexe em protocol-relative (//cdn)", () => {
    const html = `<a href="/login.asp"><img src='/img/logo.png'><form action="/go"></form><link href="//cdn/x.css">`;
    const r = tunnel.reescreverCorpo(html, PREFIXO, DVR);
    expect(r).toContain(`href="${PREFIXO}/login.asp"`);
    expect(r).toContain(`src='${PREFIXO}/img/logo.png'`);
    expect(r).toContain(`action="${PREFIXO}/go"`);
    expect(r).toContain(`href="//cdn/x.css"`); // protocol-relative NÃO é reescrito
  });

  it("prefixa url(/x) do CSS nas três formas de aspa", () => {
    const css = `a{background:url(/bg.png)} b{background:url("/b.png")} c{background:url('/c.png')}`;
    const r = tunnel.reescreverCorpo(css, PREFIXO, DVR);
    expect(r).toContain(`url(${PREFIXO}/bg.png)`);
    expect(r).toContain(`url("${PREFIXO}/b.png")`);
    expect(r).toContain(`url('${PREFIXO}/c.png')`);
  });

  it("reescreve o IP do DVR hardcoded (http:// e //)", () => {
    const js = `var ws="http://192.168.1.108/live"; var b="//192.168.1.108/api";`;
    const r = tunnel.reescreverCorpo(js, PREFIXO, DVR);
    expect(r).toContain(`"${PREFIXO}/live"`);
    expect(r).toContain(`"${PREFIXO}/api"`);
  });
});

describe("reescreverLocation e reescreverSetCookie", () => {
  it("Location absoluto (path e URL do DVR) passa pelo prefixo", () => {
    expect(tunnel.reescreverLocation("/home.asp", PREFIXO, DVR)).toBe(`${PREFIXO}/home.asp`);
    expect(tunnel.reescreverLocation("http://192.168.1.108/x", PREFIXO, DVR)).toBe(`${PREFIXO}/x`);
    expect(tunnel.reescreverLocation(`${PREFIXO}/ja-ok`, PREFIXO, DVR)).toBe(`${PREFIXO}/ja-ok`); // idempotente
  });

  it("Set-Cookie: tira Domain e prende o Path sob o prefixo", () => {
    const [c] = tunnel.reescreverSetCookie("SID=abc; Domain=192.168.1.108; Path=/; HttpOnly", PREFIXO);
    expect(c).not.toMatch(/Domain=/i);
    expect(c).toContain(`Path=${PREFIXO}/`);
    expect(c).toContain("HttpOnly");
  });

  it("Set-Cookie sem Path ganha Path do prefixo", () => {
    const [c] = tunnel.reescreverSetCookie("SID=abc", PREFIXO);
    expect(c).toContain(`Path=${PREFIXO}/`);
  });
});

describe("montarResposta", () => {
  it("reescreve corpo de TEXTO e remove headers problemáticos", () => {
    const resp = {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": "999",
        "x-frame-options": "DENY",
        "set-cookie": "SID=1; Domain=192.168.1.108; Path=/",
      },
      bodyB64: Buffer.from(`<a href="/x">`, "utf8").toString("base64"),
    };
    const { status, headers, buffer } = tunnel.montarResposta(resp, PREFIXO, DVR);
    expect(status).toBe(200);
    expect(headers["content-length"]).toBeUndefined(); // recalculado pelo servidor
    expect(headers["x-frame-options"]).toBeUndefined(); // deixa embutir/servir
    expect(buffer.toString("utf8")).toContain(`href="${PREFIXO}/x"`);
    expect(headers["set-cookie"][0]).toContain(`Path=${PREFIXO}/`);
  });

  it("corpo BINÁRIO (imagem) passa intacto", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const resp = { status: 200, headers: { "content-type": "image/png" }, bodyB64: bytes.toString("base64") };
    const { buffer } = tunnel.montarResposta(resp, PREFIXO, DVR);
    expect(Buffer.compare(buffer, bytes)).toBe(0);
  });
});

describe("registro + requisitar (socket.io fake)", () => {
  // Socket fake: .timeout(ms).emit(evt, payload, ack). `respondedor` decide o que o ack recebe.
  function socketFake(respondedor) {
    return {
      timeout() {
        return {
          emit(_evt, payload, ack) {
            respondedor(payload, ack);
          },
        };
      },
      disconnect() {},
    };
  }

  beforeEach(() => {
    for (const k of [...tunnel._tuneis.keys()]) tunnel._tuneis.delete(k);
  });

  it("registra, acha e relaya uma requisição (ack de sucesso)", async () => {
    const socket = socketFake((payload, ack) => ack(null, { status: 204, headers: {}, bodyB64: "" }));
    tunnel.registrar("dvr-1", { socket, coletorId: "col-1" });
    expect(tunnel.ativo("dvr-1")).toBeTruthy();
    const r = await tunnel.requisitar("dvr-1", { method: "GET", path: "/", headers: {} });
    expect(r.status).toBe(204);
  });

  it("timeout do app vira rejeição", async () => {
    const socket = socketFake((_payload, ack) => ack(new Error("timeout")));
    tunnel.registrar("dvr-1", { socket, coletorId: "col-1" });
    await expect(tunnel.requisitar("dvr-1", { method: "GET", path: "/", headers: {} })).rejects.toThrow(/timeout/i);
  });

  it("sem túnel ativo rejeita", async () => {
    await expect(tunnel.requisitar("inexistente", { method: "GET", path: "/", headers: {} })).rejects.toThrow(/sem túnel/i);
  });

  it("remover só apaga se for o MESMO socket", () => {
    const s1 = socketFake(() => {});
    const s2 = socketFake(() => {});
    tunnel.registrar("dvr-1", { socket: s1, coletorId: "col-1" });
    tunnel.remover("dvr-1", s2); // socket diferente → não apaga
    expect(tunnel.ativo("dvr-1")).toBeTruthy();
    tunnel.remover("dvr-1", s1); // mesmo socket → apaga
    expect(tunnel.ativo("dvr-1")).toBeNull();
  });
});
