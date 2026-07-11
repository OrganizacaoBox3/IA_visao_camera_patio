// FUNIL DE VETOS sobre GRAVAÇÃO DE CAMPO — teste GATED por env (o motor do scripts/funnel.mjs).
//
// POR QUE GATED (mesmo padrão do FAMILY_FULL de families.test.ts): o arquivo real
// (server/bt/fusion-session.jsonl) é RUNTIME/gitignored — NÃO existe no CI. Sem FUNNEL_FILE o
// teste é SKIP (CI intacto); com FUNNEL_FILE apontando o JSONL, roda o diagnóstico completo e
// imprime o relatório entre marcadores FUNNEL-REPORT-BEGIN/END (o script extrai esse bloco).
// LEITURA APENAS: a gravação de campo é artefato imutável (CLAUDE.md §3) — este teste só lê.
//
// O relatório responde às perguntas do especialista científico (diagnóstico do 1º teste de campo
// que falhou em silêncio, 2026-07-10):
//  (a) resumo por câmera: eventos, janela temporal, pistas, cadência BLE (inter-arrival mediano
//      por tag vs o que o associador precisa: minSamples amostras DISTINTAS dentro de windowMs);
//  (b) por câmera diagnosticada: o HISTOGRAMA de verdicts (onde os pares morrem, tick×par) e os
//      pares que chegaram mais perto de falar (maior score entre os vetados).
// FUNNEL_CAMERA restringe o funil a uma câmera; sem ela, TODAS as câmeras vistas são diagnosticadas.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { diagnoseFusionSession } from "./session-loader";
import type { PairFunnel } from "./associate";

const FILE = process.env.FUNNEL_FILE;
const CAMERA = process.env.FUNNEL_CAMERA;

/** Mediana (xs não-vazio). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtTs = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);
const fmtN = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));

describe.skipIf(!FILE)("funil de vetos — gravação de campo (FUNNEL_FILE)", () => {
  it("diagnostica a sessão e imprime o relatório do funil", () => {
    const lines = readFileSync(FILE!, "utf8").split(/\r?\n/);
    const out: string[] = [];

    // ——— Passada crua: estatísticas por câmera e cadência BLE (independentes do replay) ———
    type CamStat = {
      cal: number;
      trk: number;
      trkNonEmpty: number;
      tsMin: number;
      tsMax: number;
      trackSpan: Map<number, { min: number; max: number; n: number }>;
    };
    const cams = new Map<string, CamStat>();
    const bleTs: number[] = [];
    const tagTs = new Map<string, number[]>();
    for (const line of lines) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!o || typeof o.ts !== "number") continue;
      if (o.t === "ble" && Array.isArray(o.readings)) {
        bleTs.push(o.ts);
        for (const r of o.readings as { mac?: string }[]) {
          if (typeof r?.mac !== "string") continue;
          const mac = r.mac.toUpperCase();
          let arr = tagTs.get(mac);
          if (!arr) {
            arr = [];
            tagTs.set(mac, arr);
          }
          arr.push(o.ts);
        }
      } else if ((o.t === "trk" || o.t === "cal") && typeof o.cameraId === "string") {
        let c = cams.get(o.cameraId);
        if (!c) {
          c = { cal: 0, trk: 0, trkNonEmpty: 0, tsMin: Infinity, tsMax: -Infinity, trackSpan: new Map() };
          cams.set(o.cameraId, c);
        }
        c.tsMin = Math.min(c.tsMin, o.ts);
        c.tsMax = Math.max(c.tsMax, o.ts);
        if (o.t === "cal") c.cal++;
        else {
          c.trk++;
          const tracks = Array.isArray(o.tracks) ? (o.tracks as { id?: number }[]) : [];
          if (tracks.length > 0) c.trkNonEmpty++;
          for (const t of tracks) {
            if (typeof t?.id !== "number") continue;
            const sp = c.trackSpan.get(t.id);
            if (!sp) c.trackSpan.set(t.id, { min: o.ts, max: o.ts, n: 1 });
            else {
              sp.min = Math.min(sp.min, o.ts);
              sp.max = Math.max(sp.max, o.ts);
              sp.n++;
            }
          }
        }
      }
    }

    const interArrival = (ts: number[]): number[] => {
      const s = [...ts].sort((a, b) => a - b);
      const d: number[] = [];
      for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
      return d;
    };

    out.push("FUNNEL-REPORT-BEGIN");
    out.push(`arquivo: ${FILE} (${lines.length} linhas)`);
    out.push("");
    out.push("=== (a) RESUMO POR CÂMERA ===");
    for (const [id, c] of cams) {
      const spans = [...c.trackSpan.values()];
      const lifespans = spans.map((s) => s.max - s.min);
      out.push(`câmera ${id}:`);
      out.push(`  eventos: cal=${c.cal} trk=${c.trk} (trk com pistas: ${c.trkNonEmpty})`);
      out.push(`  janela: ${fmtTs(c.tsMin)} → ${fmtTs(c.tsMax)} (${((c.tsMax - c.tsMin) / 60000).toFixed(1)} min)`);
      out.push(
        `  pistas distintas: ${c.trackSpan.size}` +
          (spans.length > 0
            ? ` | vida mediana da pista: ${(median(lifespans) / 1000).toFixed(1)}s | eventos/pista mediano: ${median(spans.map((s) => s.n))}`
            : ""),
      );
    }
    out.push("");
    out.push("=== (a) CADÊNCIA BLE (o que o associador PRECISA: minSamples=5 amostras DISTINTAS na janela de 8000ms) ===");
    if (bleTs.length > 1) {
      const ia = interArrival(bleTs);
      out.push(
        `eventos ble: ${bleTs.length} | janela: ${fmtTs(Math.min(...bleTs))} → ${fmtTs(Math.max(...bleTs))} | inter-arrival mediano do BATCH: ${median(ia).toFixed(0)}ms`,
      );
    } else out.push(`eventos ble: ${bleTs.length}`);
    for (const [mac, ts] of tagTs) {
      const ia = interArrival(ts);
      const med = ia.length > 0 ? median(ia) : NaN;
      const perWindow = Number.isFinite(med) && med > 0 ? (8000 / med).toFixed(1) : "?";
      out.push(
        `  tag ${mac}: ${ts.length} leituras | inter-arrival mediano: ${Number.isFinite(med) ? med.toFixed(0) : "—"}ms → ~${perWindow} leituras DISTINTAS por janela de 8s (precisa ≥5 ticks alinhados; tick=500ms repete o último batch)`,
      );
    }

    // ——— Funil por câmera (replay fiel + diagnoseFunnel por tick) ———
    const targets = CAMERA ? [CAMERA] : [...cams.keys()];
    for (const cameraId of targets) {
      const { funnels, scenario } = diagnoseFusionSession(lines, { cameraId });
      out.push("");
      out.push(`=== (b) FUNIL — câmera ${cameraId} ===`);
      out.push(
        `parse: ${scenario.diag.linesTotal} linhas (${scenario.diag.linesDropped} descartadas) | ticks no cenário: ${scenario.ticks.length} | ticks processados (com BLE): ${funnels.length} | H: ${scenario.H ? "calibrada" : "NULA (proxy 1/bh)"}`,
      );
      const histogram = new Map<string, number>();
      let pairTicks = 0;
      let ticksSemPar = 0;
      // Melhor momento de cada par (trackId, tag): o tick de MAIOR score — "quão perto chegou".
      const bestByPair = new Map<string, { ts: number; p: PairFunnel }>();
      const spokeByPair = new Map<string, { n: number; tsMin: number; tsMax: number }>();
      // Distribuição do movVar entre os pares que CHEGARAM ao gate de movimento (pearson definida)
      // — quantifica "quão longe do limiar minMovement" o campo real fica.
      const movVars: number[] = [];
      for (const f of funnels) {
        if (f.pairs.length === 0) {
          ticksSemPar++;
          continue;
        }
        for (const p of f.pairs) {
          pairTicks++;
          histogram.set(p.verdict, (histogram.get(p.verdict) ?? 0) + 1);
          const key = `${p.trackId}↔${p.tag}`;
          if (p.verdict === "SPOKE") {
            const s = spokeByPair.get(key);
            if (!s) spokeByPair.set(key, { n: 1, tsMin: f.ts, tsMax: f.ts });
            else {
              s.n++;
              s.tsMax = f.ts;
            }
          }
          const b = bestByPair.get(key);
          if (!b || p.score > b.p.score) bestByPair.set(key, { ts: f.ts, p });
          if (p.movVar !== null) movVars.push(p.movVar);
        }
      }
      out.push(`ticks×par avaliados: ${pairTicks} | ticks sem nenhum par (sem pista corrente ou sem tag na janela): ${ticksSemPar}`);
      out.push("histograma de verdicts (onde o funil mata):");
      const total = Math.max(1, pairTicks);
      for (const [v, n] of [...histogram.entries()].sort((a, b) => b[1] - a[1]))
        out.push(`  ${v.padEnd(24)} ${String(n).padStart(6)}  (${((100 * n) / total).toFixed(1)}%)`);
      if (movVars.length > 0) {
        const s = [...movVars].sort((a, b) => a - b);
        const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
        // Limiar lido dos thresholds REAIS do funil (não hardcoded — pegou desatualizado 1x quando
        // o default mudou 0,25→0,15 e o texto seguiu dizendo 0,25 enquanto o motor usava 0,15).
        const minMovement = funnels.find((f) => f.pairs.length > 0)?.pairs[0]?.thresholds.minMovement;
        out.push(
          `movVar nos pares que chegaram ao gate de movimento (n=${s.length}): p50=${q(0.5).toFixed(4)} p90=${q(0.9).toFixed(4)} max=${s[s.length - 1].toFixed(4)} | limiar minMovement=${minMovement ?? "?"} (m² com H; proxy² sem H)`,
        );
      }
      if (spokeByPair.size > 0) {
        out.push("pares que FALARAM:");
        for (const [key, s] of spokeByPair)
          out.push(`  ${key}: ${s.n} ticks SPOKE (t+${(s.tsMin / 1000).toFixed(0)}s → t+${(s.tsMax / 1000).toFixed(0)}s)`);
      } else out.push("pares que FALARAM: NENHUM (o silêncio do campo, reproduzido)");
      const near = [...bestByPair.entries()]
        .filter(([, b]) => b.p.verdict !== "SPOKE")
        .sort((a, b) => b[1].p.score - a[1].p.score)
        .slice(0, 5);
      out.push("mais perto de falar (melhor tick de cada par vetado, top 5 por score):");
      for (const [key, b] of near) {
        const p = b.p;
        out.push(
          `  ${key} @t+${(b.ts / 1000).toFixed(0)}s: score=${fmtN(p.score)} corr=${fmtN(p.corr)} movVar=${fmtN(p.movVar)} ` +
            `dist=${p.distSamples} rssi=${p.rssiSamples} alin=${p.alignedSamples} span=${p.spanMs}ms margem=${fmtN(p.margin)} → ${p.verdict}`,
        );
      }
      if (near.length === 0) out.push("  (nenhum par vetado com score > 0 — nada chegou nem perto)");
    }
    out.push("FUNNEL-REPORT-END");

    console.log(out.join("\n"));
    expect(cams.size).toBeGreaterThan(0);
  });
});
