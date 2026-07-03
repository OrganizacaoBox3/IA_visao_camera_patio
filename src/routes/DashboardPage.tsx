import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Video } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../config";
import { setInferencePriority } from "../vision/scheduler";
import { type FrameSource } from "../frame";
import { CameraWorkspace } from "../CameraWorkspace";
import { FadigaView } from "../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../report/store";
import { getCameraCfg, setCameraCfg, loadCamConfig, type CameraCfg } from "../cameraConfig";
import { loadZonesForCamera } from "../zones";
import { useAuth } from "../auth";
import { Button, Switch, Select, Dialog, Tooltip, Badge, useToast } from "../ui";
import {
  listAlarms,
  ackAlarm,
  forwardAlarm,
  getViews,
  saveViews,
  ApiError,
  type AlarmEvent,
  type AlarmPriority,
  type AlarmState,
  type SavedView,
} from "../api";
import { type Camera, type CameraStatus } from "./dashboard/types";
import { CameraTile } from "./dashboard/CameraTile";
import { AlarmDrawer } from "./dashboard/AlarmDrawer";
import { ViewsManager } from "./dashboard/ViewsManager";
import "./alarms.css";
import "./views.css";

// ImageBitmap decodificado fora da main thread; só guardamos o último frame (descarta atrasados).
// INVARIANTE (2.2): w/h refletem SEMPRE o tamanho do BITMAP decodificado (bmp.width/height) — que
// pode ser MENOR que o frame nativo quando o decode de tile aplica resize. Os consumidores
// (cropFor/motion no CameraWorkspace) usam zonas normalizadas 0..1 sobre f.w/f.h, então crops e
// leituras de luma permanecem consistentes com o bitmap entregue.
type FrameEntry = {
  bmp: ImageBitmap | null;
  w: number;
  h: number;
  srcW: number; // largura NATIVA informada no payload (0 = desconhecida; RTSP não envia w/h)
  ts: number;
  pending: ArrayBuffer | null;
  decoding: boolean;
};

// Largura do decode reduzido para feeds que estão SÓ em tile (a grade exibe ~400px).
const TILE_DECODE_WIDTH = 640;

function colsFor(n: number): number {
  return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4;
}

// ── Views salvas por setor (Onda C · item 11) ──────────────────────────────────────────────
// Uma "view" é um subconjunto ordenado de câmeras (ex.: "Docas", "Expedição"). A ordem dos ids
// define a ordem dos tiles. A view especial "Todas" (activeViewId=null) mostra tudo como hoje.
//
// FONTE DAS VIEWS = BACKEND (compartilhada): a LISTA de views agora vive no hub (GET/PUT
// /api/views, via getViews/saveViews de api.ts) — uma lista global vista por todos os operadores.
// O tipo `SavedView` é o canônico exportado de api.ts (sem cópia local).
//
// PREFERÊNCIAS LOCAIS (não compartilhadas): a view selecionada (`activeViewId`) e o toggle
// `autoSurface` continuam por operador, no localStorage (chave nova `vp-view-prefs::...`), pois
// são preferências do posto de trabalho, não estado compartilhado.
//
// MIGRAÇÃO (best-effort, única): instalações antigas guardavam a lista de views no localStorage
// (chave legada `vp-views::user::host`). Na 1ª carga, se o backend vier VAZIO e existirem views
// legadas, fazemos um upload único delas (saveViews) para não perder o trabalho do operador. A
// chave legada é preservada como backup (não a apagamos); como o backend passa a ter as views,
// recargas seguintes leem do backend e a migração não dispara de novo.
type LegacyViewsStore = { views: SavedView[]; activeViewId: string | null; autoSurface: boolean };
type ViewPrefs = { activeViewId: string | null; autoSurface: boolean };

// Chave LEGADA (combinava views + prefs) — só lida para migração/fallback de prefs.
function legacyViewsKey(userId: string): string {
  return `vp-views::${userId}::${APP_CONFIG.net.serverUrl}`;
}
// Chave NOVA: só preferências locais do operador (activeViewId + autoSurface).
function viewPrefsKey(userId: string): string {
  return `vp-view-prefs::${userId}::${APP_CONFIG.net.serverUrl}`;
}

// Lê a store legada (combinada). Usada como fonte da migração e como fallback de prefs.
function loadLegacyStore(userId: string): LegacyViewsStore {
  try {
    const raw = localStorage.getItem(legacyViewsKey(userId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<LegacyViewsStore>;
      const views = Array.isArray(p.views)
        ? p.views.filter(
            (v): v is SavedView =>
              !!v &&
              typeof v.id === "string" &&
              typeof v.name === "string" &&
              Array.isArray(v.cameraIds),
          )
        : [];
      const activeViewId = typeof p.activeViewId === "string" ? p.activeViewId : null;
      return { views, activeViewId, autoSurface: !!p.autoSurface };
    }
  } catch {
    /* no-op */
  }
  return { views: [], activeViewId: null, autoSurface: false };
}

// Carrega as PREFS locais: chave nova primeiro; se ausente, herda da chave legada (continuidade).
function loadViewPrefs(userId: string): ViewPrefs {
  try {
    const raw = localStorage.getItem(viewPrefsKey(userId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<ViewPrefs>;
      return {
        activeViewId: typeof p.activeViewId === "string" ? p.activeViewId : null,
        autoSurface: !!p.autoSurface,
      };
    }
  } catch {
    /* no-op */
  }
  const legacy = loadLegacyStore(userId);
  return { activeViewId: legacy.activeViewId, autoSurface: legacy.autoSurface };
}

// Janela de "atividade recente" para o auto-surface (ver activityScore abaixo).
const AUTOSURFACE_WINDOW_MS = 10 * 60_000;

export function DashboardPage() {
  const { token, user, logout } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const framesRef = useRef<Map<string, FrameEntry>>(new Map());
  const gettersRef = useRef<Map<string, () => FrameSource | null>>(new Map());
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

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CameraStatus>>({});
  // ── F1-C (ADR-009): fonte da ANÁLISE por câmera (anti-duplicação de ingest) ──
  // O hub anuncia via evento socket ADITIVO `analysis-status {cameraId, engine:"hub"|"local"}`
  // (snapshot no connect + mudanças) quais câmeras o MOTOR server-side está analisando. O mapa
  // desce como prop `analysisEngine` aos tiles/câmera aberta: com "hub", o CameraWorkspace
  // SUPRIME os ingests locais (recordSamples/recordFlow) — o servidor é a fonte dos indicadores.
  // Hub antigo sem o evento → mapa vazio → tudo "local" (comportamento idêntico ao atual).
  const [analysisEngines, setAnalysisEngines] = useState<Record<string, "hub" | "local">>({});
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [page, setPage] = useState(0);
  // Modo demo ("Limite curto 10s") OFF por padrão (produção). Liga via env VITE_DEMO_MODE=1 ou toggle;
  // a escolha do toggle é lembrada na sessão para não voltar a disparar alertas falsos a cada reload.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    try {
      const v = sessionStorage.getItem("vp-demo-mode");
      if (v != null) return v === "1";
    } catch {
      /* no-op */
    }
    return APP_CONFIG.demo.shortLimitDefault;
  });
  const [connected, setConnected] = useState(false);
  // ── Fila de alarmes acionável (Onda B · item 7) — consome o backend B1 (só metadados, LGPD) ──
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const [alarmsOpen, setAlarmsOpen] = useState(false);
  const { toast } = useToast();

  // ── Views salvas por setor + auto-surface (Onda C · item 11) ──
  // Lista de views = backend (compartilhada); activeViewId/autoSurface = prefs locais do operador.
  const initialPrefs = useMemo(() => loadViewPrefs(user.id), [user.id]);
  // Fonte da migração: views legadas capturadas EM MEMÓRIA no 1º render (antes de qualquer escrita
  // de prefs no localStorage), para não perdê-las caso a migração precise rodar depois.
  const legacyViews = useMemo(() => loadLegacyStore(user.id).views, [user.id]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(true);
  const migratedRef = useRef(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialPrefs.activeViewId);
  const [autoSurface, setAutoSurface] = useState<boolean>(() => initialPrefs.autoSurface);
  const [viewsMgrOpen, setViewsMgrOpen] = useState(false);
  // ── Sincronização ao vivo (ADR-006) — revisão de tripwires por câmera ──
  // Cada `camcfg-updated{kind:"tripwires",cameraId}` incrementa o contador daquela câmera; o número
  // é repassado às tiles via prop `tripwiresRev` (CameraWorkspace re-busca os tripwires quando muda).
  const [revByCamera, setRevByCamera] = useState<Map<string, number>>(new Map());
  // "Tick" para reordenar periodicamente no auto-surface (a recência decai com o tempo, mesmo sem
  // novos eventos socket). Só roda quando o modo está ligado.
  const [surfaceTick, setSurfaceTick] = useState(0);

  // Decodifica o frame mais recente em ImageBitmap (assíncrono, fora da main thread); mantém só o último.
  // Estável (useCallback []): só toca `framesRef`/`activeIdsRef` (refs estáveis); a recursão usa o nome
  // da própria função (não a const externa). Identidade fixa → entra nas deps dos efeitos sem religá-los.
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

  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socketRef.current = socket;
    // Cópia local do Map de frames (estável) p/ usar no cleanup sem ler `framesRef.current` lá
    // (evita o aviso de ref que "pode ter mudado"); é o mesmo Map, então fecha todos os bitmaps.
    const frames = framesRef.current;
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
    socket.on("frame", (p: { id: string; buf: ArrayBuffer; w?: number; h?: number }) => {
      let f = framesRef.current.get(p.id);
      if (!f) {
        f = { bmp: null, w: 0, h: 0, srcW: 0, ts: 0, pending: null, decoding: false };
        framesRef.current.set(p.id, f);
      }
      f.pending = p.buf;
      // Largura NATIVA do payload (webcam envia w/h; RTSP não) — usada só p/ evitar UPSCALE no
      // resize de tile (2.2). f.w/f.h continuam sendo as dimensões do bitmap decodificado.
      if (typeof p.w === "number" && p.w > 0) f.srcW = p.w;
      f.ts = Date.now();
      // Só decodifica feeds ATIVOS: feeds fora da página atual não pagam createImageBitmap (CPU/memória).
      if (activeIdsRef.current.has(p.id)) drainDecode(p.id);
    });
    // Sincronização ao vivo de config compartilhada (ADR-006). Evento aditivo na sala `dashboards`:
    //   • kind:"views" → recarrega a LISTA de views do backend (last-write-wins). A seleção local
    //     (activeViewId) é preservada; se a view selecionada sumiu, o efeito de validação cai p/ "Todas".
    //     Idempotente: como o próprio salvar já atualiza o estado, recarregar não dispara toasts (silencioso
    //     em sucesso; só loga em falha p/ não quebrar a central nem repetir avisos).
    //   • kind:"tripwires" → incrementa a revisão daquela câmera; a prop `tripwiresRev` faz a tile re-buscar.
    socket.on(
      "camcfg-updated",
      (
        p:
          | { kind: "views" }
          | { kind: "tripwires" | "zones" | "camconfig"; cameraId: string },
      ) => {
        if (p?.kind === "views") {
          getViews()
            .then((remote) => setViews(remote))
            .catch((e) => {
              console.error("[views] recarga ao vivo falhou", e);
            });
        } else if (p?.kind === "tripwires" && typeof p.cameraId === "string") {
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
      frames.forEach((f) => f.bmp?.close());
    };
  }, [token, logout, drainDecode, loadReadingFlag]);

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
  }, [cameras]);

  // 2.2 — quando a lista de câmeras chega/muda, carrega 1× por câmera o flag "tem zona de
  // leitura?" (async; até resolver, o decode de tile fica NATIVO — ver drainDecode).
  useEffect(() => {
    for (const c of cameras) loadReadingFlag(c.id, c.label);
  }, [cameras, loadReadingFlag]);

  // garante uma config carregada por câmera (default = atividade → retrocompatível)
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of cameras)
        if (!next[c.id]) {
          next[c.id] = getCameraCfg(c.id);
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [cameras]);

  // Persiste só as PREFS locais (seleção + auto-surface) no localStorage (por usuário + host).
  // A LISTA de views é compartilhada e vive no backend (ver efeito de carga/migração abaixo).
  useEffect(() => {
    try {
      localStorage.setItem(viewPrefsKey(user.id), JSON.stringify({ activeViewId, autoSurface }));
    } catch {
      /* no-op */
    }
  }, [user.id, activeViewId, autoSurface]);

  // Carga inicial das views compartilhadas + migração única do localStorage legado.
  // • Sucesso com lista → usa o backend como fonte.
  // • Sucesso VAZIO + views legadas → upload único (saveViews) e adota o resultado salvo.
  // • Falha → degrada para lista vazia + toast (a central segue funcionando: "Todas as câmeras").
  useEffect(() => {
    let alive = true;
    setViewsLoading(true);
    getViews()
      .then(async (remote) => {
        if (!alive) return;
        if (remote.length === 0 && legacyViews.length > 0 && !migratedRef.current) {
          migratedRef.current = true; // garante upload único
          try {
            const saved = await saveViews(legacyViews);
            if (alive) {
              setViews(saved);
              toast("Views locais migradas para o servidor (compartilhadas).", "ok");
            }
          } catch (e) {
            console.error("[views] migração falhou", e);
            if (alive)
              toast(
                e instanceof ApiError ? e.message : "Não foi possível migrar as views locais.",
                "alert",
              );
          }
        } else {
          setViews(remote);
        }
      })
      .catch((e) => {
        console.error("[views] carga falhou", e);
        if (!alive) return;
        setViews([]); // degrada sem quebrar a central
        toast(
          e instanceof ApiError ? e.message : "Não foi possível carregar as views compartilhadas.",
          "alert",
        );
      })
      .finally(() => {
        if (alive) setViewsLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // activeViewId inválido (view excluída por outro operador, migração falha, etc.) → "Todas".
  useEffect(() => {
    if (viewsLoading) return; // espera a lista chegar para não derrubar uma seleção válida
    if (activeViewId != null && !views.some((v) => v.id === activeViewId)) setActiveViewId(null);
  }, [viewsLoading, views, activeViewId]);

  // No auto-surface, reavalia a ordem a cada 15s para que a recência (decaimento) atualize o ranking
  // mesmo sem novos eventos chegando pelo socket.
  useEffect(() => {
    if (!autoSurface) return;
    const t = setInterval(() => setSurfaceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [autoSurface]);

  // View ativa (null = "Todas"). Se o id apontar para uma view inexistente, comporta-se como "Todas".
  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) ?? null,
    [views, activeViewId],
  );

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
    // Pré-computa o score 1× por câmera (O(N·alarmes)) em vez de recalcular a cada comparação
    // do sort (O(N·log N·alarmes)).
    const scores = new Map(viewCameras.map((c) => [c.id, activityScore(c.id)]));
    return [...viewCameras].sort(
      (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewCameras, autoSurface, statuses, alarms, surfaceTick]);

  // Ao trocar de view ou ligar/desligar auto-surface, volta para a 1ª página (evita ficar "preso").
  useEffect(() => {
    setPage(0);
  }, [activeViewId, autoSurface]);

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
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Conjunto ativo = feeds visíveis (página) + câmera aberta. Decodifica os recém-ativos e libera
  // o ImageBitmap dos que saíram (memória); feeds inativos param de ser decodificados (ver `frame`).
  useEffect(() => {
    const active = new Set<string>(pageCameras.map((c) => c.id));
    if (openId) active.add(openId);
    openIdRef.current = openId; // ref lida pelo drainDecode (aberta = decode nativo, sem resize)
    const prev = activeIdsRef.current;
    activeIdsRef.current = active;
    // 2.1 — assinatura por câmera (contrato ADITIVO): anuncia ao hub o conjunto COMPLETO que este
    // dashboard quer receber; o hub passa a filtrar o evento `frame` por room (`cam:<id>`).
    // O (re)connect reanuncia no handler "connect" (reconexão perde as rooms no servidor).
    socketRef.current?.emit("watch", { ids: [...active] });
    prev.forEach((id) => {
      if (!active.has(id)) {
        const f = framesRef.current.get(id);
        if (f?.bmp) {
          f.bmp.close();
          f.bmp = null;
          f.w = 0;
          f.h = 0;
        }
      }
    });
    active.forEach((id) => {
      const f = framesRef.current.get(id);
      if (f?.pending && !f.decoding) drainDecode(id);
    });
  }, [pageCameras, openId, drainDecode]);

  // Eleva a prioridade da câmera ABERTA na fila do scheduler de inferência (A1). As tiles pedem
  // "low" e a câmera aberta (full) já pede "high"; aqui reforçamos a key na transição de abertura.
  useEffect(() => {
    if (openId) setInferencePriority(`${openId}:atividade`, "high");
  }, [openId]);

  // Lembra a escolha do toggle demo na sessão (evita reativar alertas falsos a cada reload).
  useEffect(() => {
    try {
      sessionStorage.setItem("vp-demo-mode", demoMode ? "1" : "0");
    } catch {
      /* no-op */
    }
  }, [demoMode]);

  // Carga inicial da fila de alarmes (ts desc); ao vivo entra pelos sockets acima. Falha não quebra a central.
  useEffect(() => {
    let alive = true;
    listAlarms({ limit: 200 })
      .then((list) => {
        if (alive) setAlarms(list);
      })
      .catch((e) => {
        console.error("[alarms] carga inicial falhou", e);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Contador de "novos" (estado new) — realce glanceable no cabeçalho. Prioridade máx. entre os novos.
  const newAlarms = useMemo(() => alarms.filter((a) => a.state === "new"), [alarms]);
  const newCount = newAlarms.length;
  const topNewPriority: AlarmPriority = useMemo(
    () =>
      newAlarms.some((a) => a.priority === "critical")
        ? "critical"
        : newAlarms.some((a) => a.priority === "high")
          ? "high"
          : "advisory",
    [newAlarms],
  );

  // Ack/forward otimista: reflete o estado já; confirma com a resposta (e o socket `alarm-update` reforça).
  async function actOnAlarm(a: AlarmEvent, kind: "ack" | "forward") {
    if (a.state !== "new") return; // já tratado
    const prevState = a.state;
    const optimistic: AlarmState = kind === "ack" ? "acknowledged" : "forwarded";
    setAlarms((prev) =>
      prev.map((x) =>
        x.id === a.id ? { ...x, state: optimistic, ackBy: user.usuario, ackAt: Date.now() } : x,
      ),
    );
    try {
      const updated = await (kind === "ack"
        ? ackAlarm(a.id, user.usuario)
        : forwardAlarm(a.id, user.usuario));
      setAlarms((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
      toast(kind === "ack" ? "Alarme reconhecido." : "Alarme encaminhado.", "ok");
    } catch (e) {
      setAlarms((prev) =>
        prev.map((x) =>
          x.id === a.id ? { ...x, state: prevState, ackBy: undefined, ackAt: undefined } : x,
        ),
      ); // rollback
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar o alarme.", "alert");
    }
  }

  function getterFor(id: string): () => FrameSource | null {
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
  }

  function cfgOf(id: string): CameraCfg {
    return cfgs[id] ?? getCameraCfg(id);
  }
  function isFadiga(id: string): boolean {
    return cfgOf(id).modo === "fadiga";
  }
  function setKind(id: string, fadiga: boolean) {
    setCfgs((prev) => {
      const merged: CameraCfg = { ...cfgOf(id), modo: fadiga ? "fadiga" : "atividade" };
      setCameraCfg(id, merged);
      return { ...prev, [id]: merged };
    });
  }

  // Seleção da view ativa (preferência local do operador). "__all__" = "Todas as câmeras".
  function pickView(v: string) {
    setActiveViewId(v === "__all__" ? null : v);
  }

  const open = openId ? (cameras.find((c) => c.id === openId) ?? null) : null;

  // Alerta do painel: mostra o toast E repassa ao hub (andon → webhook externo, se configurado).
  // useCallback (1.6): identidade estável p/ não quebrar o memo do CameraTile (`toast` é estável
  // — useCallback([]) no ToastProvider; o socket vai via ref).
  const handleAlert = useCallback(
    (msg: string) => {
      toast(msg, msg.includes("⚠") ? "alert" : "default");
      socketRef.current?.emit("alert", { text: msg, ts: Date.now() });
    },
    [toast],
  );

  // Abertura de câmera (1.6): callback único e estável; o tile chama com o próprio id.
  const handleOpen = useCallback((id: string) => setOpenId(id), []);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Central de câmeras</h1>
        <div className="spacer" />
        {/* Views salvas por setor (Onda C · item 11): troca rápida do conjunto/ordem de câmeras. */}
        <span className="switch view-picker" aria-label="View por setor">
          <Select
            value={activeView ? activeView.id : "__all__"}
            onChange={pickView}
            ariaLabel="View por setor"
            options={[
              { value: "__all__", label: "Todas as câmeras" },
              ...views.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </span>
        <Tooltip content="Criar, renomear ou excluir views por setor">
          <Button onClick={() => setViewsMgrOpen(true)}>▤ Views</Button>
        </Tooltip>
        <Tooltip content="Prioriza as câmeras com mais atividade recente (alarmes + fps) na 1ª página.">
          <span className="switch">
            <Switch
              checked={autoSurface}
              onCheckedChange={setAutoSurface}
              ariaLabel="Auto-destaque das câmeras ativas"
            />{" "}
            Auto-destaque
          </span>
        </Tooltip>
        <Tooltip content="Encurta o limite p/ demonstrar ao vivo. Tempo exibido é real.">
          <span className="switch">
            <Switch
              checked={demoMode}
              onCheckedChange={setDemoMode}
              ariaLabel="Limite curto (10s)"
            />{" "}
            Limite curto (10s)
          </span>
        </Tooltip>
        <Tooltip content="Definir o tipo de cada câmera (área × operador)">
          <Button onClick={() => setShowConfig(true)}>⚙ Câmeras</Button>
        </Tooltip>
        {/* Ação ÚNICA de câmeras (substitui "+ Nó de câmera" e "+ Câmera IP"): leva à tela
            /cameras, que adiciona/gerencia tanto câmera IP (só superadmin lá dentro, como o
            botão antigo) quanto o nó local (webcam) — visível a todos, como o botão antigo. */}
        <Tooltip content="Adicionar/gerenciar câmeras (IP/RTSP ou webcam/nó local)">
          <Button asChild variant="primary">
            <Link to="/cameras">
              <Video size={16} strokeWidth={1.75} aria-hidden /> + Câmera
            </Link>
          </Button>
        </Tooltip>
        {/* Paginação: réplica do .switch em utilities (gap 4px, como o inline anterior): utility
            em layer não vence o gap:6px do .switch (index.css não-layered) — por isso sem a classe. */}
        {pageCount > 1 && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-text-dim"
            aria-label="Paginação de feeds"
          >
            <Tooltip content="Página anterior">
              <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page <= 0}>
                ‹
              </Button>
            </Tooltip>
            <span className="muted">
              {page + 1}/{pageCount}
            </span>
            <Tooltip content="Próxima página">
              <Button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
              >
                ›
              </Button>
            </Tooltip>
          </span>
        )}
        <Tooltip content="Fila de alarmes (eventos acionáveis)">
          <Button onClick={() => setAlarmsOpen((o) => !o)} active={alarmsOpen}>
            ▦ Alarmes
            {newCount > 0 && (
              <span
                className="alarm-badge"
                data-prio={topNewPriority}
                aria-label={`${newCount} novos`}
              >
                {newCount}
              </span>
            )}
          </Button>
        </Tooltip>
        {/* Going-gray: os chips informativos "hub ok · câmeras N · online N" foram removidos
            (ruído — a grade já mostra as câmeras e o estado de cada uma). Só o caso ANORMAL
            permanece: hub desconectado é informação crítica e ganha cor saturada. */}
        {!connected && (
          <span aria-live="polite">
            <Badge tone="alert">hub desconectado</Badge>
          </span>
        )}
      </header>

      <div className="dash-body">
        {cameras.length === 0 ? (
          <div className="dash-empty">
            <p>
              <b>Nenhuma câmera conectada.</b>
            </p>
            <p>
              Adicione uma câmera IP/RTSP ou abra um nó de câmera (webcam) pela tela de câmeras.
            </p>
            <Button asChild variant="primary">
              <Link to="/cameras">Adicionar câmera</Link>
            </Button>
            <p className="muted mt-3">
              Hub: <code>{APP_CONFIG.net.serverUrl}</code> ·{" "}
              {connected ? "conectado" : "desconectado"}
            </p>
          </div>
        ) : orderedCameras.length === 0 ? (
          <div className="dash-empty">
            <p>
              <b>Esta view não tem câmeras conectadas.</b>
            </p>
            <p className="muted">
              Edite a view em <b>▤ Views</b> ou selecione <b>Todas as câmeras</b>.
            </p>
            <Button onClick={() => setActiveViewId(null)}>Ver todas as câmeras</Button>
          </div>
        ) : (
          <div className="dash-grid" data-cols={colsFor(pageCameras.length)}>
            {pageCameras.map((c) => (
              <CameraTile
                key={`wrap-${c.id}`}
                camera={c}
                isOpen={c.id === openId}
                isFadiga={isFadiga(c.id)}
                getFrame={getterFor(c.id)}
                demoMode={demoMode}
                tripwiresRev={revByCamera.get(c.id) ?? 0}
                status={statuses[c.id]}
                analysisEngine={analysisEngines[c.id] ?? "local"}
                onOpen={handleOpen}
                onAlert={handleAlert}
              />
            ))}
          </div>
        )}

        {/* Overlay: câmera aberta */}
        {open && (
          <div className="cam-overlay">
            {isFadiga(open.id) ? (
              <FadigaView
                key={`full-${open.id}`}
                cameraId={open.id}
                label={open.label}
                getFrame={getterFor(open.id)}
                mode="full"
                onClose={() => setOpenId(null)}
                onAlert={handleAlert}
                onSample={recordFadigaSamples}
                onEvent={recordFadigaEvent}
              />
            ) : (
              <CameraWorkspace
                key={`full-${open.id}`}
                cameraId={open.id}
                label={open.label}
                getFrame={getterFor(open.id)}
                mode="full"
                demoMode={demoMode}
                tripwiresRev={revByCamera.get(open.id) ?? 0}
                analysisEngine={analysisEngines[open.id] ?? "local"}
                onClose={() => setOpenId(null)}
                onAlert={handleAlert}
              />
            )}
          </div>
        )}

        {/* Modal: tipo de cada câmera */}
        <Dialog
          open={showConfig}
          onOpenChange={setShowConfig}
          title="Configuração de câmeras"
          description={
            <>
              <b>Câmera de área</b> (padrão): vista geral do setor — abra a câmera e desenhe zonas,
              cada uma com seu modo (Atividade / Leitura / Objetos / Fadiga).{" "}
              <b>Operador (fadiga)</b>: câmera dedicada apontada ao rosto de 1 operador — só
              monitora fadiga, sem zonas.
            </>
          }
        >
          {cameras.length === 0 && <p className="empty-note">Nenhuma câmera conectada.</p>}
          {cameras.map((c) => (
            <div key={`cfg-${c.id}`} className="cfg-row">
              <div className="cfg-name">
                <b>{c.label}</b>
                <span className="muted">{c.id}</span>
              </div>
              <Select
                value={isFadiga(c.id) ? "fadiga" : "area"}
                onChange={(v) => setKind(c.id, v === "fadiga")}
                ariaLabel="Tipo da câmera"
                options={[
                  { value: "area", label: "Câmera de área (zonas)" },
                  { value: "fadiga", label: "Operador (fadiga)" },
                ]}
              />
            </div>
          ))}
        </Dialog>

        {/* Gerenciador de views por setor (Onda C · item 11) — criar/renomear/excluir + ordenar */}
        <ViewsManager
          open={viewsMgrOpen}
          onOpenChange={setViewsMgrOpen}
          views={views}
          setViews={setViews}
          setActiveViewId={setActiveViewId}
          cameras={cameras}
          viewsLoading={viewsLoading}
        />

        {/* Fila de alarmes acionável (Onda B · item 7) */}
        <AlarmDrawer
          open={alarmsOpen}
          onOpenChange={setAlarmsOpen}
          alarms={alarms}
          newCount={newCount}
          onAct={actOnAlarm}
        />
      </div>
    </div>
  );
}
