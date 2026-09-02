// Acesso restrito multi-usuário. Login (usuário+senha) é validado no hub (POST /api/login),
// que devolve um token de sessão assinado + o papel do usuário. O token vai no handshake do
// socket (auth.token); a senha nunca fica no cliente. O papel habilita áreas (ex.: superadmin).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Cctv } from "lucide-react";
import { APP_CONFIG } from "./config";
import { Alert, Button, Input, Field } from "./ui";

const KEY = "vp-auth";
// Papéis (RBAC Setup × Live — Onda C item 12):
//   - "superadmin": acesso total (gestão de usuários/câmeras/notificações + configuração).
//   - "engenheiro": equipe de configuração/setup — PODE editar thresholds/zonas; NÃO gerencia usuários.
//   - "usuario":    operador em modo só-visualização — não configura nem gerencia usuários.
//   - "cliente":    RBAC com escopo (spec-multitenancy) — só-visualização das câmeras alocadas a
//     ele (users.cameraIds no servidor); nunca configura. A restrição é toda no SERVIDOR (REST +
//     socket) — o front não precisa filtrar nada, só recebe o que já vem escopado.
export type Papel = "superadmin" | "engenheiro" | "usuario" | "cliente";
export type AuthUser = { id: string; usuario: string; papel: Papel };
type Session = { token: string; user: AuthUser };

// Capacidade de configuração (thresholds/zonas): superadmin OU engenheiro. A onda seguinte
// (gate da tela de câmera) consome `canConfigure` do contexto para liberar/bloquear a edição.
export function canConfigurePapel(papel: Papel): boolean {
  return papel === "superadmin" || papel === "engenheiro";
}

// Não mascarar falha de infra como "senha errada": distingue credencial inválida (401 —
// único status que o /api/login emite p/ recusa) de indisponibilidade (429/≥500, tipicamente
// do proxy/hub fora do ar). Replica a INTENÇÃO do friendlyStatus de api.ts sem importá-lo
// (api.ts é contrato de outra frente; F7 poderá exportar friendlyStatus e unificar).
function loginErrorFor(status: number): string {
  if (status === 401 || status === 403) return "Usuário ou senha inválidos.";
  if (status === 429) return "Muitas tentativas. Aguarde um instante e tente de novo.";
  if (status >= 500) return "Servidor indisponível no momento. Tente novamente em instantes.";
  return "Não foi possível entrar. Tente novamente.";
}

function readSession(): Session | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Session) : null;
  } catch {
    return null;
  }
}

// `isSuper`     = papel === "superadmin" (gestão de usuários/admin, como já era).
// `canConfigure`= superadmin OU engenheiro (capacidade de editar thresholds/zonas — Setup × Live).
type AuthCtx = {
  token: string;
  user: AuthUser;
  isSuper: boolean;
  canConfigure: boolean;
  logout: (reason?: string) => void;
};
const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [error, setError] = useState<string | null>(null);

  const login = useCallback((s: Session) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* no-op */
    }
    setError(null);
    setSession(s);
  }, []);
  const logout = useCallback((reason?: string) => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* no-op */
    }
    setError(reason ?? null);
    setSession(null);
  }, []);

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

function LoginScreen({
  initialError,
  onLogin,
}: {
  initialError: string | null;
  onLogin: (s: Session) => void;
}) {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!usuario.trim() || !senha) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${APP_CONFIG.net.serverUrl}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usuario: usuario.trim(), senha }),
      });
      if (!res.ok) {
        setErr(loginErrorFor(res.status));
        setBusy(false);
        return;
      }
      const data = (await res.json()) as Session;
      onLogin(data);
    } catch {
      setErr("Não foi possível conectar ao servidor.");
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        {/* h1 SEMÂNTICO (1ª tela do produto não tinha heading): visual do .login-brand
            preservado (m-0/font-normal anulam os defaults de h1); o glifo ▣ vira o
            Cctv do shell (Lucide único — regra 11 da doutrina). */}
        <h1 className="login-brand m-0 flex items-center justify-center gap-2 font-normal">
          <Cctv size={20} strokeWidth={1.75} aria-hidden /> Visão de Pátio
        </h1>
        <p className="login-sub">Acesso restrito</p>
        <Field label="Usuário" htmlFor="login-user">
          <Input
            id="login-user"
            type="text"
            autoFocus
            autoComplete="username"
            className="max-[640px]:min-h-[44px]"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
          />
        </Field>
        <Field label="Senha" htmlFor="login-pass">
          <Input
            id="login-pass"
            type="password"
            autoComplete="current-password"
            className="max-[640px]:min-h-[44px]"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
        </Field>
        {/* Erro de PÁGINA (credencial/servidor) = Alert inline com role="alert" (aria-live) —
            padrão único de feedback da spec §3; não é erro de campo, então sai do Field. */}
        {err && <Alert tone="alert">{err}</Alert>}
        <Button
          variant="primary"
          block
          type="submit"
          className="max-[640px]:min-h-[44px]"
          aria-busy={busy}
          disabled={busy || !usuario.trim() || !senha}
        >
          {busy ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </div>
  );
}
