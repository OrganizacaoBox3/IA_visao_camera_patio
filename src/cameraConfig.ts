// Configuração por câmera definida na CENTRAL (LGPD: só metadados, sem imagens).
// Modo decide o pipeline: "atividade" (ocupação/ociosidade, padrão) | "leitura" (código de barras).
// Persistência local por cameraId, mesmo padrão das zonas (vp-zones-<id>).

import { APP_CONFIG } from "./config";
import { OBJECT_KEYS } from "./objects/catalog";

export type CameraMode = "atividade" | "leitura" | "objetos" | "fadiga";
export type CapturePreset = "media" | "alta" | "maxima";
export type CameraCfg = { modo: CameraMode; pontoLeitura: string; capture: CapturePreset; selectedClasses: string[] };

const DEFAULT: CameraCfg = { modo: "atividade", pontoLeitura: APP_CONFIG.reading.defaultPonto, capture: "alta", selectedClasses: [...OBJECT_KEYS] };

function key(cameraId: string) { return `vp-camcfg-${cameraId}`; }

export function getCameraCfg(cameraId: string): CameraCfg {
  try {
    const raw = localStorage.getItem(key(cameraId));
    if (!raw) return { ...DEFAULT, selectedClasses: [...OBJECT_KEYS] };
    const c = JSON.parse(raw) as Partial<CameraCfg>;
    const sel = Array.isArray(c.selectedClasses) ? c.selectedClasses.filter((k) => OBJECT_KEYS.includes(k)) : [];
    return {
      modo: c.modo === "leitura" || c.modo === "objetos" || c.modo === "fadiga" ? c.modo : "atividade",
      pontoLeitura: typeof c.pontoLeitura === "string" && c.pontoLeitura.trim() ? c.pontoLeitura : DEFAULT.pontoLeitura,
      capture: c.capture === "media" || c.capture === "maxima" ? c.capture : "alta",
      selectedClasses: sel.length ? sel : [...OBJECT_KEYS],
    };
  } catch { return { ...DEFAULT, selectedClasses: [...OBJECT_KEYS] }; }
}

export function setCameraCfg(cameraId: string, cfg: CameraCfg) {
  try { localStorage.setItem(key(cameraId), JSON.stringify(cfg)); } catch { /* no-op */ }
}
