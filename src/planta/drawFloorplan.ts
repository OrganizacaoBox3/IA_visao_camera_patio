// DESENHO da Planta BLE — folha de PINTURA, SEPARADA do cálculo. O núcleo de mundo (a estimativa
// X,Y de cada tag, grampeada ao galpão) vive em fusion/floorplan.ts, testável sem canvas; a
// suavização temporal (EMA) vive no hook planta/useFloorplanMap.ts. Aqui só se PINTA a view pronta —
// a mesma divisão cálculo↔pintura de camera/drawTopdown.ts.
//
// A DIFERENÇA CRUCIAL para o top-down: ali a tag é um ANEL (1 antena = distância, não posição); AQUI
// a tag é um PONTO X,Y (multilateração de ≥2 antenas). O dono foi explícito: "círculos não são uma
// boa ideia, precisamos de coordenadas x e y". Então pintamos o ponto E a coordenada em metros.
//
// COR = INFORMAÇÃO (doutrina): base neutra por token --state-*; going-gray para antena sem sinal. Ao
// contrário dos overlays SOBRE o vídeo (draw.ts, onde "a imagem é soberana" proíbe número na cena),
// AQUI o canvas É a própria vista de dados — o número/coordenada é o CONTEÚDO, não ruído sobre imagem.
// Consome os tokens via cssVar (mesmo cache do draw.ts); nunca hex cru de estado.
//
// HONESTIDADE do selo `fix` (herdada do núcleo): ok (≥3 antenas) = ponto sólido, coordenada firme;
// weak (2 antenas) = ponto OCO + halo tracejado + prefixo "≈" (comunica "chute geométrico"); none
// (1 antena) = SEM ponto (não tem X,Y) — fica só na lista textual da página.

import { cssVar } from "../camera/draw";
import { bboxOf, type TopdownBbox, type TopdownTransform } from "../fusion/topdown";
import type { FloorplanView } from "../fusion/floorplan";
import type { Vec2 } from "../api";

/** Passo de rótulo dos eixos adaptado ao tamanho do galpão (evita amontoar/rarear demais os ticks). */
const tickStep = (span: number): number =>
  span <= 6 ? 1 : span <= 15 ? 2 : span <= 40 ? 5 : 10;

/**
 * Bbox de mundo que ENQUADRA a planta: os 4 cantos do retângulo do galpão [0,0]→(w,h) ∪ a posição
 * de cada antena ∪ a posição de cada tag com X,Y (as "none" não têm ponto). Robusto: sem caixa
 * (w/h ≤ 0) e sem antenas/tags → null (o canvas cai no fundo puro). Reusa o bboxOf da família topdown.
 */
export function floorplanBounds(view: FloorplanView): TopdownBbox | null {
  const pts: Vec2[] = [];
  const w = view?.widthM ?? 0;
  const h = view?.heightM ?? 0;
  if (w > 0 && h > 0) {
    pts.push({ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h });
  }
  for (const s of view?.stations ?? []) if (s?.pos) pts.push(s.pos);
  for (const t of view?.tags ?? []) if (t?.pos) pts.push(t.pos);
  return bboxOf(pts);
}

/** Desenha um texto curto sobre um scrim escuro (legível sobre a superfície escura da vista). */
function label(
  ctx: CanvasRenderingContext2D,
  txt: string,
  x: number,
  y: number,
  fg: string,
  scrim: string,
) {
  const w = ctx.measureText(txt).width + 6;
  ctx.fillStyle = scrim;
  ctx.fillRect(x, y - 8, w, 14);
  ctx.fillStyle = fg;
  ctx.fillText(txt, x + 3, y + 3);
}

/** Rótulo ANCORADO a um ponto (px,py), consciente da borda: por padrão à direita do ponto; se
 *  estourasse a borda direita do canvas, vira para a ESQUERDA (marcador na beira do galpão não pode
 *  ter o nome cortado — é o que acontece com a antena em x=largura). */
function labelNear(
  ctx: CanvasRenderingContext2D,
  txt: string,
  px: number,
  py: number,
  fg: string,
  scrim: string,
  canvasW: number,
) {
  const w = ctx.measureText(txt).width + 6;
  let x = px + 8;
  if (x + w > canvasW - 2) x = px - 8 - w; // não cabe à direita → à esquerda do ponto
  if (x < 2) x = 2; // nem à esquerda (ponto colado na borda esquerda) → gruda na margem
  label(ctx, txt, x, py, fg, scrim);
}

/** Marcador de ÂNCORA: triângulo ▲ preenchido apontando para cima, centrado no ponto projetado. */
function anchorMarker(ctx: CanvasRenderingContext2D, p: Vec2, col: string) {
  const s = 6;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - s);
  ctx.lineTo(p.x - s, p.y + s * 0.85);
  ctx.lineTo(p.x + s, p.y + s * 0.85);
  ctx.closePath();
  ctx.fill();
}

export function drawFloorplan(
  ctx: CanvasRenderingContext2D,
  view: FloorplanView,
  tf: TopdownTransform,
  canvas: { w: number; h: number },
) {
  const surface = cssVar("--cam-surface-bg", "#05080c");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  const neutral = cssVar("--state-neutral", "#64748b");
  const neutralDim = cssVar("--state-neutral-dim", "#5b6b7a");
  const info = cssVar("--state-info", "#38bdf8");
  const warn = cssVar("--state-warn", "#eab308");
  const fg = cssVar("--cam-overlay-fg", "#cbd5e1");

  ctx.save();
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.w, canvas.h);
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineJoin = "round";

  const w = view.widthM;
  const h = view.heightM;
  const hasBox = w > 0 && h > 0;

  // ── Grade métrica de 1 m + retângulo do galpão (a caixa [0,0]→(w,h) = a planta) + eixos rotulados.
  //    O dono quer LER coordenadas, então marcamos os ticks ("0", "5 m", "10 m") nas bordas. ──
  if (hasBox) {
    // Grade de 1 m (linhas finas esmaecidas), dentro da caixa.
    ctx.strokeStyle = neutralDim;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= Math.floor(w); gx++) {
      const a = tf.project({ x: gx, y: 0 });
      const b = tf.project({ x: gx, y: h });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let gy = 0; gy <= Math.floor(h); gy++) {
      const a = tf.project({ x: 0, y: gy });
      const b = tf.project({ x: w, y: gy });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Retângulo do galpão (contorno firme).
    const tl = tf.project({ x: 0, y: 0 });
    const br = tf.project({ x: w, y: h });
    ctx.strokeStyle = neutral;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // Rótulos de eixo: X ao longo da borda de cima, Y ao longo da borda esquerda. "0" e "N m".
    const sx = tickStep(w);
    const sy = tickStep(h);
    for (let tx = 0; tx <= w + 1e-6; tx += sx) {
      const p = tf.project({ x: tx, y: 0 });
      labelNear(ctx, tx === 0 ? "0" : `${tx} m`, p.x - 6, p.y - 6, neutralDim, scrim, canvas.w);
    }
    for (let ty = sy; ty <= h + 1e-6; ty += sy) {
      const p = tf.project({ x: 0, y: ty });
      label(ctx, `${ty} m`, tl.x - 34, p.y, neutralDim, scrim);
    }
  }

  // ── TAGS: um PONTO na estimativa X,Y + a coordenada em metros. É o que o dono quer ver. ──
  //    ok (≥3) = ponto sólido info, coordenada firme; weak (2) = ponto OCO warn + halo tracejado +
  //    "≈"; none (1) = sem ponto (sem X,Y) — só na lista textual da página.
  for (const t of view.tags) {
    if (!t.pos) continue; // fix "none": nada a pintar aqui
    const p = tf.project(t.pos);
    const coord = `(${t.pos.x.toFixed(1)}, ${t.pos.y.toFixed(1)})`;
    if (t.fix === "weak") {
      // Halo tracejado = "estimativa fraca, só 2 antenas".
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = warn;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Ponto OCO (só contorno) — comunica "chute".
      ctx.strokeStyle = warn;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      labelNear(ctx, `≈ ${t.label} ${coord}`, p.x, p.y - 2, warn, scrim, canvas.w);
    } else {
      // fix "ok": ponto sólido, coordenada firme.
      ctx.fillStyle = info;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      labelNear(ctx, `${t.label} ${coord}`, p.x, p.y - 2, info, scrim, canvas.w);
    }
  }

  // ── ANTENAS: o referencial FIXO. Triângulo ▲ preenchido + NOME. VIVA = info; sem sinal = going-gray
  //    (neutral-dim + " · sem sinal"). Desenhadas por ÚLTIMO (por cima das tags) — são a âncora. ──
  for (const s of view.stations) {
    const p = tf.project(s.pos);
    const col = s.live ? info : neutralDim;
    anchorMarker(ctx, p, col);
    labelNear(ctx, s.live ? s.label : `${s.label} · sem sinal`, p.x, p.y - 2, col, scrim, canvas.w);
  }

  // ── Legenda curta ──
  label(
    ctx,
    "▲ antena · ● tag (≥3 antenas) · ○ estimativa fraca (2)",
    8,
    canvas.h - 8,
    fg,
    scrim,
  );

  ctx.restore();
}
