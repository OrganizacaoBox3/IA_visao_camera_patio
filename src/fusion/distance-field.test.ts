// TORNEIO DA DISTÂNCIA ABSOLUTA sobre a GRAVAÇÃO REAL DE CAMPO (READ-ONLY — server/bt/*.jsonl é
// artefato IMUTÁVEL, CLAUDE.md §3: este teste SÓ LÊ). Motor do `node eval/absolute-distance.mjs`.
// GATED por env (DIST_FIELD_FILES): sem ela é SKIP — a gravação é runtime/gitignored, o CI não a tem.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A RÉGUA — PINADA A PRIORI, ANTES DE QUALQUER NÚMERO SAIR (achado NEGATIVO conta igual):
//   R0 (Regra 9 — o portão): σ do instrumento, medido por LOO nas âncoras, tem de RESOLVER a cena.
//       piso de resolução = d·(10^σ − 1) < separação típica entre duas pessoas (mesas: ~1,2 m).
//       Se o piso ≥ separação, o método NÃO RESOLVE e o resto do torneio é teatro — REPROVA aqui.
//   R1: precisão(dist) ≥ precisão(corr) na MESMA população (a das pessoas PARADAS).
//   R2: cobertura(corr+dist) ≥ 1,5 × cobertura(corr).
//   R3: conflito(corr+dist) ≤ 0,6 × conflito(corr).
//   R4 (Regra 11 — OBRIGATÓRIA): a precisão do DELTA, ISOLADA. O agregado MENTE (já escondeu
//       subpopulação 100% errada atrás de 99,6% global). Aqui o delta é a população em que a
//       correlação NÃO FALA — e é sobre ELA que a precisão sai.
//   R5 (Regra 13): agreementOnFailure entre corr e dist ANTES de somar. Sem essa medição, NÃO SOMA.
//   R6: toda proporção sai com n e INTERVALO DE WILSON 95%. 13/13 não é 100%.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A VERDADE-TERRENO (o único juiz não-circular que o campo oferece): as ÂNCORAS. Uma âncora é um
// MAC CONHECIDO numa POSIÇÃO CONHECIDA (camcfg.calibrations[cam].points[].mac + .world) — ou seja,
// é literalmente uma TAG PARADA numa MESA, com gabarito. A gravação não diz qual MAC está em qual
// pessoa (laudo §7), mas diz exatamente onde estão 4 tags. Portanto o experimento decisivo da H3 —
// "a distância absoluta identifica uma tag PARADA?" — é executável em dado REAL, com verdade.
//
// PROTOCOLO (leave-one-out SIMÉTRICO — nenhuma leitura calibra o modelo que a julga):
//   janela de 8 s (windowMs de produção), NÃO-SOBREPOSTA (janela sobreposta compartilha dado ⇒
//   não é evidência independente — Regra 8/13);
//   alvo = uma âncora A (a "pessoa parada"): a câmera diria d(A) = |world(A) − world(estação)|
//     (geometria PURA, zero RSSI — é a distância que a homografia entrega para quem está ali);
//   candidatos = TODOS os MACs ouvidos na janela (as outras âncoras + a tag livre);
//   cada candidato c é pontuado por um modelo ajustado SEM c (LOO simétrico: o modelo nunca viu a
//     tag que julga — exatamente o que a produção enfrenta com a tag de uma PESSOA);
//   veredito = argmax do score absoluto; abstenção se margem < minMargin (0,1 — o de produção).
// INVARIÂNCIA IMPORTANTE (declarada): argmax de exp(−z²/2) é argmin |gap em décadas| ⇒ a PRECISÃO
// do argmax NÃO depende de σ. σ entra só na margem/no score — a curva de margem é reportada.
//
// VIÉS DECLARADO (o que este protocolo NÃO prova): as 4 âncoras vivem num retângulo de 2,5 × 1,2 m —
// a separação entre elas É a separação entre mesas vizinhas (o caso do produto), mas NÃO cobre
// "pessoa a 8 m vs pessoa a 2 m" (fácil demais) nem multidão. E o corpo humano entre tag e estação
// (4–10 dB) NÃO está presente numa âncora de parede: o σ medido aqui é um LIMITE INFERIOR do erro
// que uma tag em crachá terá. Se REPROVAR aqui, reprova mais ainda no crachá.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import { fitPathLoss, type AnchorObs } from "./floor-plot";
import {
  absoluteScore,
  dedupeConsecutive,
  estimateTagDistM,
  looResiduals,
  median,
  resolutionFloorM,
  sigmaDecadesFromResiduals,
} from "./distance";
import { TagTrackAssociator, type FusionFrame } from "./associate";

const FILES = process.env.DIST_FIELD_FILES; // lista separada por vírgula
const CAMERA = process.env.DIST_FIELD_CAMERA ?? "cam-8a95ac6090";
const CAMCFG = process.env.DIST_FIELD_CAMCFG ?? "server/camcfg.json";

const WINDOW_MS = 8000; // windowMs de produção
const MIN_MARGIN = 0.1; // minMargin de produção
const DESK_SEP_M = 1.2; // separação típica entre duas mesas vizinhas (a cena do dono)

// ——— Wilson 95% (Regra: 13/13 não é 100%) ———
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
const pct = (v: number) => (100 * v).toFixed(1);
const prop = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${n ? pct(k / n) : "—"}% [IC ${pct(lo)}–${pct(hi)}%]`;
};

type BleEv = { ts: number; readings: { mac: string; rssi: number }[] };
type TrkEv = { ts: number; tracks: { id: number; bbox: [number, number, number, number] }[] };

function parse(files: string[]): { ble: BleEv[]; trk: TrkEv[]; H: Matrix3 | null; stationPx: Vec2 | null } {
  const ble: BleEv[] = [];
  const trk: TrkEv[] = [];
  let H: Matrix3 | null = null;
  let stationPx: Vec2 | null = null;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof o.ts !== "number") continue;
      if (o.t === "ble" && Array.isArray(o.readings)) {
        const rs = (o.readings as { mac?: unknown; rssi?: unknown }[])
          .filter((r) => typeof r?.mac === "string" && typeof r?.rssi === "number")
          .map((r) => ({ mac: (r.mac as string).toUpperCase(), rssi: r.rssi as number }));
        if (rs.length) ble.push({ ts: o.ts, readings: rs });
      } else if (o.t === "trk" && o.cameraId === CAMERA && Array.isArray(o.tracks)) {
        trk.push({ ts: o.ts, tracks: o.tracks as TrkEv["tracks"] });
      } else if (o.t === "cal" && o.cameraId === CAMERA) {
        if (Array.isArray(o.H) && o.H.length === 9) H = o.H as Matrix3;
        const st = o.station as { x?: number; y?: number } | null;
        if (st && typeof st.x === "number" && typeof st.y === "number") stationPx = { x: st.x, y: st.y };
      }
    }
  }
  ble.sort((a, b) => a.ts - b.ts);
  trk.sort((a, b) => a.ts - b.ts);
  return { ble, trk, H, stationPx };
}

describe.skipIf(!FILES)("distância absoluta — torneio sobre gravação de campo", () => {
  it("mede o instrumento (LOO nas âncoras), o piso de resolução e o torneio corr × dist", () => {
    const files = FILES!.split(",").map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    const log = (s = "") => out.push(s);

    // ——— Âncoras: MAC + posição-mundo (a verdade-terreno). Estação: px do camcfg/cal → mundo. ———
    const cfg = JSON.parse(readFileSync(CAMCFG, "utf8")) as {
      calibrations?: Record<
        string,
        { points?: { mac?: string; world?: Vec2; px?: Vec2 }[]; H?: number[]; station?: Vec2 }
      >;
    };
    const cal = cfg.calibrations?.[CAMERA];
    const anchorWorld = new Map<string, Vec2>();
    for (const p of cal?.points ?? [])
      if (typeof p.mac === "string" && p.world) anchorWorld.set(p.mac.toUpperCase(), p.world);

    const { ble, trk, H: Hrec, stationPx: stRec } = parse(files);
    const H = (Hrec ?? (cal?.H as Matrix3 | undefined) ?? null) as Matrix3 | null;
    const stationPx = stRec ?? cal?.station ?? null;
    const stationWorld = H && stationPx ? pixelToWorld(H, stationPx) : null;

    log(`arquivos: ${files.length} · eventos ble: ${ble.length} · trk(${CAMERA}): ${trk.length}`);
    log(`H: ${H ? "sim" : "NÃO"} · estação px: ${stationPx ? `${stationPx.x.toFixed(3)},${stationPx.y.toFixed(3)}` : "NÃO"} · estação mundo: ${stationWorld ? `${stationWorld.x.toFixed(2)},${stationWorld.y.toFixed(2)} m` : "NÃO"}`);
    expect(stationWorld, "sem H+estação não há régua métrica — nada a medir").not.toBeNull();

    // ——— A GEOMETRIA REAL (o que o torneio tem de separar) ———
    log("");
    log("== A CENA (geometria pura, zero RSSI) ==");
    const dTrue = new Map<string, number>();
    for (const [mac, w] of anchorWorld) {
      const d = Math.hypot(w.x - stationWorld!.x, w.y - stationWorld!.y);
      dTrue.set(mac, d);
      log(`  âncora ${mac} @ (${w.x}, ${w.y}) m → ${d.toFixed(2)} m da estação`);
    }
    const seps: number[] = [];
    const macs = [...anchorWorld.keys()];
    for (let i = 0; i < macs.length; i++)
      for (let j = i + 1; j < macs.length; j++) {
        const a = anchorWorld.get(macs[i])!;
        const b = anchorWorld.get(macs[j])!;
        seps.push(Math.hypot(a.x - b.x, a.y - b.y));
      }
    const dRadial = [...dTrue.values()];
    const radialSeps: number[] = [];
    for (let i = 0; i < dRadial.length; i++)
      for (let j = i + 1; j < dRadial.length; j++) radialSeps.push(Math.abs(dRadial[i] - dRadial[j]));
    log(`  separação FÍSICA entre âncoras: min ${Math.min(...seps).toFixed(2)} m · mediana ${median(seps)!.toFixed(2)} m`);
    log(`  separação RADIAL (o que o rádio enxerga): min ${Math.min(...radialSeps).toFixed(2)} m · mediana ${median(radialSeps)!.toFixed(2)} m`);
    log(`  (a distância absoluta é um ANEL: duas tags à MESMA distância da estação são indistinguíveis por construção)`);

    // ——— Janelas NÃO-SOBREPOSTAS de 8 s ———
    type Win = { t0: number; byMac: Map<string, number[]> };
    const wins: Win[] = [];
    if (ble.length) {
      const t0 = ble[0].ts;
      const tEnd = ble[ble.length - 1].ts;
      let i = 0;
      for (let w = t0; w <= tEnd; w += WINDOW_MS) {
        const byMac = new Map<string, number[]>();
        while (i < ble.length && ble[i].ts < w + WINDOW_MS) {
          for (const r of ble[i].readings) {
            let arr = byMac.get(r.mac);
            if (!arr) byMac.set(r.mac, (arr = []));
            arr.push(r.rssi);
          }
          i++;
        }
        if (byMac.size) wins.push({ t0: w, byMac });
      }
    }
    log("");
    log(`== JANELAS (8 s, NÃO-sobrepostas — janela sobreposta não é evidência independente) ==`);
    log(`  n = ${wins.length}`);

    // ——— REGRA 8: o teto de evidência (leituras DISTINTAS, não POSTs) ———
    let posts = 0;
    let distinct = 0;
    const distinctPerWin: number[] = [];
    for (const w of wins)
      for (const [, rs] of w.byMac) {
        posts += rs.length;
        const d = dedupeConsecutive(rs).length;
        distinct += d;
        distinctPerWin.push(d);
      }
    log(`  Regra 8 — leituras: ${posts} POSTs → ${distinct} DISTINTAS (${pct(distinct / Math.max(1, posts))}% carrega informação; o resto é cópia do sample-and-hold)`);
    log(`  distintas por (janela,tag): mediana ${median(distinctPerWin)?.toFixed(1)} · a correlação exige minSamples=5 DESSAS`);

    // ——— O INSTRUMENTO: σ por LOO nas âncoras (o juiz não-circular) ———
    log("");
    log("== R0 · O INSTRUMENTO (LOO nas âncoras — o modelo NUNCA vê a tag que julga) ==");
    const allRes: ReturnType<typeof looResiduals> = [];
    const rssiByAnchor = new Map<string, number[]>();
    for (const w of wins) {
      const obs: AnchorObs[] = [];
      for (const [mac, world] of anchorWorld) {
        const rs = w.byMac.get(mac);
        if (!rs) continue;
        const m = median(dedupeConsecutive(rs));
        if (m === null) continue;
        obs.push({ mac, world, rssi: m });
        let arr = rssiByAnchor.get(mac);
        if (!arr) rssiByAnchor.set(mac, (arr = []));
        arr.push(m);
      }
      if (obs.length >= 3) allRes.push(...looResiduals(obs, stationWorld!));
    }
    const sigma = sigmaDecadesFromResiduals(allRes);
    const errsM = allRes.map((r) => r.errM).sort((a, b) => a - b);
    const errsD = allRes.map((r) => r.errDecades).sort((a, b) => a - b);
    const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
    log(`  resíduos LOO: n = ${allRes.length} · regime do fit: ${[...new Set(allRes.map((r) => r.source))].join(",")}`);
    log(`  erro |d̂ − d| em METROS:  mediana ${q(errsM, 0.5).toFixed(2)} m · p90 ${q(errsM, 0.9).toFixed(2)} m · máx ${q(errsM, 0.999).toFixed(2)} m`);
    log(`  erro em DÉCADAS:         mediana ${q(errsD, 0.5).toFixed(3)} · p90 ${q(errsD, 0.9).toFixed(3)}`);
    log(`  σ (RMS das décadas) = ${sigma?.toFixed(3) ?? "—"}  ⇒  fator multiplicativo típico ×${sigma ? Math.pow(10, sigma).toFixed(2) : "—"}`);
    const dMed = median(dRadial)!;
    const floor = sigma ? resolutionFloorM(sigma, dMed) : null;
    const radialMed = median(radialSeps)!;
    log(`  REGRA 9 — PISO DE RESOLUÇÃO a ${dMed.toFixed(2)} m da estação: ${floor?.toFixed(2) ?? "—"} m`);
    log(`  o que precisamos resolver:`);
    log(`    · separação FÍSICA entre duas mesas: ${DESK_SEP_M.toFixed(2)} m`);
    log(`    · separação RADIAL entre elas (É ESTA a régua — 1 antena só enxerga o RAIO, não o ângulo): ${radialMed.toFixed(2)} m`);
    const resolves = floor !== null && floor < radialMed;
    log(
      `  R0 ⇒ ${resolves ? "PASSA — o instrumento RESOLVE a cena" : `REPROVA — o piso (${floor?.toFixed(2)} m) é ${(floor! / radialMed).toFixed(1)}× MAIOR que a separação radial que precisa distinguir (${radialMed.toFixed(2)} m).\n         O instrumento NÃO RESOLVE a cena. Tudo abaixo é confirmação, não descoberta.`}`,
    );

    // ——— O TETO FÍSICO: quanto o RSSI de uma tag PARADA passeia (dispersão em dB) ———
    log("");
    log("== O TETO FÍSICO (RSSI de tag FIXA, parede, sem corpo humano na frente) ==");
    for (const [mac, xs] of rssiByAnchor) {
      const s = [...xs].sort((a, b) => a - b);
      const iqr = q(s, 0.75) - q(s, 0.25);
      const range = q(s, 0.99) - q(s, 0.01);
      log(
        `  ${mac}: mediana ${median(s)!.toFixed(1)} dBm · IQR ${iqr.toFixed(1)} dB · p1–p99 ${range.toFixed(1)} dB (n janelas ${s.length})`,
      );
    }
    log(`  (n = 2,2 ⇒ 6 dB de deriva = fator ×${Math.pow(10, 6 / 22).toFixed(2)} na distância; 12 dB = ×${Math.pow(10, 12 / 22).toFixed(2)})`);

    // ——— O TORNEIO: identificar a tag de uma PESSOA PARADA (a âncora é a pessoa parada) ———
    log("");
    log("== R1/R4 · TORNEIO — quem é a tag desta pessoa PARADA? (verdade = a âncora) ==");
    let nTrials = 0;
    let corrSpoke = 0; // baseline: a correlação FALA nesta população?
    let distSpoke = 0;
    let distRight = 0;
    let distSpokeMargin = 0;
    let distRightMargin = 0;
    let conflictNoMargin = 0;
    const gapTrue: number[] = [];
    const gapWrong: number[] = [];
    const trials: { target: string; right: boolean; margin: number; nCand: number }[] = [];

    for (const w of wins) {
      // Candidatos: TODO MAC ouvido na janela com ≥1 leitura distinta.
      const cands = [...w.byMac.keys()].filter((m) => dedupeConsecutive(w.byMac.get(m)!).length >= 1);
      if (cands.length < 2) continue; // sem competidor não há discriminação a medir
      for (const target of anchorWorld.keys()) {
        if (!w.byMac.has(target)) continue; // a tag da "pessoa" tem de estar audível
        const dCam = dTrue.get(target)!; // o que a CÂMERA diria de quem está ali (geometria)
        // Modelo LOO SIMÉTRICO por candidato: ajustado com as âncoras MENOS o próprio candidato.
        const scores: { mac: string; score: number; gap: number }[] = [];
        for (const c of cands) {
          const obs: AnchorObs[] = [];
          for (const [mac, world] of anchorWorld) {
            if (mac === c) continue; // o modelo NUNCA vê a tag que julga
            const rs = w.byMac.get(mac);
            if (!rs) continue;
            const m = median(dedupeConsecutive(rs));
            if (m !== null) obs.push({ mac, world, rssi: m });
          }
          if (obs.length < 2) continue; // sem calibração não há distância honesta
          const model = fitPathLoss(obs, stationWorld!);
          const est = estimateTagDistM(model, w.byMac.get(c)!);
          if (!est) continue;
          const gap = Math.abs(Math.log10(Math.max(est.distM, 0.1) / Math.max(dCam, 0.1)));
          scores.push({ mac: c, score: absoluteScore(dCam, est.distM, sigma ?? 0.3), gap });
        }
        if (scores.length < 2) continue;
        nTrials++;
        scores.sort((a, b) => b.score - a.score);
        const best = scores[0];
        const second = scores[1];
        for (const s of scores) (s.mac === target ? gapTrue : gapWrong).push(s.gap);

        // A distância absoluta SEMPRE fala (não precisa de movimento) — é o ponto do método.
        distSpoke++;
        if (best.mac === target) distRight++;
        const margin = best.score - second.score;
        trials.push({ target, right: best.mac === target, margin, nCand: scores.length });
        if (margin >= MIN_MARGIN) {
          distSpokeMargin++;
          if (best.mac === target) distRightMargin++;
        } else conflictNoMargin++;

        // BASELINE CORRELAÇÃO, no MESMO episódio: pessoa PARADA na posição da âncora + o RSSI REAL
        // da janela. Motor de PRODUÇÃO (TagTrackAssociator, DEFAULTS) — não uma reimplementação.
        const assoc = new TagTrackAssociator();
        const evs: { ts: number; readings: { mac: string; rssi: number }[] }[] = [];
        for (const b of ble) if (b.ts >= w.t0 && b.ts < w.t0 + WINDOW_MS) evs.push(b);
        for (const ev of evs) {
          const frame: FusionFrame = {
            ts: ev.ts,
            tracks: [{ trackId: 1, dist: dCam, metric: true }], // PARADA: a distância não muda
            readings: ev.readings.map((r) => ({ tag: r.mac, rssi: r.rssi })),
          };
          assoc.push(frame);
        }
        const asg = evs.length ? assoc.assign(evs[evs.length - 1].ts) : [];
        if (asg.some((a) => a.tag !== null)) corrSpoke++;
      }
    }

    log(`  episódios (janela × pessoa-parada com tag audível): n = ${nTrials}`);
    log("");
    log(`  BASELINE — CORRELAÇÃO (motor de produção, DEFAULTS, mesma janela, mesmo RSSI):`);
    log(`    cobertura (falou): ${prop(corrSpoke, nTrials)}`);
    log(`    precisão: ${corrSpoke === 0 ? "INDEFINIDA — ela não fala nesta população (é o achado do laudo: pessoa parada ⇒ correlação indefinida)" : prop(0, corrSpoke)}`);
    log("");
    log(`  DELTA ISOLADO (Regra 11) — DISTÂNCIA ABSOLUTA, sozinha, na população em que a correlação é MUDA:`);
    log(`    cobertura (sem gate de margem): ${prop(distSpoke, nTrials)}`);
    log(`    PRECISÃO: ${prop(distRight, distSpoke)}`);
    log(`    cobertura (com minMargin=${MIN_MARGIN}): ${prop(distSpokeMargin, nTrials)}`);
    log(`    PRECISÃO (com margem): ${prop(distRightMargin, distSpokeMargin)}`);
    log(`    conflito (margem insuficiente ⇒ cala): ${prop(conflictNoMargin, nTrials)}`);
    const chance = 1 / Math.max(1, median([...wins.map((w) => w.byMac.size)]) ?? 1);
    log(`    ACASO (1/nº de candidatos): ${pct(chance)}% — a barra que o método TEM de bater`);
    log("");
    log(`  A CURVA, NÃO O PONTO — precisão × margem exigida (apertar a barra COMPRA precisão?):`);
    for (const thr of [0, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      const sel = trials.filter((t) => t.margin >= thr);
      const k = sel.filter((t) => t.right).length;
      log(`    margem ≥ ${thr.toFixed(2)}: cobertura ${prop(sel.length, nTrials)} · precisão ${prop(k, sel.length)}`);
    }
    log("");
    log(`  POR ALVO (Regra 11 — o agregado pode esconder uma subpopulação 100% errada):`);
    for (const mac of anchorWorld.keys()) {
      const sel = trials.filter((t) => t.target === mac);
      const k = sel.filter((t) => t.right).length;
      log(`    ${mac} (d = ${dTrue.get(mac)!.toFixed(2)} m): precisão ${prop(k, sel.length)}`);
    }
    log("");
    log(`  SEPARABILIDADE do gap em décadas (o que o argmax vê):`);
    const gt = gapTrue.sort((a, b) => a - b);
    const gw = gapWrong.sort((a, b) => a - b);
    log(`    par VERDADEIRO: mediana ${q(gt, 0.5).toFixed(3)} · p90 ${q(gt, 0.9).toFixed(3)} (n ${gt.length})`);
    log(`    par ERRADO:     mediana ${q(gw, 0.5).toFixed(3)} · p10 ${q(gw, 0.1).toFixed(3)} (n ${gw.length})`);
    log(`    (se a mediana do VERDADEIRO ≥ o p10 do ERRADO, as distribuições se superpõem — o argmax é moeda)`);

    // ——— O PRÊMIO DE CONSOLAÇÃO: se a distância não sabe DECIDIR, ela ao menos sabe VETAR? ———
    // O gate `maxDistRatio` do associate.ts veta o par quando |log10(distM/dist)| > log10(r).
    // Custo = par VERDADEIRO vetado (o dono da tag perde o rótulo). Benefício = par ERRADO vetado
    // (um falso-rótulo a menos). Um gate só vale se o benefício vier MUITO mais barato que o custo.
    log("");
    log("== O GATE (maxDistRatio) — a distância sabe ao menos VETAR o par impossível? ==");
    for (const r of [1.5, 2, 3, 5, 10]) {
      const thr = Math.log10(r);
      const vetoTrue = gapTrue.filter((g) => g > thr).length;
      const vetoWrong = gapWrong.filter((g) => g > thr).length;
      log(
        `  r = ${r.toFixed(1)}: veta ${pct(vetoTrue / gapTrue.length)}% dos pares VERDADEIROS (custo) · ${pct(vetoWrong / gapWrong.length)}% dos ERRADOS (benefício) · razão ${(vetoWrong / gapWrong.length / Math.max(1e-9, vetoTrue / gapTrue.length)).toFixed(2)}×`,
      );
    }
    log(`  (razão ≈ 1 ⇒ o gate corta os dois lados igualmente: não separa nada, só derruba cobertura)`);

    // ——— R5 · Regra 13: agreementOnFailure entre corr e dist ———
    log("");
    log("== R5 · REGRA 13 — agreementOnFailure(corr, dist) ==");
    log(
      corrSpoke === 0
        ? `  NÃO MENSURÁVEL: as duas evidências NUNCA co-decidem nesta população (a correlação tem cobertura 0/${nTrials}).\n  ⇒ SOMAR as duas é proibido por falta de medição (Regra 13). Onde uma fala, a outra é muda: a soma\n     honesta é DISJUNTA (corr para quem anda, dist para quem para), não um blend ponderado.`
        : `  co-decisões: ${corrSpoke} — medir a concordância-no-erro ANTES de somar.`,
    );

    // ——— Cobertura sobre PESSOAS de verdade (sem verdade-terreno: cobertura sim, precisão NÃO) ———
    log("");
    log("== COBERTURA sobre PESSOAS REAIS (tracks da câmera — sem verdade-terreno: só cobertura) ==");
    let winsWithPerson = 0;
    let winsPersonDistCanSpeak = 0;
    for (const w of wins) {
      const ts = trk.filter((t) => t.ts >= w.t0 && t.ts < w.t0 + WINDOW_MS && t.tracks.length > 0);
      if (!ts.length) continue;
      winsWithPerson++;
      const nonAnchor = [...w.byMac.keys()].filter((m) => !anchorWorld.has(m));
      if (H && nonAnchor.some((m) => dedupeConsecutive(w.byMac.get(m)!).length >= 1))
        winsPersonDistCanSpeak++;
    }
    log(`  janelas com pessoa em cena: ${winsWithPerson}`);
    log(`  destas, a distância absoluta PODE falar (H métrica + ≥1 leitura distinta de tag não-âncora): ${prop(winsPersonDistCanSpeak, winsWithPerson)}`);
    log(`  (a correlação PODE falar em 5,4% [2,7–10,8%] — laudo 2026-07-13, corpus ouro)`);
    log(`  PRECISÃO aqui é NÃO-MENSURÁVEL: a gravação não diz qual MAC está em qual pessoa (laudo §7).`);
    log(`  Reportar precisão sobre pessoas reais sem verdade seria fabricar número. Não fabricamos.`);

    console.log("\nDIST-REPORT-BEGIN\n" + out.join("\n") + "\nDIST-REPORT-END\n");
    expect(nTrials).toBeGreaterThan(0);
  }, 600_000);
});
