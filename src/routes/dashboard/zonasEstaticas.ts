// ─────────────────────────────────────────────────────────────────────────────
// PLANTA DE ZONAS — a geometria do desenho estático, separada da renderização.
//
// POR QUE EXISTE. O objetivo do produto é a NOTIFICAÇÃO, não o plantão de olhos. Medido em
// produção (14/09/2026): painel aberto levou o load da máquina de 8,04 para 15,63 em 4 vCPU, e
// ficou aberto 17% das horas de uma semana. O vídeo do painel disputa CPU com a análise que
// gera o alerta — quem fica olhando atrasa a detecção que o sistema existe para fazer.
//
// O CLIENTE (papel `cliente`) não opera o sistema: ele recebe o aviso e precisa saber ONDE.
// Então, para ele, a câmera não transmite — mostra as ÁREAS DEMARCADAS, desenhadas.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// POR QUE DESENHO VETORIAL E NÃO UM "PRINT" DA CENA — a parte que precisa estar escrita:
//
// Guardar um instantâneo da câmera no servidor violaria o invariante mais duro do projeto:
// "nenhuma imagem/frame é persistida no servidor; frames são efêmeros em memória" (ADR-002,
// CLAUDE.md §3). Um print de pátio com gente dentro é dado pessoal, e passaria a existir em
// disco, em backup e em qualquer cópia do volume — exatamente o que o ADR proíbe.
//
// O desenho resolve o mesmo problema e é ESTRITAMENTE melhor:
//   · zero imagem → zero exposição LGPD, zero armazenamento, zero banda de vídeo;
//   · mais barato que um print (são alguns polígonos, não um JPEG por câmera);
//   · sempre ATUAL — o print envelhece no instante em que alguém move uma zona;
//   · legível: a zona aparece com NOME e MODO, que é o que liga o desenho à mensagem que o
//     cliente recebeu ("presença em área proibida (Cofre)").
//
// O que ele NÃO dá é o fundo da cena. Se o dono decidir que o fundo é necessário, isso é uma
// REVERSÃO do ADR-002 — decisão dele, com ADR próprio, não efeito colateral deste arquivo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Zone, ZoneMode } from "../../zones";

/** Caixa de desenho em coordenadas de viewBox (0..100 nos dois eixos). */
export type Caixa = { x: number; y: number; w: number; h: number };

/** Uma zona pronta para desenhar: o polígono (ou o retângulo) já em coordenadas de viewBox. */
export type ZonaDesenhada = {
  id: string;
  label: string;
  modo: ZoneMode;
  /** Caixa envolvente — usada para posicionar o rótulo e como forma quando não há polígono. */
  caixa: Caixa;
  /** Pontos do polígono no formato do atributo `points` de <polygon>. `null` = use a caixa. */
  pontos: string | null;
};

/** Lado do viewBox. 100 mantém a conta trivial: coordenada normalizada × 100 = unidade do SVG. */
export const VIEWBOX = 100;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const pct = (v: number) => Math.round(clamp01(v) * VIEWBOX * 10) / 10;

/**
 * Converte uma zona (coordenadas normalizadas 0..1) em geometria de viewBox.
 *
 * Zona degenerada (largura ou altura zero/negativa, vinda de um cadastro antigo ou de um
 * arrasto acidental) recebe um piso de 1% em vez de sumir: uma zona invisível no desenho
 * seria lida como "não existe", e ela existe — inclusive alarma.
 */
export function desenharZona(z: Zone): ZonaDesenhada {
  const x = pct(z.x);
  const y = pct(z.y);
  const w = Math.max(1, pct(z.w));
  const h = Math.max(1, pct(z.h));
  // Polígono só quando ele é um polígono de verdade (≥3 vértices) — com menos, o `points` do
  // SVG desenharia uma linha ou nada, e a caixa é a representação honesta do que foi salvo.
  const pontos =
    Array.isArray(z.points) && z.points.length >= 3
      ? z.points.map((p) => `${pct(p.x)},${pct(p.y)}`).join(" ")
      : null;
  return { id: z.id, label: z.label, modo: z.modo, caixa: { x, y, w, h }, pontos };
}

/** Converte a lista inteira, preservando a ordem do cadastro (é a que o operador desenhou). */
export function desenharZonas(zonas: ReadonlyArray<Zone>): ZonaDesenhada[] {
  return (zonas || []).filter(Boolean).map(desenharZona);
}

/** Onde o rótulo da zona assenta: topo interno da caixa, com recuo pequeno. */
export function ancoraDoRotulo(c: Caixa): { x: number; y: number } {
  return { x: c.x + 1.5, y: c.y + 4 };
}

/** Cor por MODO da zona — token, nunca hex cru (going-gray: a cor é informação).
 *  Zona PROIBIDA é a única com cor de alerta: é a que gera alarme crítico. */
export const COR_DO_MODO: Record<ZoneMode, string> = {
  atividade: "var(--state-info)",
  proibida: "var(--state-critical)",
  leitura: "var(--state-neutral-fg)",
  objetos: "var(--state-warn)",
  fadiga: "var(--state-warn)",
  exclusao: "var(--text-muted)",
};
