// Testes da normalização PURA da config de câmera (cameraConfig.normalizeCfg): valida/sanea uma
// config vinda de qualquer origem (localStorage OU backend) aplicando defaults. As funções com I/O
// (getCameraCfg/setCameraCfg/loadCamConfig) dependem de localStorage/API → cobertas pelo e2e.
import { describe, it, expect } from "vitest";
import { normalizeCfg } from "./cameraConfig";
import { OBJECT_KEYS } from "./objects/catalog";
import { APP_CONFIG } from "./config";

describe("normalizeCfg — defaults e saneamento", () => {
  it("null/undefined → config default com TODAS as classes selecionadas", () => {
    const d = normalizeCfg(null);
    expect(d).toEqual({
      modo: "atividade",
      pontoLeitura: APP_CONFIG.reading.defaultPonto,
      capture: "maxima",
      selectedClasses: [...OBJECT_KEYS],
      longRange: false,
      transport: "auto",
    });
    expect(normalizeCfg(undefined)).toEqual(d);
  });

  it("preserva modos válidos e cai p/ 'atividade' no inválido", () => {
    expect(normalizeCfg({ modo: "leitura" }).modo).toBe("leitura");
    expect(normalizeCfg({ modo: "objetos" }).modo).toBe("objetos");
    expect(normalizeCfg({ modo: "fadiga" }).modo).toBe("fadiga");
    expect(normalizeCfg({ modo: "coisa" as never }).modo).toBe("atividade");
  });

  it("capture: aceita media/alta/maxima; ausente/inválido vira 'maxima' (melhor por default)", () => {
    expect(normalizeCfg({ capture: "media" }).capture).toBe("media");
    expect(normalizeCfg({ capture: "maxima" }).capture).toBe("maxima");
    expect(normalizeCfg({ capture: "ultra" as never }).capture).toBe("maxima");
  });

  it("selectedClasses: filtra chaves desconhecidas; vazio após filtrar → todas", () => {
    expect(normalizeCfg({ selectedClasses: ["pessoa", "caixa", "inexistente"] }).selectedClasses).toEqual(
      ["pessoa", "caixa"],
    );
    expect(normalizeCfg({ selectedClasses: ["nada-valido"] }).selectedClasses).toEqual([
      ...OBJECT_KEYS,
    ]);
    expect(normalizeCfg({ selectedClasses: [] }).selectedClasses).toEqual([...OBJECT_KEYS]);
  });

  it("longRange é opt-in ESTRITO: só `true` liga (ausente/valor falso → false)", () => {
    expect(normalizeCfg({ longRange: true }).longRange).toBe(true);
    expect(normalizeCfg({ longRange: false }).longRange).toBe(false);
    expect(normalizeCfg({ longRange: "true" as never }).longRange).toBe(false);
    expect(normalizeCfg({}).longRange).toBe(false);
  });

  it("transport: overrides mjpeg/webrtc preservados; ausente/inválido → 'auto'", () => {
    expect(normalizeCfg({ transport: "mjpeg" }).transport).toBe("mjpeg");
    expect(normalizeCfg({ transport: "webrtc" }).transport).toBe("webrtc");
    expect(normalizeCfg({ transport: "quic" as never }).transport).toBe("auto");
    expect(normalizeCfg({}).transport).toBe("auto");
  });

  it("pontoLeitura em branco/whitespace cai p/ o default", () => {
    expect(normalizeCfg({ pontoLeitura: "Doca 5" }).pontoLeitura).toBe("Doca 5");
    expect(normalizeCfg({ pontoLeitura: "   " }).pontoLeitura).toBe(APP_CONFIG.reading.defaultPonto);
    expect(normalizeCfg({ pontoLeitura: "" }).pontoLeitura).toBe(APP_CONFIG.reading.defaultPonto);
  });
});
