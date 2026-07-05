// Testes de unidade da lógica PURA de transporte de vídeo (transport.ts). Determinísticos: o
// relógio (`now`) e os cooldowns entram por parâmetro. Cobre os limites: override manual, cooldown
// de falha de WebRTC (fronteira exata) e descoberta go2rtc.
import { describe, it, expect } from "vitest";
import { transportOf } from "./transport";

const NOW = 1_000_000;

describe("transportOf", () => {
  it("'mjpeg' manual força MJPEG mesmo com o go2rtc servindo a câmera", () => {
    const streams = new Set(["cam"]);
    expect(transportOf("mjpeg", "cam", streams, new Map(), NOW)).toBe("mjpeg");
  });

  it("'auto' resolve WebRTC quando o go2rtc serve a câmera", () => {
    expect(transportOf("auto", "cam", new Set(["cam"]), new Map(), NOW)).toBe("webrtc");
  });

  it("'auto' cai pra MJPEG quando o go2rtc NÃO serve a câmera (Set vazio = go2rtc fora)", () => {
    expect(transportOf("auto", "cam", new Set(), new Map(), NOW)).toBe("mjpeg");
  });

  it("'webrtc' manual ainda exige o go2rtc servir a câmera (senão MJPEG)", () => {
    expect(transportOf("webrtc", "cam", new Set(), new Map(), NOW)).toBe("mjpeg");
    expect(transportOf("webrtc", "cam", new Set(["cam"]), new Map(), NOW)).toBe("webrtc");
  });

  describe("cooldown de falha de WebRTC", () => {
    it("força MJPEG enquanto o cooldown está ativo, mesmo com o stream listado", () => {
      const fail = new Map([["cam", NOW + 5000]]);
      expect(transportOf("auto", "cam", new Set(["cam"]), fail, NOW)).toBe("mjpeg");
      // vale também p/ o "webrtc" manual (webrtc factualmente quebrado usa o fallback)
      expect(transportOf("webrtc", "cam", new Set(["cam"]), fail, NOW)).toBe("mjpeg");
    });

    it("na FRONTEIRA exata (until === now) o cooldown já expirou → torna a tentar WebRTC", () => {
      const fail = new Map([["cam", NOW]]); // until não é > now
      expect(transportOf("auto", "cam", new Set(["cam"]), fail, NOW)).toBe("webrtc");
    });

    it("cooldown expirado (until < now) volta a WebRTC (retry periódico)", () => {
      const fail = new Map([["cam", NOW - 1]]);
      expect(transportOf("auto", "cam", new Set(["cam"]), fail, NOW)).toBe("webrtc");
    });

    it("cooldown de OUTRA câmera não afeta esta", () => {
      const fail = new Map([["outra", NOW + 5000]]);
      expect(transportOf("auto", "cam", new Set(["cam"]), fail, NOW)).toBe("webrtc");
    });
  });
});
