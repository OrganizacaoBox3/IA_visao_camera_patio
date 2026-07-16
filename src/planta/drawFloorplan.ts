// DESENHO da Planta BLE — folha de PINTURA, SEPARADA do cálculo. O núcleo de mundo (a estimativa
// X,Y de cada tag vive em fusion/floorplan.ts/continuous-position.ts, testável sem canvas; o filtro
// temporal vive no hook useContinuousFloorplan. Aqui só se PINTA a view pronta —
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
// HONESTIDADE do selo `fix`: ponto sólido significa estimativa qualificada, nunca coordenada exata;
// weak = ponto oco + halo; none = sem X,Y. O halo materializa a incerteza e cresce sem evidência.

import { cssVar } from "../camera/draw";
import { bboxOf, type TopdownBbox, type TopdownTransform } from "../fusion/topdown";
import type { FloorplanView } from "../fusion/floorplan";
import type { ContinuousFloorplanTag } from "../fusion/continuous-position";
import type { FloorplanWorkArea, Vec2 } from "../api";

/** Marcador de ZONA DE TRABALHO (ponto de survey do fingerprinting com coordenada) + quem está nela
 *  AGORA segundo a presença com histerese (fusion/zone-presence.ts). É o PRODUTO da tela: "a tag
 *  está/não está na zona" — a zona ocupada acende (--state-ok); vazia fica neutra. ADITIVO: sem
 *  `zones`, o desenho é byte-idêntico ao anterior. */
export type ZoneMarker = { label: string; pos: Vec2; ocupantes: string[] };
/** Área física para pintura + OCUPAÇÃO opcional (rótulos das tags com presença CONFIRMADA pela
 *  histerese dentro dela). Ocupação é derivada da posição publicada ∩ polígono — nunca move a tag
 *  (ADR-017); só muda a cor/rótulo da área. Ausente = desenho neutro de sempre. */
export type WorkAreaMarker = FloorplanWorkArea & { ocupantes?: readonly string[] };

/** Passo de rótulo dos eixos adaptado ao tamanho do galpão (evita amontoar/rarear demais os ticks). */
const tickStep = (span: number): number => (span <= 6 ? 1 : span <= 15 ? 2 : span <= 40 ? 5 : 10);

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

/** Losango ◆ de zona, centrado no ponto projetado (distinto do ▲ de antena e do ● de tag). */
function zoneMarkerShape(ctx: CanvasRenderingContext2D, p: Vec2, col: string, filled: boolean) {
  const s = 6;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - s);
  ctx.lineTo(p.x + s, p.y);
  ctx.lineTo(p.x, p.y + s);
  ctx.lineTo(p.x - s, p.y);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = col;
    ctx.fill();
  } else {
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

export function drawFloorplan(
  ctx: CanvasRenderingContext2D,
  view: FloorplanView,
  tf: TopdownTransform,
  canvas: { w: number; h: number },
  zones?: readonly ZoneMarker[],
  options: { editing?: boolean; workAreas?: readonly WorkAreaMarker[] } = {},
) {
  const surface = cssVar("--cam-surface-bg", "#05080c");
  const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
  const neutral = cssVar("--state-neutral", "#64748b");
  const neutralDim = cssVar("--state-neutral-dim", "#5b6b7a");
  const info = cssVar("--state-info", "#38bdf8");
  const warn = cssVar("--state-warn", "#eab308");
  const ok = cssVar("--state-ok", "#22c55e");
  const fg = cssVar("--cam-overlay-fg", "#cbd5e1");

  ctx.save();
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.w, canvas.h);
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineJoin = "round";

  const w = view.widthM;
  const h = view.heightM;
  const hasBox = w > 0 && h > 0;
  const compact = canvas.w < 520;

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
      label(ctx, `${ty} m`, Math.max(2, tl.x - 34), p.y, neutralDim, scrim);
    }
  }

  // ÁREAS FÍSICAS são geometria independente do classificador. O polígono informa onde a mesa
  // existe; ele nunca é usado para mover a tag. Distância/ocupação são derivados da posição publicada.
  // Área OCUPADA (presença confirmada pela histerese) acende em --state-ok com quem está nela;
  // vazia segue neutra (going-gray: cor é informação).
  for (const area of options.workAreas ?? []) {
    if (area.polygon.length < 3) continue;
    const ocupantes = area.ocupantes ?? [];
    const ocupada = ocupantes.length > 0;
    const col = ocupada ? ok : neutralDim;
    const points = area.polygon.map(tf.project);
    const anchor = points.reduce((best, point) =>
      point.y < best.y || (point.y === best.y && point.x < best.x) ? point : best,
    );
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.globalAlpha = ocupada ? 0.16 : 0.12;
    ctx.fill();
    ctx.globalAlpha = ocupada ? 0.95 : 0.8;
    ctx.strokeStyle = col;
    ctx.setLineDash(ocupada ? [] : [4, 3]);
    ctx.stroke();
    ctx.restore();
    const quem = ocupantes.join(", ");
    const txt = ocupada
      ? `${area.label} · ${quem.length > 26 ? `${ocupantes.length} na mesa` : quem}`
      : area.label;
    labelNear(ctx, txt, anchor.x, anchor.y - 4, col, scrim, canvas.w);
  }

  // ── ZONAS DE TRABALHO (pontos de survey com coordenada): losango ◆ + nome. Zona OCUPADA acende
  //    (--state-ok, preenchida, rótulo "Zona · quem"); vazia fica neutra (contorno). Desenhadas ANTES
  //    das tags/antenas (são chão, não devem cobrir os marcadores vivos). A ocupação vem da presença
  //    com HISTERESE (zone-presence) — não da classificação instantânea, que oscila. ──
  for (const z of zones ?? []) {
    const p = tf.project(z.pos);
    const ocupada = z.ocupantes.length > 0;
    zoneMarkerShape(ctx, p, ocupada ? ok : neutralDim, ocupada);
    const txt = ocupada
      ? `${z.label} · ${z.ocupantes.length} ${z.ocupantes.length === 1 ? "tag" : "tags"}`
      : z.label;
    labelNear(ctx, txt, p.x, p.y + 14, ocupada ? ok : neutralDim, scrim, canvas.w);
  }

  // ── TAGS: o mapa operacional mostra identidade, não telemetria. Coordenadas e contagem de antenas
  //    pertencem ao diagnóstico BLE; removê-las daqui reduz sobreposição sem esconder a posição. ──
  //    ok (≥3) = ponto sólido info, coordenada firme; weak (2) = ponto OCO warn + halo tracejado +
  //    "≈"; none (1) = sem ponto (sem X,Y) — só na lista textual da página.
  for (const t of view.tags) {
    if (!t.pos) continue; // fix "none": nada a pintar aqui
    const p = tf.project(t.pos);
    const continuous = t as FloorplanTagWithDisplay;
    const tagLabel = compact ? t.label.trim().split(/\s+/)[0] : t.label;
    const uncertain = continuous.motionState === "incerto";
    const uncertaintyM = continuous.uncertaintyM ?? 0;
    if (uncertaintyM > 0) {
      const edge = tf.project({ x: t.pos.x + uncertaintyM, y: t.pos.y });
      const radiusPx = Math.max(8, Math.min(52, Math.abs(edge.x - p.x)));
      ctx.save();
      ctx.strokeStyle = uncertain || t.fix === "weak" ? warn : info;
      ctx.globalAlpha = uncertain ? 0.45 : 0.25;
      ctx.setLineDash(uncertain ? [4, 4] : []);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (t.fix === "weak" || uncertain) {
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
      if (!options.editing) labelNear(ctx, `≈ ${tagLabel}`, p.x, p.y - 2, warn, scrim, canvas.w);
    } else {
      // Ponto sólido = estimativa qualificada; o halo continua comunicando a incerteza espacial.
      ctx.fillStyle = info;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (!options.editing) labelNear(ctx, tagLabel, p.x, p.y - 2, info, scrim, canvas.w);
    }
  }

  // ── ANTENAS: o referencial FIXO. Triângulo ▲ preenchido + NOME. VIVA = info; sem sinal = going-gray
  //    (neutral-dim + " · sem sinal"). Desenhadas por ÚLTIMO (por cima das tags) — são a âncora. ──
  for (const s of view.stations) {
    const p = tf.project(s.pos);
    const col = s.live ? info : neutralDim;
    anchorMarker(ctx, p, col);
    if (!options.editing && !compact) {
      labelNear(
        ctx,
        s.live ? s.label : `${s.label} · sem sinal`,
        p.x,
        p.y - 2,
        col,
        scrim,
        canvas.w,
      );
    }
  }

  // ── Legenda curta (ganha o ◆ de zona só quando há zonas desenháveis) ──
  label(
    ctx,
    ((options.workAreas?.length ?? 0) > 0 ? "▭ área · " : "") +
      (zones?.length ? "◆ zona · " : "") +
      "▲ antena · ● tag",
    8,
    canvas.h - 8,
    fg,
    scrim,
  );

  ctx.restore();
}

type FloorplanTagWithDisplay = FloorplanView["tags"][number] &
  Partial<Pick<ContinuousFloorplanTag, "motionState" | "uncertaintyM">>;
