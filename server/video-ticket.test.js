// Testes do passe de vídeo (server/video-ticket.js) — o gate que fecha o "/go2rtc/* sem auth".
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de go2rtc-source.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { signTicket, verifyTicket, verifyRequestUrl } = require("./video-ticket");

describe("signTicket / verifyTicket", () => {
  it("round-trip: um ticket geral recém-assinado verifica (payload com exp futuro)", () => {
    const t = signTicket();
    const p = verifyTicket(t);
    expect(p).toBeTruthy();
    expect(p.exp).toBeGreaterThan(Date.now());
    expect(p.src).toBeUndefined(); // geral = sem src no payload
  });

  it("assinatura adulterada é rejeitada (dente na assinatura)", () => {
    const t = signTicket({ src: "cam1" });
    const [body, sig] = t.split(".");
    // troca o último char da assinatura por outro (mantém o comprimento p/ exercitar o timing-safe)
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
    expect(verifyTicket(`${body}.${flipped}`, "cam1")).toBeNull();
  });

  it("payload adulterado (re-encodado) sem re-assinar é rejeitado", () => {
    const t = signTicket({ src: "cam1" });
    const sig = t.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ src: "cam2", exp: Date.now() + 60000 })).toString(
      "base64url",
    );
    expect(verifyTicket(`${forged}.${sig}`, "cam2")).toBeNull();
  });

  it("ticket expirado é rejeitado", () => {
    const t = signTicket({ ttlMs: -1000 }); // exp no passado
    expect(verifyTicket(t)).toBeNull();
  });

  it("ticket COM src só abre aquele src", () => {
    const t = signTicket({ src: "cam1" });
    expect(verifyTicket(t, "cam1")).toBeTruthy();
    expect(verifyTicket(t, "cam2")).toBeNull();
    expect(verifyTicket(t, undefined)).toBeNull(); // não abre path sem src (ex.: /api/streams)
  });

  it("ticket GERAL abre path sem src E qualquer src", () => {
    const t = signTicket();
    expect(verifyTicket(t, undefined)).toBeTruthy(); // /api/streams
    expect(verifyTicket(t, "cam1")).toBeTruthy(); // qualquer stream
  });

  it("controle negativo: lixo / vazio / sem ponto → null", () => {
    expect(verifyTicket("")).toBeNull();
    expect(verifyTicket("semponto")).toBeNull();
    expect(verifyTicket("a.b.c")).toBeNull();
    expect(verifyTicket(null)).toBeNull();
    expect(verifyTicket(undefined)).toBeNull();
  });
});

describe("verifyRequestUrl (o gate puro do proxy)", () => {
  it("extrai ticket+src da URL crua e valida (WS de sinalização)", () => {
    const t = signTicket({ src: "cam1" });
    expect(verifyRequestUrl(`/api/ws?src=cam1&ticket=${encodeURIComponent(t)}`)).toBeTruthy();
    expect(verifyRequestUrl(`/api/ws?src=cam2&ticket=${encodeURIComponent(t)}`)).toBeNull();
  });

  it("ticket geral libera /api/streams (sem src) e o WHIP (src=webrtc: do go2rtc)", () => {
    const t = signTicket();
    expect(verifyRequestUrl(`/api/streams?ticket=${encodeURIComponent(t)}`)).toBeTruthy();
    // O WHIP usa o param `src` do PRÓPRIO go2rtc (webrtc:) — só o ticket geral casa.
    expect(
      verifyRequestUrl(`/api/streams?name=cam1&src=webrtc:&ticket=${encodeURIComponent(t)}`),
    ).toBeTruthy();
  });

  it("ausência de ticket → null (o buraco que estamos fechando)", () => {
    expect(verifyRequestUrl("/api/streams")).toBeNull();
    expect(verifyRequestUrl("/api/ws?src=cam1")).toBeNull();
  });

  it("URL inválida não lança — retorna null", () => {
    expect(verifyRequestUrl(undefined)).toBeNull();
    expect(verifyRequestUrl("")).toBeNull();
  });
});
