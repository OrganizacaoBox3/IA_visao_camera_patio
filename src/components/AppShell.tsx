import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useAuth } from "../auth";
import { Tooltip } from "../ui";

// Shell persistente da SPA: rail lateral slim + área de conteúdo (Outlet).
// O nó de câmera (/camera) fica FORA do shell (é a visão do dispositivo, sem navegação).
// A11y: skip-link, <nav> rotulado, e o foco vai para o conteúdo ao trocar de rota (SPA).
export function AppShell() {
  const { user, canConfigure, logout } = useAuth();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { mainRef.current?.focus(); }, [pathname]);

  const item = ({ isActive }: { isActive: boolean }) => `rail-item ${isActive ? "on" : ""}`;
  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">Pular para o conteúdo</a>
      <nav className="rail" aria-label="Navegação principal">
        <Tooltip content="Visão de Pátio"><div className="rail-brand">▣</div></Tooltip>
        <NavLink to="/" end className={item}><span className="ri-ic" aria-hidden>▦</span><span className="ri-lb">Central</span></NavLink>
        <NavLink to="/relatorio" className={item}><span className="ri-ic" aria-hidden>📊</span><span className="ri-lb">Relatório</span></NavLink>
        {canConfigure && <NavLink to="/alarmes-saude" className={item}><span className="ri-ic" aria-hidden>🔔</span><span className="ri-lb">Saúde alarmes</span></NavLink>}
        {user.papel === "superadmin" && <NavLink to="/usuarios" className={item}><span className="ri-ic" aria-hidden>👤</span><span className="ri-lb">Usuários</span></NavLink>}
        <NavLink to="/perfil" className={item}><span className="ri-ic" aria-hidden>⚙</span><span className="ri-lb">Meu perfil</span></NavLink>
        <div className="spacer" />
        <Tooltip content="Sair (encerrar acesso)">
          <button className="rail-item" onClick={() => logout()}><span className="ri-ic" aria-hidden>⎋</span><span className="ri-lb">Sair</span></button>
        </Tooltip>
        <Tooltip content="Processamento local · sem identificação individual"><div className="rail-foot" aria-hidden>●</div></Tooltip>
      </nav>
      <main id="main-content" className="shell-main" ref={mainRef} tabIndex={-1}><Outlet /></main>
    </div>
  );
}
