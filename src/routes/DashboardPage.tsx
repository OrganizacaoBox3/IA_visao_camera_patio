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
import { Button, IconButton, Switch, Checkbox, Select, Input, Dialog, Tooltip, useToast } from "../ui";
import { listAlarms, ackAlarm, forwardAlarm, ApiError, type AlarmEvent, type AlarmPriority, type AlarmState } from "../api";
import "./alarms.css";
import "./views.css";

type Camera = { id: string; label: string };
// Status por câmera vindo do hub (contrato A4 — evento socket `camera-status`). Aditivo: se o hub
// não emitir, a UI assume "online" e nada quebra.
type CameraStatus = { id: string; state: "connecting" | "online" | "error" | "stopped"; fps?: number; lastError?: string | null; label?: string; kind?: "rtsp" | "browser" };
// ImageBitmap decodificado fora da main thread; só guardamos o último frame (descarta atrasados).
type FrameEntry = { bmp: ImageBitmap | null; w: number; h: number; ts: number; pending: ArrayBuffer | null; decoding: boolean };

function colsFor(n: number): number { return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4; }

// ── Views salvas por setor (Onda C · item 11) ──────────────────────────────────────────────
// Uma "view" é um subconjunto ordenado de câmeras (ex.: "Docas", "Expedição"). A ordem dos ids
// define a ordem dos tiles. A view especial "Todas" (activeViewId=null) mostra tudo como hoje.
// Persistência 100% no localStorage (sem backend), por usuário + host do hub — assim cada
// operador tem suas views e elas não vazam entre instalações/servidores diferentes.
type SavedView = { id: string; name: string; cameraIds: string[] };
type ViewsStore = { views: SavedView[]; activeViewId: string | null; autoSurface: boolean };

function viewsKey(userId: string): string { return `vp-views::${userId}::${APP_CONFIG.net.serverUrl}`; }

function loadViewsStore(userId: string): ViewsStore {
  try {
    const raw = localStorage.getItem(viewsKey(userId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<ViewsStore>;
      const views = Array.isArray(p.views)
        ? p.views.filter((v): v is SavedView => !!v && typeof v.id === "string" && typeof v.name === "string" && Array.isArray(v.cameraIds))
        : [];
      const activeViewId = typeof p.activeViewId === "string" && views.some((v) => v.id === p.activeViewId) ? p.activeViewId : null;
      return { views, activeViewId, autoSurface: !!p.autoSurface };
    }
  } catch { /* no-op */ }
  return { views: [], activeViewId: null, autoSurface: false };
}

function newViewId(): string { return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

// Janela de "atividade recente" para o auto-surface (ver activityScore abaixo).
const AUTOSURFACE_WINDOW_MS = 10 * 60_000;

export function DashboardPage() {
  const { token, user, logout } = useAuth();
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
  // ── Fila de alarmes acionável (Onda B · item 7) — consome o backend B1 (só metadados, LGPD) ──
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const [alarmsOpen, setAlarmsOpen] = useState(false);
  const [fPriority, setFPriority] = useState<"all" | AlarmPriority>("all");
  const [fState, setFState] = useState<"all" | AlarmState>("all");
  const [hideAcked, setHideAcked] = useState(false); // só filtro de exibição (não apaga no servidor)
  const { toast } = useToast();

  // ── Views salvas por setor + auto-surface (Onda C · item 11) ──
  const initialViews = useMemo(() => loadViewsStore(user.id), [user.id]);
  const [views, setViews] = useState<SavedView[]>(() => initialViews.views);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialViews.activeViewId);
  const [autoSurface, setAutoSurface] = useState<boolean>(() => initialViews.autoSurface);
  const [viewsMgrOpen, setViewsMgrOpen] = useState(false);
  // Editor do gerenciador: editId = id da view em edição, "new" (criando) ou null (nada aberto).
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftIds, setDraftIds] = useState<string[]>([]);
  // "Tick" para reordenar periodicamente no auto-surface (a recência decai com o tempo, mesmo sem
  // novos eventos socket). Só roda quando o modo está ligado.
  const [surfaceTick, setSurfaceTick] = useState(0);

  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, { transports: ["websocket"], auth: { token }, query: { role: "dashboard" } });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => { if (err.message === "unauthorized") logout("Sessão expirada. Entre novamente."); });
    socket.on("cameras", (list: Camera[]) => setCameras(list));
    socket.on("camera-status", (s: CameraStatus) => setStatuses((prev) => ({ ...prev, [s.id]: s })));
    // Alarmes ao vivo (aditivos, B1): novo evento → topo da fila; update → casa por id e substitui.
    socket.on("alarm-event", (a: AlarmEvent) => setAlarms((prev) => [a, ...prev.filter((x) => x.id !== a.id)]));
    socket.on("alarm-update", (a: AlarmEvent) => setAlarms((prev) => {
      let found = false;
      const next = prev.map((x) => (x.id === a.id ? ((found = true), a) : x));
      return found ? next : [a, ...next];
    }));
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

  // Persiste views/seleção/auto-surface no localStorage (por usuário + host). Sem backend nesta frente.
  useEffect(() => {
    try { localStorage.setItem(viewsKey(user.id), JSON.stringify({ views, activeViewId, autoSurface })); } catch { /* no-op */ }
  }, [user.id, views, activeViewId, autoSurface]);

  // No auto-surface, reavalia a ordem a cada 15s para que a recência (decaimento) atualize o ranking
  // mesmo sem novos eventos chegando pelo socket.
  useEffect(() => {
    if (!autoSurface) return;
    const t = setInterval(() => setSurfaceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [autoSurface]);

  // View ativa (null = "Todas"). Se o id apontar para uma view inexistente, comporta-se como "Todas".
  const activeView = useMemo(() => views.find((v) => v.id === activeViewId) ?? null, [views, activeViewId]);

  // Critério de ATIVIDADE para o auto-surface (documentado): combina os sinais já disponíveis na central:
  //   • alarmes recentes da câmera (últimos 10 min) — sinal mais forte de "está acontecendo algo",
  //     ponderado por prioridade (crítico=100 / alta=40 / informativo=15) e por recência (decai linear);
  //   • fps do camera-status (frames fluindo = câmera viva/movimentada) como contribuição menor;
  //   • câmeras em erro/paradas afundam para o fim (não faz sentido destacá-las).
  function activityScore(camId: string): number {
    const s = statuses[camId];
    const state = s?.state ?? "online";
    if (state === "error" || state === "stopped") return -1_000 + (s?.fps ?? 0); // afunda offline/erro
    const now = Date.now();
    let score = 0;
    for (const a of alarms) {
      if (a.cameraId !== camId) continue;
      const age = now - a.ts;
      if (age < 0 || age > AUTOSURFACE_WINDOW_MS) continue;
      const w = a.priority === "critical" ? 100 : a.priority === "high" ? 40 : 15;
      const recency = 1 - age / AUTOSURFACE_WINDOW_MS; // 1 (agora) → 0 (limite da janela)
      score += w * (0.5 + 0.5 * recency);
    }
    score += (s?.fps ?? 0) * 0.5; // câmera com mais frames/s pesa um pouco mais
    return score;
  }

  // Conjunto base = câmeras da view ativa (na ordem salva), ou todas. Câmeras da view que não estão
  // mais conectadas são silenciosamente omitidas (o id permanece salvo para quando voltarem).
  const viewCameras = useMemo<Camera[]>(() => {
    if (!activeView) return cameras;
    const byId = new Map(cameras.map((c) => [c.id, c]));
    return activeView.cameraIds.map((id) => byId.get(id)).filter((c): c is Camera => !!c);
  }, [cameras, activeView]);

  // Ordem final: auto-surface reordena por atividade; senão mantém a ordem da view/lista.
  const orderedCameras = useMemo<Camera[]>(() => {
    if (!autoSurface) return viewCameras;
    return [...viewCameras].sort((a, b) => activityScore(b.id) - activityScore(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewCameras, autoSurface, statuses, alarms, surfaceTick]);

  // Ao trocar de view ou ligar/desligar auto-surface, volta para a 1ª página (evita ficar "preso").
  useEffect(() => { setPage(0); }, [activeViewId, autoSurface]);

  // ── Paginação dos feeds: só os feeds da página atual são montados (CameraWorkspace) → só eles
  //    processam inferência. A view/auto-surface definem o CONJUNTO e a ORDEM; a paginação continua
  //    valendo sobre esse conjunto (no auto-surface, as mais ativas caem na 1ª página = processadas). ──
  const feedsPerPage = APP_CONFIG.dashboard.feedsPerPage;
  const pageCount = Math.max(1, Math.ceil(orderedCameras.length / feedsPerPage));
  const pageCameras = useMemo(
    () => orderedCameras.slice(page * feedsPerPage, page * feedsPerPage + feedsPerPage),
    [orderedCameras, page, feedsPerPage],
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

  // Carga inicial da fila de alarmes (ts desc); ao vivo entra pelos sockets acima. Falha não quebra a central.
  useEffect(() => {
    let alive = true;
    listAlarms({ limit: 200 })
      .then((list) => { if (alive) setAlarms(list); })
      .catch((e) => { console.error("[alarms] carga inicial falhou", e); });
    return () => { alive = false; };
  }, []);

  // Contador de "novos" (estado new) — realce glanceable no cabeçalho. Prioridade máx. entre os novos.
  const newAlarms = useMemo(() => alarms.filter((a) => a.state === "new"), [alarms]);
  const newCount = newAlarms.length;
  const topNewPriority: AlarmPriority = useMemo(
    () => (newAlarms.some((a) => a.priority === "critical") ? "critical" : newAlarms.some((a) => a.priority === "high") ? "high" : "advisory"),
    [newAlarms],
  );

  // Lista visível = filtros de prioridade/estado + "ocultar reconhecidos" (só exibição). Mantém ts desc.
  const visibleAlarms = useMemo(
    () => alarms.filter((a) =>
      (fPriority === "all" || a.priority === fPriority) &&
      (fState === "all" || a.state === fState) &&
      (!hideAcked || a.state === "new"),
    ),
    [alarms, fPriority, fState, hideAcked],
  );

  // Ack/forward otimista: reflete o estado já; confirma com a resposta (e o socket `alarm-update` reforça).
  async function actOnAlarm(a: AlarmEvent, kind: "ack" | "forward") {
    if (a.state !== "new") return; // já tratado
    const prevState = a.state;
    const optimistic: AlarmState = kind === "ack" ? "acknowledged" : "forwarded";
    setAlarms((prev) => prev.map((x) => (x.id === a.id ? { ...x, state: optimistic, ackBy: user.usuario, ackAt: Date.now() } : x)));
    try {
      const updated = await (kind === "ack" ? ackAlarm(a.id, user.usuario) : forwardAlarm(a.id, user.usuario));
      setAlarms((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
      toast(kind === "ack" ? "Alarme reconhecido." : "Alarme encaminhado.", "ok");
    } catch (e) {
      setAlarms((prev) => prev.map((x) => (x.id === a.id ? { ...x, state: prevState, ackBy: undefined, ackAt: undefined } : x))); // rollback
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar o alarme.", "alert");
    }
  }

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

  // ── Handlers do gerenciador de views ──
  function pickView(v: string) { setActiveViewId(v === "__all__" ? null : v); }
  function startNewView() { setEditId("new"); setDraftName(""); setDraftIds([]); }
  function startEditView(v: SavedView) { setEditId(v.id); setDraftName(v.name); setDraftIds([...v.cameraIds]); }
  function cancelEditView() { setEditId(null); }
  function toggleDraftCam(id: string) { setDraftIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])); }
  function moveDraftCam(id: string, dir: -1 | 1) {
    setDraftIds((prev) => {
      const i = prev.indexOf(id); if (i < 0) return prev;
      const j = i + dir; if (j < 0 || j >= prev.length) return prev;
      const next = [...prev]; const tmp = next[i]; next[i] = next[j]; next[j] = tmp; return next;
    });
  }
  function saveEditView() {
    const name = draftName.trim() || "View sem nome";
    if (editId === "new") {
      const id = newViewId();
      setViews((prev) => [...prev, { id, name, cameraIds: draftIds }]);
      setActiveViewId(id);
    } else if (editId) {
      setViews((prev) => prev.map((v) => (v.id === editId ? { ...v, name, cameraIds: draftIds } : v)));
    }
    setEditId(null);
    toast("View salva.", "ok");
  }
  function deleteView(id: string) {
    setViews((prev) => prev.filter((v) => v.id !== id));
    setActiveViewId((cur) => (cur === id ? null : cur));
    if (editId === id) setEditId(null);
    toast("View excluída.", "default");
  }
  const camLabel = (id: string): string => cameras.find((c) => c.id === id)?.label ?? id;

  const open = openId ? cameras.find((c) => c.id === openId) ?? null : null;
  const camNodeUrl = `${location.origin}/camera`;

  // Alerta do painel: mostra o toast E repassa ao hub (andon → webhook externo, se configurado).
  function handleAlert(msg: string) {
    toast(msg, msg.includes("⚠") ? "alert" : "default");
    socketRef.current?.emit("alert", { text: msg, ts: Date.now() });
  }

  // Estado de conexão por câmera (contrato A4). Sem evento `camera-status` → assume "online".
  // "Going gray" (Onda A): base neutra/cinza; cor saturada SÓ para anormalidade. Mapa de tokens
  // (src/index.css · estado→token): online→neutral (operação normal, evita "árvore de natal");
  // connecting→info (azul, advisory não-crítico); error→critical (vermelho); stopped→neutral-dim
  // (cinza apagado). dot = realce; border = borda discreta por estado (glanceable à distância).
  function statusInfo(id: string): { text: string; dot: string; border: string; fps?: number } {
    const s = statuses[id];
    const state = s?.state ?? "online";
    const text = state === "online" ? "online" : state === "connecting" ? "conectando…" : state === "stopped" ? "parada" : "erro";
    const dot =
      state === "connecting" ? "var(--state-info)"
      : state === "error" ? "var(--state-critical)"
      : state === "stopped" ? "var(--state-neutral-dim)"
      : "var(--state-neutral)"; // online (normal) → neutro, sem cor de alarme
    const border =
      state === "connecting" ? "var(--state-info-border)"
      : state === "error" ? "var(--state-critical-border)"
      : state === "stopped" ? "var(--state-neutral-border)"
      : "var(--state-neutral-border)";
    return { text, dot, border, fps: s?.fps };
  }

  // Prioridade → token de cor (going-gray): advisory=info(azul), high=warn(amarelo), critical=critical(vermelho).
  function prioColor(p: AlarmPriority): string {
    return p === "critical" ? "var(--state-critical)" : p === "high" ? "var(--state-warn)" : "var(--state-info)";
  }
  function prioBorder(p: AlarmPriority): string {
    return p === "critical" ? "var(--state-critical-border)" : p === "high" ? "var(--state-warn-border)" : "var(--state-info-border)";
  }
  const PRIO_LABEL: Record<AlarmPriority, string> = { advisory: "informativo", high: "alta", critical: "crítico" };
  const STATE_LABEL: Record<AlarmState, string> = { new: "novo", acknowledged: "reconhecido", forwarded: "encaminhado" };

  function renderAlarmCard(a: AlarmEvent) {
    const done = a.state !== "new";
    const when = new Date(a.ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const local = a.cameraLabel || a.cameraId || a.zona;
    return (
      <div key={a.id} className="alarm-card" data-done={done ? 1 : 0} style={{ borderLeftColor: prioBorder(a.priority) }}>
        <div className="alarm-card__top">
          <span className="alarm-card__dot" style={{ background: prioColor(a.priority) }} />
          <span className="alarm-card__prio" style={{ color: prioColor(a.priority) }}>{PRIO_LABEL[a.priority]}</span>
          <span className="alarm-card__time" title={new Date(a.ts).toLocaleString("pt-BR")}>{when}</span>
        </div>
        <div className="alarm-card__text">{a.text}</div>
        <div className="alarm-card__meta">
          {local && <span>📍 {local}{a.zona && a.zona !== local ? ` · ${a.zona}` : ""}</span>}
          <span>{a.tipo}</span>
          <span className="alarm-card__state">
            {STATE_LABEL[a.state]}{a.ackBy ? ` · ${a.ackBy}` : ""}
          </span>
        </div>
        {!done && (
          <div className="alarm-card__actions">
            <Button size="sm" variant="primary" onClick={() => actOnAlarm(a, "ack")} title="Reconhecer (assumir o alarme)">Reconhecer</Button>
            <Button size="sm" onClick={() => actOnAlarm(a, "forward")} title="Encaminhar a outro operador">Encaminhar</Button>
          </div>
        )}
      </div>
    );
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
          style={{ position: "absolute", top: 6, left: 6, zIndex: 2, display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 11, background: "var(--cam-overlay-scrim)", color: "var(--cam-overlay-fg)", border: `1px solid ${st.border}`, padding: "2px 7px", borderRadius: 999, pointerEvents: "none" }}
        >
          {/* .dot-status dá o formato; cor vem do token de estado (going-gray) via inline. */}
          <span className="dot-status" style={{ background: st.dot }} />
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
        {/* Views salvas por setor (Onda C · item 11): troca rápida do conjunto/ordem de câmeras. */}
        <span className="switch view-picker" aria-label="View por setor">
          <Select value={activeView ? activeView.id : "__all__"} onChange={pickView} ariaLabel="View por setor"
            options={[{ value: "__all__", label: "Todas as câmeras" }, ...views.map((v) => ({ value: v.id, label: v.name }))]} />
        </span>
        <Button onClick={() => setViewsMgrOpen(true)} title="Criar, renomear ou excluir views por setor">▤ Views</Button>
        <Tooltip content="Prioriza as câmeras com mais atividade recente (alarmes + fps) na 1ª página.">
          <span className="switch"><Switch checked={autoSurface} onCheckedChange={setAutoSurface} ariaLabel="Auto-destaque das câmeras ativas" /> Auto-destaque</span>
        </Tooltip>
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
        <Button onClick={() => setAlarmsOpen((o) => !o)} active={alarmsOpen} title="Fila de alarmes (eventos acionáveis)">
          ▦ Alarmes
          {newCount > 0 && <span className="alarm-badge" data-prio={topNewPriority} aria-label={`${newCount} novos`}>{newCount}</span>}
        </Button>
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
        ) : orderedCameras.length === 0 ? (
          <div className="dash-empty">
            <p><b>Esta view não tem câmeras conectadas.</b></p>
            <p className="muted">Edite a view em <b>▤ Views</b> ou selecione <b>Todas as câmeras</b>.</p>
            <Button onClick={() => setActiveViewId(null)}>Ver todas as câmeras</Button>
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

        {/* Gerenciador de views por setor (Onda C · item 11) — criar/renomear/excluir + ordenar */}
        <Dialog open={viewsMgrOpen} onOpenChange={(o) => { setViewsMgrOpen(o); if (!o) setEditId(null); }}
          title="Views por setor"
          description={<>Monte conjuntos de câmeras por setor (ex.: <b>Docas</b>, <b>Expedição</b>) e alterne rápido pelo seletor do cabeçalho. <b>Todas as câmeras</b> é a view padrão. Salvo neste navegador.</>}>
          {editId === null ? (
            <div className="views-mgr">
              <div className="views-mgr__row views-mgr__row--all">
                <div className="views-mgr__name"><b>Todas as câmeras</b><span className="muted">padrão · {cameras.length} câmera(s)</span></div>
              </div>
              {views.length === 0 && <p className="empty-note">Nenhuma view salva ainda.</p>}
              {views.map((v) => (
                <div key={`vrow-${v.id}`} className="views-mgr__row">
                  <div className="views-mgr__name"><b>{v.name}</b><span className="muted">{v.cameraIds.length} câmera(s)</span></div>
                  <Button size="sm" onClick={() => startEditView(v)} title="Editar câmeras, ordem e nome">Editar</Button>
                  <Button size="sm" variant="danger" onClick={() => deleteView(v.id)} title="Excluir esta view">Excluir</Button>
                </div>
              ))}
              <div className="views-mgr__foot">
                <Button variant="primary" onClick={startNewView}>+ Nova view</Button>
              </div>
            </div>
          ) : (
            <div className="views-mgr views-editor">
              <label className="views-editor__name">
                <span className="ui-label">Nome da view</span>
                <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Ex.: Docas" autoFocus />
              </label>

              <div className="views-editor__col">
                <span className="ui-label">Câmeras na view (ordem dos tiles)</span>
                {draftIds.length === 0
                  ? <p className="empty-note">Adicione câmeras da lista abaixo.</p>
                  : draftIds.map((id, i) => (
                    <div key={`sel-${id}`} className="views-editor__item">
                      <span className="views-editor__pos">{i + 1}</span>
                      <span className="views-editor__lbl">{camLabel(id)}</span>
                      <IconButton label="Subir" onClick={() => moveDraftCam(id, -1)} disabled={i === 0}>↑</IconButton>
                      <IconButton label="Descer" onClick={() => moveDraftCam(id, 1)} disabled={i === draftIds.length - 1}>↓</IconButton>
                      <IconButton label="Remover da view" onClick={() => toggleDraftCam(id)}>✕</IconButton>
                    </div>
                  ))}
              </div>

              <div className="views-editor__col">
                <span className="ui-label">Câmeras disponíveis</span>
                {cameras.filter((c) => !draftIds.includes(c.id)).length === 0
                  ? <p className="empty-note">Todas as câmeras conectadas já estão na view.</p>
                  : cameras.filter((c) => !draftIds.includes(c.id)).map((c) => (
                    <div key={`av-${c.id}`} className="views-editor__item">
                      <span className="views-editor__lbl">{c.label}</span>
                      <Button size="sm" onClick={() => toggleDraftCam(c.id)} title="Adicionar à view">+ Adicionar</Button>
                    </div>
                  ))}
              </div>

              <div className="views-mgr__foot">
                <Button onClick={cancelEditView}>Cancelar</Button>
                <Button variant="primary" onClick={saveEditView}>Salvar view</Button>
              </div>
            </div>
          )}
        </Dialog>

        {/* Fila de alarmes acionável (Onda B · item 7) — drawer lateral, ts desc, ack/forward */}
        {alarmsOpen && (
          <aside className="alarm-drawer" aria-label="Fila de alarmes">
            <header className="alarm-drawer__head">
              <b>Fila de alarmes</b>
              <span className="alarm-drawer__count" data-zero={newCount === 0 ? 1 : 0}>{newCount} novo(s)</span>
              <div className="spacer" />
              <IconButton label="Fechar fila de alarmes" onClick={() => setAlarmsOpen(false)}>✕</IconButton>
            </header>
            <div className="alarm-drawer__filters">
              <Select value={fPriority} onChange={(v) => setFPriority(v as "all" | AlarmPriority)} ariaLabel="Filtrar por prioridade"
                options={[{ value: "all", label: "Toda prioridade" }, { value: "critical", label: "Crítico" }, { value: "high", label: "Alta" }, { value: "advisory", label: "Informativo" }]} />
              <Select value={fState} onChange={(v) => setFState(v as "all" | AlarmState)} ariaLabel="Filtrar por estado"
                options={[{ value: "all", label: "Todo estado" }, { value: "new", label: "Novos" }, { value: "acknowledged", label: "Reconhecidos" }, { value: "forwarded", label: "Encaminhados" }]} />
              <label><Checkbox checked={hideAcked} onCheckedChange={setHideAcked} ariaLabel="Ocultar reconhecidos" /> Limpar reconhecidos</label>
            </div>
            <div className="alarm-drawer__list">
              {visibleAlarms.length === 0
                ? <p className="alarm-drawer__empty">{alarms.length === 0 ? "Nenhum alarme registrado." : "Nenhum alarme para os filtros atuais."}</p>
                : visibleAlarms.map(renderAlarmCard)}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
