// Conexão Socket.IO da central: abre o socket e roteia TODOS os eventos do hub para os refs do
// relé de frames e para os setters de estado das outras frentes. CONTRATOS SOCKET aditivos/
// defensivos (payloads desconhecidos degradam para o default seguro; nunca quebram a central).
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../../config";
import {
  type HubAnalysis,
  type HubTrack,
  type HubZone,
} from "../../CameraWorkspace";
import { loadCamConfig } from "../../cameraConfig";
import { type AlarmEvent, type BtReading } from "../../api";
import { mergeSourceBatch, type SourceBatch } from "../../fusion/source-pool";
import { type Camera, type CameraStatus } from "./types";
import { newFrameEntry, type FrameEntry } from "./useFrameRelay";

type Deps = {
  token: string | null;
  logout: (reason?: string) => void;
  // Foco (ADR-009): id da câmera ABERTA em tela cheia (ou null). Só vira pedido de foco ao hub
  // quando essa câmera é analisada pelo MOTOR ("hub"); do contrário o hub não tem o que boostar.
  openId: string | null;
  // Refs do relé de frames (useFrameRelay) que o socket alimenta/consulta.
  framesRef: React.RefObject<Map<string, FrameEntry>>;
  activeIdsRef: React.RefObject<Set<string>>;
  hubAnalysisRef: React.RefObject<Map<string, HubAnalysis>>;
  readingZoneRef: React.RefObject<Map<string, boolean>>;
  drainDecode: (id: string) => void;
  loadReadingFlag: (id: string, label: string) => void;
  // Setters das outras frentes (câmeras + alarmes).
  setCameras: React.Dispatch<React.SetStateAction<Camera[]>>;
  setAlarms: React.Dispatch<React.SetStateAction<AlarmEvent[]>>;
};

export type DashboardSocket = {
  socketRef: React.RefObject<Socket | null>;
  connected: boolean;
  statuses: Record<string, CameraStatus>;
  // Fonte da ANÁLISE por câmera — anti-duplicação de ingest (ADR-009).
  analysisEngines: Record<string, "hub" | "local">;
  // Sincronização ao vivo — revisão de tripwires por câmera (ADR-006).
  revByCamera: Map<string, number>;
  // Sincronização ao vivo — revisão da CALIBRAÇÃO (homografia/station) por câmera. Mesmo idioma
  // do revByCamera: `camcfg-updated {kind:"calibration"}` incrementa; a fusão tag↔pessoa re-busca.
  calibrationRevByCamera: Map<string, number>;
  // Leituras BLE da estação (bt-readings) — getter estável p/ a fusão tag↔pessoa (caminho C).
  getBtReadings: () => BtReading[];
};

export function useDashboardSocket({
  token,
  logout,
  openId,
  framesRef,
  activeIdsRef,
  hubAnalysisRef,
  readingZoneRef,
  drainDecode,
  loadReadingFlag,
  setCameras,
  setAlarms,
}: Deps): DashboardSocket {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, CameraStatus>>({});
  // O hub anuncia via `analysis-status {cameraId, engine:"hub"|"local"}` quais câmeras o MOTOR
  // server-side analisa (ADR-009). Hub antigo sem o evento → mapa vazio → tudo "local".
  const [analysisEngines, setAnalysisEngines] = useState<Record<string, "hub" | "local">>({});
  // Cada `camcfg-updated{kind:"tripwires",cameraId}` incrementa o contador daquela câmera; o
  // número é repassado às tiles via `tripwiresRev` (re-busca dos tripwires). (ADR-006)
  const [revByCamera, setRevByCamera] = useState<Map<string, number>>(new Map());
  // Idem para a CALIBRAÇÃO da câmera (H em metros + station): sem isto, dashboards abertos ficavam
  // com a homografia ANTIGA até remontar (useCameraTagLabels busca 1× por mount). (ADR-006)
  const [calibrationRevByCamera, setCalibrationRevByCamera] = useState<Map<string, number>>(
    new Map(),
  );
  // Último id de foco anunciado ao hub. Ref (não state): mudá-lo não deve re-renderizar — é só
  // o "espelho" do que o servidor já sabe, usado p/ idempotência (não reemitir o mesmo id),
  // re-emit no reconnect (o servidor perde o foco no disconnect) e release no unmount.
  const focusRef = useRef<string | null>(null);
  // Leituras BLE vivas (bt-readings, global). Ref (sem re-render por evento, padrão hubAnalysisRef);
  // a fusão tag↔pessoa (useTagFusion) e o plot de chão (useFloorTags) leem pelo getter estável
  // abaixo. MULTI-ANTENA (spec F4): o hub emite UM envelope por POST de estação (só a varredura
  // DAQUELA fonte) — guardar "o último envelope" fazia o pool PISCAR entre fontes (lista-só-A ↔
  // lista-só-B), corrompendo a série de RSSI por tag. btSourcesRef acumula a varredura POR fonte;
  // o ref publica o POOL unido (todas as fontes vivas) — semântica em source-pool.ts.
  const btSourcesRef = useRef<Map<string, SourceBatch<BtReading>>>(new Map());
  const btReadingsRef = useRef<BtReading[]>([]);

  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      // A reconexão pode ter trocado o hub (com/sem motor): zera o mapa de engines; o snapshot
      // `analysis-status` emitido no connect repovoa. Sem o evento (hub antigo/motor desligado),
      // tudo volta a "local" — o default seguro (browser volta a gravar).
      setAnalysisEngines({});
      // A reconexão perde as rooms no servidor: reanuncia o conjunto assistido para voltar
      // a receber frames (o efeito de feeds ativos cobre as MUDANÇAS; aqui cobre o re-connect).
      socket.emit("watch", { ids: [...activeIdsRef.current] });
      // O servidor perde o foco no disconnect (como as rooms). Se ainda há câmera focada
      // (motor do hub), reanuncia para o hub voltar a boostar a análise dela na reconexão.
      if (focusRef.current) socket.emit("analysis-focus", { id: focusRef.current });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      if (err.message === "unauthorized") logout("Sessão expirada. Entre novamente.");
    });
    socket.on("cameras", (list: Camera[]) => setCameras(list));
    socket.on("camera-status", (s: CameraStatus) =>
      setStatuses((prev) => ({ ...prev, [s.id]: s })),
    );
    // Alarmes ao vivo (aditivos, B1): novo evento → topo da fila; update → casa por id e substitui.
    socket.on("alarm-event", (a: AlarmEvent) =>
      setAlarms((prev) => [a, ...prev.filter((x) => x.id !== a.id)]),
    );
    socket.on("alarm-update", (a: AlarmEvent) =>
      setAlarms((prev) => {
        let found = false;
        const next = prev.map((x) => (x.id === a.id ? ((found = true), a) : x));
        return found ? next : [a, ...next];
      }),
    );
    // Fonte da análise por câmera (snapshot no connect + mudanças; ADR-009). Update funcional
    // que PRESERVA a referência quando nada mudou (evita re-render da grade à toa).
    // Payload defensivo: engine desconhecida degrada p/ "local" (browser grava — sem buraco).
    socket.on("analysis-status", (p: { cameraId: string; engine: "hub" | "local" }) => {
      if (!p || typeof p.cameraId !== "string") return;
      const engine = p.engine === "hub" ? "hub" : "local";
      setAnalysisEngines((prev) =>
        prev[p.cameraId] === engine ? prev : { ...prev, [p.cameraId]: engine },
      );
    });
    // Overlays servidos (ADR-009): guarda o último payload por câmera no REF (sem setState —
    // ver hubAnalysisRef). `ts` = RECEPÇÃO local (Date.now): o gate de stale (~5s) no
    // CameraWorkspace compara com o relógio local e fica imune a skew hub×cliente. Payload
    // defensivo: campos ausentes viram lista vazia (tile fica sem caixas, nunca quebra).
    socket.on(
      "analysis-tracks",
      (p: { cameraId: string; ts?: number; tracks?: HubTrack[]; zones?: HubZone[]; latencyMs?: number }) => {
        if (!p || typeof p.cameraId !== "string") return;
        hubAnalysisRef.current.set(p.cameraId, {
          ts: Date.now(),
          tracks: Array.isArray(p.tracks) ? p.tracks : [],
          zones: Array.isArray(p.zones) ? p.zones : [],
          // Idade do frame no hub (captura→emissão) → o interpolador compensa o overlay lag.
          latencyMs: typeof p.latencyMs === "number" && p.latencyMs >= 0 ? p.latencyMs : 0,
        });
      },
    );
    // Leituras BLE (estações → hub → dashboards; 1 envelope POR fonte). MERGE por fonte com poda
    // de staleness (15 s, espelho do store do servidor — source-pool.ts): o pool entregue à fusão
    // contém TODAS as fontes vivas SIMULTANEAMENTE, então a série de RSSI de cada (tag, fonte)
    // fica íntegra p/ a correlação (antes o ref alternava entre fontes a cada POST). `ts` do
    // merge = RECEPÇÃO local (Date.now), imune a skew hub×cliente — mesmo idioma do
    // analysis-tracks. Envelope sem stationId (hub antigo) → fonte única implícita "" — com UMA
    // estação o pool é a própria varredura corrente, idêntico ao de sempre (CA-3).
    socket.on("bt-readings", (p: { stationId?: string; readings?: BtReading[] }) => {
      const readings = Array.isArray(p?.readings) ? p.readings : [];
      const stationId = typeof p?.stationId === "string" ? p.stationId : "";
      btReadingsRef.current = mergeSourceBatch(btSourcesRef.current, stationId, readings, Date.now());
    });
    socket.on("frame", (p: { id: string; buf: ArrayBuffer; w?: number; h?: number }) => {
      let f = framesRef.current.get(p.id);
      if (!f) {
        f = newFrameEntry();
        framesRef.current.set(p.id, f);
      }
      f.pending = p.buf;
      // Largura NATIVA do payload (webcam envia w/h; RTSP não) — usada só p/ evitar UPSCALE no
      // resize de tile. f.w/f.h continuam sendo as dimensões do bitmap decodificado.
      if (typeof p.w === "number" && p.w > 0) f.srcW = p.w;
      f.ts = Date.now(); // epoch-ms da chegada (frame-gate barato quando exposto pelo getter)
      // Só decodifica feeds ATIVOS: feeds fora da página atual não pagam createImageBitmap (CPU/memória).
      if (activeIdsRef.current.has(p.id)) drainDecode(p.id);
    });
    // Sincronização ao vivo de config compartilhada (ADR-006). Evento aditivo na sala `dashboards`:
    //   • kind:"tripwires" → incrementa a revisão daquela câmera; a prop `tripwiresRev` faz a tile re-buscar.
    //   • kind:"calibration" → idem para a homografia/station; a prop `calibrationRev` faz a fusão re-buscar.
    socket.on(
      "camcfg-updated",
      (p: { kind: "tripwires" | "zones" | "camconfig" | "calibration"; cameraId: string }) => {
        if (p?.kind === "tripwires" && typeof p.cameraId === "string") {
          setRevByCamera((prev) => {
            const next = new Map(prev);
            next.set(p.cameraId, (next.get(p.cameraId) ?? 0) + 1);
            return next;
          });
        } else if (p?.kind === "calibration" && typeof p.cameraId === "string") {
          // Calibração salva em OUTRO posto: incrementa a rev → useCameraTagLabels re-busca o
          // H/station daquela câmera (1 fetch por evento; grade e fullscreen deixam de ficar stale).
          setCalibrationRevByCamera((prev) => {
            const next = new Map(prev);
            next.set(p.cameraId, (next.get(p.cameraId) ?? 0) + 1);
            return next;
          });
        } else if (p?.kind === "zones" && typeof p.cameraId === "string") {
          // Zonas mudaram (talvez ganhou/perdeu zona de leitura): invalida o flag e recarrega;
          // enquanto recarrega, o flag ausente força decode NATIVO (seguro p/ ZXing).
          readingZoneRef.current.delete(p.cameraId);
          loadReadingFlag(p.cameraId, p.cameraId);
        } else if (p?.kind === "camconfig" && typeof p.cameraId === "string") {
          // longRange pode ter mudado em OUTRO posto: refresca o cache local (localStorage)
          // que o leitor síncrono getCameraCfg usa na exceção do resize.
          loadCamConfig(p.cameraId, false).catch(() => {});
        }
      },
    );
    return () => {
      // Libera o foco antes de a conexão cair (unmount ou troca de token). Emite antes do
      // disconnect p/ o hub baixar o boost; se a conexão já caiu, é inócuo (contrato aditivo).
      if (focusRef.current) socket.emit("analysis-focus", { id: null });
      socket.disconnect();
    };
  }, [
    token,
    logout,
    framesRef,
    activeIdsRef,
    hubAnalysisRef,
    readingZoneRef,
    drainDecode,
    loadReadingFlag,
    setCameras,
    setAlarms,
  ]);

  // ── Foco (ADR-009): quando a câmera ABERTA em tela cheia é analisada pelo MOTOR do hub, pede
  // ao hub para BOOSTAR a análise dela (`analysis-focus {id}`); ao fechar, TROCAR de câmera aberta,
  // ou se aquela câmera não é "hub" (engine "local" ou ainda desconhecido), libera (`{id:null}`).
  // Contrato ADITIVO: só um emit novo — não toca o `watch`/relé de frames. Idempotente (focusRef
  // evita reemitir o mesmo id). Reconexão é coberta no handler "connect"; unmount/troca-de-token,
  // no cleanup do efeito do socket. Estrito ao `analysis-status` da câmera (sem fallback p/ default):
  // só boostamos quando o hub confirmou que é ele quem a analisa — nunca uma câmera do pipeline local.
  useEffect(() => {
    const wanted = openId && analysisEngines[openId] === "hub" ? openId : null;
    if (focusRef.current === wanted) return; // idempotência: nada mudou → não spamma o hub
    focusRef.current = wanted;
    socketRef.current?.emit("analysis-focus", { id: wanted });
  }, [openId, analysisEngines]);

  // Getter estável das leituras BLE (identidade fixa → não quebra o memo de quem consome a fusão).
  const getBtReadings = useCallback(() => btReadingsRef.current, []);

  return {
    socketRef,
    connected,
    statuses,
    analysisEngines,
    revByCamera,
    calibrationRevByCamera,
    getBtReadings,
  };
}
