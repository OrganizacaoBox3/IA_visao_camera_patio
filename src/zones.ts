// Modelo de ZONA com modo + config (base do "Modo por Zona").
// Uma câmera tem N zonas; cada zona roda o pipeline do seu modo na sua ROI.
// Persistência por câmera em localStorage `vp-zones-<id>` (estende o formato antigo de atividade).
import { APP_CONFIG } from "./config";
import { activityForLabel } from "./processors/atividade";
import { OBJECT_KEYS } from "./objects/catalog";
import { getCameraCfg } from "./cameraConfig";

export type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga";
export const DEFAULT_GRID = { cols: 32, rows: 18 };
// Zona com geometria normalizada (0..1) + modo + config (planos, por modo).
// `x,y,w,h` = bounding box (recorte/ROI). `mask` (opcional) = células pintadas (área irregular);
// quando ausente, a zona é o retângulo cheio (retrocompat).
export type Zone = {
  id: string; label: string; x: number; y: number; w: number; h: number; modo: ZoneMode;
  mask?: string;                                               // máscara em grade codificada (zoneMask)
  idleAlertMs: number; sensitivity: number; atividade: string; // atividade
  ponto: string;                                               // leitura
  selectedClasses: string[];                                   // objetos
};

function key(cameraId: string) { return `vp-zones-${cameraId}`; }
let seq = 0;
export function newZoneId(cameraId: string) { return `${cameraId}-z${Date.now().toString(36)}${++seq}`; }

// Preenche defaults de TODOS os modos numa zona (campos planos), respeitando o que já existe.
function withDefaults(z: Partial<Zone>, cameraId: string): Zone {
  const label = z.label ?? "Área";
  return {
    id: z.id ?? newZoneId(cameraId),
    label, x: z.x ?? 0, y: z.y ?? 0, w: z.w ?? 1, h: z.h ?? 1,
    mask: typeof z.mask === "string" ? z.mask : undefined,
    modo: z.modo === "leitura" || z.modo === "objetos" || z.modo === "fadiga" ? z.modo : "atividade",
    idleAlertMs: z.idleAlertMs ?? APP_CONFIG.zones.defaultIdleAlertMs,
    sensitivity: z.sensitivity ?? 5,
    atividade: z.atividade ?? activityForLabel(label),
    ponto: z.ponto ?? APP_CONFIG.reading.defaultPonto,
    selectedClasses: Array.isArray(z.selectedClasses) && z.selectedClasses.length ? z.selectedClasses : [...OBJECT_KEYS],
  };
}

export function saveZones(cameraId: string, zones: Zone[]) {
  try { localStorage.setItem(key(cameraId), JSON.stringify(zones)); } catch { /* no-op */ }
}

// Carrega as zonas da câmera, migrando o formato antigo (modo-de-câmera + zonas só de atividade).
export function loadZones(cameraId: string, cameraLabel: string): Zone[] {
  let raw: unknown = null;
  try { const s = localStorage.getItem(key(cameraId)); raw = s ? JSON.parse(s) : null; } catch { raw = null; }
  const stored: Partial<Zone>[] = Array.isArray(raw) ? raw : [];

  // Já no formato novo (alguma zona com `modo`) → só normaliza.
  if (stored.some((z) => typeof z.modo === "string")) return stored.map((z) => withDefaults(z, cameraId));

  // Migração a partir do cameraConfig (modo-de-câmera) + zonas antigas (atividade).
  const cfg = getCameraCfg(cameraId);
  if (cfg.modo === "leitura") {
    return [withDefaults({ label: cameraLabel, x: 0, y: 0.30, w: 1, h: 0.40, modo: "leitura", ponto: cfg.pontoLeitura }, cameraId)];
  }
  if (cfg.modo === "objetos") {
    if (stored.length) return stored.map((z) => withDefaults({ ...z, modo: "objetos", selectedClasses: cfg.selectedClasses }, cameraId));
    return [withDefaults({ label: cameraLabel, x: 0, y: 0, w: 1, h: 1, modo: "objetos", selectedClasses: cfg.selectedClasses }, cameraId)];
  }
  // atividade (default): zonas antigas, ou as zonas-semente padrão
  if (stored.length) return stored.map((z) => withDefaults({ ...z, modo: "atividade" }, cameraId));
  return APP_CONFIG.defaultZones.map((z) => withDefaults({ label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, modo: "atividade" }, cameraId));
}

export const ZONE_MODE_COLOR: Record<ZoneMode, string> = { atividade: "#22c55e", leitura: "#38bdf8", objetos: "#f59e0b", fadiga: "#a78bfa" };
export const ZONE_MODE_LABEL: Record<ZoneMode, string> = { atividade: "Atividade", leitura: "Leitura", objetos: "Objetos", fadiga: "Fadiga" };
