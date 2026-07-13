// Modelo de ZONA com modo + config (base do "Modo por Zona").
// Uma câmera tem N zonas; cada zona roda o pipeline do seu modo na sua ROI.
// PERSISTÊNCIA (Onda 2): fonte de verdade = BACKEND (compartilhado por câmera, via api.ts
// getZones/saveZones), com FALLBACK gracioso para o localStorage `vp-zones-<id>` (cache/legado)
// — a câmera nunca quebra por causa da rede. O formato local estende o antigo (só atividade).
import { APP_CONFIG } from "./config";
import { activityForLabel } from "./processors/atividade";
import { OBJECT_KEYS } from "./objects/catalog";
import { getCameraCfg } from "./cameraConfig";
import { getZones as apiGetZones, saveZones as apiSaveZones } from "./api";
import { pointInPolygon } from "./fusion/floor-polygon";
import { anySet, containsNorm, createMask, type Mask } from "./zoneMask";

// "exclusao" é um modo de SUPRESSÃO: não produz indicador nenhum — só MASCARA a área para
// descartar detecções de pessoa cujo pé (bottom-center do bbox) cai dentro dela (fontes fixas de
// falso positivo: grade, placa, janela de van, TV/monitor). Quem itera zonas por indicador
// (atividade/leitura/objetos/fadiga) simplesmente ignora as zonas "exclusao". Ver CameraWorkspace
// (filtro local em updateTracks) e a frente do motor (mesma semântica no hub).
// "proibida" é o ESPELHO do alerta de inatividade (spec alerta-por-atividade E1): área que deve
// ficar VAZIA — pessoa presente por ≥ presencaAlertMs dispara alarme tipo "presenca" (critical).
// O PRODUTOR do alarme é o MOTOR DO HUB (24/7, sem espectador); o cliente cadastra e exibe —
// sem processador local nesta onda (ver camera/holders.ts).
export type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga" | "exclusao" | "proibida";
export const DEFAULT_GRID = { cols: 32, rows: 18 };

// ── JANELA DE ARMAMENTO (spec-turnos-por-zona F2 / spec-alerta-por-atividade E4) ─────────────
// "sempre" = 24/7 (default seguro, comportamento de hoje). "dentro-turnos"/"fora-turnos" armam
// a zona PROIBIDA relativamente aos turnos atribuídos a ela (Zone.shiftIds) — é o caso "área
// normal no expediente, proibida à noite". Quem DECIDE é o servidor (server/alarm/shift.js, na
// política de alarme); o cliente só cadastra. Sem shiftIds, "dentro/fora" não têm referência e
// a zona segue 24/7 (fail-open: config incompleta nunca CALA um alarme).
export type ZoneArming = "sempre" | "dentro-turnos" | "fora-turnos";
export const ZONE_ARMINGS: readonly ZoneArming[] = ["sempre", "dentro-turnos", "fora-turnos"];
export const ZONE_ARMING_LABEL: Record<ZoneArming, string> = {
  sempre: "Sempre (24/7)",
  "dentro-turnos": "Só dentro dos turnos",
  "fora-turnos": "Só fora dos turnos",
};
// Zona com geometria normalizada (0..1) + modo + config (planos, por modo).
// `x,y,w,h` = bounding box (recorte/ROI). `mask` (opcional) = células pintadas (área irregular);
// quando ausente, a zona é o retângulo cheio (retrocompat). `points` (opcional) = POLÍGONO
// fechado (spec zonas-poligonais P4: o retângulo É um polígono de 4 vértices; zona sem points
// segue o caminho retângulo+máscara intocado). Com points, `x,y,w,h` vira bbox DERIVADA deles
// (pré-filtro barato de todos os call-sites) e a máscara de pincel fica LEGADA (P5: points vence).
// NÃO confundir com `calibration.points` (homografia) — objetos distintos (armadilha 10).
export type Zone = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  modo: ZoneMode;
  mask?: string; // máscara em grade codificada (zoneMask)
  points?: ZonePoint[]; // polígono SIMPLES normalizado 0..1; ≥3, ≤20 vértices (P2)
  idleAlertMs: number;
  sensitivity: number;
  atividade: string; // atividade
  ponto: string; // leitura
  selectedClasses: string[]; // objetos
  // proibida (spec alerta-por-atividade E2/E4) — OPCIONAIS no tipo (contrato pinado entre as
  // frentes), mas SEMPRE preenchidos por withDefaults; o motor do hub lê os mesmos campos do
  // camcfg do servidor (allowlist cleanZone — armadilha A5).
  presencaAlertMs?: number; // dwell: presença contínua acima disto → alarme (default 10s)
  arming?: ZoneArming; // janela de armamento da zona proibida (E4) — decidida no servidor
  // TURNOS atribuídos à zona (spec-turnos-por-zona F2). Ausente/[] = zona 24/7 = comportamento
  // ATUAL (CA-5, default seguro). Numa zona de ATIVIDADE eles gateiam o alerta de ociosidade
  // (só dentro do turno e fora das pausas); numa zona PROIBIDA são a referência do `arming`.
  // São IDs do cadastro global (/api/shifts) — a resolução do turno é do servidor, NUNCA do front.
  shiftIds?: string[];
};

// Presets do dwell de PRESENÇA (modo proibida) — mesmo padrão dos limitPresetsMs da atividade.
// Vivem aqui (perto do modelo) porque config.ts é importado por este módulo (evita ciclo).
export const PRESENCA_ALERT_PRESETS_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
export const DEFAULT_PRESENCA_ALERT_MS = 10_000;

// ── ZONA POLIGONAL (spec zonas-poligonais F1) ─────────────────────────────────
// O teste fino por PONTO usa o pointInPolygon de fusion/floor-polygon (ray casting, puro); o
// hub tem ESPELHO byte-a-byte em server/analysis/zones.js — mudou aqui, re-porta LÁ (o sensor
// de paridade são as fixtures compartilhadas zones-polygon-fixtures.json, CA-4).
export type ZonePoint = { x: number; y: number };
export const POLYGON_MIN_POINTS = 3; // P2: não fecha com menos
export const POLYGON_MAX_POINTS = 20; // P2: teto do setor (Dahua 20; cobre qualquer zona real)

const clampCoord = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// IDs de turno vindos de fora (backend/localStorage/edição): só strings não-vazias, sem
// duplicata, ordem preservada. Malformado → [] (= zona 24/7, o default seguro da CA-5).
// ESPELHO da allowlist do hub (server/camcfg.js cleanZone) — armadilha A5.
export function sanitizeShiftIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// Polígono SIMPLES (ONVIF: "simple non-intersecting polygon") — nenhum par de arestas
// NÃO-adjacentes se cruza. O(n²) com n≤20 é barato e roda só em validação (nunca por frame).
// Degenerados de área zero (vértices repetidos/colineares) passam — pointInPolygon devolve
// false p/ tudo neles (inofensivo; não vale a complexidade extra de barrar — KISS).
// ESPELHO byte-a-byte em server/analysis/zones.js (isSimplePolygon).
function cross(o: ZonePoint, a: ZonePoint, b: ZonePoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function onSegment(p: ZonePoint, q: ZonePoint, r: ZonePoint): boolean {
  return (
    Math.min(p.x, r.x) <= q.x &&
    q.x <= Math.max(p.x, r.x) &&
    Math.min(p.y, r.y) <= q.y &&
    q.y <= Math.max(p.y, r.y)
  );
}
function segmentsIntersect(p1: ZonePoint, p2: ZonePoint, p3: ZonePoint, p4: ZonePoint): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  if (d1 === 0 && onSegment(p3, p1, p4)) return true;
  if (d2 === 0 && onSegment(p3, p2, p4)) return true;
  if (d3 === 0 && onSegment(p1, p3, p2)) return true;
  if (d4 === 0 && onSegment(p1, p4, p2)) return true;
  return false;
}
export function isSimplePolygon(pts: ZonePoint[]): boolean {
  const n = pts.length;
  if (n < POLYGON_MIN_POINTS) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // arestas adjacentes compartilham vértice
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  return true;
}

// Valida/normaliza `points` vindos de fora (backend/localStorage/edição): ≥3 e ≤20 vértices
// {x,y} finitos → CLAMP 0..1 → polígono SIMPLES. Malformado → undefined, NUNCA [] (armadilha 8:
// [] viraria "polígono vazio = zona sem área" mudo). ESPELHO em server/analysis/zones.js.
export function sanitizeZonePoints(raw: unknown): ZonePoint[] | undefined {
  if (!Array.isArray(raw) || raw.length < POLYGON_MIN_POINTS || raw.length > POLYGON_MAX_POINTS)
    return undefined;
  const pts: ZonePoint[] = [];
  for (const p of raw) {
    const x = (p as ZonePoint | null)?.x;
    const y = (p as ZonePoint | null)?.y;
    if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
    if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
    pts.push({ x: clampCoord(x), y: clampCoord(y) });
  }
  return isSimplePolygon(pts) ? pts : undefined;
}

// bbox NORMALIZADA derivada dos vértices (padrão maskBBoxNorm): o pré-filtro retangular que
// TODOS os call-sites rodam antes do teste fino continua válido (armadilha 3).
export function polygonBBox(pts: ZonePoint[]): { x: number; y: number; w: number; h: number } {
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

// Polígono EFETIVO da zona (já saneado por withDefaults/cleanZone) ou null. O mesmo check
// mínimo do espelho do hub (polygonOf) — a fonte da verdade da validação é sanitizeZonePoints.
export function zonePolygon(z: Pick<Zone, "points">): ZonePoint[] | null {
  const p = z.points;
  return Array.isArray(p) && p.length >= POLYGON_MIN_POINTS ? p : null;
}

// Teste fino EXATO por ponto (P5) — cada call-site mantém a própria ÂNCORA (centro/pé, CA-6).
export function polygonContainsFn(pts: ZonePoint[]): (nx: number, ny: number) => boolean {
  return (nx: number, ny: number) => pointInPolygon({ x: nx, y: ny }, pts);
}

// `contains` do caminho de MÁSCARA (grade O(1) por ponto) — reusado pelo caminho por-pixel.
export function maskContainsFn(mask: Mask | null): ((nx: number, ny: number) => boolean) | undefined {
  return mask && anySet(mask) ? (nx: number, ny: number) => containsNorm(mask, nx, ny) : undefined;
}

// PRECEDÊNCIA points>mask (P5) — fábrica ÚNICA do teste fino de contenção por PONTO do cliente
// (assignZone/exclusão-pé/objetos). `mask` = máscara efetiva da zona (cacheada pelo chamador);
// com points ela é IGNORADA (vira legado da zona). Idêntica ao hub (attributeZone/inExclusionZone).
export function zoneContainsFn(
  z: Pick<Zone, "points">,
  mask: Mask | null,
): ((nx: number, ny: number) => boolean) | undefined {
  const pts = zonePolygon(z);
  return pts ? polygonContainsFn(pts) : maskContainsFn(mask);
}

// P6: o laço de movimento POR PIXEL não chama pointInPolygon (O(px×vértices) por frame) — o
// polígono é RASTERIZADO 1× para a grade de máscara existente e o caminho per-pixel consome a
// máscara como hoje. Um mecanismo, dois consumos: exato p/ pontos, rasterizado p/ pixels.
// Critério da célula: o CENTRO dela dentro do polígono (determinístico; grade DEFAULT_GRID).
export function rasterizePolygonMask(cols: number, rows: number, pts: ZonePoint[]): Mask {
  const m = createMask(cols, rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (pointInPolygon({ x: (c + 0.5) / cols, y: (r + 0.5) / rows }, pts))
        m.bits[r * cols + c] = 1;
  return m;
}

function key(cameraId: string) {
  return `vp-zones-${cameraId}`;
}
let seq = 0;
export function newZoneId(cameraId: string) {
  return `${cameraId}-z${Date.now().toString(36)}${++seq}`;
}

// Preenche defaults de TODOS os modos numa zona (campos planos), respeitando o que já existe.
// Exportada p/ teste unitário (pura, exceto o id gerado quando ausente via newZoneId).
export function withDefaults(z: Partial<Zone>, cameraId: string): Zone {
  const label = z.label ?? "Área";
  // POLÍGONO (P2/P4): points validados (≥3, ≤20, clamp01, SIMPLES); malformado → undefined,
  // NUNCA []. Com points, a bbox x,y,w,h é DERIVADA deles (o pré-filtro retangular de todos os
  // call-sites continua válido — armadilha 3); sem points, comportamento antigo intocado (CA-5).
  const points = sanitizeZonePoints(z.points);
  const bb = points ? polygonBBox(points) : null;
  return {
    id: z.id ?? newZoneId(cameraId),
    label,
    x: bb ? bb.x : (z.x ?? 0),
    y: bb ? bb.y : (z.y ?? 0),
    w: bb ? bb.w : (z.w ?? 1),
    h: bb ? bb.h : (z.h ?? 1),
    points,
    mask: typeof z.mask === "string" ? z.mask : undefined,
    modo:
      z.modo === "leitura" ||
      z.modo === "objetos" ||
      z.modo === "fadiga" ||
      z.modo === "exclusao" ||
      z.modo === "proibida"
        ? z.modo
        : "atividade",
    idleAlertMs: z.idleAlertMs ?? APP_CONFIG.zones.defaultIdleAlertMs,
    sensitivity: z.sensitivity ?? 5,
    atividade: z.atividade ?? activityForLabel(label),
    ponto: z.ponto ?? APP_CONFIG.reading.defaultPonto,
    selectedClasses:
      Array.isArray(z.selectedClasses) && z.selectedClasses.length
        ? z.selectedClasses
        : [...OBJECT_KEYS],
    // proibida: dwell normalizado (número finito ≥0; inválido → default 10s) + arming (enum
    // ZONE_ARMINGS; inválido/ausente → "sempre" = 24/7, o comportamento de hoje).
    presencaAlertMs:
      typeof z.presencaAlertMs === "number" &&
      Number.isFinite(z.presencaAlertMs) &&
      z.presencaAlertMs >= 0
        ? z.presencaAlertMs
        : DEFAULT_PRESENCA_ALERT_MS,
    arming: ZONE_ARMINGS.includes(z.arming as ZoneArming) ? (z.arming as ZoneArming) : "sempre",
    // turnos atribuídos (F2): campo PLANO como os demais — [] = 24/7 (CA-5).
    shiftIds: sanitizeShiftIds(z.shiftIds),
  };
}

// Cache local (localStorage) — mantido como fallback offline e origem de migração do legado.
function cacheZones(cameraId: string, zones: Zone[]) {
  try {
    localStorage.setItem(key(cameraId), JSON.stringify(zones));
  } catch {
    /* no-op */
  }
}

// Há zonas LEGADAS realmente salvas no localStorage? (decide migração best-effort × semente padrão).
function hasStoredZones(cameraId: string): boolean {
  try {
    const s = localStorage.getItem(key(cameraId));
    if (!s) return false;
    const raw = JSON.parse(s);
    return Array.isArray(raw) && raw.length > 0;
  } catch {
    return false;
  }
}

// Carrega as zonas da câmera do LOCALSTORAGE (fallback/legado), migrando o formato antigo
// (modo-de-câmera + zonas só de atividade). Câmera sem nada salvo → LISTA VAZIA: a câmera nova
// abre LIMPA e o usuário desenha a própria zona ("✎ Zona"). As antigas 4 zonas-semente
// (Expedição/Carga/Estoque/Espera) foram removidas por decisão de produto — geravam estranheza
// para novos usuários e capturavam contagens no lugar da zona desenhada (F6 do diagnóstico).
export function loadZones(cameraId: string, cameraLabel: string): Zone[] {
  let raw: unknown;
  try {
    const s = localStorage.getItem(key(cameraId));
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  const stored: Partial<Zone>[] = Array.isArray(raw) ? raw : [];

  // Já no formato novo (alguma zona com `modo`) → só normaliza.
  if (stored.some((z) => typeof z.modo === "string"))
    return stored.map((z) => withDefaults(z, cameraId));

  // Migração a partir do cameraConfig (modo-de-câmera) + zonas antigas (atividade).
  const cfg = getCameraCfg(cameraId);
  if (cfg.modo === "leitura") {
    return [
      withDefaults(
        {
          label: cameraLabel,
          x: 0,
          y: 0.3,
          w: 1,
          h: 0.4,
          modo: "leitura",
          ponto: cfg.pontoLeitura,
        },
        cameraId,
      ),
    ];
  }
  if (cfg.modo === "objetos") {
    if (stored.length)
      return stored.map((z) =>
        withDefaults({ ...z, modo: "objetos", selectedClasses: cfg.selectedClasses }, cameraId),
      );
    return [
      withDefaults(
        {
          label: cameraLabel,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          modo: "objetos",
          selectedClasses: cfg.selectedClasses,
        },
        cameraId,
      ),
    ];
  }
  // atividade (default): zonas antigas migradas, ou NADA (sem semente automática).
  return stored.map((z) => withDefaults({ ...z, modo: "atividade" }, cameraId));
}

// Carga da câmera com o BACKEND como fonte de verdade + FALLBACK gracioso (Onda 2). ASSÍNCRONA
// (o backend é remoto). Comportamento:
// • Backend com zonas → usa (normalizadas) e refresca o cache local.
// • Backend VAZIO + zonas LEGADAS no localStorage → migração única best-effort (se `canConfigure`,
//   pois o PUT exige perfil de configuração); sem permissão, usa o legado só nesta sessão.
// • Backend VAZIO + sem legado → LISTA VAZIA (a câmera abre limpa; o usuário desenha a própria
//   zona — nada é criado nem persistido automaticamente).
// • Backend FALHOU (erro/offline) → degrada para o localStorage (loadZones), sem quebrar a câmera.
export async function loadZonesForCamera(
  cameraId: string,
  cameraLabel: string,
  canConfigure: boolean,
): Promise<Zone[]> {
  let remote: Zone[];
  try {
    remote = await apiGetZones(cameraId);
  } catch (e) {
    console.error("[zones] carga do backend falhou — usando localStorage", e);
    return loadZones(cameraId, cameraLabel);
  }
  if (remote.length > 0) {
    const norm = remote.map((z) => withDefaults(z, cameraId));
    cacheZones(cameraId, norm); // mantém o localStorage como cache/fallback
    return norm;
  }
  // Backend sem zonas → resolve pelo localStorage: migração de legado OU lista vazia.
  const local = loadZones(cameraId, cameraLabel);
  if (hasStoredZones(cameraId) && canConfigure) {
    try {
      const saved = await apiSaveZones(cameraId, local); // migração única best-effort
      const norm = saved.map((z) => withDefaults(z, cameraId));
      cacheZones(cameraId, norm);
      return norm;
    } catch (e) {
      console.error("[zones] migração best-effort falhou — usando legado nesta sessão", e);
      return local;
    }
  }
  return local; // vazio (câmera nova limpa) ou legado sem permissão p/ migrar
}

// Write-through: grava no cache local (imediato/offline-safe) e persiste no BACKEND. Rejeita em
// erro de rede/permissão — o chamador trata com toast SEM perder a edição local (que fica no cache).
export async function persistZones(cameraId: string, zones: Zone[]): Promise<Zone[]> {
  cacheZones(cameraId, zones);
  return apiSaveZones(cameraId, zones);
}

export const ZONE_MODE_COLOR: Record<ZoneMode, string> = {
  atividade: "#22c55e",
  leitura: "#38bdf8",
  objetos: "#f59e0b",
  fadiga: "#a78bfa",
  exclusao: "#64748b", // going-gray: supressão é operação normal, não anormalidade (base neutra)
  proibida: "#a85d5d", // vermelho DESSATURADO: armada é estado normal; saturação só na VIOLAÇÃO (E6)
};
export const ZONE_MODE_LABEL: Record<ZoneMode, string> = {
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Fadiga",
  exclusao: "Exclusão",
  proibida: "Proibida",
};

// Ponto normalizado (0..1) cai dentro da zona? Respeita a MÁSCARA via `contains` (quando a zona
// foi pintada); sem máscara, é o retângulo cheio `x,y,w,h`. Função PURA (testável) reusada pelo
// filtro de EXCLUSÃO (o "pé"/bottom-center da pessoa) no CameraWorkspace.
export function pointInZone(
  z: Pick<Zone, "x" | "y" | "w" | "h">,
  px: number,
  py: number,
  contains?: (nx: number, ny: number) => boolean,
): boolean {
  if (px < z.x || px > z.x + z.w || py < z.y || py > z.y + z.h) return false;
  return contains ? contains(px, py) : true;
}

// ── Atribuição de zona com DESEMPATE — regra ÚNICA do front ──────────────────────────────────
// Candidata = ponto (cx,cy) dentro do retângulo E da máscara (via containsOf). Entre candidatas
// SOBREPOSTAS vence a de MAIOR interseção bbox∩zona (a zona que mais "contém" o corpo);
// persistindo o empate, a de MENOR área (a mais específica). Sem bbox, interseção = 0 p/ todas →
// decide a menor área. Consumida por CameraWorkspace (tracks) e ObjetosProcessor (zoneOf) —
// first-match por ordem de lista NÃO é critério válido (a contagem caía na zona errada).
export type AssignableZone = { x: number; y: number; w: number; h: number };
export function assignZone<Z extends AssignableZone>(
  zones: readonly Z[],
  cx: number,
  cy: number,
  bbox?: readonly [number, number, number, number],
  containsOf?: (z: Z) => ((nx: number, ny: number) => boolean) | undefined,
): Z | null {
  let best: Z | null = null;
  let bestOv = -1;
  for (const z of zones) {
    if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
    const cn = containsOf?.(z);
    if (cn && !cn(cx, cy)) continue;
    let ov = 0;
    if (bbox) {
      const ix = Math.min(bbox[0] + bbox[2], z.x + z.w) - Math.max(bbox[0], z.x);
      const iy = Math.min(bbox[1] + bbox[3], z.y + z.h) - Math.max(bbox[1], z.y);
      ov = Math.max(0, ix) * Math.max(0, iy);
    }
    if (!best || ov > bestOv || (ov === bestOv && z.w * z.h < best.w * best.h)) {
      best = z;
      bestOv = ov;
    }
  }
  return best;
}
