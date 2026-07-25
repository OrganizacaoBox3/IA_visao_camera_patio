// O GATE DE MOVIMENTO TEM DE HONRAR `points` (spec-zona-unificada §5 — o risco nº 1).
//
// A MORDIDA QUE ESTE ARQUIVO EXISTE PARA IMPEDIR: `buildMotionIgnore` mapeava a zona de exclusão
// para `{x,y,w,h}` e DESCARTAVA `points` em silêncio. Enquanto nenhuma exclusão era polígono, o
// dano era zero. Depois da unificação TODA exclusão é polígono — e uma exclusão em "L" viraria o
// RETÂNGULO ENVOLVENTE no mapa de ignore do gate. O gate passaria a ignorar TAMBÉM o VÃO do L, que
// é área de trabalho com gente de verdade.
//
// A DIREÇÃO DA FALHA É A PERIGOSA (e é por isso que o teste principal aqui NÃO checa bits, checa
// COMPORTAMENTO): movimento no vão não conta ⇒ ratio abaixo do limiar ⇒ o gate PULA a inferência
// ⇒ O MOTOR NÃO ACORDA. É vigilância: um gate que cega a câmera é pior que um gate que não economiza.
// É a MESMA CLASSE do bug do `calibration.stations` (consumidor descartando um campo calado) —
// contrato entre camadas sem teste é a regressão silenciosa nº 1.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("./engine");
const motion = require("./motion");
const { PRECISION } = require("./precision");

// Fixtures COMPARTILHADAS (CA-4) — o mesmo "elle" côncavo que zones.test.js/zones.test.ts usam.
const FIX = require("../../src/zones-polygon-fixtures.json");
const ELLE = FIX.polygons.elle; // braço x∈[0.1,0.3] y∈[0.1,0.8] + pé x∈[0.1,0.6] y∈[0.6,0.8]

const W = motion.THUMB_W; // 64
const H = motion.THUMB_H; // 48

// PRÉ-CONDIÇÃO: o gate lê ANALYSIS_MOTION_GATE no load do módulo. Com ele desligado,
// buildMotionIgnore devolve null por contrato e nada aqui faz sentido — falhe alto, não calado.
if (!motion.GATE_ON) throw new Error("engine.test.js exige o gate de movimento LIGADO (ANALYSIS_MOTION_GATE)");

/** índice do pixel do thumbnail sob um ponto NORMALIZADO (mesma indexação do mapa de ignore) */
function px(nx, ny) {
  const c = Math.min(W - 1, Math.max(0, Math.floor(nx * W)));
  const r = Math.min(H - 1, Math.max(0, Math.floor(ny * H)));
  return r * W + c;
}
/** zona de exclusão POLIGONAL como o camcfg grava: points + bbox DERIVADA (nunca autorada) */
function polyZone(points) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { id: "zx", label: "Ex", modo: "exclusao", x: minX, y: minY, w: maxX - minX, h: maxY - minY, points };
}

describe("buildMotionIgnore — a exclusão POLIGONAL é rasterizada, não achatada na envolvente", () => {
  it("ignora SÓ o L, não a envolvente dele (o vão do L continua VIGIADO)", () => {
    const m = engine.buildMotionIgnore([polyZone(ELLE)]);
    expect(m).not.toBeNull();
    expect(m.length).toBe(W * H);

    // DENTRO do L → ignorado (é o que a zona de exclusão pede: hotspot não dispara o gate)
    expect(m[px(0.2, 0.3)]).toBe(1); // braço vertical
    expect(m[px(0.45, 0.7)]).toBe(1); // pé horizontal

    // NO VÃO do L → NÃO ignorado. Está DENTRO da bbox envolvente (0.1..0.6 × 0.1..0.8):
    // é exatamente o pixel que o bug entregava como "ignore". Aqui ele tem de valer 1 na
    // vigilância, isto é, 0 no mapa de ignore.
    expect(m[px(0.45, 0.3)]).toBe(0);
    expect(m[px(0.5, 0.2)]).toBe(0);

    // FORA da bbox → nunca foi ignorado (nem com o bug); pino de sanidade.
    expect(m[px(0.9, 0.9)]).toBe(0);
  });

  it("FAIL DIRECTION: movimento no vão do L AINDA ACORDA o motor (o gate não cega a câmera)", () => {
    const ignore = engine.buildMotionIgnore([polyZone(ELLE)]);

    // Cena estática (luma uniforme) + um blob que se mexe DENTRO DO VÃO do L: 7×7 células,
    // todas com centro em x∈(0.41,0.51) e y∈(0.26,0.39) — dentro da BBOX do L, FORA do L.
    const prev = new Uint8Array(W * H).fill(100);
    const cur = Uint8Array.from(prev);
    for (let r = 12; r < 19; r++)
      for (let c = 26; c < 33; c++) cur[r * W + c] = 100 + PRECISION.gate.pixelDelta + 10; // pixel MUDOU

    const { changed, ratio } = motion.motionRatio(cur, prev, ignore);
    expect(changed).toBe(49); // COM o bug (bbox achatada) estes 49 pixels seriam ignorados → 0
    expect(ratio).toBeGreaterThanOrEqual(PRECISION.gate.motionRatio);

    // sinceMs=0 → o piso de PROBE não salva; a única coisa que acorda o motor é o movimento
    // ter sido CONTADO. Este assert é o produto inteiro do conserto.
    const dec = motion.gateDecision({ ratio, sinceMs: 0, hasPrev: true });
    expect(dec).toEqual({ infer: true, reason: "motion" });
  });

  it("CA-5: zona SEM points segue no retângulo conservador (comportamento intocado)", () => {
    const rect = { id: "zr", label: "Grade", modo: "exclusao", x: 0.1, y: 0.1, w: 0.5, h: 0.7 };
    const m = engine.buildMotionIgnore([rect]);
    const esperado = motion.buildIgnoreMask(W, H, [{ x: 0.1, y: 0.1, w: 0.5, h: 0.7 }]);
    expect([...m]).toEqual([...esperado]); // bit a bit igual ao caminho de sempre
    expect(m[px(0.45, 0.3)]).toBe(1); // retângulo cheio: o "vão" NÃO existe aqui — é zona mesmo
  });

  it("mistura rect + polígono → UNIÃO (uma zona não apaga a outra)", () => {
    const rect = { id: "zr", label: "Relógio", modo: "exclusao", x: 0.8, y: 0.0, w: 0.2, h: 0.1 };
    const m = engine.buildMotionIgnore([rect, polyZone(ELLE)]);
    expect(m[px(0.9, 0.05)]).toBe(1); // do retângulo
    expect(m[px(0.2, 0.3)]).toBe(1); // do polígono
    expect(m[px(0.45, 0.3)]).toBe(0); // e o vão do L segue vigiado
  });

  it("sem zona de exclusão → null (caminho rápido preservado)", () => {
    expect(engine.buildMotionIgnore([])).toBeNull();
    expect(engine.buildMotionIgnore(null)).toBeNull();
    expect(engine.buildMotionIgnore(undefined)).toBeNull();
  });

  it("polígono DEGENERADO (área zero, nenhuma célula marcada) → null, como o rect vazio", () => {
    // 3 vértices colineares: sanitizeZonePoints deixa passar (documentado em zones.js) e
    // pointInPolygon devolve false p/ tudo → nenhuma célula marcada. Não pode virar máscara
    // toda-zero (custo por pixel no laço do motionRatio à toa) nem lançar.
    const linha = [
      { x: 0.2, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ];
    expect(engine.buildMotionIgnore([polyZone(linha)])).toBeNull();
  });

  it("CUSTO: rasterizar roda no REBUILD de config, não por frame — e é barato", () => {
    // 20 vértices (o TETO da casa) num círculo — o pior caso real de uma zona.
    const teto = Array.from({ length: 20 }, (_, i) => {
      const a = (i / 20) * Math.PI * 2;
      return { x: 0.5 + 0.35 * Math.cos(a), y: 0.5 + 0.35 * Math.sin(a) };
    });
    const z = [polyZone(teto)];
    engine.buildMotionIgnore(z); // aquece
    const t0 = process.hrtime.bigint();
    const N = 20;
    for (let i = 0; i < N; i++) engine.buildMotionIgnore(z);
    const msPorRebuild = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    // Teto FOLGADO (50ms): o número real medido é ~0,3ms — o assert existe p/ pegar uma
    // regressão de ORDEM DE GRANDEZA (ex.: alguém rasterizar por FRAME), não p/ cronometrar
    // a máquina. 10ms flakeou em dev sob carga real (hub + pool D-FINE + vite rodando juntos:
    // mediu 12,5ms de pura contenção de CPU, 2026-07-22); 50ms segue 150× acima do real e
    // ainda reprova qualquer regressão de verdade. Isto roda 1× por mudança de zona.
    expect(msPorRebuild).toBeLessThan(50);
  });
});
