// Relé de frames da central (extraído do god-component DashboardPage — auditoria §S1). Encapsula o
// holder de frames em ref (framesRef), o decode assíncrono fora da main-thread (drainDecode), os
// getters estáveis por câmera (getterFor/hubGetterFor), o cache do flag "tem zona de leitura?" e a
// poda de câmeras removidas. TUDO em refs (zero re-render por frame): o rAF do CameraWorkspace lê os
// getters; o socket (useDashboardSocket) escreve nos refs. Comportamento byte-a-byte do original.
import { useCallback, useEffect, useRef } from "react";
import { type FrameSource } from "../../frame";
import { type HubAnalysis } from "../../CameraWorkspace";
import { getCameraCfg } from "../../cameraConfig";
import { loadZonesForCamera } from "../../zones";
import { type Camera } from "./types";

// ImageBitmap decodificado fora da main thread; só guardamos o último frame (descarta atrasados).
// INVARIANTE (2.2): w/h refletem SEMPRE o tamanho do BITMAP decodificado (bmp.width/height) — que
// pode ser MENOR que o frame nativo quando o decode de tile aplica resize. Os consumidores
// (cropFor/motion no CameraWorkspace) usam zonas normalizadas 0..1 sobre f.w/f.h, então crops e
// leituras de luma permanecem consistentes com o bitmap entregue.
export type FrameEntry = {
  bmp: ImageBitmap | null;
  w: number;
  h: number;
  srcW: number; // largura NATIVA informada no payload (0 = desconhecida; RTSP não envia w/h)
  ts: number; // epoch-ms da última chegada (frame-gate barato quando o getter o expõe)
  pending: ArrayBuffer | null;
  decoding: boolean;
};

// Fábrica de entrada nova — usada pelo handler `frame` do socket ao ver uma câmera pela 1ª vez.
export function newFrameEntry(): FrameEntry {
  return { bmp: null, w: 0, h: 0, srcW: 0, ts: 0, pending: null, decoding: false };
}

// Largura do decode reduzido para feeds que estão SÓ em tile (a grade exibe ~400px).
const TILE_DECODE_WIDTH = 640;

export type FrameRelay = {
  framesRef: React.RefObject<Map<string, FrameEntry>>;
  gettersRef: React.RefObject<Map<string, () => FrameSource | null>>;
  activeIdsRef: React.RefObject<Set<string>>;
  openIdRef: React.RefObject<string | null>;
  readingZoneRef: React.RefObject<Map<string, boolean>>;
  hubAnalysisRef: React.RefObject<Map<string, HubAnalysis>>;
  hubGettersRef: React.RefObject<Map<string, () => HubAnalysis | null>>;
  drainDecode: (id: string) => void;
  getterFor: (id: string) => () => FrameSource | null;
  hubGetterFor: (id: string) => () => HubAnalysis | null;
  loadReadingFlag: (id: string, label: string) => void;
};

export function useFrameRelay(cameras: Camera[]): FrameRelay {
  const framesRef = useRef<Map<string, FrameEntry>>(new Map());
  const gettersRef = useRef<Map<string, () => FrameSource | null>>(new Map());
  // ── F2 (ADR-009): overlays SERVIDOS — último `analysis-tracks` por câmera ──
  // Evento volatile @1fps do MOTOR DO HUB (tracks + zonas). SEM setState por evento (padrão
  // framesRef): o payload vai a este ref e o rAF do CameraWorkspace o lê via getter estável
  // (padrão gettersRef, hubGetterFor abaixo) — zero re-render da grade por frame de análise.
  const hubAnalysisRef = useRef<Map<string, HubAnalysis>>(new Map());
  const hubGettersRef = useRef<Map<string, () => HubAnalysis | null>>(new Map());
  // Conjunto de feeds ATIVOS (página atual + câmera aberta). Só estes são decodificados/processados.
  const activeIdsRef = useRef<Set<string>>(new Set());
  // Câmera aberta espelhada em ref: drainDecode (estável, useCallback []) decide o resize sem
  // religar efeitos; atualizada no efeito de feeds ativos (que já depende de openId).
  const openIdRef = useRef<string | null>(null);
  // 2.2 — cache: a câmera TEM zona de modo "leitura"? (true/false). AUSENTE = ainda não carregado
  // → default SEGURO é decode nativo (ZXing precisa de pixels). Carregado 1× por câmera quando a
  // lista chega (loadZonesForCamera) e invalidado/recarregado no `camcfg-updated { kind:"zones" }`.
  const readingZoneRef = useRef<Map<string, boolean>>(new Map());
  const readingLoadingRef = useRef<Set<string>>(new Set());

  // Decodifica o frame mais recente em ImageBitmap (assíncrono, fora da main thread); mantém só o
  // último. Estável (useCallback []): só toca `framesRef`/`activeIdsRef` (refs estáveis); a recursão
  // usa o nome da própria função (não a const externa). Identidade fixa → entra nas deps sem religar.
  const drainDecode = useCallback(function drainDecode(id: string) {
    const f = framesRef.current.get(id);
    if (!f || f.decoding || !f.pending) return;
    const buf = f.pending;
    f.pending = null;
    f.decoding = true;
    // 2.2 — decode com RESIZE p/ tiles: feed que está só na grade não precisa de pixels nativos
    // (o tile exibe ~400px; decodificar 1280×720 RGBA p/ isso desperdiça CPU/GPU/memória).
    // Exceções — decode NATIVO sempre:
    //  (a) câmera ABERTA (id === openIdRef): zoom/cine-loop/análise full usam o frame inteiro;
    //  (b) `getCameraCfg(id).longRange === true`: o tiling 4×4 NA GRADE recorta o frame nativo;
    //  (c) câmera com zona de modo "leitura": ZXing decodifica código de barras (precisa de
    //      pixels). Enquanto as zonas da câmera não carregaram (flag ausente), assume leitura —
    //      default seguro é nativo;
    //  (d) frame nativo já ≤ TILE_DECODE_WIDTH (quando conhecido): resize só faria upscale.
    // Consistência: f.w/f.h recebem SEMPRE bmp.width/height (abaixo), então os consumidores veem
    // as dimensões REAIS do bitmap (não as nativas) — crops/motion normalizam por proporção.
    const tileOnly = id !== openIdRef.current;
    const mayResize =
      tileOnly &&
      readingZoneRef.current.get(id) === false &&
      getCameraCfg(id).longRange !== true &&
      !(f.srcW > 0 && f.srcW <= TILE_DECODE_WIDTH);
    // Sem resizeHeight: createImageBitmap preserva a proporção sozinho (RTSP não manda w/h).
    const opts: ImageBitmapOptions | undefined = mayResize
      ? { resizeWidth: TILE_DECODE_WIDTH, resizeQuality: "low" }
      : undefined;
    createImageBitmap(new Blob([buf], { type: "image/jpeg" }), opts)
      .then((bmp) => {
        // Corrida (1.7): se o feed saiu do conjunto ativo (paginação) ou a entrada foi podada
        // (câmera removida) enquanto o decode estava em voo, fecha o bitmap recém-criado e não
        // reatribui — antes ele virava um f.bmp órfão que ninguém fechava (vazamento de GPU/RAM).
        if (!activeIdsRef.current.has(id) || framesRef.current.get(id) !== f) {
          bmp.close();
          return;
        }
        const old = f.bmp;
        f.bmp = bmp;
        f.w = bmp.width;
        f.h = bmp.height;
        if (old) old.close();
      })
      .catch(() => {})
      .finally(() => {
        f.decoding = false;
        // Só re-agenda se o feed continua ativo e a entrada ainda é a mesma — evita a cadeia
        // decode→pending→decode se auto-perpetuar para um feed que já saiu da página.
        if (f.pending && activeIdsRef.current.has(id) && framesRef.current.get(id) === f)
          drainDecode(id);
      });
  }, []);

  // 2.2 — carrega (1× por câmera) o flag "tem zona de leitura?" usado nas exceções do resize.
  // canConfigure=false: leitura pura, sem disparar a migração best-effort de zonas do legado.
  // Em falha, o flag fica AUSENTE → drainDecode segue no decode nativo (default seguro).
  const loadReadingFlag = useCallback((id: string, label: string) => {
    if (readingZoneRef.current.has(id) || readingLoadingRef.current.has(id)) return;
    readingLoadingRef.current.add(id);
    loadZonesForCamera(id, label, false)
      .then((zones) => {
        readingZoneRef.current.set(
          id,
          zones.some((z) => z.modo === "leitura"),
        );
      })
      .catch(() => {
        /* flag ausente = decode nativo (seguro) */
      })
      .finally(() => {
        readingLoadingRef.current.delete(id);
      });
  }, []);

  // Poda entradas de câmeras que saíram da lista (1.7): fecha o bitmap e descarta a entrada
  // (pending incluso) — antes framesRef/gettersRef só cresciam. Um decode em voo da entrada
  // removida se auto-descarta no `.then` (a entrada não está mais no Map). Se a câmera voltar,
  // o handler `frame` recria a entrada e `getterFor` recria o getter.
  useEffect(() => {
    if (cameras.length === 0) return; // lista vazia inicial (pré-socket) não é remoção
    const ids = new Set(cameras.map((c) => c.id));
    framesRef.current.forEach((f, id) => {
      if (ids.has(id)) return;
      f.bmp?.close();
      framesRef.current.delete(id);
      gettersRef.current.delete(id);
    });
    // F2: poda também o espelho de análise do hub (payload + getter) da câmera removida.
    hubAnalysisRef.current.forEach((_, id) => {
      if (ids.has(id)) return;
      hubAnalysisRef.current.delete(id);
      hubGettersRef.current.delete(id);
    });
  }, [cameras]);

  // 2.2 — quando a lista de câmeras chega/muda, carrega 1× por câmera o flag "tem zona de
  // leitura?" (async; até resolver, o decode de tile fica NATIVO — ver drainDecode).
  useEffect(() => {
    for (const c of cameras) loadReadingFlag(c.id, c.label);
  }, [cameras, loadReadingFlag]);

  // Limpa todos os bitmaps ao desmontar a central (evita vazamento de GPU/RAM).
  useEffect(() => {
    const frames = framesRef.current;
    return () => frames.forEach((f) => f.bmp?.close());
  }, []);

  const getterFor = useCallback((id: string): (() => FrameSource | null) => {
    let g = gettersRef.current.get(id);
    if (!g) {
      g = () => {
        const f = framesRef.current.get(id);
        if (!f || !f.bmp) return null;
        return { el: f.bmp, w: f.w, h: f.h };
      };
      gettersRef.current.set(id, g);
    }
    return g;
  }, []);

  // F2 (ADR-009): getter estável por câmera do último `analysis-tracks` (padrão getterFor).
  // Identidade fixa por id → não quebra o React.memo do CameraTile nem religa efeitos.
  const hubGetterFor = useCallback((id: string): (() => HubAnalysis | null) => {
    let g = hubGettersRef.current.get(id);
    if (!g) {
      g = () => hubAnalysisRef.current.get(id) ?? null;
      hubGettersRef.current.set(id, g);
    }
    return g;
  }, []);

  return {
    framesRef,
    gettersRef,
    activeIdsRef,
    openIdRef,
    readingZoneRef,
    hubAnalysisRef,
    hubGettersRef,
    drainDecode,
    getterFor,
    hubGetterFor,
    loadReadingFlag,
  };
}
