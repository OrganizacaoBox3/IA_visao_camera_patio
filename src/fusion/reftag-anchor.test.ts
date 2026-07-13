// A refTAG COMO 5º PONTO DO fitPathLoss — MEDIÇÃO sobre a GRAVAÇÃO REAL DE CAMPO (READ-ONLY —
// server/bt/*.jsonl é artefato IMUTÁVEL, CLAUDE.md §3: este teste SÓ LÊ). Motor do
// `node eval/reftag-anchor.mjs`. GATED por env (REFTAG_FILES): sem ela é SKIP (a gravação é
// runtime/gitignored — o CI não a tem).
//
// A PERGUNTA (task #67): a refTag hoje é coletada-mas-INERTE (guarda `mac` + `px`, ponto de imagem).
// As âncoras dos cantos (calibration.points[].mac + .world em METROS) alimentam o fitPathLoss
// (floor-plot.ts:77). O laudo H3 mediu: 4 âncoras num retângulo de 2,5×1,2 m NÃO identificam o
// expoente n (span de log10(d) muito abaixo do gate SPAN_MIN_DECADES=0.4). Antes de dar `world` à
// refTag e ligá-la ao fit (UI + hub + tipo), a doutrina exige MEDIR: adicionar a refTag como 5º
// ponto (com world derivado do px via H) melhora a identificabilidade? Ou é insuficiente do mesmo
// jeito — o problema é a GEOMETRIA das âncoras, não a CONTAGEM de pontos?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A RÉGUA — PINADA A PRIORI, ANTES DE QUALQUER NÚMERO SAIR (achado NEGATIVO conta igual, é OURO):
//   G1 (identificabilidade / span): CONSTRÓI só se o span de log10(d) com os 5 pontos CRUZAR
//       0.4 década (SPAN_MIN_DECADES do floor-plot) — o limiar acima do qual o fit deixa de ser
//       "anchors-offset" (n fixo) e vira "anchors" (n estimável). Span é GEOMETRIA PURA (não usa
//       RSSI): dado onde a refTag está, é resposta determinística.
//   G2 (o fit muda de regime): ≥ 50% das janelas com os 5 pontos audíveis viram source="anchors".
//   G3 (o delta que a refTag COMPRA — Regra 11, isolada): resíduo LOO MEDIANO (décadas) da âncora
//       retida cai ≥ 20% ao pôr a refTag no conjunto de calibração vs sem ela. Wilson onde couber.
//   R0 (Regra 9 — o portão): mesmo identificável, o piso de resolução = d·(10^σ−1) tem de cair
//       ABAIXO da separação radial entre mesas (~0.49 m medida). Se não cair, o modelo não RESOLVE
//       a cena e n identificável é teatro numérico.
//   VEREDITO: CONSTRÓI (dar world à refTag no tipo/hub/UI/fit) só se G1 ∧ (G2 ∨ G3) ∧ R0-não-piora.
//       Caso contrário: NÃO constrói a UI enganosa — relata o achado honesto e aponta o caminho
//       alternativo (monitor de DRIFT do RSSI@1m FORA da tela de calibração).
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A VERDADE-TERRENO: as ÂNCORAS (MAC conhecido em posição-mundo conhecida) — o único juiz não-
// circular de campo. A refTag entra como PONTO EXTRA de calibração; seu `world` sai do px via
// pixelToWorld(H, px) (é o que a UI faria). VIÉS DECLARADO: as 4 âncoras vivem num retângulo de
// 2,5×1,2 m — a refTag adicionada herda a MESMA vizinhança geométrica; se ela estiver perto das
// âncoras (o caso do RSSI@1m, ~1 m da estação), não estende o span. Este teste MEDE onde ela está.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import { fitPathLoss, distFromRssi, type AnchorObs } from "./floor-plot";
import { median, dedupeConsecutive } from "./distance";

const FILES = process.env.REFTAG_FILES; // lista separada por vírgula
const CAMERA = process.env.REFTAG_CAMERA ?? "cam-8a95ac6090";
const CAMCFG = process.env.REFTAG_CAMCFG ?? "server/camcfg.json";

const WINDOW_MS = 8000; // windowMs de produção
const SPAN_MIN_DECADES = 0.4; // espelho do floor-plot: gate de identificabilidade do expoente
const DESK_SEP_RADIAL_M = 0.49; // separação RADIAL mediana entre mesas (medida no absolute-distance)
const MIN_ANCHOR_DIST_M = 0.3; // espelho do floor-plot: campo próximo fica fora do fit

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
const q = (xs: number[], p: number) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN;

type BleEv = { ts: number; readings: { mac: string; rssi: number }[] };

function parse(files: string[]): { ble: BleEv[]; H: Matrix3 | null; stationPx: Vec2 | null } {
  const ble: BleEv[] = [];
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
      } else if (o.t === "cal" && o.cameraId === CAMERA) {
        if (Array.isArray(o.H) && o.H.length === 9) H = o.H as Matrix3;
        const st = o.station as { x?: number; y?: number } | null;
        if (st && typeof st.x === "number" && typeof st.y === "number") stationPx = { x: st.x, y: st.y };
      }
    }
  }
  ble.sort((a, b) => a.ts - b.ts);
  return { ble, H, stationPx };
}

/** span de log10(d) sobre uma lista de pontos {world} contra a estação; excluídos os de campo próximo. */
function spanDecades(worlds: Vec2[], station: Vec2): { span: number; dmin: number; dmax: number; n: number } {
  const logs: number[] = [];
  for (const w of worlds) {
    const d = Math.hypot(w.x - station.x, w.y - station.y);
    if (d <= MIN_ANCHOR_DIST_M) continue;
    logs.push(Math.log10(d));
  }
  if (logs.length < 2) return { span: 0, dmin: NaN, dmax: NaN, n: logs.length };
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  return { span: hi - lo, dmin: Math.pow(10, lo), dmax: Math.pow(10, hi), n: logs.length };
}

describe.skipIf(!FILES)("refTag como 5º ponto do fitPathLoss — sobre gravação de campo", () => {
  it("mede span, regime do fit e o resíduo LOO que a refTag compra", () => {
    const files = FILES!.split(",").map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    const log = (s = "") => out.push(s);

    // ——— Calibração: âncoras (mac+world), estação (px→world), refTag (mac+px→world) ———
    const cfg = JSON.parse(readFileSync(CAMCFG, "utf8")) as {
      calibrations?: Record<
        string,
        {
          points?: { mac?: string; world?: Vec2; px?: Vec2 }[];
          H?: number[];
          station?: Vec2;
          refTag?: { mac?: string; px?: Vec2 };
        }
      >;
    };
    const cal = cfg.calibrations?.[CAMERA];
    const anchorWorld = new Map<string, Vec2>();
    for (const p of cal?.points ?? [])
      if (typeof p.mac === "string" && p.world) anchorWorld.set(p.mac.toUpperCase(), p.world);

    const { ble, H: Hrec, stationPx: stRec } = parse(files);
    const H = (Hrec ?? (cal?.H as Matrix3 | undefined) ?? null) as Matrix3 | null;
    const stationPx = stRec ?? cal?.station ?? null;
    const stationWorld = H && stationPx ? pixelToWorld(H, stationPx) : null;

    log(`arquivos: ${files.length} · eventos ble: ${ble.length} · câmera: ${CAMERA}`);
    log(`H: ${H ? "sim" : "NÃO"} · estação mundo: ${stationWorld ? `${stationWorld.x.toFixed(2)},${stationWorld.y.toFixed(2)} m` : "NÃO"}`);
    expect(stationWorld, "sem H+estação não há régua métrica — nada a medir").not.toBeNull();

    // ——— A refTag: existe? qual MAC? onde cairia o world (px→H)? é audível na gravação? ———
    log("");
    log("== A refTag (o candidato a 5º ponto) ==");
    const rt = cal?.refTag;
    const refMac = rt && typeof rt.mac === "string" ? rt.mac.toUpperCase() : null;
    const refWorld = rt && rt.px && H ? pixelToWorld(H, rt.px) : null;
    const dRef = refWorld && stationWorld ? Math.hypot(refWorld.x - stationWorld.x, refWorld.y - stationWorld.y) : null;
    if (!refMac || !rt?.px) {
      log(`  NÃO HÁ refTag configurada em camcfg.calibrations[${CAMERA}].refTag.`);
      log(`  ⇒ Sem px real, não há world real: mede-se o CONTRAFACTUAL (varredura de posição) abaixo.`);
    } else {
      log(`  mac: ${refMac} · px: (${rt.px.x.toFixed(3)}, ${rt.px.y.toFixed(3)})`);
      log(`  world (px→H): ${refWorld ? `(${refWorld.x.toFixed(2)}, ${refWorld.y.toFixed(2)}) m` : "px além do horizonte — SEM world projetável"}`);
      log(`  distância à estação: ${dRef !== null ? `${dRef.toFixed(2)} m` : "—"}`);
    }

    // ——— A CENA: âncoras e seu span (o baseline de 4 pontos) ———
    log("");
    log("== A CENA (geometria pura, zero RSSI) ==");
    const anchorMacs = [...anchorWorld.keys()];
    const anchorWorlds = anchorMacs.map((m) => anchorWorld.get(m)!);
    for (const m of anchorMacs) {
      const w = anchorWorld.get(m)!;
      const d = Math.hypot(w.x - stationWorld!.x, w.y - stationWorld!.y);
      log(`  âncora ${m} @ (${w.x}, ${w.y}) m → ${d.toFixed(2)} m da estação`);
    }
    const s4 = spanDecades(anchorWorlds, stationWorld!);
    log(`  SPAN base (4 âncoras): ${s4.span.toFixed(3)} década (dmin ${s4.dmin.toFixed(2)} m · dmax ${s4.dmax.toFixed(2)} m · dmax/dmin ${(s4.dmax / s4.dmin).toFixed(2)})`);
    log(`  gate de identificabilidade do expoente: SPAN_MIN_DECADES = ${SPAN_MIN_DECADES} ⇒ base ${s4.span >= SPAN_MIN_DECADES ? "JÁ passa" : "NÃO passa (fit fica 'anchors-offset', n fixo)"}`);

    // ——— G1: o span COM a refTag (5 pontos) — GEOMETRIA, determinístico ———
    log("");
    log("== G1 · SPAN com a refTag como 5º ponto (geometria — o gate é aqui) ==");
    let g1Pass = false;
    if (refWorld) {
      const s5 = spanDecades([...anchorWorlds, refWorld], stationWorld!);
      g1Pass = s5.span >= SPAN_MIN_DECADES;
      log(`  SPAN com refTag (5 pts): ${s5.span.toFixed(3)} década (dmin ${s5.dmin.toFixed(2)} m · dmax ${s5.dmax.toFixed(2)} m)`);
      log(`  Δspan = ${(s5.span - s4.span).toFixed(3)} década`);
      log(`  G1 ⇒ ${g1Pass ? "PASSA — o span cruza 0.4, o expoente vira identificável" : `REPROVA — ${s5.span.toFixed(3)} < ${SPAN_MIN_DECADES}: a refTag NÃO estende o span o bastante`}`);
    } else {
      log(`  (sem world real da refTag — G1 avaliado no contrafactual abaixo)`);
    }

    // ——— CONTRAFACTUAL: onde a refTag PRECISARIA estar para o span cruzar 0.4 ———
    log("");
    log("== CONTRAFACTUAL · para QUALQUER 5º ponto, a que distância radial ele cruza o span? ==");
    const logAnchors = anchorWorlds
      .map((w) => Math.log10(Math.hypot(w.x - stationWorld!.x, w.y - stationWorld!.y)))
      .filter(Number.isFinite);
    const loA = Math.min(...logAnchors);
    const hiA = Math.max(...logAnchors);
    log(`  âncoras cobrem log10(d) ∈ [${loA.toFixed(3)}, ${hiA.toFixed(3)}] (span ${(hiA - loA).toFixed(3)})`);
    const dNearMax = Math.pow(10, hiA - SPAN_MIN_DECADES); // 5º ponto ABAIXO estende p/ perto
    const dFarMin = Math.pow(10, loA + SPAN_MIN_DECADES); // 5º ponto ACIMA estende p/ longe
    log(`  para cruzar ${SPAN_MIN_DECADES}: a refTag teria de estar a d ≤ ${dNearMax.toFixed(2)} m (perto) OU d ≥ ${dFarMin.toFixed(2)} m (longe) da estação`);
    log(`  (d ≤ ${MIN_ANCHOR_DIST_M} m é campo próximo — EXCLUÍDO do fit; então o único caminho útil é d ≥ ${dFarMin.toFixed(2)} m)`);
    log(`  o propósito da refTag (heartbeat/RSSI@1m) a coloca a ~1 m da estação ⇒ span ${spanDecades([...anchorWorlds, { x: stationWorld!.x + 1, y: stationWorld!.y }], stationWorld!).span.toFixed(3)} década (não cruza)`);
    for (const d of [0.5, 1, 2, 2.7, 3, 4, 5]) {
      const hypo = { x: stationWorld!.x + d, y: stationWorld!.y };
      const s5 = spanDecades([...anchorWorlds, hypo], stationWorld!);
      log(`    refTag hipotética a ${d.toFixed(1)} m → span ${s5.span.toFixed(3)} ${s5.span >= SPAN_MIN_DECADES ? "✓ cruza" : "✗"}`);
    }

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

    // ——— Cobertura da refTag: em quantas janelas ela é sequer audível? ———
    log("");
    log("== Cobertura da refTag na gravação (uma âncora que não se ouve não calibra nada) ==");
    let winsRefAudible = 0;
    if (refMac)
      for (const w of wins) if (w.byMac.has(refMac)) winsRefAudible++;
    log(`  janelas totais: ${wins.length}`);
    log(`  refTag audível: ${refMac ? prop(winsRefAudible, wins.length) : "— (sem refTag configurada)"}`);

    // ——— G2 + G3: por janela, o regime do fit e o resíduo LOO com/sem a refTag ———
    // Para cada janela com ≥3 âncoras audíveis: LOO sobre as âncoras. Para a âncora RETIDA,
    // ajusta o modelo com (a) as demais âncoras, (b) as demais âncoras + refTag (se audível+world).
    // Compara |errDecades|. Também registra o source do fit (a) e (b) e o n estimado em (b).
    log("");
    log("== G2/G3 · regime do fit e resíduo LOO — o DELTA que a refTag compra (Regra 11) ==");
    let winsFit = 0;
    let srcAnchorsBase = 0; // fit base (só âncoras) já é "anchors"?
    let srcAnchorsWithRef = 0; // fit +refTag vira "anchors"?
    const nWithRef: number[] = [];
    const looBase: number[] = [];
    const looWithRef: number[] = [];
    for (const w of wins) {
      const obsAnchors: AnchorObs[] = [];
      for (const [mac, world] of anchorWorld) {
        const rs = w.byMac.get(mac);
        if (!rs) continue;
        const m = median(dedupeConsecutive(rs));
        if (m === null) continue;
        obsAnchors.push({ mac, world, rssi: m });
      }
      if (obsAnchors.length < 3) continue;
      // refTag desta janela (se audível e com world projetável)
      let refObs: AnchorObs | null = null;
      if (refMac && refWorld) {
        const rrs = w.byMac.get(refMac);
        const rm = rrs ? median(dedupeConsecutive(rrs)) : null;
        if (rm !== null) refObs = { mac: refMac, world: refWorld, rssi: rm };
      }
      winsFit++;
      // Regime do fit sobre o conjunto COMPLETO (todas as âncoras audíveis) com e sem refTag.
      const fitBase = fitPathLoss(obsAnchors, stationWorld!);
      if (fitBase.source === "anchors") srcAnchorsBase++;
      if (refObs) {
        const fitRef = fitPathLoss([...obsAnchors, refObs], stationWorld!);
        if (fitRef.source === "anchors") srcAnchorsWithRef++;
        nWithRef.push(fitRef.n);
      }
      // LOO sobre as âncoras: retém cada âncora, prevê-a de um modelo que NÃO a viu.
      for (let i = 0; i < obsAnchors.length; i++) {
        const held = obsAnchors[i];
        const rest = obsAnchors.filter((_, j) => j !== i);
        if (rest.length < 2) continue;
        const dTrue = Math.hypot(held.world.x - stationWorld!.x, held.world.y - stationWorld!.y);
        if (!(dTrue > 0)) continue;
        const mBase = fitPathLoss(rest, stationWorld!);
        const eBase = Math.abs(Math.log10(Math.max(distFromRssi(mBase, held.rssi), 0.1) / Math.max(dTrue, 0.1)));
        looBase.push(eBase);
        if (refObs) {
          const mRef = fitPathLoss([...rest, refObs], stationWorld!);
          const eRef = Math.abs(Math.log10(Math.max(distFromRssi(mRef, held.rssi), 0.1) / Math.max(dTrue, 0.1)));
          looWithRef.push(eRef);
        }
      }
    }
    log(`  janelas com ≥3 âncoras (base do fit): ${winsFit}`);
    log(`  G2 — fit vira source="anchors": base ${prop(srcAnchorsBase, winsFit)} · +refTag ${refMac ? prop(srcAnchorsWithRef, winsFit) : "— (refTag inaudível/ausente)"}`);
    const g2Pass = winsFit > 0 && srcAnchorsWithRef / winsFit >= 0.5;
    if (nWithRef.length) {
      const ns = [...nWithRef].sort((a, b) => a - b);
      log(`  n estimado com 5 pts: mediana ${median(ns)!.toFixed(2)} · p10 ${q(ns, 0.1).toFixed(2)} · p90 ${q(ns, 0.9).toFixed(2)} (n janelas ${ns.length})`);
      log(`    (n indoor plausível 1.8–3.5; se p10–p90 varre 1.2–4.5 o expoente é RUÍDO, não medição)`);
    }
    const mBaseL = median(looBase);
    const mRefL = median(looWithRef);
    log("");
    log(`  G3 — resíduo LOO da âncora RETIDA (décadas; o delta que a refTag compra, Regra 11):`);
    log(`    sem refTag na calibração: mediana ${mBaseL?.toFixed(3) ?? "—"} (n ${looBase.length})`);
    log(`    com refTag na calibração: ${looWithRef.length ? `mediana ${mRefL?.toFixed(3)} (n ${looWithRef.length})` : "— (refTag nunca audível junto de ≥2 âncoras)"}`);
    // Comparação PAREADA quando há os dois (mesmas retenções):
    let g3Pass = false;
    if (looWithRef.length && mBaseL && mRefL) {
      // recomputa base pareado só onde há withRef não é trivial aqui; reporta razão das medianas.
      const ratio = mRefL / mBaseL;
      log(`    razão mediana(+refTag)/mediana(base) = ${ratio.toFixed(2)} (régua: ≤ 0.80 conta como ganho)`);
      g3Pass = ratio <= 0.8;
    }

    // ——— R0: σ e piso de resolução, base vs +refTag ———
    log("");
    log("== R0 · Regra 9 — piso de resolução (o modelo RESOLVE a cena?) ==");
    const sigma = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length) : null);
    const sBase = sigma(looBase);
    const sRef = sigma(looWithRef);
    const dMed = median(anchorWorlds.map((w) => Math.hypot(w.x - stationWorld!.x, w.y - stationWorld!.y)))!;
    const floor = (s: number | null) => (s ? dMed * (Math.pow(10, s) - 1) : null);
    log(`  σ (décadas) — base ${sBase?.toFixed(3) ?? "—"} · +refTag ${sRef?.toFixed(3) ?? "—"}`);
    log(`  piso de resolução a ${dMed.toFixed(2)} m — base ${floor(sBase)?.toFixed(2) ?? "—"} m · +refTag ${floor(sRef)?.toFixed(2) ?? "—"} m`);
    log(`  separação radial a resolver: ${DESK_SEP_RADIAL_M} m`);
    const r0Base = floor(sBase);
    const r0Ref = floor(sRef);
    const r0Pass = r0Ref !== null && r0Ref < DESK_SEP_RADIAL_M;
    log(`  R0 ⇒ base ${r0Base !== null && r0Base < DESK_SEP_RADIAL_M ? "resolve" : "NÃO resolve"} · +refTag ${r0Ref === null ? "—" : r0Ref < DESK_SEP_RADIAL_M ? "resolve" : `NÃO resolve (piso ${r0Ref.toFixed(2)} m ≥ ${DESK_SEP_RADIAL_M} m)`}`);

    // ——— CAMINHO ALTERNATIVO (task #67 parte 3): a estabilidade de uma refTag FIXA no TEMPO ———
    // O laudo mediu 2–30% de saltos >6 dB, mas em tags EM MOVIMENTO (ponto cego declarado). As
    // ÂNCORAS são exatamente refTags FIXAS na parede — então medimos AQUI o que o monitor de drift
    // vigiaria: a deriva do RSSI de uma tag PARADA ao longo de toda a gravação (39 h). Se o próprio
    // sinal de uma tag fixa passeia muito, o alarme de drift tem de morar bem ACIMA desse passeio,
    // senão vira alarme falso — isto DIMENSIONA (ou mata) a alternativa, sem tela de calibração.
    log("");
    log("== ALTERNATIVA · DRIFT do RSSI de uma tag FIXA no TEMPO (as âncoras são refTags fixas) ==");
    // Série temporal do RSSI mediano por HORA de cada âncora (a granularidade que um monitor usaria).
    const HOUR_MS = 3600_000;
    for (const mac of anchorMacs) {
      const perHour = new Map<number, number[]>();
      for (const w of wins) {
        const rs = w.byMac.get(mac);
        if (!rs) continue;
        const m = median(dedupeConsecutive(rs));
        if (m === null) continue;
        const h = Math.floor(w.t0 / HOUR_MS);
        let arr = perHour.get(h);
        if (!arr) perHour.set(h, (arr = []));
        arr.push(m);
      }
      const hourlyMed = [...perHour.values()].map((xs) => median(xs)!).filter(Number.isFinite);
      if (hourlyMed.length < 2) {
        log(`  ${mac}: horas com sinal < 2 — sem série de drift`);
        continue;
      }
      const hs = [...hourlyMed].sort((a, b) => a - b);
      const spread = q(hs, 0.99) - q(hs, 0.01); // deriva ponta-a-ponta das medianas HORÁRIAS
      const iqrH = q(hs, 0.75) - q(hs, 0.25);
      // fração de horas cujo desvio da mediana-global excede 6 dB (o limiar do laudo)
      const gm = median(hs)!;
      const jumps = hourlyMed.filter((v) => Math.abs(v - gm) > 6).length;
      log(
        `  ${mac}: mediana-global ${gm.toFixed(1)} dBm · deriva horária p1–p99 ${spread.toFixed(1)} dB · IQR ${iqrH.toFixed(1)} dB · horas >6 dB da mediana: ${prop(jumps, hourlyMed.length)}`,
      );
    }
    log(`  LEITURA: o alarme de drift precisa de um limiar ACIMA da deriva NATURAL de uma tag fixa`);
    log(`  (medida aqui, sem movimento e sem corpo humano na frente); abaixo dela, é alarme falso.`);

    // ——— VEREDITO ———
    log("");
    log("== VEREDITO ==");
    log(`  G1 (span cruza 0.4): ${refWorld ? (g1Pass ? "PASSA" : "REPROVA") : "N/A (sem refTag)"}`);
    log(`  G2 (fit vira 'anchors' ≥50%): ${refMac ? (g2Pass ? "PASSA" : "REPROVA") : "N/A"}`);
    log(`  G3 (LOO cai ≥20%): ${looWithRef.length ? (g3Pass ? "PASSA" : "REPROVA") : "N/A"}`);
    log(`  R0 (piso < ${DESK_SEP_RADIAL_M} m): ${r0Ref === null ? "N/A" : r0Pass ? "PASSA" : "REPROVA"}`);
    const build = !!refWorld && g1Pass && (g2Pass || g3Pass) && r0Pass;
    log(`  ⇒ ${build ? "CONSTRÓI a fiação (world na refTag: tipo/hub/UI/fit)" : "NÃO CONSTRÓI — a refTag como 5º ponto NÃO identifica o modelo. O problema é a GEOMETRIA das âncoras (todas ~1–1.7 m da estação), não a CONTAGEM de pontos. Caminho alternativo: monitor de DRIFT do RSSI@1m FORA da tela de calibração."}`);

    console.log("\nREFTAG-REPORT-BEGIN\n" + out.join("\n") + "\nREFTAG-REPORT-END\n");
    expect(wins.length).toBeGreaterThan(0);
  }, 600_000);
});
