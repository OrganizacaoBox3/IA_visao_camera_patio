// CONTRATO CALIBRAÇÃO → MOTOR (o elo que estava CORTADO — H4, 2026-07-13).
//
// O bug que este arquivo existe para impedir de voltar: `useCameraTagLabels` carregava
// `calibration.stations` (o ponto de chão de CADA estação BLE, salvo pela UI e persistido pelo hub)
// e NÃO o repassava ao `useTagFusion` ⇒ `buildFusionFrame` nunca recebia `stationsPx` ⇒
// `TrackDist.distByStation` NUNCA era emitido no caminho vivo ⇒ o motor jamais via a geometria da
// 2ª antena. Silencioso: nenhum teste quebrava, porque nenhum teste ia de PONTA A PONTA.
//
// "Contrato entre camadas sem teste = regressão silenciosa nº 1" (CLAUDE.md). Então o teste não
// olha só o adaptador: ele ALIMENTA o buildFusionFrame de PRODUÇÃO com a saída do adaptador e
// confere o que o MOTOR recebe. Como esta casa não tem testing-library, a adaptação foi extraída
// como função PURA (fusionInputsFrom) — o hook virou repasse dela.
import { describe, expect, it } from "vitest";
import { fusionInputsFrom } from "./useCameraTagLabels";
import { buildFusionFrame, type DrawTrack } from "./frame";
import type { FloorCalibration } from "./useFloorTags";
import type { CalibrationPoint } from "../api";
import type { Matrix3 } from "../vision/homography";

// Homografia IDENTIDADE: px (0..1) == mundo (metros) — a geometria se confere no olho.
const H_ID: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Uma pista cujo PÉ (bottom-center) cai exatamente em (0.5, 0.5). */
const TRACK: DrawTrack = { id: 7, bbox: [0.45, 0.4, 0.1, 0.1] };
const READING = { mac: "AA:BB", rotulo: null, rssi: -60, stationId: "est-a" };

const anchor = (mac: string): CalibrationPoint & { mac: string } => ({
  mac,
  px: { x: 0, y: 0 },
  world: { x: 0, y: 0 },
});

/** Calibração completa de 2 antenas: A no canto (0,0), B no canto oposto (1,1). */
const CAL_2_ANTENAS: FloorCalibration = {
  H: H_ID,
  station: { x: 0, y: 0 },
  points: [anchor("fx:01")],
  stations: { "est-a": { x: 0, y: 0 }, "est-b": { x: 1, y: 1 } },
};

describe("fusionInputsFrom — o que a calibração entrega ao motor", () => {
  it("2 estações calibradas → stationsPx com AS DUAS (o elo que morria aqui)", () => {
    const i = fusionInputsFrom(CAL_2_ANTENAS);
    expect(i.stationsPx).toEqual({ "est-a": { x: 0, y: 0 }, "est-b": { x: 1, y: 1 } });
    expect(i.stationPx).toEqual({ x: 0, y: 0 }); // a PRINCIPAL segue chegando (retrocompat)
    expect(i.H).toBe(H_ID);
  });

  it("âncoras cadastradas viram excludeTags em MAIÚSCULAS (jamais candidatas)", () => {
    expect([...fusionInputsFrom(CAL_2_ANTENAS).excludeTags!]).toEqual(["FX:01"]);
  });

  it("sem stations (mundo de 1 antena) → undefined, não {} (retrocompat dura)", () => {
    const i = fusionInputsFrom({ H: H_ID, station: { x: 0, y: 0 }, points: [] });
    expect(i.stationsPx).toBeUndefined();
    expect(i.excludeTags).toBeUndefined();
  });

  it("stations VAZIO ({}) → undefined (não emite geometria por fonte à toa)", () => {
    const i = fusionInputsFrom({ H: H_ID, station: null, points: [], stations: {} });
    expect(i.stationsPx).toBeUndefined();
    expect(i.stationPx).toBeUndefined(); // sem station → frame.ts cai no default (0.5, 1.0)
  });
});

describe("PONTA A PONTA: calibração → buildFusionFrame → o que o MOTOR vê", () => {
  it("com 2 estações, o motor RECEBE a distância a CADA uma (distByStation)", () => {
    const i = fusionInputsFrom(CAL_2_ANTENAS);
    const f = buildFusionFrame([TRACK], [READING], i.H, 1000, i.stationPx, i.excludeTags, i.stationsPx);
    const t = f.tracks[0];
    expect(t.metric).toBe(true);
    // Pé em (0.5,0.5): √0,5 ≈ 0,7071 de CADA canto — as duas geometrias existem e são distintas
    // por construção do cenário real (aqui o pé é equidistante de propósito: o que se testa é a
    // PRESENÇA das duas séries, não o valor).
    expect(Object.keys(t.distByStation ?? {})).toEqual(["est-a", "est-b"]);
    expect(t.distByStation!["est-a"]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(t.distByStation!["est-b"]).toBeCloseTo(Math.SQRT1_2, 6);
    // E a leitura chega ao motor com a FONTE (stationId → sourceId): sem isso a partição por
    // fonte veria 1 grupo só e a 2ª antena não votaria.
    expect(f.readings[0].sourceId).toBe("est-a");
  });

  it("pé FORA do meio: as duas distâncias DIVERGEM (é disso que a 2ª antena vive)", () => {
    const i = fusionInputsFrom(CAL_2_ANTENAS);
    const perto: DrawTrack = { id: 1, bbox: [0.15, 0.1, 0.1, 0.1] }; // pé em (0.2, 0.2)
    const f = buildFusionFrame([perto], [READING], i.H, 1000, i.stationPx, i.excludeTags, i.stationsPx);
    const d = f.tracks[0].distByStation!;
    expect(d["est-a"]).toBeCloseTo(Math.hypot(0.2, 0.2), 6);
    expect(d["est-b"]).toBeCloseTo(Math.hypot(0.8, 0.8), 6);
    expect(d["est-b"]).toBeGreaterThan(d["est-a"] * 3); // eixos radiais MESMO distintos
  });

  it("mundo de 1 antena → a chave distByStation NEM EXISTE (nada mudou p/ o campo de hoje)", () => {
    const i = fusionInputsFrom({ H: H_ID, station: { x: 0, y: 0 }, points: [] });
    const f = buildFusionFrame([TRACK], [READING], i.H, 1000, i.stationPx, i.excludeTags, i.stationsPx);
    expect("distByStation" in f.tracks[0]).toBe(false);
  });
});
