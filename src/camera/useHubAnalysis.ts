// ── F1/F2/F3 (ADR-009): análise no HUB — espelho dos overlays servidos + "hoje" das linhas ──
// Extraído do CameraWorkspace (Onda C) SEM mudança de comportamento. Com engine==="hub" o MOTOR do
// hub (D-FINE+ByteTrack, 24/7) grava os indicadores e emite `analysis-tracks` @1fps; este componente
// vira ESPELHO (desenha os tracks/zonas servidos) e SUPRIME os ingests locais p/ não duplicar.
// Engine "local" (motor desligado) → efeitos inertes = pipeline local idêntico ao de sempre.
import { useEffect, useRef, useState } from "react";
import { type Detection } from "../vision/model";
import { type TripwireCounts } from "../vision/counting";
import { loadFlowToday } from "../report/store";
import type { HubAnalysis, HubZone, Track } from "../CameraWorkspace";

// Payload do hub mais velho que isto é STALE (motor reiniciando/rede) → não desenhar caixa velha.
const HUB_TRACKS_STALE_MS = 5000;
// Cadência do refresh do acumulado "hoje" das linhas quando o MOTOR DO HUB analisa a câmera.
const HUB_FLOW_REFRESH_MS = 30_000;

type Ref<T> = { current: T };
// Refs de estado do pipeline que o applyHubAnalysis muta (owned pelo CameraWorkspace).
export type HubApplyRefs = {
  tracksRef: Ref<Track[]>;
  detsRef: Ref<Detection[]>;
  hubZonesRef: Ref<HubZone[] | null>;
  hubTracksTsRef: Ref<number>;
  hubFirstSeenRef: Ref<Map<number, number>>;
};

// ── Sub-passo PURO do rAF: alimenta tracksRef/detsRef com o payload do HUB (grade e câmera aberta) ──
// Converte HubTrack → Track (shape do drawTracks/presença/heatmap): score REAL da detecção (o slider
// de confiança volta a atenuar/apagar caixas; track sem score = hub antigo → 1). foot derivado do bbox
// (bottom-center) e firstSeen mantido POR ID entre payloads (rótulo de permanência). detsRef recebe
// pseudo-dets "person" (bbox em PIXELS, contrato Detection) — mantém vivo o `occupied` do
// AtividadeProcessor (OCIOSA×VAZIA), que antes vinha do coco local. Conversão SÓ quando o payload
// muda (~1fps); payload mais velho que HUB_TRACKS_STALE_MS é descartado (limpa as caixas).
export function applyHubAnalysis(
  hubActive: boolean,
  hd: HubAnalysis | null,
  now: number,
  frameW: number,
  frameH: number,
  refs: HubApplyRefs,
): void {
  const { tracksRef, detsRef, hubZonesRef, hubTracksTsRef, hubFirstSeenRef } = refs;
  if (hubActive) {
    const fresh = !!hd && Date.now() - hd.ts <= HUB_TRACKS_STALE_MS;
    if (!fresh) {
      if (tracksRef.current.length) tracksRef.current = [];
      if (detsRef.current.length) detsRef.current = [];
      hubZonesRef.current = null;
      if (hubFirstSeenRef.current.size) hubFirstSeenRef.current.clear();
    } else if (hd.ts !== hubTracksTsRef.current) {
      hubTracksTsRef.current = hd.ts;
      const seen = hubFirstSeenRef.current;
      const alive = new Set<number>();
      tracksRef.current = hd.tracks.map((t) => {
        alive.add(t.id);
        let fs = seen.get(t.id);
        if (fs == null) {
          fs = now;
          seen.set(t.id, fs);
        }
        return {
          id: t.id,
          cx: t.cx,
          cy: t.cy,
          foot: { x: t.bbox[0] + t.bbox[2] / 2, y: t.bbox[1] + t.bbox[3] },
          bbox: t.bbox,
          firstSeen: fs,
          lastSeen: now,
          zone: t.zone,
          // Score real p/ o DESENHO: o slider (confRef) atenua/apaga fantasmas pontuais.
          // Retrocompat: hub antigo não envia score → 1 (nunca atenuado, como antes).
          score: t.score ?? 1,
        };
      });
      seen.forEach((_, id) => {
        if (!alive.has(id)) seen.delete(id); // poda ids mortos (mapa não cresce sem limite)
      });
      // Pseudo-dets p/ a CONTAGEM/occupied (AtividadeProcessor), NÃO p/ o desenho: score fica 1 de
      // propósito — o motor já filtrou por people.scoreThreshold; o slider de confiança é só do overlay.
      detsRef.current = hd.tracks.map((t) => ({
        class: "person",
        score: 1,
        bbox: [t.bbox[0] * frameW, t.bbox[1] * frameH, t.bbox[2] * frameW, t.bbox[3] * frameH] as [
          number,
          number,
          number,
          number,
        ],
      }));
      hubZonesRef.current = hd.zones;
    }
  } else if (hubZonesRef.current) {
    // saiu do modo espelho (engine voltou a local) → limpa o resíduo do hub; o pipeline local
    // reassume na próxima rodada de detecção (fallback = comportamento atual).
    hubZonesRef.current = null;
    hubTracksTsRef.current = 0;
    hubFirstSeenRef.current.clear();
  }
}

// ── Suavização DISPLAY-ONLY das caixas do HUB (deslize em vez de salto) ───────────────────────────
// O hub emite `analysis-tracks` em cadência baixa (~1fps; ~6fps quando a câmera está focada). Como o
// palco redesenha a ~30fps, a bbox CRUA fica congelada entre payloads e SALTA quando chega o próximo.
// Aqui guardamos uma bbox EXIBIDA por track (Map por id do ByteTrack, que SOBREVIVE à troca de payload)
// e a cada frame do rAF a deslizamos (LERP) até o ALVO = a bbox EXATA do último payload.
//
// É SÓ p/ DESENHO. O track real (contagem por linha, pé em zona de exclusão, tripwire, ocupação) segue
// lendo `tracksRef` EXATO — foot/cx/cy/bbox reais NÃO mudam (a lógica já rodou antes do drawScene). O
// grid (routes/dashboard/TrackOverlay) tem a própria via de suavização (camera/interpolate.ts, modelo
// de velocidade com fade/expire); aqui a via é mais LEVE de propósito: pega carona no pipeline de
// tracks EXATOS do workspace e preserva o aparecer/sumir imediato (track fora do payload some, como
// hoje) — só ADICIONA o deslize da bbox. Nada de fade/extrapolação.

// Fator do LERP por frame: ~0.25 acomoda em ~100–150ms @~60fps (constante de tempo τ ≈ Δt/−ln(1−f)).
export const HUB_EASE_FACTOR = 0.25;

/** LERP escalar puro (t=0 → a, t=1 → b) — base do deslize da caixa exibida. Testável em Vitest. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Estado do easing REUSADO entre frames (sem alocar no hot-path do rAF):
//  box  = bbox EXIBIDA por id (tupla mutada in-place a cada frame; sobrevive à troca de payload)
//  pool = wrapper Track reusado por id p/ o desenho (bbox = a MESMA tupla suavizada de `box`)
//  out  = array de saída reusado (consumido por drawTracks/personTrackBoxes)
export type HubEaseState = {
  box: Map<number, [number, number, number, number]>;
  pool: Map<number, Track>;
  out: Track[];
};
export function makeHubEaseState(): HubEaseState {
  return { box: new Map(), pool: new Map(), out: [] };
}

function hasId(tracks: readonly Track[], id: number): boolean {
  for (let i = 0; i < tracks.length; i++) if (tracks[i].id === id) return true;
  return false;
}

// Passo por-frame do rAF (SÓ no modo hub): desliza a bbox EXIBIDA de cada track até o ALVO (bbox
// exata do último payload) e devolve os tracks com a bbox SUAVIZADA p/ DESENHO. Reusa buffers — só
// aloca p/ id NOVO. Track novo NASCE no alvo (sem deslizar do zero). Id que sumiu do payload é podado
// (box/pool não vazam). SEPARAÇÃO display×lógica: só a `bbox` é a exibida; id/score/firstSeen/zone
// (e cx/cy/foot, não usados no desenho) são os EXATOS do track — a lógica lê `tracksRef`, não isto.
export function easeHubTracks(tracks: readonly Track[], st: HubEaseState, factor: number): Track[] {
  const { box, pool, out } = st;
  out.length = 0; // reusa o array (não realoca o backing store)
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    let d = box.get(t.id);
    if (d === undefined) {
      d = [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]]; // nova detecção → nasce NO alvo
      box.set(t.id, d);
    } else {
      d[0] = lerp(d[0], t.bbox[0], factor); // desliza in-place até o alvo
      d[1] = lerp(d[1], t.bbox[1], factor);
      d[2] = lerp(d[2], t.bbox[2], factor);
      d[3] = lerp(d[3], t.bbox[3], factor);
    }
    let w = pool.get(t.id);
    if (w === undefined) {
      w = { ...t, bbox: d }; // wrapper novo (bbox = a tupla suavizada)
      pool.set(t.id, w);
    } else {
      // reusa o wrapper: campos EXATOS do track + bbox SUAVIZADA (mesma tupla `d`, mutada acima)
      w.id = t.id;
      w.cx = t.cx;
      w.cy = t.cy;
      w.foot = t.foot;
      w.firstSeen = t.firstSeen;
      w.lastSeen = t.lastSeen;
      w.zone = t.zone;
      w.score = t.score;
      w.bbox = d;
    }
    out.push(w);
  }
  // Poda ids que sumiram do payload (só quando há sobra → o caso comum é no-op, sem varredura).
  if (box.size > tracks.length) for (const id of box.keys()) if (!hasId(tracks, id)) box.delete(id);
  if (pool.size > tracks.length)
    for (const id of pool.keys()) if (!hasId(tracks, id)) pool.delete(id);
  return out;
}

export function useHubAnalysis(
  analysisEngine: "hub" | "local",
  cameraId: string,
  getHubAnalysis: (() => HubAnalysis | null) | undefined,
) {
  // Refs espelho p/ leitura DENTRO do rAF/drawScene (o loop é criado 1× por câmera e a prop pode
  // mudar em runtime quando o motor do hub liga/desliga — mesmo padrão de onAlertRef/pausedRef).
  const analysisEngineRef = useRef(analysisEngine);
  useEffect(() => {
    analysisEngineRef.current = analysisEngine;
  }, [analysisEngine]);
  const getHubAnalysisRef = useRef(getHubAnalysis);
  useEffect(() => {
    getHubAnalysisRef.current = getHubAnalysis;
  }, [getHubAnalysis]);
  const hubZonesRef = useRef<HubZone[] | null>(null); // zones[] do último payload FRESCO do hub
  const hubTracksTsRef = useRef(0); // ts do último payload consumido (gate "payload novo")
  const hubFirstSeenRef = useRef<Map<number, number>>(new Map()); // id do hub → 1ª vez visto aqui
  // Estado do easing DISPLAY-ONLY das caixas do hub (buffers reusados; lido no drawScene). Só o
  // desenho o consome — a lógica (contagem/exclusão/tripwire) segue no tracksRef EXATO.
  const hubEaseRef = useRef<HubEaseState>(makeHubEaseState());

  // "hoje" das linhas no MODO HUB — refresh periódico do SERVIDOR, SEM somar a sessão. Com o motor
  // ligado, o servidor grava os MESMOS cruzamentos que o counter local vê; exibir flowBase+sessão
  // contaria cada cruzamento 2×. Aqui o "hoje" exibido (HUD via hubFlowRef + painel via hubFlowToday)
  // é SÓ o valor do servidor, re-buscado a cada ~30s. Modo local: efeito inerte → comportamento atual.
  const hubFlowRef = useRef<Record<string, TripwireCounts>>({}); // lido no rAF (HUD, sem alocar)
  const [hubFlowToday, setHubFlowToday] = useState<Record<string, TripwireCounts>>({});
  useEffect(() => {
    if (analysisEngine !== "hub") return; // local → nada muda (flowBase carrega 1×, como hoje)
    let cancelled = false;
    const refresh = () =>
      loadFlowToday(cameraId)
        .then((acc) => {
          if (cancelled) return;
          hubFlowRef.current = acc;
          // Preserva a referência quando nada mudou — evita re-render a cada tick de 30s.
          setHubFlowToday((prev) => (JSON.stringify(prev) === JSON.stringify(acc) ? prev : acc));
        })
        .catch(() => {
          /* mantém o último valor exibido; o próximo tick tenta de novo */
        });
    refresh();
    const t = setInterval(refresh, HUB_FLOW_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
      hubFlowRef.current = {};
      setHubFlowToday({});
    };
  }, [analysisEngine, cameraId]);

  return {
    analysisEngineRef,
    getHubAnalysisRef,
    hubZonesRef,
    hubTracksTsRef,
    hubFirstSeenRef,
    hubEaseRef,
    hubFlowRef,
    hubFlowToday,
  };
}
