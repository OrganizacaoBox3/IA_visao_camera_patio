// Views salvas por setor + auto-surface (extraído do god-component DashboardPage — auditoria §S1).
// Onda C · item 11. Encapsula: carga/migração/persistência das views e as PREFERÊNCIAS locais do
// operador (view selecionada + auto-surface). Comportamento byte-a-byte do original.
//
// FONTE DAS VIEWS = BACKEND (compartilhada): a LISTA de views vive no hub (GET/PUT /api/views) — uma
// lista global vista por todos os operadores. O tipo `SavedView` é o canônico de api.ts.
//
// PREFERÊNCIAS LOCAIS (não compartilhadas): a view selecionada (`activeViewId`) e o toggle
// `autoSurface` ficam por operador, no localStorage (chave `vp-view-prefs::...`).
//
// MIGRAÇÃO (best-effort, única): instalações antigas guardavam a lista de views no localStorage
// (chave legada `vp-views::user::host`). Na 1ª carga, se o backend vier VAZIO e existirem views
// legadas, fazemos um upload único delas (saveViews). A chave legada é preservada como backup.
import { useEffect, useMemo, useRef, useState } from "react";
import { APP_CONFIG } from "../../config";
import { getViews, saveViews, ApiError, type SavedView } from "../../api";
import { type ToastTone } from "../../ui";

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

export type SavedViews = {
  views: SavedView[];
  setViews: React.Dispatch<React.SetStateAction<SavedView[]>>;
  viewsLoading: boolean;
  activeViewId: string | null;
  setActiveViewId: React.Dispatch<React.SetStateAction<string | null>>;
  activeView: SavedView | null;
  autoSurface: boolean;
  setAutoSurface: React.Dispatch<React.SetStateAction<boolean>>;
  viewsMgrOpen: boolean;
  setViewsMgrOpen: React.Dispatch<React.SetStateAction<boolean>>;
  surfaceTick: number;
};

export function useSavedViews(
  userId: string,
  toast: (msg: string, tone?: ToastTone) => void,
): SavedViews {
  // Lista de views = backend (compartilhada); activeViewId/autoSurface = prefs locais do operador.
  const initialPrefs = useMemo(() => loadViewPrefs(userId), [userId]);
  // Fonte da migração: views legadas capturadas EM MEMÓRIA no 1º render (antes de qualquer escrita
  // de prefs no localStorage), para não perdê-las caso a migração precise rodar depois.
  const legacyViews = useMemo(() => loadLegacyStore(userId).views, [userId]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(true);
  const migratedRef = useRef(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialPrefs.activeViewId);
  const [autoSurface, setAutoSurface] = useState<boolean>(() => initialPrefs.autoSurface);
  const [viewsMgrOpen, setViewsMgrOpen] = useState(false);
  // "Tick" para reordenar periodicamente no auto-surface (a recência decai com o tempo, mesmo sem
  // novos eventos socket). Só roda quando o modo está ligado.
  const [surfaceTick, setSurfaceTick] = useState(0);

  // Persiste só as PREFS locais (seleção + auto-surface) no localStorage (por usuário + host).
  // A LISTA de views é compartilhada e vive no backend (ver efeito de carga/migração abaixo).
  useEffect(() => {
    try {
      localStorage.setItem(viewPrefsKey(userId), JSON.stringify({ activeViewId, autoSurface }));
    } catch {
      /* no-op */
    }
  }, [userId, activeViewId, autoSurface]);

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

  return {
    views,
    setViews,
    viewsLoading,
    activeViewId,
    setActiveViewId,
    activeView,
    autoSurface,
    setAutoSurface,
    viewsMgrOpen,
    setViewsMgrOpen,
    surfaceTick,
  };
}
