// Configuração por câmera definida na CENTRAL (LGPD: só metadados, sem imagens).
// Modo decide o pipeline: "atividade" (ocupação/ociosidade, padrão) | "leitura" (código de barras).
// PERSISTÊNCIA (Onda 2): fonte de verdade = BACKEND (compartilhado por câmera, via api.ts
// getCamConfig/saveCamConfig), com o localStorage (`vp-camcfg-<id>`) como CACHE/fallback offline.
// getCameraCfg/setCameraCfg mantêm a assinatura SÍNCRONA (consumidas na central): setCameraCfg faz
// write-through no backend; loadCamConfig (assíncrona) hidrata/migra o cache a partir do backend.

import { APP_CONFIG } from "./config";
import { OBJECT_KEYS } from "./objects/catalog";
import { getCamConfig, saveCamConfig } from "./api";

export type CameraMode = "atividade" | "leitura" | "objetos" | "fadiga";
export type CapturePreset = "media" | "alta" | "maxima";
export type CameraCfg = {
  modo: CameraMode;
  pontoLeitura: string;
  capture: CapturePreset;
  selectedClasses: string[];
};

const DEFAULT: CameraCfg = {
  modo: "atividade",
  pontoLeitura: APP_CONFIG.reading.defaultPonto,
  capture: "alta",
  selectedClasses: [...OBJECT_KEYS],
};

function key(cameraId: string) {
  return `vp-camcfg-${cameraId}`;
}

// Normaliza/valida uma config (de qualquer origem: localStorage OU backend) aplicando defaults.
function normalizeCfg(c: Partial<CameraCfg> | null | undefined): CameraCfg {
  if (!c) return { ...DEFAULT, selectedClasses: [...OBJECT_KEYS] };
  const sel = Array.isArray(c.selectedClasses)
    ? c.selectedClasses.filter((k) => OBJECT_KEYS.includes(k))
    : [];
  return {
    modo:
      c.modo === "leitura" || c.modo === "objetos" || c.modo === "fadiga" ? c.modo : "atividade",
    pontoLeitura:
      typeof c.pontoLeitura === "string" && c.pontoLeitura.trim()
        ? c.pontoLeitura
        : DEFAULT.pontoLeitura,
    capture: c.capture === "media" || c.capture === "maxima" ? c.capture : "alta",
    selectedClasses: sel.length ? sel : [...OBJECT_KEYS],
  };
}

// Cache local (localStorage) — fallback offline e origem de migração do legado.
function cacheCameraCfg(cameraId: string, cfg: CameraCfg) {
  try {
    localStorage.setItem(key(cameraId), JSON.stringify(cfg));
  } catch {
    /* no-op */
  }
}
// Há config LEGADA salva no localStorage? (decide migração best-effort × defaults).
function hasStoredCfg(cameraId: string): boolean {
  try {
    return localStorage.getItem(key(cameraId)) != null;
  } catch {
    return false;
  }
}

// Leitura SÍNCRONA do cache local (+ defaults). Fonte de fallback usada pela central; o cache é
// mantido em dia pelo write-through de setCameraCfg e pela hidratação de loadCamConfig.
export function getCameraCfg(cameraId: string): CameraCfg {
  try {
    const raw = localStorage.getItem(key(cameraId));
    if (!raw) return { ...DEFAULT, selectedClasses: [...OBJECT_KEYS] };
    return normalizeCfg(JSON.parse(raw) as Partial<CameraCfg>);
  } catch {
    return { ...DEFAULT, selectedClasses: [...OBJECT_KEYS] };
  }
}

// Grava a config: cache local imediato (offline-safe) + write-through no BACKEND. Assinatura
// SÍNCRONA preservada (a central chama sem await). O PUT exige perfil de configuração; para
// operador (403) ou offline, degrada silenciosamente — o cache local mantém a UX.
export function setCameraCfg(cameraId: string, cfg: CameraCfg) {
  cacheCameraCfg(cameraId, cfg);
  saveCamConfig(cameraId, cfg).catch((e) => {
    console.warn("[camconfig] write-through falhou — mantendo apenas o cache local", e);
  });
}

// Carga da câmera com o BACKEND como fonte de verdade + FALLBACK gracioso (Onda 2). ASSÍNCRONA.
// Refresca o cache local para que o leitor síncrono getCameraCfg passe a refletir o backend.
// • Backend com config → normaliza, atualiza o cache e retorna.
// • Backend NULL (nunca salvo) + legado no localStorage → migração única best-effort (se
//   `canConfigure`; o PUT exige perfil de configuração); sem permissão/erro, usa o cache local.
// • Backend NULL + sem legado → defaults.
// • Backend FALHOU (erro/offline) → degrada para o cache local/defaults (getCameraCfg).
export async function loadCamConfig(cameraId: string, canConfigure: boolean): Promise<CameraCfg> {
  let remote: CameraCfg | null;
  try {
    remote = await getCamConfig(cameraId);
  } catch (e) {
    console.error("[camconfig] carga do backend falhou — usando cache local", e);
    return getCameraCfg(cameraId);
  }
  if (remote) {
    const cfg = normalizeCfg(remote);
    cacheCameraCfg(cameraId, cfg);
    return cfg;
  }
  const local = getCameraCfg(cameraId);
  if (hasStoredCfg(cameraId) && canConfigure) {
    try {
      const saved = normalizeCfg(await saveCamConfig(cameraId, local)); // migração best-effort
      cacheCameraCfg(cameraId, saved);
      return saved;
    } catch (e) {
      console.error("[camconfig] migração best-effort falhou — usando cache local", e);
    }
  }
  return local;
}
