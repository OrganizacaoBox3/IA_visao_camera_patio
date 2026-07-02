import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BellRing,
  Cctv,
  ChevronDown,
  CircleUser,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth";
import type { Papel } from "../auth";
import { DropdownMenu, Tooltip, type DropdownItem } from "../ui";
import "./appshell.css";

// Iconografia única do shell (Lucide): 1 tamanho, 1 strokeWidth — consistência
// visual e stroke em currentColor (obedece o going-gray: cor vem do estado do item).
const NAV_ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true } as const;
const MENU_ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

// Shell persistente da SPA: rail lateral slim + área de conteúdo (Outlet).
// O nó de câmera (/camera) fica FORA do shell (é a visão do dispositivo, sem navegação).
// A11y: skip-link, <nav> rotulado, e o foco vai para o conteúdo ao trocar de rota (SPA).

// Rail "compacto" = md (641–900px): index.css esconde os rótulos (só ícones). Nesse
// modo mostramos Tooltip nos ícones (fora dele o próprio rótulo já é visível).
function useCompactRail(): boolean {
  const query = "(min-width: 641px) and (max-width: 900px)";
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setCompact(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

const PAPEL_LABEL: Record<Papel, string> = {
  superadmin: "Administrador",
  engenheiro: "Engenheiro",
  usuario: "Operador",
};

type NavItem = { to: string; end?: boolean; icon: LucideIcon; label: string };

export function AppShell() {
  const { user, canConfigure, logout } = useAuth();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const compact = useCompactRail();
  useEffect(() => {
    mainRef.current?.focus();
  }, [pathname]);

  // NavLink aplica aria-current="page" automaticamente no item ativo; a classe .on
  // dispara o realce discreto (going-gray) definido em appshell.css.
  const itemCls = ({ isActive }: { isActive: boolean }) => `rail-item ${isActive ? "on" : ""}`;

  // Itens de navegação por papel (visibilidade preservada: Saúde só p/ canConfigure;
  // Usuários só p/ superadmin). "Meu perfil" permanece um link direto (navegação primária).
  const navItems: NavItem[] = [
    { to: "/", end: true, icon: LayoutDashboard, label: "Central" },
    { to: "/relatorio", icon: BarChart3, label: "Relatório" },
    ...(canConfigure ? [{ to: "/alarmes-saude", icon: BellRing, label: "Saúde alarmes" }] : []),
    ...(user.papel === "superadmin" ? [{ to: "/usuarios", icon: Users, label: "Usuários" }] : []),
    { to: "/perfil", icon: CircleUser, label: "Meu perfil" },
  ];

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

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <nav className="rail rail--app" aria-label="Navegação principal">
        <Tooltip content="Visão de Pátio">
          <div className="rail-brand">
            <Cctv size={20} strokeWidth={1.75} aria-hidden />
          </div>
        </Tooltip>
        {navItems.map((it) => {
          const Icon = it.icon;
          const link = (
            <NavLink key={it.to} to={it.to} end={it.end} className={itemCls} aria-label={it.label}>
              <span className="ri-ic" aria-hidden>
                <Icon {...NAV_ICON} />
              </span>
              <span className="ri-lb">{it.label}</span>
            </NavLink>
          );
          // No modo compacto (só ícones) o Tooltip revela o rótulo; fora dele seria redundante.
          return compact ? (
            <Tooltip key={it.to} content={it.label}>
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
        <div className="spacer" />
        <DropdownMenu
          side="top"
          align="start"
          ariaLabel="Menu do usuário"
          items={userMenu}
          trigger={
            <button
              type="button"
              className="rail-item rail-user"
              aria-label={`Conta de ${user.usuario} (${PAPEL_LABEL[user.papel]}) — abrir menu`}
            >
              <span className="ri-ic rail-avatar" aria-hidden>
                {user.usuario.charAt(0).toUpperCase()}
              </span>
              <span className="ri-lb">{user.usuario}</span>
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
