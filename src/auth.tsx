// Acesso restrito multi-usuário. Login (usuário+senha) é validado no hub (POST /api/login),
// que devolve um token de sessão assinado + o papel do usuário. O token vai no handshake do
// socket (auth.token); a senha nunca fica no cliente. O papel habilita áreas (ex.: superadmin).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { APP_CONFIG } from "./config";
import { Button, Input, Field } from "./ui";

const KEY = "vp-auth";
// Papéis (RBAC Setup × Live — Onda C item 12):
//   - "superadmin": acesso total (gestão de usuários/câmeras/notificações + configuração).
//   - "engenheiro": equipe de configuração/setup — PODE editar thresholds/zonas; NÃO gerencia usuários.
//   - "usuario":    operador em modo só-visualização — não configura nem gerencia usuários.
export type Papel = "superadmin" | "engenheiro" | "usuario";
export type AuthUser = { id: string; usuario: string; papel: Papel };
type Session = { token: string; user: AuthUser };

// Capacidade de configuração (thresholds/zonas): superadmin OU engenheiro. A onda seguinte
// (gate da tela de câmera) consome `canConfigure` do contexto para liberar/bloquear a edição.
export function canConfigurePapel(papel: Papel): boolean {
  return papel === "superadmin" || papel === "engenheiro";
}

function readSession(): Session | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : null; } catch { return null; }
}

// `isSuper`     = papel === "superadmin" (gestão de usuários/admin, como já era).
// `canConfigure`= superadmin OU engenheiro (capacidade de editar thresholds/zonas — Setup × Live).
type AuthCtx = { token: string; user: AuthUser; isSuper: boolean; canConfigure: boolean; logout: (reason?: string) => void };
const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [error, setError] = useState<string | null>(null);

  const login = useCallback((s: Session) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* no-op */ } setError(null); setSession(s); }, []);
  const logout = useCallback((reason?: string) => { try { localStorage.removeItem(KEY); } catch { /* no-op */ } setError(reason ?? null); setSession(null); }, []);

  const value = useMemo<AuthCtx | null>(() => {
    if (!session) return null;
    const papel = session.user.papel;
    return {
      token: session.token,
      user: session.user,
      isSuper: papel === "superadmin",
      canConfigure: canConfigurePapel(papel),
      logout,
    };
  }, [session, logout]);

  if (!session || !value) return <LoginScreen initialError={error} onLogin={login} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function LoginScreen({ initialError, onLogin }: { initialError: string | null; onLogin: (s: Session) => void }) {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!usuario.trim() || !senha) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`${APP_CONFIG.net.serverUrl}/api/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ usuario: usuario.trim(), senha }),
      });
      if (!res.ok) { setErr("Usuário ou senha inválidos."); setBusy(false); return; }
      const data = (await res.json()) as Session;
      onLogin(data);
    } catch { setErr("Não foi possível conectar ao servidor."); setBusy(false); }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">▣ Visão de Pátio</div>
        <p className="login-sub">Acesso restrito</p>
        <Field label="Usuário" htmlFor="login-user">
          <Input id="login-user" type="text" autoFocus autoComplete="username" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
        </Field>
        <Field label="Senha" htmlFor="login-pass" error={err ?? undefined}>
          <Input id="login-pass" type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} />
        </Field>
        <Button variant="primary" block type="submit" disabled={busy || !usuario.trim() || !senha}>{busy ? "Entrando…" : "Entrar"}</Button>
      </form>
    </div>
  );
}
