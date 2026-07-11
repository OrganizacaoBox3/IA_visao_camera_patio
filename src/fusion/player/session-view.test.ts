import { describe, expect, it } from "vitest";
import {
  SYNTH_WORLD_DOMAIN,
  collectTrackIds,
  parseSessionTruthJson,
  sessionWorldDomain,
} from "./session-view";
import type { SimTick } from "../sim";
import type { Matrix3, Vec2 } from "../../vision/homography";

/** SimTick mínimo: só tracks importam para este módulo (readings/verdade vão vazios). */
function tick(ts: number, tracks: { id: number; bbox: [number, number, number, number] }[]): SimTick {
  return { ts, tracks, readings: [], truthTagByTrack: {} };
}

/** H identidade: pixel = mundo (w projetivo = 1) — bbox vira posição-mundo direto pelo pé. */
const H_ID: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Última linha zera o w projetivo → pixelToWorld devolve null pra TODO ponto (horizonte). */
const H_DEGENERATE: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 0];
const STATION: Vec2 = { x: 0.5, y: 1.0 };

describe("collectTrackIds (lista do modo anotação)", () => {
  it("vazio → []", () => {
    expect(collectTrackIds([])).toEqual([]);
    expect(collectTrackIds([tick(0, [])])).toEqual([]);
  });

  it("une os tracks de TODOS os ticks, sem duplicar, em ordem crescente", () => {
    const ticks = [
      tick(0, [{ id: 7, bbox: [0, 0, 0.1, 0.1] }]),
      tick(500, [
        { id: 3, bbox: [0, 0, 0.1, 0.1] },
        { id: 7, bbox: [0.2, 0, 0.1, 0.1] },
      ]),
      tick(1000, [{ id: 12, bbox: [0, 0, 0.1, 0.1] }]),
    ];
    expect(collectTrackIds(ticks)).toEqual([3, 7, 12]);
  });
});

describe("sessionWorldDomain (enquadramento da planta pra gravação real)", () => {
  it("sem H → fallback 8×6 do simulador", () => {
    const ticks = [tick(0, [{ id: 1, bbox: [0.4, 0.4, 0.2, 0.2] }])];
    expect(sessionWorldDomain(ticks, null, STATION)).toEqual(SYNTH_WORLD_DOMAIN);
  });

  it("H presente mas nada projeta (horizonte) → fallback 8×6", () => {
    const ticks = [tick(0, [{ id: 1, bbox: [0.4, 0.4, 0.2, 0.2] }])];
    expect(sessionWorldDomain(ticks, H_DEGENERATE, STATION)).toEqual(SYNTH_WORLD_DOMAIN);
  });

  it("bounding box dos pés projetados + estação, com folga (padM)", () => {
    // Pés (bottom-center): [1,1,2,2] → (2,3); [8,5,2,3] → (9,8). Estação (0.5,1) também entra.
    const ticks = [
      tick(0, [{ id: 1, bbox: [1, 1, 2, 2] }]),
      tick(500, [{ id: 2, bbox: [8, 5, 2, 3] }]),
    ];
    const d = sessionWorldDomain(ticks, H_ID, STATION, { padM: 0.5, minSpanM: 0 });
    expect(d).toEqual({ minX: 0, minY: 0.5, maxX: 9.5, maxY: 8.5 });
  });

  it("ponto único (pessoa parada) não degenera: vão mínimo por eixo em torno do centro", () => {
    // Um pé só em (2,3); estação idem (2,3) via H identidade não — usa stationPx (2,3) também.
    const ticks = [tick(0, [{ id: 1, bbox: [1.5, 2.5, 1, 0.5] }])]; // pé = (2, 3)
    const d = sessionWorldDomain(ticks, H_ID, { x: 2, y: 3 }, { padM: 0, minSpanM: 2 });
    expect(d).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
  });

  it("amostra SÓ os primeiros sampleTicks (tick além do corte não estica o domínio)", () => {
    const ticks = [
      tick(0, [{ id: 1, bbox: [1, 1, 2, 2] }]), // pé (2,3)
      tick(500, [{ id: 1, bbox: [99, 99, 2, 2] }]), // pé (100,101) — fora da amostra
    ];
    const d = sessionWorldDomain(ticks, H_ID, { x: 2, y: 3 }, { sampleTicks: 1, padM: 0, minSpanM: 0 });
    expect(d.maxX).toBe(2);
    expect(d.maxY).toBe(3);
  });

  it("sem ticks mas com H e estação projetável → caixa mínima em torno da estação", () => {
    const d = sessionWorldDomain([], H_ID, { x: 4, y: 5 }, { padM: 0, minSpanM: 2 });
    expect(d).toEqual({ minX: 3, minY: 4, maxX: 5, maxY: 6 });
  });

  it("gravação que começa VAZIA (câmera ligada antes do roteiro): ticks vazios não consomem o orçamento — o domínio cobre os tracks que vêm depois", () => {
    // 2000 ticks vazios (o DEFAULT_SAMPLE_TICKS inteiro) e SÓ DEPOIS os tracks. A amostragem
    // cronológica antiga devolvia um domínio só com a estação → tudo desenhava fora do canvas.
    const empty = Array.from({ length: 2000 }, (_, i) => tick(i * 500, []));
    const ticks = [
      ...empty,
      tick(2000 * 500, [{ id: 1, bbox: [1, 1, 2, 2] }]), // pé (2,3)
      tick(2001 * 500, [{ id: 2, bbox: [8, 5, 2, 3] }]), // pé (9,8)
    ];
    const d = sessionWorldDomain(ticks, H_ID, STATION, { padM: 0, minSpanM: 0 });
    expect(d.maxX).toBe(9);
    expect(d.maxY).toBe(8);
  });

  it("o teto conta ticks COM tracks: vazios no meio não gastam a amostra, e o corte ainda vale", () => {
    const ticks = [
      tick(0, []), // vazio — não consome
      tick(500, [{ id: 1, bbox: [1, 1, 2, 2] }]), // pé (2,3) — consome o orçamento de 1
      tick(1000, [{ id: 1, bbox: [99, 99, 2, 2] }]), // pé (100,101) — além do corte
    ];
    const d = sessionWorldDomain(ticks, H_ID, { x: 2, y: 3 }, { sampleTicks: 1, padM: 0, minSpanM: 0 });
    expect(d.maxX).toBe(2);
    expect(d.maxY).toBe(3);
  });
});

describe("parseSessionTruthJson (import do modo anotação)", () => {
  it("round-trip do export: MACs e nulls voltam como saíram", () => {
    const truth = { 1: "AA:BB:CC:DD:EE:FF", 2: null, 12: "00:11:22:33:44:55" };
    expect(parseSessionTruthJson(JSON.stringify(truth))).toEqual(truth);
  });

  it("não-JSON, raiz não-objeto e array → null (arquivo inválido)", () => {
    expect(parseSessionTruthJson("não é json")).toBeNull();
    expect(parseSessionTruthJson('"string"')).toBeNull();
    expect(parseSessionTruthJson("42")).toBeNull();
    expect(parseSessionTruthJson("null")).toBeNull();
    expect(parseSessionTruthJson("[1,2]")).toBeNull();
  });

  it("entradas inválidas são descartadas sem derrubar as válidas", () => {
    const raw = JSON.stringify({
      "1": "AA:BB:CC:DD:EE:FF",
      abc: "BB:BB:BB:BB:BB:BB", // chave não-numérica
      "2": 42, // valor não-string/não-null
      "3": "", // string vazia não é MAC
      "4": null,
    });
    expect(parseSessionTruthJson(raw)).toEqual({ 1: "AA:BB:CC:DD:EE:FF", 4: null });
  });

  it("objeto vazio é válido (anotação zerada)", () => {
    expect(parseSessionTruthJson("{}")).toEqual({});
  });

  it('chave "" NÃO vira track 0 (Number("")===0 corromperia a anotação do track 0)', () => {
    const raw = JSON.stringify({ "": "AA:BB:CC:DD:EE:FF", "0": "00:11:22:33:44:55" });
    expect(parseSessionTruthJson(raw)).toEqual({ 0: "00:11:22:33:44:55" });
  });

  it("chave só vale como inteiro decimal: hex, notação científica e fração são descartadas", () => {
    const raw = JSON.stringify({
      "0x10": "AA:AA:AA:AA:AA:AA", // Number() daria 16
      "1e3": "BB:BB:BB:BB:BB:BB", // Number() daria 1000
      "1.5": "CC:CC:CC:CC:CC:CC", // Number() daria 1.5
      "7": "DD:DD:DD:DD:DD:DD",
      "-2": null, // inteiro negativo passa no /^-?\d+$/ (defensivo, ids reais são >= 0)
    });
    expect(parseSessionTruthJson(raw)).toEqual({ 7: "DD:DD:DD:DD:DD:DD", "-2": null });
  });

  it("valor entra TRIMADO e em MAIÚSCULO (convenção do MAC do session-loader)", () => {
    const raw = JSON.stringify({ "1": "  aa:bb:cc:dd:ee:ff  " });
    expect(parseSessionTruthJson(raw)).toEqual({ 1: "AA:BB:CC:DD:EE:FF" });
  });
});
