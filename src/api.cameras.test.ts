// Testes das lógicas PURAS do client de câmeras IP (api.ts): validação de URL (espelha o backend)
// e mascaramento de credenciais para exibição (LGPD — nunca expor user:pass).
import { describe, it, expect } from "vitest";
import { isValidCameraUrl, maskCameraUrl } from "./api";

describe("isValidCameraUrl", () => {
  it("aceita esquemas suportados (rtsp/rtsps/http/https)", () => {
    expect(isValidCameraUrl("rtsp://10.0.0.5:554/stream")).toBe(true);
    expect(isValidCameraUrl("rtsps://cam.local/live")).toBe(true);
    expect(isValidCameraUrl("http://cam/stream.mjpg")).toBe(true);
    expect(isValidCameraUrl("https://ex.com/playlist.m3u8")).toBe(true);
    expect(isValidCameraUrl("  rtsp://a/b  ")).toBe(true); // tolera espaços nas bordas
  });

  it("rejeita esquemas não suportados ou url vazia", () => {
    expect(isValidCameraUrl("")).toBe(false);
    expect(isValidCameraUrl("10.0.0.5:554/stream")).toBe(false);
    expect(isValidCameraUrl("ftp://cam/stream")).toBe(false);
    expect(isValidCameraUrl("rtsp://")).toBe(false); // sem host/caminho
    expect(isValidCameraUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("maskCameraUrl", () => {
  it("oculta as credenciais (user:pass@) mantendo host/caminho", () => {
    expect(maskCameraUrl("rtsp://admin:1234@10.0.0.5:554/stream")).toBe(
      "rtsp://***@10.0.0.5:554/stream",
    );
    expect(maskCameraUrl("https://user:pw@ex.com/live.m3u8")).toBe("https://***@ex.com/live.m3u8");
  });

  it("mantém a url quando não há credenciais", () => {
    expect(maskCameraUrl("rtsp://10.0.0.5:554/stream")).toBe("rtsp://10.0.0.5:554/stream");
    expect(maskCameraUrl("")).toBe("");
  });
});
