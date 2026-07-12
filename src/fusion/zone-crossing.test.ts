// Testes de zone-crossing.ts (unitários, CI) + MEDIÇÃO da confiabilidade da fronteira sobre a
// gravação REAL (gated por ZONE_FILE, SKIP no CI — mesmo padrão de funnel-session.test.ts). A
// gravação de campo é artefato IMUTÁVEL (CLAUDE.md §3): este teste SÓ LÊ, via parseFusionSession.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyCrossing,
  trackZoneEvents,
  zoneOccupancy,
  type Zone,
  type ZoneSample,
  type ZoneEvent,
} from "./zone-crossing";
import { pointInPolygon, type Polygon } from "./floor-polygon";
import { parseFusionSession } from "./session-loader";
import { pixelToWorld, type Vec2 } from "../vision/homography";

// Retângulo axis-aligned como Polígono (CCW).
const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

// Track sintético num único eixo x (y fixo dentro do retângulo), 1 amostra por tick de 500 ms.
const trackFromXs = (xs: number[], y = 0.5, t0 = 0): ZoneSample[] =>
  xs.map((x, i) => ({ ts: t0 + i * 500, foot: { x, y } }));

const ZONE: Zone = { id: "z", poly: rect(0, 0, 1, 1) }; // dentro sse x,y em (0,1)

describe("classifyCrossing", () => {
  it("cobre os 4 quadrantes de (antes, agora)", () => {
    expect(classifyCrossing(false, true)).toBe("entrou");
    expect(classifyCrossing(true, false)).toBe("saiu");
    expect(classifyCrossing(true, true)).toBe("dentro");
    expect(classifyCrossing(false, false)).toBe("fora");
  });
});

describe("trackZoneEvents — histerese anti-flicker", () => {
  it("confirma um cruzamento LIMPO (bounces=0) com latência N-1 ticks", () => {
    // fora, fora, DENTRO, dentro, dentro (x cruza de -1 para 0.5) — acaba dentro → +morreu-dentro
    const track = trackFromXs([-1, -1, 0.5, 0.5, 0.5]);
    const ev = trackZoneEvents(track, ZONE); // N=2 default
    expect(ev.map((e) => e.kind)).toEqual(["entrou", "morreu-dentro"]);
    expect(ev[0].bounces).toBe(0);
    expect(ev[0].tickIndex).toBe(3); // confirmado no 2º tick dentro (N=2), não no 1º
  });

  it("SUPRIME uma excursão de 1 tick sobre a borda (tradeoff declarado: cruzamento relâmpago perdido)", () => {
    // fora, DENTRO(pico), fora, fora — dip de 1 tick não confirma nada com N=2
    const track = trackFromXs([-1, 0.5, -1, -1]);
    const ev = trackZoneEvents(track, ZONE);
    expect(ev).toHaveLength(0);
  });

  it("oscilação na borda vira UM cruzamento com bounces>0 (não 4 cruzamentos)", () => {
    // dithering: fora,dentro,fora,dentro,dentro,dentro → 1 'entrou' confirmado (acaba dentro → +morreu),
    // e NÃO 3 cruzamentos; bounces reflete o ruído absorvido.
    const track = trackFromXs([-1, 0.5, -1, 0.5, 0.5, 0.5]);
    const ev = trackZoneEvents(track, ZONE);
    const crossings = ev.filter((e) => e.kind === "entrou" || e.kind === "saiu");
    expect(crossings.map((e) => e.kind)).toEqual(["entrou"]); // 1 só, não 3
    expect(crossings[0].bounces).toBeGreaterThan(0); // a borda oscilou antes de estabilizar
  });

  it("N=1 desliga a histerese (cada flip cru vira evento)", () => {
    const track = trackFromXs([-1, 0.5, -1, 0.5]); // acaba dentro → +morreu-dentro
    const ev = trackZoneEvents(track, ZONE, { confirmTicks: 1 });
    expect(ev.map((e) => e.kind)).toEqual(["entrou", "saiu", "entrou", "morreu-dentro"]);
  });

  it("entra e SAI (dois cruzamentos confirmados)", () => {
    const track = trackFromXs([-1, -1, 0.5, 0.5, -1, -1]);
    const ev = trackZoneEvents(track, ZONE);
    expect(ev.map((e) => e.kind)).toEqual(["entrou", "saiu"]);
  });
});

describe("trackZoneEvents — casos-limite da conservação", () => {
  it("nasceu-dentro: 1º tick já dentro (distinto de 'entrou')", () => {
    const track = trackFromXs([0.5, 0.5, -1, -1]); // nasce dentro, depois sai
    const ev = trackZoneEvents(track, ZONE);
    expect(ev[0].kind).toBe("nasceu-dentro");
    expect(ev[0].tickIndex).toBe(0);
    expect(ev.some((e) => e.kind === "entrou")).toBe(false); // nunca vira 'entrou'
    expect(ev.some((e) => e.kind === "saiu")).toBe(true);
  });

  it("morreu-dentro: track some com estado confirmado dentro (sem 'saiu')", () => {
    const track = trackFromXs([-1, -1, 0.5, 0.5, 0.5]); // entra e o track acaba dentro
    const ev = trackZoneEvents(track, ZONE);
    expect(ev.map((e) => e.kind)).toEqual(["entrou", "morreu-dentro"]);
  });

  it("nasce E morre dentro (permanência pura — a fronteira nunca vê o token)", () => {
    const track = trackFromXs([0.5, 0.5, 0.5]); // presente o tempo todo, nunca cruza
    const ev = trackZoneEvents(track, ZONE);
    expect(ev.map((e) => e.kind)).toEqual(["nasceu-dentro", "morreu-dentro"]);
  });

  it("track vazio → sem eventos", () => {
    expect(trackZoneEvents([], ZONE)).toEqual([]);
  });

  it("polígono inválido (<3 pts) → tudo fora, sem eventos (retorno seguro do primitivo)", () => {
    const bad: Zone = { id: "b", poly: [{ x: 0, y: 0 }] };
    expect(trackZoneEvents(trackFromXs([0.5, 0.5, 0.5]), bad)).toEqual([]);
  });

  it("usa o MESMO pointInPolygon de floor-polygon (fronteira = borda do polígono)", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, ZONE.poly)).toBe(true);
    expect(pointInPolygon({ x: -1, y: 0.5 }, ZONE.poly)).toBe(false);
  });
});

describe("zoneOccupancy — base da conservação", () => {
  it("entrou +1 / saiu -1 ao longo do tempo", () => {
    const events: ZoneEvent[] = [
      { zoneId: "z", kind: "entrou", ts: 0, tickIndex: 0, bounces: 0 },
      { zoneId: "z", kind: "entrou", ts: 500, tickIndex: 1, bounces: 0 },
      { zoneId: "z", kind: "saiu", ts: 1000, tickIndex: 2, bounces: 0 },
    ];
    const occ = zoneOccupancy(events);
    expect(occ.timeline.map((p) => p.occ)).toEqual([1, 2, 1]);
    expect(occ.maxOcc).toBe(2);
    expect(occ.endOcc).toBe(1);
  });

  it("nasceu-dentro conta presença (+1) e vai para bornInside; morreu-dentro NÃO decrementa", () => {
    const events: ZoneEvent[] = [
      { zoneId: "z", kind: "nasceu-dentro", ts: 0, tickIndex: 0, bounces: 0 },
      { zoneId: "z", kind: "morreu-dentro", ts: 500, tickIndex: 1, bounces: 0 },
    ];
    const occ = zoneOccupancy(events);
    expect(occ.bornInside).toBe(1);
    expect(occ.diedInside).toBe(1);
    expect(occ.endOcc).toBe(1); // morreu-dentro não zera — a conservação tem de segurar (H2)
  });

  it("ocupação pode ir NEGATIVA (saiu sem entrou = entrada antes da observação)", () => {
    const events: ZoneEvent[] = [{ zoneId: "z", kind: "saiu", ts: 0, tickIndex: 0, bounces: 0 }];
    expect(zoneOccupancy(events).minOcc).toBe(-1);
  });

  it("lista vazia → tudo zero", () => {
    const occ = zoneOccupancy([]);
    expect(occ).toEqual({ timeline: [], bornInside: 0, diedInside: 0, minOcc: 0, maxOcc: 0, endOcc: 0 });
  });
});

// ——————————————————————————————————————————————————————————————————————————————————————————————
// MEDIÇÃO DE CAMPO (gated por ZONE_FILE — SKIP no CI). Confiabilidade da fronteira (H2) +
// distribuição de features dos tracks estáticos (§3). Relatório entre ZONE-REPORT-BEGIN/END.
// ——————————————————————————————————————————————————————————————————————————————————————————————
const FILE = process.env.ZONE_FILE;
const CONFIRM = process.env.ZONE_CONFIRM ? Number(process.env.ZONE_CONFIRM) : 2;

const foot = (b: readonly [number, number, number, number]): Vec2 => ({ x: b[0] + b[2] / 2, y: b[1] + b[3] });
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "—");

describe.skipIf(!FILE)("MEDIÇÃO fronteira+estáticos — gravação de campo (ZONE_FILE)", () => {
  it("mede confiabilidade da fronteira e distribuição das features estáticas", () => {
    const lines = readFileSync(FILE!, "utf8").split(/\r?\n/);
    const { ticks, H, diag } = parseFusionSession(lines, {});
    const out: string[] = [];
    out.push("ZONE-REPORT-BEGIN");
    out.push(`arquivo: ${FILE} (${lines.length} linhas, ${diag.linesDropped} descartadas) | ticks: ${ticks.length} | H: ${H ? "calibrada (espaço=MUNDO/m)" : "NULA (espaço=IMAGEM 0..1)"}`);

    // ——— Séries por track: DEDUP de repetições do resample (o grid de 500ms repete o último 'trk';
    // a histerese tem de rodar sobre OBSERVAÇÕES DISTINTAS da câmera, não sobre repetições do grid). ———
    type Obs = { ts: number; footImg: Vec2; footZone: Vec2; h: number; w: number };
    const byTrack = new Map<number, Obs[]>();
    let projFail = 0;
    for (const tk of ticks) {
      for (const t of tk.tracks) {
        const fi = foot(t.bbox);
        let fz: Vec2 | null = fi;
        if (H) fz = pixelToWorld(H, fi); // fronteira/zonas no MUNDO quando calibrado
        if (!fz) { projFail++; continue; }
        let arr = byTrack.get(t.id);
        if (!arr) { arr = []; byTrack.set(t.id, arr); }
        const prev = arr[arr.length - 1];
        if (prev && prev.footImg.x === fi.x && prev.footImg.y === fi.y) continue; // repetição do grid
        arr.push({ ts: tk.ts, footImg: fi, footZone: fz, h: t.bbox[3], w: t.bbox[2] });
      }
    }
    out.push(`tracks distintos: ${byTrack.size} | falhas de projeção (horizonte): ${projFail}`);

    // ——— Zonas plausíveis (~1/4 da cena cada), no espaço da fronteira, a partir da extensão real ———
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const arr of byTrack.values())
      for (const o of arr) {
        minX = Math.min(minX, o.footZone.x); maxX = Math.max(maxX, o.footZone.x);
        minY = Math.min(minY, o.footZone.y); maxY = Math.max(maxY, o.footZone.y);
      }
    const wS = maxX - minX, hS = maxY - minY;
    const zones: Zone[] = [
      { id: "quadrante-inf-esq", poly: rect(minX, minY, minX + wS / 2, minY + hS / 2) },
      { id: "centro", poly: rect(minX + wS / 4, minY + hS / 4, minX + (3 * wS) / 4, minY + (3 * hS) / 4) },
    ];
    out.push(`extensão da cena (pé): x[${f3(minX)},${f3(maxX)}] y[${f3(minY)},${f3(maxY)}]`);
    out.push(`histerese: confirmTicks=${CONFIRM} (observações DISTINTAS consecutivas)`);

    // ——— Fronteira por zona ———
    out.push("");
    out.push("=== (H2) CONFIABILIDADE DA FRONTEIRA ===");
    const EPHEMERAL_MAX_OBS = 1; // track de 1 observação = blip (nasce E morre no mesmo tick)
    for (const zone of zones) {
      let crossings = 0, clean = 0, rawTransitions = 0, shortExcursions = 0, tracksTouching = 0;
      let everInside = 0, crossedCleanly = 0, onlyBornDied = 0; // tracks que interagem com o interior
      let bornEph = 0, diedEph = 0; // nasceu/morreu-dentro de blips (1 obs) — não é permanência real
      const bouncesDist: number[] = [];
      const allEvents: ZoneEvent[] = [];
      for (const arr of byTrack.values()) {
        const track: ZoneSample[] = arr.map((o) => ({ ts: o.ts, foot: o.footZone }));
        // Membership cru + transições/excursões curtas (cruzamentos POTENCIALMENTE PERDIDOS pela histerese).
        const raw = track.map((s) => pointInPolygon(s.foot, zone.poly));
        let flips = 0, runLen = 1, touched = false;
        for (let i = 1; i < raw.length; i++) {
          if (raw[i] !== raw[i - 1]) { flips++; touched = true; if (runLen < CONFIRM) shortExcursions++; runLen = 1; }
          else runLen++;
        }
        rawTransitions += flips;
        if (touched) tracksTouching++;
        const wasInside = raw.some(Boolean);
        if (wasInside) everInside++;
        const ev = trackZoneEvents(track, zone, { confirmTicks: CONFIRM });
        let trackCrossings = 0, trackBorn = 0, trackDied = 0;
        for (const e of ev) {
          allEvents.push(e);
          if (e.kind === "entrou" || e.kind === "saiu") {
            crossings++; trackCrossings++;
            if (e.bounces === 0) clean++;
            bouncesDist.push(e.bounces);
          } else if (e.kind === "nasceu-dentro") { trackBorn++; if (arr.length <= EPHEMERAL_MAX_OBS) bornEph++; }
          else if (e.kind === "morreu-dentro") { trackDied++; if (arr.length <= EPHEMERAL_MAX_OBS) diedEph++; }
        }
        if (wasInside) {
          if (trackCrossings > 0) crossedCleanly++;
          else if (trackBorn > 0 || trackDied > 0) onlyBornDied++;
        }
      }
      const occ = zoneOccupancy(allEvents);
      out.push(`zona "${zone.id}":`);
      out.push(`  tracks tocando a fronteira: ${tracksTouching} | transições CRUAS (flips): ${rawTransitions} | excursões curtas (<${CONFIRM} obs, cruzamento p/ perder): ${shortExcursions}`);
      out.push(`  cruzamentos CONFIRMADOS: ${crossings} | LIMPOS (bounces=0): ${clean} | OSCILANTES: ${crossings - clean} | TAXA LIMPA: ${crossings > 0 ? ((100 * clean) / crossings).toFixed(1) + "%" : "— (nenhum)"}`);
      if (bouncesDist.length > 0)
        out.push(`  bounces/cruzamento: p50=${pct(bouncesDist, 0.5)} p90=${pct(bouncesDist, 0.9)} max=${Math.max(...bouncesDist)}`);
      out.push(`  nasceu-dentro: ${occ.bornInside} (blips 1-obs: ${bornEph}) | morreu-dentro: ${occ.diedInside} (blips 1-obs: ${diedEph}) | ocupação[min=${occ.minOcc} max=${occ.maxOcc} final=${occ.endOcc}]`);
      out.push(`  tracks que estiveram DENTRO: ${everInside} | entraram/saíram por cruzamento LIMPO da fronteira: ${crossedCleanly} | SÓ nasceram/morreram dentro (fronteira nunca viu): ${onlyBornDied}`);
    }

    // ——— §3: features dos tracks ESTÁTICOS (maxDisp<0,02 no espaço IMAGEM, como a mineração anterior) ———
    out.push("");
    out.push("=== (§3) TRACKS ESTÁTICOS — features que ajudam a separar MOBÍLIA de PESSOA PARADA ===");
    const STATIC_MAXDISP = 0.02;
    type Feat = { durS: number; medH: number; medArea: number; medAspect: number; cx: number; cy: number };
    const staticF: Feat[] = [], movingF: Feat[] = [];
    for (const arr of byTrack.values()) {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      const hs: number[] = [], areas: number[] = [], aspects: number[] = [], cxs: number[] = [], cys: number[] = [];
      for (const o of arr) {
        mnx = Math.min(mnx, o.footImg.x); mxx = Math.max(mxx, o.footImg.x);
        mny = Math.min(mny, o.footImg.y); mxy = Math.max(mxy, o.footImg.y);
        hs.push(o.h); areas.push(o.h * o.w); aspects.push(o.w > 1e-6 ? o.h / o.w : 0);
        cxs.push(o.footImg.x); cys.push(o.footImg.y);
      }
      const maxDisp = Math.hypot(mxx - mnx, mxy - mny); // diâmetro da nuvem do pé (espaço imagem)
      const durS = (arr[arr.length - 1].ts - arr[0].ts) / 1000;
      const feat: Feat = { durS, medH: pct(hs, 0.5), medArea: pct(areas, 0.5), medAspect: pct(aspects, 0.5), cx: pct(cxs, 0.5), cy: pct(cys, 0.5) };
      (maxDisp < STATIC_MAXDISP ? staticF : movingF).push(feat);
    }
    const dumpCol = (label: string, sel: (f: Feat) => number, rows: Feat[]) => {
      const xs = rows.map(sel).filter(Number.isFinite);
      out.push(`  ${label.padEnd(22)} p10=${f3(pct(xs, 0.1))} p50=${f3(pct(xs, 0.5))} p90=${f3(pct(xs, 0.9))}`);
    };
    const spread = (rows: Feat[]) => {
      const cx = rows.map((r) => r.cx), cy = rows.map((r) => r.cy);
      const std = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); };
      return `stdX=${f3(std(cx))} stdY=${f3(std(cy))}`;
    };
    // A cauda PERSISTENTE dos estáticos (dur>=3s) é onde vivem MOBÍLIA e OPERADOR PARADO — os blips
    // de 1-2 obs não são nem um nem outro. Isolar essa subpopulação é o 1º passo para o dono julgar.
    const PERSIST_S = 3;
    const persistF = staticF.filter((f) => f.durS >= PERSIST_S);
    out.push(`ESTÁTICOS (maxDisp<${STATIC_MAXDISP}): ${staticF.length} tracks (dos quais PERSISTENTES dur>=${PERSIST_S}s: ${persistF.length}) | MÓVEIS: ${movingF.length} tracks`);
    out.push(` estáticos TODOS — distribuição:`);
    dumpCol("duração (s)", (f) => f.durS, staticF);
    dumpCol("altura bbox (norm)", (f) => f.medH, staticF);
    dumpCol("área bbox (norm²)", (f) => f.medArea, staticF);
    dumpCol("aspect h/w (pessoa~2-3)", (f) => f.medAspect, staticF);
    out.push(`  posição estáticos: ${spread(staticF)} (spread baixo=aglomerado em pontos fixos=mobília; alto=ruído espalhado)`);
    out.push(` estáticos PERSISTENTES (dur>=${PERSIST_S}s — mobília + operador parado vivem aqui):`);
    dumpCol("duração (s)", (f) => f.durS, persistF);
    dumpCol("altura bbox (norm)", (f) => f.medH, persistF);
    dumpCol("área bbox (norm²)", (f) => f.medArea, persistF);
    dumpCol("aspect h/w (pessoa~2-3)", (f) => f.medAspect, persistF);
    out.push(`  posição persistentes: ${spread(persistF)}`);
    out.push(` MÓVEIS (contraste) — distribuição:`);
    dumpCol("duração (s)", (f) => f.durS, movingF);
    dumpCol("altura bbox (norm)", (f) => f.medH, movingF);
    dumpCol("área bbox (norm²)", (f) => f.medArea, movingF);
    dumpCol("aspect h/w", (f) => f.medAspect, movingF);
    out.push("ZONE-REPORT-END");

    console.log(out.join("\n"));
    expect(byTrack.size).toBeGreaterThan(0);
  });
});
