import { useEffect, useState } from "react";
import { clearSession, getStoredScope, getToken, onUnauthorized } from "./api";
import type { Scope, Site } from "./types";
import { Button } from "./ui";
import { Login } from "./screens/Login";
import { Fleet } from "./screens/Fleet";
import { SiteView } from "./screens/SiteView";
import { Manage } from "./screens/Manage";

// Roteamento por estado simples (sem react-router — poucas telas, uma pilha rasa). Ver README.
type View = { name: "fleet" } | { name: "manage" } | { name: "site"; site: Site };

function scopeLabel(scope: Scope | null): string {
  if (!scope) return "";
  const alvo = scope.scope_id ? ` #${scope.scope_id}` : "";
  return `${scope.role} · ${scope.scope_type}${alvo}`;
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => !!getToken());
  const [scope, setScope] = useState<Scope | null>(() => getStoredScope());
  const [view, setView] = useState<View>({ name: "fleet" });

  // Qualquer 401 no cliente (token ausente/expirado) derruba a sessão e volta ao login.
  useEffect(() => {
    return onUnauthorized(() => {
      setAuthed(false);
      setScope(null);
      setView({ name: "fleet" });
    });
  }, []);

  function logout() {
    clearSession();
    setAuthed(false);
    setScope(null);
    setView({ name: "fleet" });
  }

  if (!authed) {
    return (
      <div className="cp-shell">
        <Login
          onLoggedIn={(r) => {
            setScope(r.scope);
            setAuthed(true);
            setView({ name: "fleet" });
          }}
        />
      </div>
    );
  }

  return (
    <div className="cp-shell">
      <header className="cp-topbar">
        <h1>Portal — Visão Pátio</h1>
        <nav className="cp-nav" aria-label="Seções">
          <button
            className="cp-nav__item"
            aria-current={view.name === "fleet" ? "page" : undefined}
            onClick={() => setView({ name: "fleet" })}
          >
            Frota
          </button>
          <button
            className="cp-nav__item"
            aria-current={view.name === "manage" ? "page" : undefined}
            onClick={() => setView({ name: "manage" })}
          >
            Gerenciar
          </button>
        </nav>
        <span className="spacer" />
        {scope && <span className="cp-scope">{scopeLabel(scope)}</span>}
        <Button variant="ghost" onClick={logout}>
          Sair
        </Button>
      </header>
      <main className="cp-main">
        {view.name === "fleet" && (
          <Fleet onOpenSite={(site) => setView({ name: "site", site })} />
        )}
        {view.name === "manage" && scope && <Manage scope={scope} />}
        {view.name === "site" && (
          <SiteView site={view.site} onBack={() => setView({ name: "fleet" })} />
        )}
      </main>
    </div>
  );
}
