// Configuração por câmera definida na CENTRAL (LGPD: só metadados, sem imagens).
// Modo decide o pipeline: "atividade" (ocupação/ociosidade, padrão) | "leitura" (código de barras).
// PERSISTÊNCIA (Onda 2): fonte de verdade = BACKEND (compartilhado por câmera, via api.ts
// getCamConfig/saveCamConfig), com o localStorage (`vp-camcfg-<id>`) como CACHE/fallback offline.
// getCameraCfg segue SÍNCRONA (consumida na central); setCameraCfg grava o cache no mesmo tick e
// faz write-through no backend respondendo sucesso/falha (Promise<boolean>, nunca rejeita);
// loadCamConfig (assíncrona) hidrata/migra o cache a partir do backend.

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
  // Perfil "Longo alcance / Panorâmica" (P0/P1 de `docs/analises/plano-deteccao-objetos.md`). OPT-IN por
  // câmera; default false = comportamento atual. Ligado → o CameraWorkspace aplica tiling na grade +
  // tile maior + limiares menores (detection.longRange) e movimento/pessoas mais sensíveis.
  longRange: boolean;
  // Transporte de VÍDEO NO PAINEL por câmera. NÃO confundir com o `transport` tcp/udp do RTSP no
  // /cameras (aquele é do ffmpeg, conceito diferente).
  //   "auto"   (PADRÃO, Onda 2): "melhor disponível" — o dashboard resolve WebRTC quando o go2rtc
  //            serve a câmera (id ∈ GET /api/streams) e MJPEG quando não (go2rtc fora / stream ainda
  //            não montada). Sem o operador marcar câmera-a-câmera; fallback é AUTOMÁTICO, não opt-out.
  //   "mjpeg"  (OVERRIDE): força o relé JPEG por socket (o tile de sempre). Escape hatch.
  //   "webrtc" (OVERRIDE): força o vídeo fluido via go2rtc (RTSP→WHEP / webcam→WHIP). Escape hatch.
  transport: "auto" | "mjpeg" | "webrtc";
};

const DEFAULT: CameraCfg = {
  modo: "atividade",
  pontoLeitura: APP_CONFIG.reading.defaultPonto,
  // MELHOR QUALIDADE COMO BASE (norte "zero escolha"): a câmera NOVA nasce em "maxima" (1920,
  // JPEG 0.92 — ver reading.capturePresets). O operador não precisa subir resolução câmera-a-câmera;
  // a melhor imagem já vem por default. Só afeta o caminho MJPEG/leitura+webcam-relé; o WebRTC
  // codec-copy do RTSP já entrega o nativo (a melhor imagem lá é automática, sem preset). Tradeoff
  // honesto: "maxima" pede ~6fps (vs 8 em "alta") p/ caber os pixels a mais — nitidez > cadência
  // numa captura de vigilância. Escape hatch p/ cena com banda/CPU restrita: baixar p/ "alta"/"media".
  capture: "maxima",
  selectedClasses: [...OBJECT_KEYS],
  longRange: false,
  transport: "auto",
};

function key(cameraId: string) {
  return `vp-camcfg-${cameraId}`;
}

// Normaliza/valida uma config (de qualquer origem: localStorage OU backend) aplicando defaults.
// Exportada p/ teste unitário (pura, sem I/O): valida modo/capture/transport e filtra classes.
export function normalizeCfg(c: Partial<CameraCfg> | null | undefined): CameraCfg {
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
    // Valor salvo VÁLIDO é preservado (o operador pode ter baixado p/ "media"/"alta" numa cena
    // restrita); ausente/inválido cai no DEFAULT — hoje "maxima" (melhor imagem sem escolha).
    capture:
      c.capture === "media" || c.capture === "alta" || c.capture === "maxima"
        ? c.capture
        : DEFAULT.capture,
    selectedClasses: sel.length ? sel : [...OBJECT_KEYS],
    longRange: c.longRange === true, // opt-in; qualquer coisa != true (inclusive ausente) → false
    // Retrocompat: overrides antigos ("mjpeg"/"webrtc") são PRESERVADOS; ausente/inválido → "auto"
    // (novo default = melhor disponível, resolvido no dashboard por transportOf).
    transport: c.transport === "mjpeg" || c.transport === "webrtc" ? c.transport : "auto",
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

// Grava a config: cache local imediato (offline-safe) + write-through no BACKEND. Responde
// SUCESSO/FALHA do PUT (Promise<boolean>, NUNCA rejeita — caller fire-and-forget segue seguro):
// quem tem superfície de feedback (ex.: /cameras) mostra o erro em vez de a falha sumir em
// silêncio. Em falha (403 do operador, offline), o cache local ainda mantém a UX desta máquina.
export function setCameraCfg(cameraId: string, cfg: CameraCfg): Promise<boolean> {
  cacheCameraCfg(cameraId, cfg);
  return saveCamConfig(cameraId, cfg).then(
    () => true,
    (e) => {
      console.warn("[camconfig] write-through falhou — mantendo apenas o cache local", e);
      return false;
    },
  );
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
