// DESENHO da vista superior (top-down) 2D — folha de pintura, SEPARADA do cálculo (o núcleo de
// mundo vive em fusion/topdown.ts, testável sem canvas; a mesma divisão de floor-polygon.ts).
//
// Pinta: grade métrica de 1 m, o retângulo do chão calibrado, os beacons (círculo + nome; VIVO vs
// "sem sinal" going-gray), os anéis de distância por tag (finos), o beacon MAIS PRÓXIMO de cada tag
// DESTACADO com uma linha radial e o rótulo "d≈X m", e uma legenda curta.
//
// COR = INFORMAÇÃO (doutrina): base neutra por token --state-*; going-gray para beacon sem sinal. Ao
// contrário dos overlays SOBRE o vídeo (draw.ts, onde "a imagem é soberana" proíbe número na cena),
// AQUI o canvas É a própria vista de dados — número/rótulo são o conteúdo, não ruído sobre a imagem.
// Consome os tokens via cssVar (mesmo cache do draw.ts); nunca hex cru de estado.

import { cssVar } from "./draw";
import type { TopdownTransform, TopdownView } from "../fusion/topdown";
import type { Vec2 } from "../vision/homography";

const RING_SEGMENTS = 72; // amostragem do círculo em mundo (suave sem custar caro; dado BLE é lento)

/** Desenha um texto curto sobre um scrim escuro (legível sobre a superfície escura da vista). */
function label(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, fg: string, scrim: string) {
  const w = ctx.measureText(txt).width + 6;
  ctx.fillStyle = scrim;
  ctx.fillRect(x, y - 8, w, 14);
  ctx.fillStyle = fg;
  ctx.fillText(txt, x + 3, y + 3);
}

/** Traça um anel (círculo de raio `radiusM` em MUNDO ao redor de `centerWorld`) já projetado. */
function ringPath(ctx: CanvasRenderingContext2D, tf: TopdownTransform, centerWorld: Vec2, radiusM: number) {
  ctx.beginPath();
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const th = (2 * Math.PI * i) / RING_SEGMENTS;
    const p = tf.project({ x: centerWorld.x + radiusM * Math.cos(th), y: centerWorld.y + radiusM * Math.sin(th) });
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
}

export function drawTopdown(
  ctx: CanvasRenderingContext2D,
  view: TopdownView,
  tf: TopdownTransform,
  canvas: { w: number; h: number },
) {
  const surface = cssVar("--cam-surface-bg", "#05080c");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  const neutral = cssVar("--state-neutral", "#64748b");
  const neutralDim = cssVar("--state-neutral-dim", "#5b6b7a");
  const info = cssVar("--state-info", "#38bdf8");
  const fg = cssVar("--cam-overlay-fg", "#cbd5e1");

  ctx.save();
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.w, canvas.h);
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineJoin = "round";

  const worldById = new Map(view.beacons.map((b) => [b.id, b.world] as const));

  // ── Grade métrica de 1 m + retângulo do chão (só com calibração) ──
  if (view.floorWorld.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of view.floorWorld) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    ctx.strokeStyle = neutralDim;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx++) {
      const a = tf.project({ x: gx, y: minY });
      const b = tf.project({ x: gx, y: maxY });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let gy = Math.ceil(minY); gy <= Math.floor(maxY); gy++) {
      const a = tf.project({ x: minX, y: gy });
      const b = tf.project({ x: maxX, y: gy });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Contorno do chão calibrado (polígono dos cantos).
    ctx.strokeStyle = neutral;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    view.floorWorld.forEach((p, i) => {
      const q = tf.project(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  // ── Anéis de distância por tag (finos). Não-mais-próximo: tracejado neutro esmaecido. ──
  ctx.lineWidth = 1;
  for (const t of view.tags) {
    for (const r of t.rings) {
      const c = worldById.get(r.beaconId);
      if (!c) continue;
      const isNearest = t.nearest?.beaconId === r.beaconId;
      ctx.setLineDash(isNearest ? [] : [4, 4]);
      ctx.strokeStyle = isNearest ? info : neutral;
      ctx.globalAlpha = isNearest ? 0.95 : 0.4;
      ctx.lineWidth = isNearest ? 1.75 : 1;
      ringPath(ctx, tf, c, r.radiusM);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // ── Linha tag↔beacon-mais-próximo + rótulo "d≈X m". A tag NÃO tem ponto (1 estação dá distância,
  //    não posição): a linha é uma SPOKE radial do beacon até a borda do seu anel (o mais próximo),
  //    espalhada por ângulo para não empilhar rótulos. Comunica "a tag está nESTE anel, a ~d m
  //    dESTE beacon (o mais perto)", sem inventar (x,y). ──
  ctx.lineWidth = 1.25;
  view.tags.forEach((t, i) => {
    if (!t.nearest) return;
    const c = worldById.get(t.nearest.beaconId);
    if (!c) return;
    const th = (i * 2.399963) % (2 * Math.PI); // ângulo áureo — distribui as spokes
    const edge = tf.project({ x: c.x + t.nearest.distM * Math.cos(th), y: c.y + t.nearest.distM * Math.sin(th) });
    const o = tf.project(c);
    ctx.strokeStyle = info;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(edge.x, edge.y);
    ctx.stroke();
    const dist = t.nearest.distM < 10 ? t.nearest.distM.toFixed(1) : String(Math.round(t.nearest.distM));
    label(ctx, `${t.label} · d≈${dist} m`, edge.x + 4, edge.y, info, scrim);
  });

  // ── Beacons: círculo cheio + anel + NOME. VIVO = info; sem sinal = going-gray (neutral-dim). ──
  for (const b of view.beacons) {
    const p = tf.project(b.world);
    const col = b.live ? info : neutralDim;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    label(ctx, b.live ? b.label : `${b.label} · sem sinal`, p.x + 10, p.y - 2, col, scrim);
  }

  // ── Legenda curta ──
  label(
    ctx,
    "beacon ○ · anel = distância · linha cheia = mais próximo",
    8,
    canvas.h - 8,
    fg,
    scrim,
  );

  ctx.restore();
}
