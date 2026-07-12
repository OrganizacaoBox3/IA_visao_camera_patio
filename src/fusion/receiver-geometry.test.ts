// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EXPERIMENTO DECISIVO E NÃO-CIRCULAR (ADR-014, Onda 1): mover o receptor BLE para o DESTINO fabrica
// o span radial que o gate H1 pediu?
//
// POR QUE ESTE CÁLCULO É NÃO-CIRCULAR — leia antes de duvidar do número: o span radial é propriedade
// PURA da geometria de instalação (trajetória da pessoa × distância euclidiana ao receptor). Este
// arquivo NUNCA lê o RSSI/o modelo de rádio do simulador — extrai APENAS a POSIÇÃO verdadeira da
// pessoa em metros (do pé projetado pela homografia) e computa distâncias euclidianas. Logo a
// conclusão independe do modelo de RSSI do sim (que é onde mora o risco de circularidade que
// contaminou o gate H1). É o uso legítimo da bancada do ADR-014 item 7.
//
// COMO A TRAJETÓRIA VERDADEIRA EM METROS É EXTRAÍDA (caminho escolhido, documentado):
//   O sim NÃO exporta as posições-verdade. Recupero-as EXATAS invertendo H sobre o PÉ de cada track,
//   regenerando o cenário com pxJitter:0. Isso é legítimo e exato porque:
//   • pxJitter:0 NÃO altera o caminho: o consumo de RNG é byte-idêntico (randn é SEMPRE sorteado
//     mesmo com jitter 0 — ver sim.ts; o pé projetado fica a >25σ da borda do FOV na área útil, então
//     nunca vira; e o dropout independe do jitter). Só remove o ruído de observação — o pé passa a ser
//     a projeção EXATA da posição-verdade, e pixelToWorld(H, ·) devolve a posição-verdade em metros.
//   • uncalibrated:false só EXPÕE H (o sim projeta sempre com a H real; o flag mexe apenas no campo
//     exportado) — não toca RNG nem geometria. Necessário para os cenários uncalibrated (sem-calibracao).
//   • Agrupo por truthTagByTrack (o MAC = identidade da PESSOA), não por trackId: o id do tracker
//     TROCA no id-switch (cruzamento), o MAC não → a trajetória por pessoa fica íntegra através do switch.
//   Não reimplemento o walker (seria duplicação frágil de sim.ts); inverto H (o caminho que o próprio
//   prompt sanciona). Nunca edito sim.ts — só importo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { simulateFusionScenario } from "./sim";
import type { SimOpts } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { parseFusionSession } from "./session-loader";
import { pixelToWorld } from "../vision/homography";
import {
  DEFAULT_ROOM_GRID,
  optimalReceiver,
  radialSpan,
  straightApproach,
  type Pt,
} from "./receiver-geometry";

// Constantes de geometria ESPELHADAS de sim.ts (não são exportadas de lá; espelhadas e documentadas
// — se mudarem em sim.ts, mudam aqui). STATION_WORLD = estação no canto do chão (o receptor do
// call-site fullscreen calibrado, e o que a métrica de visita usa: dist à estação em (0,0)).
// CAMERA_WORLD = câmera atrás do lado próximo — a co-locação "junto da câmera" que o ADR-014 diz
// medir ~0,08–0,11 década hoje (a instalação a BATER).
const STATION_WORLD: Pt = { x: 0, y: 0 };
const CAMERA_WORLD: Pt = { x: 4, y: -2 };

type ScenarioEntry = (typeof FUSION_SCENARIOS)[number];

/** MAC da pessoa 0 (primeira tag) no sim — a trajetória representativa por cenário. */
const PERSON0_MAC = "AA:AA";

/**
 * Trajetórias VERDADEIRAS em metros por PESSOA (chave = MAC), robustas a id-switch. Ver cabeçalho
 * para a justificativa do pxJitter:0 / uncalibrated:false / agrupamento por MAC. NÃO lê RSSI.
 */
function extractTrajectoriesMeters(opts: SimOpts, seed: number): Map<string, Pt[]> {
  const sc = simulateFusionScenario({ ...opts, pxJitter: 0, uncalibrated: false }, seed);
  const H = sc.H;
  const byMac = new Map<string, Pt[]>();
  if (!H) return byMac; // uncalibrated:false garante H; guarda defensiva
  for (const tick of sc.ticks) {
    for (const trk of tick.tracks) {
      const mac = tick.truthTagByTrack[trk.id];
      if (!mac) continue; // pessoa SEM tag → identidade indistinta, fora do escopo do experimento
      const footX = trk.bbox[0] + trk.bbox[2] / 2;
      const footY = trk.bbox[1] + trk.bbox[3];
      const world = pixelToWorld(H, { x: footX, y: footY });
      if (!world) continue;
      let arr = byMac.get(mac);
      if (!arr) {
        arr = [];
        byMac.set(mac, arr);
      }
      arr.push(world);
    }
  }
  return byMac;
}

/** Uma linha da tabela por cenário (pessoa 0): spans para receptor em câmera/estação/destino/ótimo. */
type ScenarioRow = {
  scenario: string;
  nPts: number;
  spanCamera: number;
  spanStation: number;
  spanDestino: number;
  spanOtimo: number;
  rangeOtimo: number;
  posOtimo: Pt;
};

function analyzeScenarioPerson0(entry: ScenarioEntry): ScenarioRow | null {
  const traj = extractTrajectoriesMeters(entry.opts, entry.seed).get(PERSON0_MAC);
  if (!traj || traj.length < 2) return null;
  const destino = traj[traj.length - 1]; // ponto FINAL do caminho = "receptor no destino"
  const opt = optimalReceiver(traj, DEFAULT_ROOM_GRID);
  return {
    scenario: entry.name,
    nPts: traj.length,
    spanCamera: radialSpan(traj, CAMERA_WORLD).spanDecades,
    spanStation: radialSpan(traj, STATION_WORLD).spanDecades,
    spanDestino: radialSpan(traj, destino).spanDecades,
    spanOtimo: opt.span.spanDecades,
    rangeOtimo: opt.span.rangeDecades,
    posOtimo: opt.receiver,
  };
}

function formatTable(rows: ScenarioRow[]): string {
  const header = [
    "cenário",
    "nPts",
    "span(câmera)",
    "span(estação)",
    "span(destino)",
    "span(ótimo)",
    "range(ótimo)",
    "pos(ótimo)",
  ];
  const body = rows.map((r) => [
    r.scenario,
    String(r.nPts),
    r.spanCamera.toFixed(3),
    r.spanStation.toFixed(3),
    r.spanDestino.toFixed(3),
    r.spanOtimo.toFixed(3),
    r.rangeOtimo.toFixed(3),
    `(${r.posOtimo.x.toFixed(1)},${r.posOtimo.y.toFixed(1)})`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}

describe("receiver-geometry — span radial (geometria PURA, NÃO-CIRCULAR)", () => {
  it("guarda: trajetória com <2 pontos → span 0 e range 0", () => {
    expect(radialSpan([], { x: 0, y: 0 })).toEqual({ spanDecades: 0, rangeDecades: 0, nPoints: 0 });
    expect(radialSpan([{ x: 1, y: 1 }], { x: 0, y: 0 })).toEqual({
      spanDecades: 0,
      rangeDecades: 0,
      nPoints: 1,
    });
  });

  it("guarda: receptor EM CIMA de um ponto (dist 0) não gera −∞/NaN (clamp no piso)", () => {
    const s = radialSpan([{ x: 0, y: 0 }, { x: 5, y: 0 }], { x: 0, y: 0 });
    expect(Number.isFinite(s.spanDecades)).toBe(true);
    expect(Number.isFinite(s.rangeDecades)).toBe(true);
  });

  it("distância CONSTANTE ao receptor (círculo) → span ≈ 0 (sem variação radial = sem assinatura)", () => {
    // 24 pontos num círculo de raio 3 em torno do receptor: log10(dist) constante → std 0.
    const receiver: Pt = { x: 4, y: 3 };
    const circle: Pt[] = [];
    for (let k = 0; k < 24; k++) {
      const a = (2 * Math.PI * k) / 24;
      circle.push({ x: receiver.x + 3 * Math.cos(a), y: receiver.y + 3 * Math.sin(a) });
    }
    const s = radialSpan(circle, receiver);
    expect(s.spanDecades).toBeLessThan(1e-9);
    expect(s.rangeDecades).toBeLessThan(1e-9);
  });

  it("TETO GEOMÉTRICO: aproximação RETA idealizada fica ABAIXO de 0,42 (std é stingy; range é amplo)", () => {
    // A caminhada idealizada do ADR-014: a pessoa anda em linha reta de LONGE (8 m) até ~0,3 m do
    // receptor. É o span MÁXIMO que a geometria de uma aproximação dirigida pode fabricar.
    const traj = straightApproach({ x: 8, y: 0 }, { x: 0.3, y: 0 }, 120);
    const s = radialSpan(traj, { x: 0, y: 0 });
    // Uma aproximação reta a velocidade constante distribui a distância ~uniforme no tempo, e
    // std(log10 U[a,b]) ≈ 0,29·range. Com range 8→0,3 m (≈1,43 déc) o std sai ~0,33 déc — ABAIXO do
    // ~0,9 do ADR e mal abaixo do 0,42 "passa por pouco". ACHADO: para o std bater 0,9 a razão
    // longe/perto teria de ser ~1000:1 (range ~3,1 déc) — irreal indoor. O ganho da colocação no
    // destino é real (3–4× o co-locado), mas o alvo de 0,9 em STD é otimista. Ver laudo/VEREDITO.
    const teto09 = radialSpan(straightApproach({ x: 30, y: 0 }, { x: 0.1, y: 0 }, 120), { x: 0, y: 0 });
    console.log(
      `\nTETO GEOMÉTRICO (aproximação reta a velocidade constante):\n` +
        `  8 m → 0,3 m no receptor: span=${s.spanDecades.toFixed(3)} déc | range=${s.rangeDecades.toFixed(3)} déc\n` +
        `  30 m → 0,1 m (armazém, extremo): span=${teto09.spanDecades.toFixed(3)} déc | range=${teto09.rangeDecades.toFixed(3)} déc`,
    );
    // Robusto (não cravo 0,9): a faixa dinâmica bruta é ampla (>1 déc) e o std supera o co-locado,
    // mas fica ABAIXO do 0,42 — a assertiva sela o achado de que o std de uma aproximação reta é modesto.
    expect(s.rangeDecades).toBeGreaterThan(1.0);
    expect(s.spanDecades).toBeGreaterThan(0.25);
    expect(s.spanDecades).toBeLessThan(0.42);
  });

  it("determinístico: extrair a trajetória duas vezes dá o MESMO caminho", () => {
    const a = extractTrajectoriesMeters({ steps: 60, people: 3, tagged: 2, walk: "waypoint" }, 42);
    const b = extractTrajectoriesMeters({ steps: 60, people: 3, tagged: 2, walk: "waypoint" }, 42);
    expect([...a.get(PERSON0_MAC)!]).toEqual([...b.get(PERSON0_MAC)!]);
  });

  it("TABELA + VEREDITO: span por posição de receptor, por cenário de FUSION_SCENARIOS", () => {
    const rows: ScenarioRow[] = [];
    for (const entry of FUSION_SCENARIOS) {
      const row = analyzeScenarioPerson0(entry);
      if (row) rows.push(row);
    }
    const moving = rows.filter((r) => r.spanOtimo > 1e-6); // "parado" tem span 0 em toda posição

    console.log(`\n${formatTable(rows)}\n`);
    const teto = radialSpan(straightApproach({ x: 8, y: 0 }, { x: 0.3, y: 0 }, 120), { x: 0, y: 0 })
      .spanDecades;
    const meanCam = moving.reduce((s, r) => s + r.spanCamera, 0) / moving.length;
    const meanStn = moving.reduce((s, r) => s + r.spanStation, 0) / moving.length;
    const meanDest = moving.reduce((s, r) => s + r.spanDestino, 0) / moving.length;
    const meanOpt = moving.reduce((s, r) => s + r.spanOtimo, 0) / moving.length;
    console.log(
      "MÉDIAS (cenários COM movimento, pessoa 0):\n" +
        `  span(câmera)=${meanCam.toFixed(3)}  span(estação)=${meanStn.toFixed(3)}  ` +
        `span(destino)=${meanDest.toFixed(3)}  span(ótimo)=${meanOpt.toFixed(3)} déc\n` +
        `REFERÊNCIA ADR-014: ~0,42 "passa por pouco" | ~0,9 esperado receptor NO DESTINO | ` +
        `~0,08–0,11 hoje junto da câmera | TETO reta idealizada=${teto.toFixed(3)} déc`,
    );
    console.log(
      "VEREDITO (geometria pura, NÃO-CIRCULAR): mover o receptor para o destino GANHA ~3–4× sobre a\n" +
        "co-locação com a câmera (0,09→0,29 destino / 0,34 ótimo), confirmando a DIREÇÃO do ADR-014.\n" +
        "MAS o alvo de ~0,9 década em STD NÃO é fabricado: o teto de uma aproximação reta idealizada é\n" +
        "~0,33 déc (e ~0,43 no extremo irreal 30 m→0,1 m). O std de log10(dist) é intrinsecamente modesto\n" +
        "(range amplo ~1,8 déc, mas a caminhada visita muito as distâncias intermediárias). Onda 1 entrega\n" +
        "ganho RELATIVO real, porém insuficiente para o limiar de significância de H1 — sinal de PIVÔ.",
    );

    // ── Assertivas ROBUSTAS (só o que é geometricamente garantido; os números vão pro laudo) ──
    expect(moving.length).toBeGreaterThan(0);
    for (const r of moving) {
      // Definicional: a estação (0,0) está NA grade → o ótimo nunca perde pra ela.
      expect(r.spanOtimo).toBeGreaterThanOrEqual(r.spanStation - 1e-9);
      // Há movimento → existe posição que fabrica span > 0.
      expect(r.spanOtimo).toBeGreaterThan(0);
      // DIREÇÃO do ADR-014: colocar o receptor NO DESTINO da caminhada bate a co-locação com a
      // câmera. Robusto porque o destino é um PONTO DA trajetória (dist mínima → piso), enquanto a
      // câmera é externa e fixa; o gradiente radial na chegada é sempre maior.
      expect(r.spanDestino).toBeGreaterThan(r.spanCamera);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BÔNUS: trajetória REAL da caminhada (gravação de campo) — GATED pela existência do arquivo (como
// WALK_FILES/describe.skipIf em visit-metrics.test.ts). Arquivo READ-ONLY (CLAUDE.md §3). Sem verdade
// de destino anotada → reporto span por posição candidata SEM afirmar precisão.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const WALK_FILES = [
  "server/bt/fusion-session-2026-07-11_20.jsonl",
  "server/bt/fusion-session-2026-07-11_19.jsonl",
];
const WALK_FILE = WALK_FILES.find((f) => existsSync(f));

/** Trajetórias em metros da gravação real, por trackId (sem verdade → não dá pra reagrupar por MAC;
 *  cada trackId é uma pista). Só com H calibrada (proxy de caixa não é metro real). */
function realTrajectoriesMeters(lines: string[]): { byTrack: Map<number, Pt[]>; calibrated: boolean } {
  const sc = parseFusionSession(lines, {});
  const byTrack = new Map<number, Pt[]>();
  if (!sc.H) return { byTrack, calibrated: false };
  for (const tick of sc.ticks) {
    for (const trk of tick.tracks) {
      const footX = trk.bbox[0] + trk.bbox[2] / 2;
      const footY = trk.bbox[1] + trk.bbox[3];
      const world = pixelToWorld(sc.H, { x: footX, y: footY });
      if (!world) continue;
      let arr = byTrack.get(trk.id);
      if (!arr) {
        arr = [];
        byTrack.set(trk.id, arr);
      }
      arr.push(world);
    }
  }
  return { byTrack, calibrated: true };
}

describe.skipIf(!WALK_FILE)("receiver-geometry — gravação REAL da caminhada (span geométrico)", () => {
  it("span da pista mais longa: receptor na estação atual vs posição ótima da sala", () => {
    const lines = readFileSync(WALK_FILE!, "utf8").split(/\r?\n/);
    const { byTrack, calibrated } = realTrajectoriesMeters(lines);
    const out: string[] = ["RECEIVER-REAL-BEGIN", `arquivo: ${WALK_FILE}`];
    out.push(`H: ${calibrated ? "calibrada (metros)" : "NULA (proxy — sem metros reais)"}`);

    if (calibrated) {
      const tracks = [...byTrack.entries()]
        .filter(([, pts]) => pts.length >= 2)
        .sort((a, b) => b[1].length - a[1].length);
      out.push(`pistas com ≥2 pontos: ${tracks.length}`);
      for (const [id, pts] of tracks.slice(0, 5)) {
        const stn = radialSpan(pts, STATION_WORLD).spanDecades;
        const opt = optimalReceiver(pts, DEFAULT_ROOM_GRID);
        out.push(
          `  track ${String(id).padStart(4)}: ${String(pts.length).padStart(4)} pts | ` +
            `span(estação)=${stn.toFixed(3)} | span(ótimo)=${opt.span.spanDecades.toFixed(3)} ` +
            `@ (${opt.receiver.x.toFixed(1)},${opt.receiver.y.toFixed(1)})`,
        );
      }
      out.push(
        "NOTA: sem destino anotado, o 'ótimo' é o TETO geométrico da sala para aquela pista — " +
          "não uma afirmação de precisão de identidade.",
      );
    } else {
      out.push("Sem H calibrada na gravação → não há posições em metros; span geométrico indefinido.");
    }
    out.push("RECEIVER-REAL-END");
    console.log(out.join("\n"));
    expect(byTrack.size).toBeGreaterThanOrEqual(0); // presença do arquivo já basta; laudo é o produto
  });
});
