// Geometria PURA de "chão navegável" — sem deps, sem DOM, sem projeção de câmera.
//
// BACKLOG CIENTÍFICO (docs/analises/tags-bluetooth/PENDENCIAS.md item 3;
// docs/cientifica/status-implementacao.md A1): "set-membership (anel BLE ∩ setor câmera ∩
// navegável)". Este módulo cobre SÓ o terceiro conjunto — o recorte do anel de distância
// (floor-plot.ts, `ringPixels`) pelo polígono de chão marcado manualmente pelo operador
// (paredes/mesas não fazem parte do "possível": o anel só é honesto na parte do chão onde
// dá pra PISAR).
//
// DECISÃO — recorte roda no MUNDO (metros), não em pixel:
//   1. O polígono navegável é definido pelo operador em metros — coordenada ESTÁVEL entre
//      frames (não muda com resize de canvas nem com recalibração de câmera).
//      Se o recorte rodasse em pixel, o polígono (mundo→pixel) teria que ser RE-PROJETADO a
//      cada frame usando a MESMA homografia H que já projeta o anel — trabalho redundante e
//      acopla este módulo à lógica de projeção de floor-plot.ts (duplicação/dependência
//      errada, o que a doutrina do projeto proíbe: "uma responsabilidade por unidade").
//   2. Clipar em mundo mantém este módulo 100% independente de câmera/homografia: testável
//      com números simples, sem `computeHomography`/`Matrix3` de verdade.
//   3. Por isso `clipRingToPolygon` recebe o anel JÁ EM COORDENADAS DE MUNDO — não em pixel.
//      A projeção pixel (se o desenho precisar) é responsabilidade de quem CHAMA (fase
//      futura de UI), depois do recorte, reaproveitando `applyMatrix3`/`invertMatrix3` que já
//      existe em floor-plot.ts. Este módulo não reimplementa geração de círculo em mundo
//      (`circleWorldPoints`) — aceitar o anel como parâmetro evita acoplar a fonte do anel
//      (círculo puro? amostra de sensor? outro raio?) a esta função de recorte.
//
// Responsabilidade única: point-in-polygon (ray casting) + partição do anel em arcos
// contíguos dentro do polígono.

import type { Vec2 } from "../vision/homography";

/** Polígono de chão navegável: pontos do MUNDO (metros), ordem qualquer, assumido simples
 * (não auto-intersectante) — quem desenha/persiste o polígono é responsabilidade de fase
 * futura, fora de escopo aqui. */
export type Polygon = Vec2[];

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === "object" && isFiniteNum((v as Vec2).x) && isFiniteNum((v as Vec2).y);

/**
 * Ray casting padrão (par/ímpar): lança um raio horizontal de `p` até o infinito e conta
 * quantas arestas do polígono ele cruza — ímpar = dentro, par = fora.
 *
 * Retorno SEGURO: polígono com <3 pontos (ou não-array) → SEMPRE `false`. Não é um detalhe
 * técnico, é a mesma postura de `anchorResidualM`/`distFromRssi` em floor-plot.ts: ausência
 * de dado não pode virar afirmação otimista. Sem polígono navegável definido, NADA é
 * navegável — o retorno seguro é "fora", nunca "dentro por falta de restrição".
 *
 * Ponto exatamente sobre uma aresta: o resultado depende da comparação de ponto flutuante
 * do algoritmo clássico (não há tratamento especial de borda). É DETERMINÍSTICO — a mesma
 * entrada sempre dá a mesma resposta — mas não há garantia de que "na borda" resolva para
 * dentro ou fora; não precisa ser perfeito, só consistente (documentado, não corrigido).
 */
export function pointInPolygon(p: Vec2, polygon: Polygon): boolean {
  if (!isVec(p) || !Array.isArray(polygon) || polygon.length < 3) return false;
  const n = polygon.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses) {
      const xIntersect = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * Recorta o anel (polilinha FECHADA — o ponto após o último volta ao primeiro, mesma
 * convenção de `ringPixels` em floor-plot.ts) pela interseção com o polígono navegável.
 *
 * Algoritmo: classifica cada ponto do anel como dentro/fora (`pointInPolygon`) e particiona
 * em arcos contíguos de pontos DENTRO — pontos fora simplesmente não entram em nenhum arco
 * (o corte acontece no SEGMENTO que cruza a borda, sem inserir o ponto de interseção exato:
 * a polilinha de saída já é densa o bastante — mesma amostragem do anel de entrada — pra
 * que o corte aproximado não distorça a leitura visual). Como o anel é um laço fechado, o
 * início da varredura é girado até a primeira transição fora→dentro, pra um arco que "dá a
 * volta" pelo fim/início do array não seja partido em dois pedaços artificiais.
 *
 * Retorno SEGURO: polígono inválido (<3 pontos) OU anel vazio → `[]` — mesma regra de
 * `pointInPolygon` (sem chão navegável definido, nada é navegável).
 */
export function clipRingToPolygon(ringWorld: Vec2[], polygon: Polygon): Vec2[][] {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  if (!Array.isArray(ringWorld) || ringWorld.length === 0) return [];

  const n = ringWorld.length;
  const inside = ringWorld.map((p) => isVec(p) && pointInPolygon(p, polygon));

  if (inside.every(Boolean)) return [ringWorld.slice()];
  if (!inside.some(Boolean)) return [];

  // Gira o início da varredura pra uma transição fora→dentro, pra não partir em dois um
  // arco que na verdade dá a volta pelo wraparound do anel fechado.
  let start = -1;
  for (let i = 0; i < n; i++) {
    const prev = inside[(i - 1 + n) % n];
    if (!prev && inside[i]) {
      start = i;
      break;
    }
  }
  if (start === -1) return []; // defensivo; não deveria ocorrer dados os checks acima

  const arcs: Vec2[][] = [];
  let current: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    if (inside[idx]) {
      current.push(ringWorld[idx]);
    } else if (current.length > 0) {
      arcs.push(current);
      current = [];
    }
  }
  if (current.length > 0) arcs.push(current);
  return arcs;
}
