// Conexão Socket.IO da central (extraída do god-component DashboardPage — auditoria §S1). Encapsula
// o efeito gigante que abre o socket e roteia TODOS os eventos do hub para os refs do relé de frames
// e para os setters de estado das outras frentes. CONTRATOS SOCKET byte-a-byte, aditivos/defensivos
// (payloads desconhecidos degradam para o default seguro; nunca quebram a central).
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../../config";
import {
  type HubAnalysis,
  type HubTrack,
  type HubZone,
} from "../../CameraWorkspace";
import { loadCamConfig } from "../../cameraConfig";
import { type AlarmEvent } from "../../api";
import { type Camera, type CameraStatus } from "./types";
import { newFrameEntry, type FrameEntry } from "./useFrameRelay";

type Deps = {
  token: string | null;
  logout: (reason?: string) => void;
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
  // ── F1-C (ADR-009): fonte da ANÁLISE por câmera (anti-duplicação de ingest) ──
  analysisEngines: Record<string, "hub" | "local">;
  // ── Sincronização ao vivo (ADR-006) — revisão de tripwires por câmera ──
  revByCamera: Map<string, number>;
};

export function useDashboardSocket({
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
}: Deps): DashboardSocket {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, CameraStatus>>({});
  // ── F1-C (ADR-009): o hub anuncia via `analysis-status {cameraId, engine:"hub"|"local"}` quais
  // câmeras o MOTOR server-side analisa. Hub antigo sem o evento → mapa vazio → tudo "local".
  const [analysisEngines, setAnalysisEngines] = useState<Record<string, "hub" | "local">>({});
  // ── ADR-006: cada `camcfg-updated{kind:"tripwires",cameraId}` incrementa o contador daquela
  // câmera; o número é repassado às tiles via `tripwiresRev` (re-busca dos tripwires).
  const [revByCamera, setRevByCamera] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      // F1-C — a reconexão pode ter trocado o hub (com/sem motor): zera o mapa de engines; o
      // snapshot `analysis-status` emitido no connect repovoa. Sem o evento (hub antigo/motor
      // desligado), tudo volta a "local" — o default seguro (browser volta a gravar).
      setAnalysisEngines({});
      // 2.1 — a reconexão perde as rooms no servidor: reanuncia o conjunto assistido para voltar
      // a receber frames (o efeito de feeds ativos cobre as MUDANÇAS; aqui cobre o re-connect).
      socket.emit("watch", { ids: [...activeIdsRef.current] });
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
    // F1-C (ADR-009) — fonte da análise por câmera (snapshot no connect + mudanças). Update
    // funcional que PRESERVA a referência quando nada mudou (evita re-render da grade à toa).
    // Payload defensivo: engine desconhecida degrada p/ "local" (browser grava — sem buraco).
    socket.on("analysis-status", (p: { cameraId: string; engine: "hub" | "local" }) => {
      if (!p || typeof p.cameraId !== "string") return;
      const engine = p.engine === "hub" ? "hub" : "local";
      setAnalysisEngines((prev) =>
        prev[p.cameraId] === engine ? prev : { ...prev, [p.cameraId]: engine },
      );
    });
    // F2 (ADR-009) — overlays servidos: guarda o último payload por câmera no REF (sem setState —
    // ver hubAnalysisRef). `ts` = RECEPÇÃO local (Date.now): o gate de stale (~5s) no
    // CameraWorkspace compara com o relógio local e fica imune a skew hub×cliente. Payload
    // defensivo: campos ausentes viram lista vazia (tile fica sem caixas, nunca quebra).
    socket.on(
      "analysis-tracks",
      (p: { cameraId: string; ts?: number; tracks?: HubTrack[]; zones?: HubZone[] }) => {
        if (!p || typeof p.cameraId !== "string") return;
        hubAnalysisRef.current.set(p.cameraId, {
          ts: Date.now(),
          tracks: Array.isArray(p.tracks) ? p.tracks : [],
          zones: Array.isArray(p.zones) ? p.zones : [],
        });
      },
    );
    socket.on("frame", (p: { id: string; buf: ArrayBuffer; w?: number; h?: number }) => {
      let f = framesRef.current.get(p.id);
      if (!f) {
        f = newFrameEntry();
        framesRef.current.set(p.id, f);
      }
      f.pending = p.buf;
      // Largura NATIVA do payload (webcam envia w/h; RTSP não) — usada só p/ evitar UPSCALE no
      // resize de tile (2.2). f.w/f.h continuam sendo as dimensões do bitmap decodificado.
      if (typeof p.w === "number" && p.w > 0) f.srcW = p.w;
      f.ts = Date.now(); // epoch-ms da chegada (frame-gate barato quando exposto pelo getter)
      // Só decodifica feeds ATIVOS: feeds fora da página atual não pagam createImageBitmap (CPU/memória).
      if (activeIdsRef.current.has(p.id)) drainDecode(p.id);
    });
    // Sincronização ao vivo de config compartilhada (ADR-006). Evento aditivo na sala `dashboards`:
    //   • kind:"tripwires" → incrementa a revisão daquela câmera; a prop `tripwiresRev` faz a tile re-buscar.
    socket.on(
      "camcfg-updated",
      (p: { kind: "tripwires" | "zones" | "camconfig"; cameraId: string }) => {
        if (p?.kind === "tripwires" && typeof p.cameraId === "string") {
          setRevByCamera((prev) => {
            const next = new Map(prev);
            next.set(p.cameraId, (next.get(p.cameraId) ?? 0) + 1);
            return next;
          });
        } else if (p?.kind === "zones" && typeof p.cameraId === "string") {
          // 2.2 — zonas mudaram (talvez ganhou/perdeu zona de leitura): invalida o flag e
          // recarrega; enquanto recarrega, o flag ausente força decode NATIVO (seguro p/ ZXing).
          readingZoneRef.current.delete(p.cameraId);
          loadReadingFlag(p.cameraId, p.cameraId);
        } else if (p?.kind === "camconfig" && typeof p.cameraId === "string") {
          // 2.2 — longRange pode ter mudado em OUTRO posto: refresca o cache local (localStorage)
          // que o leitor síncrono getCameraCfg usa na exceção do resize.
          loadCamConfig(p.cameraId, false).catch(() => {});
        }
      },
    );
    return () => {
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

  return { socketRef, connected, statuses, analysisEngines, revByCamera };
}
