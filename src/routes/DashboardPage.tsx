import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../config";
import { setInferencePriority } from "../vision/scheduler";
import { type FrameSource } from "../frame";
import { CameraWorkspace } from "../CameraWorkspace";
import { FadigaView } from "../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../report/store";
import { getCameraCfg, setCameraCfg, type CameraCfg } from "../cameraConfig";
import { useAuth } from "../auth";
import { Button, Switch, Select, Dialog, Tooltip, useToast } from "../ui";

type Camera = { id: string; label: string };
// Status por câmera vindo do hub (contrato A4 — evento socket `camera-status`). Aditivo: se o hub
// não emitir, a UI assume "online" e nada quebra.
type CameraStatus = { id: string; state: "connecting" | "online" | "error" | "stopped"; fps?: number; lastError?: string | null; label?: string; kind?: "rtsp" | "browser" };
// ImageBitmap decodificado fora da main thread; só guardamos o último frame (descarta atrasados).
type FrameEntry = { bmp: ImageBitmap | null; w: number; h: number; ts: number; pending: ArrayBuffer | null; decoding: boolean };

function colsFor(n: number): number { return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4; }

export function DashboardPage() {
  const { token, logout } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const framesRef = useRef<Map<string, FrameEntry>>(new Map());
  const gettersRef = useRef<Map<string, () => FrameSource | null>>(new Map());
  // Conjunto de feeds ATIVOS (página atual + câmera aberta). Só estes são decodificados/processados.
  const activeIdsRef = useRef<Set<string>>(new Set());

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CameraStatus>>({});
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [page, setPage] = useState(0);
  // Modo demo ("Limite curto 10s") OFF por padrão (produção). Liga via env VITE_DEMO_MODE=1 ou toggle;
  // a escolha do toggle é lembrada na sessão para não voltar a disparar alertas falsos a cada reload.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    try { const v = sessionStorage.getItem("vp-demo-mode"); if (v != null) return v === "1"; } catch { /* no-op */ }
    return APP_CONFIG.demo.shortLimitDefault;
  });
  const [connected, setConnected] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, { transports: ["websocket"], auth: { token }, query: { role: "dashboard" } });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => { if (err.message === "unauthorized") logout("Sessão expirada. Entre novamente."); });
    socket.on("cameras", (list: Camera[]) => setCameras(list));
    socket.on("camera-status", (s: CameraStatus) => setStatuses((prev) => ({ ...prev, [s.id]: s })));
    socket.on("frame", (p: { id: string; buf: ArrayBuffer; w: number; h: number }) => {
      let f = framesRef.current.get(p.id);
      if (!f) { f = { bmp: null, w: 0, h: 0, ts: 0, pending: null, decoding: false }; framesRef.current.set(p.id, f); }
      f.pending = p.buf; f.ts = Date.now();
      // Só decodifica feeds ATIVOS: feeds fora da página atual não pagam createImageBitmap (CPU/memória).
      if (activeIdsRef.current.has(p.id)) drainDecode(p.id);
    });
    return () => { socket.disconnect(); framesRef.current.forEach((f) => f.bmp?.close()); };
  }, [token, logout]);

  // Decodifica o frame mais recente em ImageBitmap (assíncrono, fora da main thread); mantém só o último.
  function drainDecode(id: string) {
    const f = framesRef.current.get(id);
    if (!f || f.decoding || !f.pending) return;
    const buf = f.pending; f.pending = null; f.decoding = true;
    createImageBitmap(new Blob([buf], { type: "image/jpeg" }))
      .then((bmp) => { const old = f.bmp; f.bmp = bmp; f.w = bmp.width; f.h = bmp.height; if (old) old.close(); })
      .catch(() => {})
      .finally(() => { f.decoding = false; if (f.pending) drainDecode(id); });
  }


  // garante uma config carregada por câmera (default = atividade → retrocompatível)
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of cameras) if (!next[c.id]) { next[c.id] = getCameraCfg(c.id); changed = true; }
      return changed ? next : prev;
    });
  }, [cameras]);

  // ── Paginação dos feeds: só os feeds da página atual são montados (CameraWorkspace) → só eles
  //    processam inferência. Não se roda detecção de TODOS os feeds ao mesmo tempo. ──
  const feedsPerPage = APP_CONFIG.dashboard.feedsPerPage;
  const pageCount = Math.max(1, Math.ceil(cameras.length / feedsPerPage));
  const pageCameras = useMemo(
    () => cameras.slice(page * feedsPerPage, page * feedsPerPage + feedsPerPage),
    [cameras, page, feedsPerPage],
  );
  // mantém a página dentro do intervalo válido quando a lista de câmeras muda
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [page, pageCount]);

  // Conjunto ativo = feeds visíveis (página) + câmera aberta. Decodifica os recém-ativos e libera
  // o ImageBitmap dos que saíram (memória); feeds inativos param de ser decodificados (ver `frame`).
  useEffect(() => {
    const active = new Set<string>(pageCameras.map((c) => c.id));
    if (openId) active.add(openId);
    const prev = activeIdsRef.current;
    activeIdsRef.current = active;
    prev.forEach((id) => { if (!active.has(id)) { const f = framesRef.current.get(id); if (f?.bmp) { f.bmp.close(); f.bmp = null; f.w = 0; f.h = 0; } } });
    active.forEach((id) => { const f = framesRef.current.get(id); if (f?.pending && !f.decoding) drainDecode(id); });
  }, [pageCameras, openId]);

  // Eleva a prioridade da câmera ABERTA na fila do scheduler de inferência (A1). As tiles pedem
  // "low" e a câmera aberta (full) já pede "high"; aqui reforçamos a key na transição de abertura.
  useEffect(() => { if (openId) setInferencePriority(`${openId}:atividade`, "high"); }, [openId]);

  // Lembra a escolha do toggle demo na sessão (evita reativar alertas falsos a cada reload).
  useEffect(() => { try { sessionStorage.setItem("vp-demo-mode", demoMode ? "1" : "0"); } catch { /* no-op */ } }, [demoMode]);

  function getterFor(id: string): () => FrameSource | null {
    let g = gettersRef.current.get(id);
    if (!g) {
      g = () => { const f = framesRef.current.get(id); if (!f || !f.bmp) return null; return { el: f.bmp, w: f.w, h: f.h }; };
      gettersRef.current.set(id, g);
    }
    return g;
  }

  function cfgOf(id: string): CameraCfg { return cfgs[id] ?? getCameraCfg(id); }
  function isFadiga(id: string): boolean { return cfgOf(id).modo === "fadiga"; }
  function setKind(id: string, fadiga: boolean) {
    setCfgs((prev) => { const merged: CameraCfg = { ...cfgOf(id), modo: fadiga ? "fadiga" : "atividade" }; setCameraCfg(id, merged); return { ...prev, [id]: merged }; });
  }

  const open = openId ? cameras.find((c) => c.id === openId) ?? null : null;
  const camNodeUrl = `${location.origin}/camera`;

  // Alerta do painel: mostra o toast E repassa ao hub (andon → webhook externo, se configurado).
  function handleAlert(msg: string) {
    toast(msg, msg.includes("⚠") ? "alert" : "default");
    socketRef.current?.emit("alert", { text: msg, ts: Date.now() });
  }

  // Estado de conexão por câmera (contrato A4). Sem evento `camera-status` → assume "online".
  function statusInfo(id: string): { dot: string; text: string; fps?: number } {
    const s = statuses[id];
    if (!s) return { dot: "on", text: "online" };
    const dot = s.state === "online" ? "on" : s.state === "connecting" ? "connecting" : "error";
    const text = s.state === "online" ? "online" : s.state === "connecting" ? "conectando…" : s.state === "stopped" ? "parada" : "erro";
    return { dot, text, fps: s.fps };
  }

  function renderTile(c: Camera) {
    const st = statusInfo(c.id);
    const inner = c.id === openId
      ? <div className="tile tile-open">aberta no painel</div>
      : isFadiga(c.id)
        ? <FadigaView key={`fad-${c.id}`} cameraId={c.id} label={c.label} getFrame={getterFor(c.id)} mode="tile" onOpen={() => setOpenId(c.id)} onAlert={handleAlert} onSample={recordFadigaSamples} onEvent={recordFadigaEvent} />
        : <CameraWorkspace key={`ws-${c.id}`} cameraId={c.id} label={c.label} getFrame={getterFor(c.id)} mode="tile" demoMode={demoMode} onOpen={() => setOpenId(c.id)} onAlert={handleAlert} />;
    return (
      <div key={`wrap-${c.id}`} style={{ position: "relative", display: "grid", minHeight: 0 }}>
        {inner}
        <span
          title={statuses[c.id]?.lastError || st.text}
          style={{ position: "absolute", top: 6, left: 6, zIndex: 2, display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 11, background: "rgba(5,8,12,0.7)", color: "#e6edf3", padding: "2px 7px", borderRadius: 999, pointerEvents: "none" }}
        >
          <span className={`dot-status ${st.dot}`} />
          {st.text}{st.fps != null ? ` · ${st.fps}fps` : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Central de câmeras</h1>
        <div className="spacer" />
        <Tooltip content="Encurta o limite p/ demonstrar ao vivo. Tempo exibido é real.">
          <span className="switch"><Switch checked={demoMode} onCheckedChange={setDemoMode} ariaLabel="Limite curto (10s)" /> Limite curto (10s)</span>
        </Tooltip>
        <Button onClick={() => setShowConfig(true)} title="Definir o tipo de cada câmera (área × operador)">⚙ Câmeras</Button>
        <a className="ui-btn" href={camNodeUrl} target="_blank" rel="noreferrer">+ Nó de câmera</a>
        {pageCount > 1 && (
          <span className="switch" style={{ gap: 4 }} aria-label="Paginação de feeds">
            <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page <= 0} title="Página anterior">‹</Button>
            <span className="muted">{page + 1}/{pageCount}</span>
            <Button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} title="Próxima página">›</Button>
          </span>
        )}
        <span className="dash-stats" aria-live="polite">
          <span className="stat">hub <b>{connected ? "ok" : "off"}</b></span>
          <span className="stat">câmeras <b>{cameras.length}</b></span>
          <span className="stat">online <b>{cameras.filter((c) => (statuses[c.id]?.state ?? "online") === "online").length}</b></span>
        </span>
      </header>

      <div className="dash-body">
        {cameras.length === 0 ? (
          <div className="dash-empty">
            <p><b>Nenhuma câmera conectada.</b></p>
            <p>Abra <code>/camera</code> neste computador (webcam) ou no celular apontando para o IP do hub.</p>
            <a className="ui-btn ui-btn--primary" href={camNodeUrl} target="_blank" rel="noreferrer">Abrir um nó de câmera</a>
            <p className="muted" style={{ marginTop: 12 }}>Hub: <code>{APP_CONFIG.net.serverUrl}</code> · {connected ? "conectado" : "desconectado"}</p>
          </div>
        ) : (
          <div className="dash-grid" style={{ gridTemplateColumns: `repeat(${colsFor(pageCameras.length)}, 1fr)` }}>
            {pageCameras.map(renderTile)}
          </div>
        )}

        {/* Overlay: câmera aberta */}
        {open && (
          <div className="cam-overlay">
            {isFadiga(open.id)
              ? <FadigaView key={`full-${open.id}`} cameraId={open.id} label={open.label} getFrame={getterFor(open.id)} mode="full" onClose={() => setOpenId(null)} onAlert={handleAlert} onSample={recordFadigaSamples} onEvent={recordFadigaEvent} />
              : <CameraWorkspace key={`full-${open.id}`} cameraId={open.id} label={open.label} getFrame={getterFor(open.id)} mode="full" demoMode={demoMode} onClose={() => setOpenId(null)} onAlert={handleAlert} />}
          </div>
        )}

        {/* Modal: tipo de cada câmera */}
        <Dialog open={showConfig} onOpenChange={setShowConfig} title="Configuração de câmeras"
          description={<><b>Câmera de área</b>: você desenha zonas e escolhe o modo de cada uma (atividade / leitura / objetos). <b>Operador</b>: monitor de fadiga (câmera dedicada ao rosto).</>}>
          {cameras.length === 0 && <p className="empty-note">Nenhuma câmera conectada.</p>}
          {cameras.map((c) => (
            <div key={`cfg-${c.id}`} className="cfg-row">
              <div className="cfg-name"><b>{c.label}</b><span className="muted">{c.id}</span></div>
              <Select value={isFadiga(c.id) ? "fadiga" : "area"} onChange={(v) => setKind(c.id, v === "fadiga")} ariaLabel="Tipo da câmera"
                options={[{ value: "area", label: "Câmera de área (zonas)" }, { value: "fadiga", label: "Operador (fadiga)" }]} />
            </div>
          ))}
        </Dialog>
      </div>
    </div>
  );
}
