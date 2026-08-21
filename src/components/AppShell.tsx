import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BarChart3,
  CalendarClock,
  Cctv,
  ChevronDown,
  CircleUser,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth";
import type { Papel } from "../auth";
import { listCameras, getConnectedCameras, type Camera, type ConnectedCamera } from "../api";
import { DropdownMenu, Tooltip, type DropdownItem } from "../ui";
import "./appshell.css";

// Iconografia única do shell (Lucide): 1 tamanho, 1 strokeWidth — consistência
// visual e stroke em currentColor (obedece o going-gray: cor vem do estado do item).
const NAV_ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true } as const;
const MENU_ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

// Shell persistente da SPA: sidebar colapsável (expandida 240px ↔ rail 60px) + conteúdo (Outlet).
// O nó de câmera (/camera) fica FORA do shell (é a visão do dispositivo, sem navegação).
// A11y: skip-link, <nav> rotulado, foco no conteúdo ao trocar de rota, aria-label em todo link
// (nome acessível estável mesmo com o rótulo visualmente oculto no modo colapsado — o e2e
// depende de getByRole('link', { name })).

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return match;
}

// Persistência do colapso (padrão shadcn/ui sidebar: estado por usuário, atalho Ctrl+B).
// Default EXPANDIDA (chave ausente) — o e2e roda no default. localStorage pode falhar
// (Safari privado etc.): try/catch e segue sem persistir.
const COLLAPSE_KEY = "shell.nav.collapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    /* sem persistência — estado só em memória */
  }
}

const PAPEL_LABEL: Record<Papel, string> = {
  superadmin: "Administrador",
  engenheiro: "Engenheiro",
  usuario: "Operador",
};

// `short`: rótulo compacto para o bottom-nav (≤640px) — o aria-label continua sendo `label`
// (nome acessível estável p/ e2e/leitores; WCAG 2.5.3: o texto visível está contido no nome).
// `mobileHide`: item some do bottom-nav quando já tem outro lar no mobile (dedup, não perda).
type NavItem = {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  short?: string;
  mobileHide?: boolean;
};
type NavGroup = { id: string; title: string; items: NavItem[] };
// Resultado da busca: item de menu ou câmera. Câmera navega p/ a Central
// ("/monitoramento") — não há deep-link de câmera aberta hoje; quando houver, troque o `to` aqui.
type SearchHit = { id: string; label: string; hint: string; icon: LucideIcon; to: string };

// Busca acento-insensível (relatório/relatorio, câmera/camera).
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export function AppShell() {
  const { user, canConfigure, logout } = useAuth();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // md (641–900px): index.css fixa o rail em 52px só-ícones (comportamento pré-existente).
  // desktop (>900px): entra o colapso manual expandida ↔ rail.
  const compact = useMediaQuery("(min-width: 641px) and (max-width: 900px)");
  const desktop = useMediaQuery("(min-width: 901px)");
  // sm (≤640px): rail vira bottom-nav — itens com rótulo curto e dedup (ver `groups`).
  const mobile = useMediaQuery("(max-width: 640px)");
  useEffect(() => {
    mainRef.current?.focus();
  }, [pathname]);

  // ── Colapso (desktop): persistido; Ctrl+B alterna (padrão VSCode/shadcn) ──
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleNav = useCallback(() => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  }, []);
  // Só-ícones = md automático OU colapso manual no desktop → Tooltip revela o rótulo.
  const iconOnly = compact || (desktop && collapsed);

  // ── Busca (menu + câmeras) ────────────────────────────────────────────────
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Câmeras na busca — DUAS fontes, deduplicadas por id:
  //   • CONECTADAS (GET /api/cameras/connected, QUALQUER autenticado): as mesmas câmeras da
  //     grade da Central, inclusive nós locais/webcam — sem url, só id/label/online.
  //   • CADASTRADAS (GET /api/cameras, superadmin-only): registro IP/RTSP, inclui as offline
  //     que ainda nem conectaram.
  // Carga lazy no primeiro foco; falha transitória libera nova tentativa no próximo foco.
  const isSuper = user.papel === "superadmin";
  const [cams, setCams] = useState<Camera[]>([]);
  const [liveCams, setLiveCams] = useState<ConnectedCamera[]>([]);
  const camsRequested = useRef(false);
  const liveRequested = useRef(false);
  const loadCams = useCallback(() => {
    if (!liveRequested.current) {
      liveRequested.current = true;
      getConnectedCameras()
        .then((r) => setLiveCams(r.cameras))
        .catch(() => {
          liveRequested.current = false; // permite retry num próximo foco
          setLiveCams([]);
        });
    }
    if (!isSuper || camsRequested.current) return;
    camsRequested.current = true;
    listCameras()
      .then(setCams)
      .catch(() => {
        camsRequested.current = false; // permite retry num próximo foco
        setCams([]);
      });
  }, [isSuper]);

  // Colapsada, o campo vira botão-ícone: clicar (ou Ctrl+K) EXPANDE a sidebar e foca a
  // busca (o mais simples dos dois padrões shadcn; sem estado "temporário" para desfazer).
  const [pendingFocus, setPendingFocus] = useState(false);
  useEffect(() => {
    if (pendingFocus && !collapsed) {
      searchRef.current?.focus();
      setPendingFocus(false);
    }
  }, [pendingFocus, collapsed]);
  const openSearch = useCallback(() => {
    setPendingFocus(true);
    setCollapsed((c) => {
      if (c) writeCollapsed(false);
      return false;
    });
  }, []);

  // Atalhos globais (só desktop; no mobile a busca/colapso não existem):
  // Ctrl/Cmd+B alterna o menu; Ctrl/Cmd+K e "/" focam a busca. "/" não rouba
  // digitação: ignorado quando o foco já está em input/textarea/select/editable.
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      const k = e.key.toLowerCase();
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (mod && k === "b") {
        e.preventDefault();
        toggleNav();
      } else if (mod && k === "k") {
        e.preventDefault();
        openSearch();
      } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, toggleNav, openSearch]);

  // NavLink aplica aria-current="page" automaticamente no item ativo; a classe .on
  // dispara o realce discreto (going-gray) definido em appshell.css.
  const itemCls = ({ isActive }: { isActive: boolean }) => `rail-item ${isActive ? "on" : ""}`;

  // Grupos com micro-headers (padrão Grafana/Datadog: zonear por frequência de uso).
  // RBAC preservado: Saúde alarmes só canConfigure; Usuários só superadmin. Grupo vazio
  // (ex.: Administração p/ operador) não renderiza nem o header.
  // Mobile (≤640px): "Meu perfil" sai do bottom-nav — é DUPLICADO do item "Meu perfil" do
  // menu de conta (avatar), então o dedup corta 1 slot sem perder navegação. Com rótulos
  // curtos ("Saúde"), os até 6 itens restantes cabem em 390px sem truncar.
  const allGroups: NavGroup[] = [
    {
      id: "op",
      title: "Operação",
      items: [
        // HOME: a Central (câmeras ao vivo) — "/" redireciona p/ /monitoramento (url canônica).
        // Terminologia CANÔNICA única — nav, título do dashboard e o 404 dizem "Central".
        // Rótulo curto já cabe no bottom-nav, então dispensa `short`. (Os itens BLE — Mapa/BLE/
        // Planta — migraram para o repo mvp_trilateracao_BLE; ADR-018.)
        { to: "/monitoramento", icon: LayoutDashboard, label: "Central" },
        // Câmeras (add/gestão): visível a TODOS, como o antigo "+ Nó de câmera" do header —
        // dentro da tela, o CRUD de câmera IP continua restrito ao superadmin (RBAC preservado).
        { to: "/cameras", icon: Video, label: "Câmeras" },
        // Relatório: o histórico E a saúde do alarme (a faixa do topo, que precede a leitura — se o
        // alarme está inundando, todo número abaixo é suspeito). Absorveu a /alarmes-saude (§2).
        { to: "/relatorio", icon: BarChart3, label: "Relatório" },
        // CALIBRAÇÃO não está aqui: virou MODO do palco da câmera (§1). A página existia só para
        // reconstruir o contexto que a câmera já tem — e servia um JPEG parado, enquanto o palco
        // tem o vídeo real. Um item de menu que dizia "não" ao operador (a tela o recusava).
      ],
    },
    {
      id: "adm",
      title: "Administração",
      items: [
        // Turnos de trabalho (spec-turnos-por-zona F1): cadastro global, mesmo RBAC de
        // configuração (canConfigure) — a leitura pelo relatório/overlay não passa por aqui.
        ...(canConfigure ? [{ to: "/turnos", icon: CalendarClock, label: "Turnos" }] : []),
        ...(user.papel === "superadmin"
          ? [{ to: "/usuarios", icon: Users, label: "Usuários" }]
          : []),
        // DVRs (Ponte DVR): acesso remoto de suporte aos DVRs por cliente. Só superadmin (suporte),
        // mesmo RBAC do painel de Usuários.
        ...(user.papel === "superadmin"
          ? [{ to: "/dvrs", icon: Cctv, label: "DVRs" }]
          : []),
      ],
    },
    {
      id: "conta",
      title: "Conta",
      items: [{ to: "/perfil", icon: CircleUser, label: "Meu perfil", mobileHide: true }],
    },
  ];
  const groups: NavGroup[] = allGroups
    .map((g) => (mobile ? { ...g, items: g.items.filter((i) => !i.mobileHide) } : g))
    .filter((g) => g.items.length > 0);

  // União das câmeras buscáveis: conectadas (todos os papéis) primeiro, depois as cadastradas
  // (superadmin) que ainda não conectaram — dedup por id (a câmera IP online está nas duas fontes).
  const seenCam = new Set<string>();
  const searchCams: { id: string; label: string }[] = [];
  for (const c of [...liveCams, ...cams]) {
    if (seenCam.has(c.id)) continue;
    seenCam.add(c.id);
    searchCams.push({ id: c.id, label: c.label || c.id });
  }

  // Resultados: itens do menu (sempre) + câmeras (quando carregadas), acento-insensível.
  const q = norm(query.trim());
  const hits: SearchHit[] = !q
    ? []
    : [
        ...groups
          .flatMap((g) => g.items)
          .filter((i) => norm(i.label).includes(q))
          .map((i) => ({
            id: `nav:${i.to}`,
            label: i.label,
            hint: "Menu",
            icon: i.icon,
            to: i.to,
          })),
        ...searchCams
          .filter((c) => norm(c.label).includes(q))
          .slice(0, 6)
          .map((c) => ({
            id: `cam:${c.id}`,
            label: c.label,
            hint: "Câmera",
            icon: Cctv,
            to: "/monitoramento",
          })),
      ];
  const sel = Math.min(activeIdx, Math.max(hits.length - 1, 0));

  const go = (h: SearchHit) => {
    setQuery("");
    setListOpen(false);
    navigate(h.to);
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (hits[sel]) {
        e.preventDefault();
        go(hits[sel]);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (listOpen || query) {
        setListOpen(false);
        setQuery("");
      } else {
        searchRef.current?.blur();
      }
    }
  };

  // Menu de usuário (Radix DropdownMenu): agrupa as ações de conta ("Meu perfil" + "Sair")
  // sob o nome/ícone do usuário no rodapé — Radix cuida de portal, teclado, foco e ARIA.
  const userMenu: DropdownItem[] = [
    { type: "label", label: `${user.usuario} · ${PAPEL_LABEL[user.papel]}` },
    {
      label: "Meu perfil",
      icon: (
        <span className="rail-user-mic" aria-hidden>
          <CircleUser {...MENU_ICON} />
        </span>
      ),
      onSelect: () => navigate("/perfil"),
    },
    { type: "separator" },
    {
      label: "Sair",
      danger: true,
      icon: (
        <span className="rail-user-mic" aria-hidden>
          <LogOut {...MENU_ICON} />
        </span>
      ),
      onSelect: () => logout(),
    },
  ];

  const searchOpen = listOpen && !!q;

  return (
    <div className={`shell shell--nav ${desktop && collapsed ? "nav-min" : ""}`}>
      <a href="#main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <nav className="rail rail--app" aria-label="Navegação principal">
        {/* ── Header: brand + toggle de colapso (PanelLeft, padrão shadcn/VSCode) ── */}
        <div className="rail-head">
          {iconOnly ? (
            <Tooltip content="Visão de Pátio">
              <div className="rail-brand">
                <Cctv size={20} strokeWidth={1.75} aria-hidden />
                <span className="rail-brand-lb">Visão de Pátio</span>
              </div>
            </Tooltip>
          ) : (
            <div className="rail-brand">
              <Cctv size={20} strokeWidth={1.75} aria-hidden />
              <span className="rail-brand-lb">Visão de Pátio</span>
            </div>
          )}
          {desktop && (
            <Tooltip content={collapsed ? "Expandir menu (Ctrl+B)" : "Recolher menu (Ctrl+B)"}>
              <button
                type="button"
                className="rail-toggle"
                aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
                aria-expanded={!collapsed}
                aria-keyshortcuts="Control+B"
                onClick={toggleNav}
              >
                {collapsed ? <PanelLeftOpen {...NAV_ICON} /> : <PanelLeftClose {...NAV_ICON} />}
              </button>
            </Tooltip>
          )}
        </div>

        {/* ── Busca: menu + câmeras (Ctrl+K ou "/"); colapsada vira botão-ícone ── */}
        {desktop &&
          (collapsed ? (
            <Tooltip content="Buscar (Ctrl+K)">
              <button
                type="button"
                className="rail-item rail-search-btn"
                aria-label="Buscar — expande o menu"
                onClick={openSearch}
              >
                <span className="ri-ic" aria-hidden>
                  <Search {...NAV_ICON} />
                </span>
              </button>
            </Tooltip>
          ) : (
            <div className="rail-search">
              <span className="rs-ic" aria-hidden>
                <Search size={15} strokeWidth={1.75} />
              </span>
              <input
                ref={searchRef}
                className="rail-search-in"
                type="text"
                role="combobox"
                aria-label="Buscar no menu e câmeras"
                aria-expanded={searchOpen}
                aria-controls={searchOpen ? "rail-search-list" : undefined}
                aria-activedescendant={searchOpen && hits[sel] ? `rs-opt-${sel}` : undefined}
                aria-autocomplete="list"
                placeholder="Buscar… (Ctrl+K)"
                value={query}
                onFocus={() => {
                  loadCams();
                  if (query.trim()) setListOpen(true);
                }}
                onBlur={() => setListOpen(false)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setListOpen(e.target.value.trim().length > 0);
                  setActiveIdx(0);
                }}
                onKeyDown={onSearchKey}
              />
              {searchOpen && (
                // mousedown preventDefault: não rouba o foco do input (o clique ainda navega).
                <div className="rail-search-pop" onMouseDown={(e) => e.preventDefault()}>
                  <ul id="rail-search-list" role="listbox" aria-label="Resultados da busca">
                    {hits.length === 0 && (
                      <li className="rail-search-empty" role="presentation">
                        Nada encontrado
                      </li>
                    )}
                    {hits.map((h, i) => {
                      const Ic = h.icon;
                      return (
                        <li
                          key={h.id}
                          id={`rs-opt-${i}`}
                          role="option"
                          aria-selected={i === sel}
                          className={`rail-search-opt ${i === sel ? "sel" : ""}`}
                          onMouseEnter={() => setActiveIdx(i)}
                          onClick={() => go(h)}
                        >
                          <span className="ri-ic" aria-hidden>
                            <Ic size={16} strokeWidth={1.75} />
                          </span>
                          <span className="rs-lb">{h.label}</span>
                          <span className="rs-hint">{h.hint}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          ))}

        {/* ── Grupos de navegação (micro-headers somem no modo só-ícones) ── */}
        {groups.map((g) => (
          <div key={g.id} className="rail-group">
            <div className="rail-group-h" aria-hidden>
              {g.title}
            </div>
            {g.items.map((it) => {
              const Icon = it.icon;
              const link = (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  className={itemCls}
                  aria-label={it.label}
                >
                  <span className="ri-ic" aria-hidden>
                    <Icon {...NAV_ICON} />
                  </span>
                  {/* Bottom-nav usa o rótulo curto quando existir; o aria-label (acima) segue o nome completo. */}
                  <span className="ri-lb">{mobile && it.short ? it.short : it.label}</span>
                </NavLink>
              );
              // No modo só-ícones o Tooltip revela o rótulo; fora dele seria redundante.
              return iconOnly ? (
                <Tooltip key={it.to} content={it.label}>
                  {link}
                </Tooltip>
              ) : (
                link
              );
            })}
          </div>
        ))}
        <div className="spacer" />
        <DropdownMenu
          side="top"
          align="start"
          ariaLabel="Menu do usuário"
          items={userMenu}
          trigger={
            <button
              type="button"
              // No bottom-nav este item também é o caminho p/ "Meu perfil" (dedup): rótulo
              // vira "Conta" (nome curto e estável — username truncaria) e acende quando
              // a rota ativa é /perfil (o link dedicado só existe fora do mobile).
              className={`rail-item rail-user ${mobile && pathname.startsWith("/perfil") ? "on" : ""}`}
              aria-label={`Conta de ${user.usuario} (${PAPEL_LABEL[user.papel]}) — abrir menu`}
            >
              <span className="ri-ic rail-avatar" aria-hidden>
                {user.usuario.charAt(0).toUpperCase()}
              </span>
              <span className="ri-lb">{mobile ? "Conta" : user.usuario}</span>
              <span className="ri-caret" aria-hidden>
                <ChevronDown size={14} strokeWidth={2} />
              </span>
            </button>
          }
        />
        <Tooltip content="Processamento local · sem identificação individual">
          <div className="rail-foot" aria-hidden>
            <ShieldCheck size={16} strokeWidth={1.75} />
          </div>
        </Tooltip>
      </nav>
      <main id="main-content" className="shell-main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
