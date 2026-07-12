// Triagem de tracks quase-estáticos: unidade (sintético controlado) + MEDIÇÃO na gravação de campo.
// A gravação é READ-ONLY (CLAUDE.md §3) — este teste só LÊ. Bloco de campo GATED por existência do
// arquivo (runtime/gitignored — ausente no CI → SKIP), mesmo padrão do bloco real de visit-metrics.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  buildTrackEpisodes,
  dedupeHeldFrames,
  estimateJitterFloor,
  findStaticHotspots,
  occupancyByVerdict,
  sessionBounds,
  triageSession,
  triageTrackEpisode,
  type TrackTick,
  type TriageVerdict,
} from "./static-tracks-triage";
import { parseFusionSession } from "./session-loader";
import { wilsonInterval } from "./visit-metrics";
import { pixelToWorld } from "../vision/homography";
import type { Matrix3 } from "../vision/homography";

/** Deslocamento MÁXIMO do pé em METROS (leva o pé pela homografia calibrada da sessão) — a régua
 *  física que fecha a pergunta "isto pode ser uma cadeira?". null se a sessão não tem H. */
function maxFootDispMeters(frames: readonly { bbox: readonly [number, number, number, number] }[], H: Matrix3 | null): number | null {
  if (!H) return null;
  const pts: { x: number; y: number }[] = [];
  for (const f of frames) {
    const w = pixelToWorld(H, { x: f.bbox[0] + f.bbox[2] / 2, y: f.bbox[1] + f.bbox[3] });
    if (w) pts.push(w);
  }
  let max = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      if (d > max) max = d;
    }
  }
  return max;
}

/** Gera ticks de UM track a partir de uma função de caixa por índice. */
function ticksOf(
  id: number,
  n: number,
  dtMs: number,
  box: (i: number) => [number, number, number, number],
  t0 = 0,
): TrackTick[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: t0 + i * dtMs,
    tracks: [{ id, bbox: box(i) }],
  }));
}

/** Funde ticks do MESMO ts (a sessão vê todos os tracks presentes juntos, num snapshot só). */
function mergeTicks(...groups: TrackTick[][]): TrackTick[] {
  const merged = new Map<number, TrackTick>();
  for (const tk of groups.flat()) {
    const cur = merged.get(tk.ts);
    if (cur) cur.tracks = [...cur.tracks, ...tk.tracks];
    else merged.set(tk.ts, { ts: tk.ts, tracks: [...tk.tracks] });
  }
  return [...merged.values()].sort((a, b) => a.ts - b.ts);
}

/** Ruído determinístico (LCG) — testes reprodutíveis sem dependência. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5; // −0,5..0,5
  };
}

describe("static-tracks-triage — hold, episódios e piso de jitter", () => {
  it("dedupeHeldFrames desfaz o sample-and-hold do resample (caixa idêntica repetida não é frame novo)", () => {
    const b: [number, number, number, number] = [0.1, 0.1, 0.2, 0.5];
    const c: [number, number, number, number] = [0.1, 0.1, 0.2, 0.51];
    const fresh = dedupeHeldFrames([
      { ts: 0, bbox: b },
      { ts: 500, bbox: b },
      { ts: 1000, bbox: b },
      { ts: 1500, bbox: c },
      { ts: 2000, bbox: c },
    ]);
    expect(fresh.map((f) => f.ts)).toEqual([0, 1500]); // 5 ticks → 2 observações REAIS
  });

  it("quebra episódio na AUSÊNCIA da pista (mesma definição do visit-metrics) — reaparecer = 2 episódios", () => {
    const b: [number, number, number, number] = [0.1, 0.1, 0.2, 0.5];
    const eps = buildTrackEpisodes([
      { ts: 0, tracks: [{ id: 7, bbox: b }] },
      { ts: 500, tracks: [] },
      { ts: 1000, tracks: [{ id: 7, bbox: [0.3, 0.1, 0.2, 0.5] }] },
    ]);
    expect(eps).toHaveLength(2);
    expect(eps.every((e) => e.trackId === 7)).toBe(true);
  });

  it("estimateJitterFloor é o passo mediano do episódio MAIS QUIETO (teto do ruído do detector)", () => {
    const quiet = ticksOf(1, 10, 1000, (i) => [0.1 + (i % 2) * 0.001, 0.1, 0.2, 0.5]);
    const mover = ticksOf(2, 10, 1000, (i) => [0.5 + i * 0.05, 0.1, 0.2, 0.5]);
    const floor = estimateJitterFloor(buildTrackEpisodes(mergeTicks(quiet, mover)));
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(0.01); // o quieto manda, não o que anda 0,05/frame
  });
});

describe("static-tracks-triage — o voto separa MOBÍLIA de PESSOA PARADA no caso controlado", () => {
  const bounds = (t: TrackTick[]) => sessionBounds(t);

  it("MOBÍLIA: caixa imóvel (só jitter), altura constante, do 1º ao ÚLTIMO frame da sessão", () => {
    const r = rng(1);
    const t = ticksOf(1, 60, 6000, () => [
      0.4 + r() * 0.002,
      0.3 + r() * 0.002,
      0.2 + r() * 0.001,
      0.5 + r() * 0.002,
    ]);
    const [ep] = buildTrackEpisodes(t);
    const tri = triageTrackEpisode(ep, t, bounds(t), 0);
    expect(tri.verdict).toBe("MOBILIA");
    expect(tri.maxFootDispBw).toBeLessThan(0.1);
    expect(tri.heightCv).toBeLessThan(0.03);
    expect(tri.bornAtSessionStart && tri.diedAtSessionEnd).toBe(true);
  });

  it("PESSOA PARADA: pé quase fixo, mas a ALTURA muda (postura) e ela nasce/morre no meio da sessão", () => {
    const r = rng(2);
    // Sessão: 100 frames; a pessoa só existe entre 20 e 70 (mobília ocupa o resto → bordas da sessão).
    const furniture = ticksOf(9, 100, 6000, () => [0.05, 0.05, 0.1, 0.2]);
    const person = ticksOf(
      1,
      50,
      6000,
      (i) => [
        0.4 + r() * 0.004, // pé praticamente parado (não relocaliza)
        0.3 + (i % 7 < 3 ? 0.12 : 0), // inclina-se: o TOPO desce…
        0.2 + r() * 0.004,
        0.5 - (i % 7 < 3 ? 0.12 : 0), // …e a ALTURA encolhe (postura) — o PÉ fica no lugar
      ],
      20 * 6000,
    );
    const tri = triageSession(mergeTicks(furniture, person));
    const p = tri.find((x) => x.trackId === 1)!;
    const f = tri.find((x) => x.trackId === 9)!;
    expect(p.verdict).toBe("PESSOA_PARADA"); // postura + ciclo de vida = 2/3, SEM ter andado
    expect(p.maxFootDispBw).toBeLessThan(0.5); // e de fato NÃO relocalizou — deslocamento não decidiu
    expect(f.verdict).toBe("MOBILIA");
  });

  it("INCONCLUSIVO é resultado legítimo: imóvel, altura estável, mas nasce/morre no meio", () => {
    const r = rng(3);
    const furniture = ticksOf(9, 40, 6000, () => [0.05, 0.05, 0.1, 0.2]);
    const ambiguous = ticksOf(
      1,
      10,
      6000,
      () => [0.4 + r() * 0.002, 0.3, 0.2, 0.5 + r() * 0.002],
      10 * 6000,
    );
    const tri = triageSession(mergeTicks(furniture, ambiguous));
    const a = tri.find((x) => x.trackId === 1)!;
    expect(a.verdict).toBe("INCONCLUSIVO"); // só 1/3 (ciclo de vida) — não força veredito
  });

  it("occupancyByVerdict conta TRACK-TICKS (a unidade da ocupação), não episódios — mobília longa pesa", () => {
    // Mobília eterna (40 ticks) + um blip humano de 2 ticks: por EPISÓDIO seria 50/50; a OCUPAÇÃO
    // (o que o bookkeeping soma) é dominada pela mobília. É essa a fração que quebra L0/L1.
    const furniture = ticksOf(9, 40, 6000, () => [0.05, 0.05, 0.1, 0.2]);
    const person = ticksOf(1, 2, 6000, (i) => [0.4 + i * 0.3, 0.3, 0.2, 0.5 - i * 0.1], 10 * 6000);
    const ticks = mergeTicks(furniture, person);
    const occ = occupancyByVerdict(ticks, triageSession(ticks));
    expect(occ.total).toBe(42);
    expect(occ.MOBILIA).toBe(40);
    expect(occ.unmatched).toBe(0);
    expect(occ.mobiliaShare).toBeCloseTo(40 / 42, 5);
  });

  it("findStaticHotspots PEGA a mobília PISCANDO — que escapa inteira do teste de ciclo de vida", () => {
    // Uma cadeira que o detector só vê às vezes: 20 episódios CURTOS, ids DIFERENTES, espalhados por
    // toda a sessão, SEMPRE no mesmo pé. Nenhum deles nasce no 1º nem morre no último frame → o
    // discriminante de ciclo de vida a declara "não-mobília". O hotspot a denuncia.
    const flicker: TrackTick[] = [];
    for (let k = 0; k < 20; k++) {
      flicker.push(...ticksOf(100 + k, 2, 6000, () => [0.7, 0.6, 0.1, 0.2], (2 + k * 5) * 6000));
    }
    const walker = ticksOf(1, 110, 6000, (i) => [0.02 + i * 0.008, 0.2, 0.1, 0.3]);
    const tri = triageSession(mergeTicks(walker, flicker));
    const stat = tri.filter((t) => t.maxFootDispImg < 0.02);
    expect(stat.every((t) => !(t.bornAtSessionStart && t.diedAtSessionEnd))).toBe(true); // escapou

    const hs = findStaticHotspots(stat);
    expect(hs[0].nEpisodes).toBe(20); // os 20 blips caem NO MESMO LOCAL
    expect(hs[0].spanMs).toBeGreaterThan(90 * 6000); // e o local segue devolvendo episódio a sessão TODA
    expect(hs[0].x).toBeCloseTo(0.75, 2); // o pé do objeto fixo (x + w/2)
  });

  it("occupancyByVerdict = 0 de mobília quando ninguém é mobília (bookkeeping limpo)", () => {
    const t = ticksOf(1, 10, 6000, (i) => [0.1 + i * 0.05, 0.2, 0.2, 0.5]);
    const occ = occupancyByVerdict(t, triageSession(t));
    expect(occ.mobiliaShare).toBe(0);
    expect(occ.total).toBe(10);
  });

  it("REGRA 9: a Δt de campo (~6 s) NÃO resolve balanço postural — micro-movimento fica fora do voto", () => {
    const t = ticksOf(1, 20, 6000, (i) => [0.4, 0.3 + i * 0.0001, 0.2, 0.5]);
    const [ep] = buildTrackEpisodes(t);
    expect(triageTrackEpisode(ep, t, sessionBounds(t), 0).microMovementResolvable).toBe(false);
    const fast = ticksOf(1, 20, 500, (i) => [0.4, 0.3 + i * 0.0001, 0.2, 0.5]);
    const [epf] = buildTrackEpisodes(fast);
    expect(triageTrackEpisode(epf, fast, sessionBounds(fast), 0).microMovementResolvable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// MEDIÇÃO NA GRAVAÇÃO DE CAMPO — os episódios LONGOS (>60 s) que a triagem por deslocamento havia
// jogado no balde "mobília". READ-ONLY. Relatório entre TRIAGE-REPORT-BEGIN/END.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const FILES = [
  "server/bt/fusion-session-2026-07-11_20.jsonl",
  "server/bt/fusion-session-2026-07-11_19.jsonl",
];
const FILE = FILES.find((f) => existsSync(f));
const LONG_MS = 60_000;

describe.skipIf(!FILE)("TRIAGEM dos episódios longos — gravação de campo (READ-ONLY)", () => {
  it("classifica cada episódio >60 s com discriminantes físicos (e declara o que não dá para separar)", () => {
    const lines = readFileSync(FILE!, "utf8").split(/\r?\n/);
    const scenario = parseFusionSession(lines, {});
    const ticks: TrackTick[] = scenario.ticks.map((t) => ({ ts: t.ts, tracks: t.tracks }));

    const episodes = buildTrackEpisodes(ticks);
    const all = triageSession(ticks);
    const long = all.filter((t) => t.durationMs > LONG_MS).sort((a, b) => b.durationMs - a.durationMs);
    const floor = estimateJitterFloor(episodes);
    const framesOf = (trackId: number, startTs: number) =>
      episodes.find((e) => e.trackId === trackId && e.startTs === startTs)?.frames ?? [];

    // Coexistência com BLE: alguma tag APARECE/SOME junto com um track? (indício, não prova — e o
    // RSSI absoluto NÃO decide, regra nº6 da casa.)
    const macPresence = new Map<string, { n: number; first: number; last: number }>();
    let bleTicks = 0;
    for (const t of scenario.ticks) {
      if (t.readings.length === 0) continue;
      bleTicks++;
      for (const r of t.readings) {
        const cur = macPresence.get(r.mac);
        if (cur) {
          cur.n++;
          cur.last = t.ts;
        } else macPresence.set(r.mac, { n: 1, first: t.ts, last: t.ts });
      }
    }

    const out: string[] = ["TRIAGE-REPORT-BEGIN", `arquivo: ${FILE}`];
    const b = sessionBounds(ticks);
    out.push(
      `sessão: ${((b.lastTs - b.firstTs) / 1000 / 60).toFixed(1)} min | ticks ${ticks.length} | ` +
        `episódios de track: ${all.length} | >60 s: ${long.length}`,
    );
    out.push(
      `PISO DE JITTER do detector (teto, estimado do próprio dado): ${floor.toFixed(5)} img — ` +
        `deslocamentos abaixo disso são indistinguíveis de ruído.`,
    );
    out.push(
      `RESOLUÇÃO: Δt mediano entre snapshots de track = ${long[0]?.dtMedianS.toFixed(1) ?? "?"} s → ` +
        `micro-movimento (balanço postural, ~1 Hz) ALIASADO. Regra 9: NÃO usado no voto.`,
    );
    out.push("— episódios LONGOS (>60 s) —");
    for (const t of long) {
      const m = maxFootDispMeters(framesOf(t.trackId, t.startTs), scenario.H);
      out.push(
        `  track ${String(t.trackId).padStart(3)} | ${(t.durationMs / 1000).toFixed(0).padStart(4)}s | ` +
          `${String(t.nFrames).padStart(3)} frames | pé ${t.maxFootDispBw.toFixed(2)} bw ` +
          `(${t.maxFootDispImg.toFixed(3)} img${m === null ? "" : `, ${m.toFixed(2)} m`}) | caminho ${t.pathLenBw.toFixed(1)} bw | ` +
          `hCV ${(t.heightCv * 100).toFixed(1)}% wCV ${(t.widthCv * 100).toFixed(1)}% | ` +
          `nasc/morte ${t.bornAtSessionStart ? "INÍCIO" : "meio"}/${t.diedAtSessionEnd ? "FIM" : "meio"} | ` +
          `IoU máx ${t.maxIoUWithOthers.toFixed(2)} | resid ${t.residualStdImg.toFixed(4)} lag1 ${t.residualLag1.toFixed(2)} | ` +
          `→ ${t.verdict}`,
      );
      for (const r of t.reasons) out.push(`      · ${r}`);
      if (m !== null) {
        out.push(
          `      · DESLOCAMENTO EM METROS (homografia calibrada da sessão): ${m.toFixed(2)} m — ` +
            `a régua física: mobília não anda ${m.toFixed(2)} m.`,
        );
      }
    }
    // Os CURTOS também importam: se houver mobília contada como pessoa, ela apareceria AQUI (blips).
    out.push("— demais episódios (≤60 s) — a ocupação também os conta —");
    for (const t of all
      .filter((x) => x.durationMs <= LONG_MS)
      .sort((a, b) => b.durationMs - a.durationMs)) {
      out.push(
        `  track ${String(t.trackId).padStart(3)} | ${(t.durationMs / 1000).toFixed(0).padStart(4)}s | ` +
          `${String(t.nFrames).padStart(3)} frames | pé ${t.maxFootDispBw.toFixed(2)} bw | ` +
          `hCV ${(t.heightCv * 100).toFixed(1)}% | → ${t.verdict}`,
      );
    }
    out.push("— coexistência BLE (presença de tag × existência de track) —");
    for (const [mac, p] of macPresence) {
      out.push(
        `  ${mac}: presente em ${((p.n / Math.max(bleTicks, 1)) * 100).toFixed(0)}% dos ticks com BLE, ` +
          `de +${(p.first / 1000).toFixed(0)}s a +${(p.last / 1000).toFixed(0)}s`,
      );
    }
    const counts = { PESSOA_PARADA: 0, MOBILIA: 0, INCONCLUSIVO: 0 };
    for (const t of long) counts[t.verdict]++;
    // O discriminante mais DURO e mais barato: mobília existe ANTES da câmera ligar e DEPOIS dela.
    const eternal = all.filter((t) => t.bornAtSessionStart && t.diedAtSessionEnd).length;
    out.push(
      `CICLO DE VIDA (o discriminante duro): ${eternal}/${all.length} episódios existem do PRIMEIRO ao ` +
        `ÚLTIMO frame da sessão — a assinatura obrigatória da mobília. ${
          eternal === 0 ? "NENHUM. Todo track NASCE e MORRE dentro da hora." : ""
        }`,
    );
    out.push(
      `VEREDITO (episódios >60 s): PESSOA_PARADA=${counts.PESSOA_PARADA} MOBILIA=${counts.MOBILIA} ` +
        `INCONCLUSIVO=${counts.INCONCLUSIVO}`,
    );
    out.push("TRIAGE-REPORT-END");
    console.log(out.join("\n"));

    expect(all.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// MEDIÇÃO NA GRAVAÇÃO PASSIVA (server/bt/fusion-session.jsonl) — A LACUNA: a mineração de
// fragmentação (adendo 2026-07-11 §3) achou ~988 tracks, dos quais ~484 "estáticos" (maxDisp<0,02),
// e os JOGOU no balde "mobília/flicker" SEM TRIAR. Se forem mobília, é BUG DE OCUPAÇÃO — e a
// ocupação é a base do `pessoas − tags` (zone-assignment.ts) e dos tokens da conservação por zona
// (petri-conservation.ts), o bookkeeping que sustenta L0/L1. READ-ONLY (CLAUDE.md §3).
// Relatório entre PASSIVE-TRIAGE-REPORT-BEGIN/END.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const PASSIVE_FILE = "server/bt/fusion-session.jsonl";
/** O MESMO corte da mineração antiga (deslocamento máximo do pé, em fração de imagem). */
const STATIC_DISP_IMG = 0.02;

describe.skipIf(!existsSync(PASSIVE_FILE))(
  "TRIAGEM dos tracks ESTÁTICOS — gravação PASSIVA (READ-ONLY)",
  () => {
    it("mede quantos são mobília, quanto isso vale em OCUPAÇÃO, e declara o que o dado não separa", () => {
      const lines = readFileSync(PASSIVE_FILE, "utf8").split(/\r?\n/);
      const out: string[] = ["PASSIVE-TRIAGE-REPORT-BEGIN", `arquivo: ${PASSIVE_FILE}`];

      // A gravação passiva é MULTI-CÂMERA. O loader replaya UMA por vez; triar só a "primeira vista"
      // esconderia a outra. Descobre as câmeras pelo próprio arquivo e roda todas.
      const cams = new Set<string>();
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const o = JSON.parse(l) as { t?: string; cameraId?: string };
          if ((o.t === "trk" || o.t === "cal") && typeof o.cameraId === "string")
            cams.add(o.cameraId);
        } catch {
          /* linha suja — o loader já a conta no diag */
        }
      }

      const pct = (a: number, n: number): string => {
        const w = wilsonInterval(a, n);
        return `${((a / Math.max(n, 1)) * 100).toFixed(1)}% [IC95 ${(w.lo * 100).toFixed(1)}–${(w.hi * 100).toFixed(1)}%]`;
      };
      const q = (xs: number[], p: number): string =>
        xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(1) : "?";

      let grandStatic = 0;
      let grandEternalStatic = 0;
      const grandVerdict: Record<TriageVerdict, number> = {
        PESSOA_PARADA: 0,
        MOBILIA: 0,
        INCONCLUSIVO: 0,
      };
      let grandOccTotal = 0;
      let grandOccMobilia = 0;
      let grandOccStatic = 0;
      let suspectOccMs = 0;
      let totalOccMs = 0;

      for (const cam of cams) {
        const scenario = parseFusionSession(lines, {}, { cameraId: cam });
        const ticks: TrackTick[] = scenario.ticks.map((t) => ({ ts: t.ts, tracks: t.tracks }));
        if (ticks.length === 0) {
          out.push(`\n═══ câmera ${cam}: nenhum tick de track (só "cal") — nada a triar`);
          continue;
        }
        const episodes = buildTrackEpisodes(ticks);
        const all = triageSession(ticks);
        const b = sessionBounds(ticks);
        const occ = occupancyByVerdict(ticks, all);

        out.push(`\n═══ câmera ${cam}`);
        out.push(
          `  CALIBRAÇÃO: H ${
            scenario.H
              ? "PRESENTE → deslocamento em METROS disponível"
              : "AUSENTE (null) → SEM homografia: o deslocamento em METROS NÃO EXISTE para esta câmera. Discriminante em UNIDADES DE IMAGEM (e em larguras de corpo, escala-livre). LIMITAÇÃO REAL, declarada."
          }`,
        );
        out.push(
          `  sessão ${((b.lastTs - b.firstTs) / 60000).toFixed(1)} min | ticks ${ticks.length} | ` +
            `episódios ${all.length} | ids distintos ${new Set(episodes.map((e) => e.trackId)).size}`,
        );
        const dts = all
          .filter((t) => t.nFrames >= 3)
          .map((t) => t.dtMedianS)
          .sort((x, y) => x - y);
        out.push(
          `  Δt mediano dos snapshots (entre episódios ≥3 frames): ${q(dts, 0.5)} s → ` +
            `REGRA 9: balanço postural (~0,1–1 Hz) ALIASADO ⇒ micro-movimento FORA do voto.`,
        );
        out.push(
          `  piso de jitter do detector (TETO, estimado do próprio dado): ${estimateJitterFloor(episodes).toFixed(5)} img`,
        );

        // ——— 1. O DISCRIMINANTE DURO (não depende de cinemática fina) ———
        const eternal = all.filter((t) => t.bornAtSessionStart && t.diedAtSessionEnd);
        out.push(
          `  DISCRIMINANTE DURO — presentes do 1º ao ÚLTIMO frame da sessão (assinatura OBRIGATÓRIA ` +
            `da mobília): ${eternal.length}/${all.length} (${pct(eternal.length, all.length)})`,
        );

        // ——— 2. A POPULAÇÃO DA LACUNA: os "estáticos" (maxDisp < 0,02 img) ———
        const stat = all.filter((t) => t.maxFootDispImg < STATIC_DISP_IMG);
        const statEternal = stat.filter((t) => t.bornAtSessionStart && t.diedAtSessionEnd);
        const v: Record<TriageVerdict, number> = {
          PESSOA_PARADA: 0,
          MOBILIA: 0,
          INCONCLUSIVO: 0,
        };
        for (const t of stat) v[t.verdict]++;
        out.push(
          `  ESTÁTICOS (pé < ${STATIC_DISP_IMG} img — o balde que a fragmentação descartou sem triar): ` +
            `${stat.length}/${all.length} (${pct(stat.length, all.length)})`,
        );
        out.push(
          `    · destes, presentes do 1º ao ÚLTIMO frame (candidatos FORTES a mobília): ` +
            `${statEternal.length} (${pct(statEternal.length, stat.length)})`,
        );
        out.push(
          `    · VEREDITO: MOBILIA=${v.MOBILIA} (${pct(v.MOBILIA, stat.length)}) | ` +
            `PESSOA_PARADA=${v.PESSOA_PARADA} (${pct(v.PESSOA_PARADA, stat.length)}) | ` +
            `INCONCLUSIVO=${v.INCONCLUSIVO} (${pct(v.INCONCLUSIVO, stat.length)})`,
        );
        const dur = stat.map((t) => t.durationMs / 1000).sort((x, y) => x - y);
        const hcv = stat.map((t) => t.heightCv * 100).sort((x, y) => x - y);
        const nfr = stat.map((t) => t.nFrames).sort((x, y) => x - y);
        out.push(
          `    · vida (s): mediana ${q(dur, 0.5)} | p90 ${q(dur, 0.9)} | máx ${q(dur, 1)} · ` +
            `hCV (%): mediana ${q(hcv, 0.5)} | p90 ${q(hcv, 0.9)} · ` +
            `frames FRESCOS: mediana ${q(nfr.map(Number), 0.5)} (evidência por episódio)`,
        );

        // ——— 3. O NÚMERO DO PRODUTO: fração da OCUPAÇÃO (track-ticks) que seria mobília ———
        // Índice por trackId (busca linear por tick seria O(ticks × tracks × episódios) — a sessão
        // tem ~20 k ticks e ~1 k episódios).
        const byTrack = new Map<number, typeof all>();
        for (const t of all) {
          const arr = byTrack.get(t.trackId);
          if (arr) arr.push(t);
          else byTrack.set(t.trackId, [t]);
        }
        const staticKeys = new Set(stat.map((t) => `${t.trackId}@${t.startTs}`));
        let occStatic = 0;
        for (const tk of ticks) {
          for (const trk of tk.tracks) {
            const ep = byTrack
              .get(trk.id)
              ?.find((c) => tk.ts >= c.startTs && tk.ts <= c.endTs);
            if (ep && staticKeys.has(`${ep.trackId}@${ep.startTs}`)) occStatic++;
          }
        }
        const wOcc = wilsonInterval(occ.MOBILIA, occ.total);
        out.push(
          `  OCUPAÇÃO (track-ticks — a unidade que o bookkeeping soma): total ${occ.total} | ` +
            `MOBILIA ${occ.MOBILIA} | PESSOA_PARADA ${occ.PESSOA_PARADA} | ` +
            `INCONCLUSIVO ${occ.INCONCLUSIVO} | sem episódio ${occ.unmatched}`,
        );
        out.push(
          `  → FRAÇÃO DA OCUPAÇÃO QUE SERIA MOBÍLIA: ${(occ.mobiliaShare * 100).toFixed(2)}% ` +
            `[IC95 ${(wOcc.lo * 100).toFixed(2)}–${(wOcc.hi * 100).toFixed(2)}%] ` +
            `(a população "estática" inteira responde por ${pct(occStatic, occ.total)} da ocupação)`,
        );

        // ——— 4. O BURACO do ciclo de vida: MOBÍLIA PISCANDO (episódios curtos, mesmo LUGAR, sessão toda) ———
        // Uma cadeira mal detectada NÃO seria contínua — escaparia INTEIRA do teste de ciclo de vida.
        // O que ela NÃO consegue é sair do lugar. Span longo num mesmo pé = condição NECESSÁRIA de
        // mobília piscando (não é prova — posto de trabalho faz igual). Span curto em TODOS os locais
        // = hipótese REFUTADA (modus tollens).
        const sessionMs = Math.max(b.lastTs - b.firstTs, 1);
        const hs = findStaticHotspots(stat);
        const bigHs = hs.filter((h) => h.nEpisodes >= 3);
        out.push(
          `  HOTSPOTS ESTÁTICOS (mesmo pé, ±0,5 largura de corpo) — o teste da MOBÍLIA PISCANDO: ` +
            `${hs.length} locais distintos; com ≥3 episódios: ${bigHs.length}`,
        );
        for (const h of bigHs.slice(0, 6)) {
          out.push(
            `    local (${h.x.toFixed(2)}, ${h.y.toFixed(2)}) | caixa ${h.meanW.toFixed(3)}×${h.meanH.toFixed(3)} ` +
              `(aspecto ${(h.meanH / Math.max(h.meanW, 1e-6)).toFixed(1)}) | ${h.nEpisodes} episódios | ` +
              `span ${(h.spanMs / 60000).toFixed(1)} min = ${((h.spanMs / sessionMs) * 100).toFixed(0)}% da sessão | ` +
              `presença somada ${(h.presenceMs / 1000).toFixed(0)}s`,
          );
        }
        const maxSpanFrac = hs.length ? Math.max(...hs.map((h) => h.spanMs)) / sessionMs : 0;
        out.push(
          `    → maior span de um local estático: ${(maxSpanFrac * 100).toFixed(0)}% da sessão — ` +
            `${
              maxSpanFrac < 0.5
                ? "NENHUM local é re-populado pela sessão inteira ⇒ MOBÍLIA PISCANDO REFUTADA."
                : "HÁ local re-populado por meia sessão ou mais ⇒ mobília piscando NÃO refutada, INVESTIGAR."
            }`,
        );
        // TETO DO ERRO SOB A HIPÓTESE DO PIOR CASO: se TODO hotspot suspeito (≥3 episódios E span ≥
        // metade da sessão) FOSSE mobília piscando, quanta OCUPAÇÃO ele custaria? A grade é de 500 ms,
        // então track-tick × 500 ms = a mesma unidade de `presenceMs`. Isto é um LIMITE SUPERIOR
        // (quase certamente pessimista: posto de trabalho re-visitado produz o mesmo padrão).
        const suspect = hs.filter((h) => h.nEpisodes >= 3 && h.spanMs >= 0.5 * sessionMs);
        const suspectMs = suspect.reduce((a, h) => a + h.presenceMs, 0);
        const totalMs = occ.total * 500;
        suspectOccMs += suspectMs;
        totalOccMs += totalMs;
        out.push(
          `    → TETO do erro de ocupação SE todo hotspot suspeito (n=${suspect.length}) fosse mobília ` +
            `piscando: ${(suspectMs / 1000).toFixed(0)}s de ${(totalMs / 1000).toFixed(0)}s de presença = ` +
            `${((suspectMs / Math.max(totalMs, 1)) * 100).toFixed(2)}% da ocupação (LIMITE SUPERIOR, não medida)`,
        );

        // Os 10 estáticos mais LONGOS — se houvesse mobília, ela estaria AQUI (peso máximo na ocupação).
        out.push("  — os 10 estáticos de vida mais LONGA (onde a mobília se esconderia) —");
        for (const t of [...stat].sort((a, c) => c.durationMs - a.durationMs).slice(0, 10)) {
          const mts = maxFootDispMeters(
            episodes.find((e) => e.trackId === t.trackId && e.startTs === t.startTs)?.frames ?? [],
            scenario.H,
          );
          out.push(
            `    track ${String(t.trackId).padStart(4)} | ${(t.durationMs / 1000).toFixed(0).padStart(4)}s | ` +
              `${String(t.nFrames).padStart(3)} fr | pé ${t.maxFootDispImg.toFixed(4)} img ` +
              `(${t.maxFootDispBw.toFixed(2)} bw${mts === null ? ", METROS N/D — sem H" : `, ${mts.toFixed(2)} m`}) | ` +
              `hCV ${(t.heightCv * 100).toFixed(1)}% | ` +
              `${t.bornAtSessionStart ? "INÍCIO" : "meio"}/${t.diedAtSessionEnd ? "FIM" : "meio"} | ` +
              `IoU ${t.maxIoUWithOthers.toFixed(2)} | → ${t.verdict}`,
          );
        }

        grandStatic += stat.length;
        grandEternalStatic += statEternal.length;
        for (const k of Object.keys(v) as TriageVerdict[]) grandVerdict[k] += v[k];
        grandOccTotal += occ.total;
        grandOccMobilia += occ.MOBILIA;
        grandOccStatic += occStatic;
      }

      out.push("\n═══ CONSOLIDADO (todas as câmeras da gravação passiva)");
      out.push(
        `  ESTÁTICOS triados: n=${grandStatic} | presentes do 1º ao ÚLTIMO frame ` +
          `(mobília OBRIGATORIAMENTE estaria aqui): ${grandEternalStatic} ` +
          `(${pct(grandEternalStatic, grandStatic)})`,
      );
      out.push(
        `  VEREDITO: MOBILIA=${grandVerdict.MOBILIA} (${pct(grandVerdict.MOBILIA, grandStatic)}) | ` +
          `PESSOA_PARADA=${grandVerdict.PESSOA_PARADA} (${pct(grandVerdict.PESSOA_PARADA, grandStatic)}) | ` +
          `INCONCLUSIVO=${grandVerdict.INCONCLUSIVO} (${pct(grandVerdict.INCONCLUSIVO, grandStatic)})`,
      );
      out.push(
        `  FRAÇÃO DA OCUPAÇÃO QUE SERIA MOBÍLIA (voto — mobília CONTÍNUA): ` +
          `${((grandOccMobilia / Math.max(grandOccTotal, 1)) * 100).toFixed(2)}% ` +
          `(${grandOccMobilia}/${grandOccTotal} track-ticks) · ` +
          `os estáticos como um todo = ${pct(grandOccStatic, grandOccTotal)} da ocupação medida`,
      );
      out.push(
        `  TETO do erro sob a hipótese MOBÍLIA PISCANDO (SE todo hotspot suspeito fosse móvel): ` +
          `${((suspectOccMs / Math.max(totalOccMs, 1)) * 100).toFixed(2)}% da ocupação ` +
          `(${(suspectOccMs / 1000).toFixed(0)}s de ${(totalOccMs / 1000).toFixed(0)}s de presença) — ` +
          `LIMITE SUPERIOR pessimista, não medida.`,
      );
      out.push("PASSIVE-TRIAGE-REPORT-END");
      console.log(out.join("\n"));

      expect(grandStatic).toBeGreaterThan(0);
      // Timeout generoso: a sessão passiva tem ~2,7 h de dado (≈33 k ticks × 3 câmeras) e o teste
      // roda em paralelo com a suíte inteira — os 5 s default do vitest não bastam.
    }, 120_000);
  },
);
