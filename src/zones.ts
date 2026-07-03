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

export type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga";
export const DEFAULT_GRID = { cols: 32, rows: 18 };
// Zona com geometria normalizada (0..1) + modo + config (planos, por modo).
// `x,y,w,h` = bounding box (recorte/ROI). `mask` (opcional) = células pintadas (área irregular);
// quando ausente, a zona é o retângulo cheio (retrocompat).
export type Zone = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  modo: ZoneMode;
  mask?: string; // máscara em grade codificada (zoneMask)
  idleAlertMs: number;
  sensitivity: number;
  atividade: string; // atividade
  ponto: string; // leitura
  selectedClasses: string[]; // objetos
};

function key(cameraId: string) {
  return `vp-zones-${cameraId}`;
}
let seq = 0;
export function newZoneId(cameraId: string) {
  return `${cameraId}-z${Date.now().toString(36)}${++seq}`;
}

// Preenche defaults de TODOS os modos numa zona (campos planos), respeitando o que já existe.
function withDefaults(z: Partial<Zone>, cameraId: string): Zone {
  const label = z.label ?? "Área";
  return {
    id: z.id ?? newZoneId(cameraId),
    label,
    x: z.x ?? 0,
    y: z.y ?? 0,
    w: z.w ?? 1,
    h: z.h ?? 1,
    mask: typeof z.mask === "string" ? z.mask : undefined,
    modo:
      z.modo === "leitura" || z.modo === "objetos" || z.modo === "fadiga" ? z.modo : "atividade",
    idleAlertMs: z.idleAlertMs ?? APP_CONFIG.zones.defaultIdleAlertMs,
    sensitivity: z.sensitivity ?? 5,
    atividade: z.atividade ?? activityForLabel(label),
    ponto: z.ponto ?? APP_CONFIG.reading.defaultPonto,
    selectedClasses:
      Array.isArray(z.selectedClasses) && z.selectedClasses.length
        ? z.selectedClasses
        : [...OBJECT_KEYS],
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
};
export const ZONE_MODE_LABEL: Record<ZoneMode, string> = {
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Fadiga",
};
