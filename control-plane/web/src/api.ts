// Cliente de API do portal. Base URL configurável (VITE_CP_API); vazia = same-origin (dev usa
// o proxy /api do vite; prod serve a SPA do próprio control-plane). Guarda o token em memória +
// sessionStorage (sobrevive a F5 na mesma aba; não vaza p/ outras abas/persistência longa).
// 401 → limpa a sessão e avisa quem escuta (App volta ao login).

import type {
  AdminSite,
  AdminUser,
  AlarmsResponse,
  AuditoriaDvr,
  Cliente,
  Dvr,
  LoginResponse,
  Membership,
  Overview,
  Partner,
  Scope,
  ScopeType,
  SiteCreated,
} from "./types";

const BASE = import.meta.env.VITE_CP_API ?? "";
const TOKEN_KEY = "cp.token";
const SCOPE_KEY = "cp.scope";

let token: string | null = sessionStorage.getItem(TOKEN_KEY);

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Registra um callback disparado em qualquer 401 (token ausente/expirado). Retorna o unsubscribe. */
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function getToken(): string | null {
  return token;
}

export function getStoredScope(): Scope | null {
  const raw = sessionStorage.getItem(SCOPE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Scope;
  } catch {
    return null;
  }
}

function setSession(t: string, scope: Scope): void {
  token = t;
  sessionStorage.setItem(TOKEN_KEY, t);
  sessionStorage.setItem(SCOPE_KEY, JSON.stringify(scope));
}

export function clearSession(): void {
  token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SCOPE_KEY);
}

/** Erro de API com o status HTTP e a mensagem do corpo `{error}` quando houver. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "sem conexão com o servidor");
  }

  if (res.status === 401) {
    clearSession();
    for (const fn of unauthorizedListeners) fn();
    throw new ApiError(401, "sessão expirada");
  }

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `erro ${res.status}`;
    throw new ApiError(res.status, msg);
  }

  return body as T;
}

// ── endpoints ──

export async function login(email: string, senha: string): Promise<LoginResponse> {
  const data = await request<LoginResponse>("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, senha }),
  });
  setSession(data.token, data.scope);
  return data;
}

export function getOverview(): Promise<Overview> {
  return request<Overview>("/api/overview");
}

export function getSiteAlarms(
  siteId: string,
  opts: { limit?: number; since?: number; before?: number } = {},
): Promise<AlarmsResponse> {
  const qs = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    since: String(opts.since ?? 0),
  });
  // Cursor real (para trás no desc): pede alarmes com ts < before. Omitido na 1ª página.
  if (opts.before != null) qs.set("before", String(opts.before));
  return request<AlarmsResponse>(`/api/sites/${encodeURIComponent(siteId)}/alarms?${qs}`);
}

// ── cadastro (GERENCIAR) ──
// As listas vêm SCOPED por canAccess no backend; o gate real de criação é a API (403).

export function listPartners(): Promise<Partner[]> {
  return request<Partner[]>("/api/partners");
}
export function createPartner(nome: string): Promise<Partner> {
  return request<Partner>("/api/partners", {
    method: "POST",
    body: JSON.stringify({ nome }),
  });
}

export function listClientes(): Promise<Cliente[]> {
  return request<Cliente[]>("/api/clientes");
}
export function createCliente(partner_id: string, nome: string): Promise<Cliente> {
  return request<Cliente>("/api/clientes", {
    method: "POST",
    body: JSON.stringify({ partner_id, nome }),
  });
}

export function listSites(): Promise<AdminSite[]> {
  return request<AdminSite[]>("/api/sites");
}
// Devolve a site_key CRUA (a credencial do hub) — mostrar UMA vez, não é reversível.
export function createSite(cliente_id: string, nome: string): Promise<SiteCreated> {
  return request<SiteCreated>("/api/sites", {
    method: "POST",
    body: JSON.stringify({ cliente_id, nome }),
  });
}

export function listUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>("/api/users");
}
export function createUser(email: string, senha: string): Promise<AdminUser> {
  return request<AdminUser>("/api/users", {
    method: "POST",
    body: JSON.stringify({ email, senha }),
  });
}

export function listMemberships(): Promise<Membership[]> {
  return request<Membership[]>("/api/memberships");
}
export function createMembership(input: {
  user_id: string;
  scope_type: ScopeType;
  scope_id: string | null;
  role: string;
}): Promise<Membership> {
  return request<Membership>("/api/memberships", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function deleteMembership(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/memberships/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── PONTE DVR (UI do técnico, C-fe) ──
// As listas vêm SCOPED por canAccess no backend (mesmo filtro do CRUD); o token viaja no Bearer.

// DVRs por cliente + status da sessão (C-fe-1). Cada item já traz a sessão ATIVA (ou null).
export function listDvrs(): Promise<Dvr[]> {
  return request<Dvr[]>("/api/dvr/dvrs");
}

// Encerra uma sessão ativa (o técnico, via token+canAccess). Idempotente no backend.
export function encerrarSessaoDvr(
  sessaoId: string,
): Promise<{ ok: true; sessaoId: string; status: string }> {
  return request(`/api/dvr/sessao/${encodeURIComponent(sessaoId)}/encerrar`, { method: "POST" });
}

// Auditoria por cliente/coletor (C-fe-2). Filtro opcional por coletor.
export function listAuditoriaDvr(
  opts: { coletor?: string; limit?: number } = {},
): Promise<AuditoriaDvr[]> {
  const qs = new URLSearchParams();
  if (opts.coletor) qs.set("coletor", opts.coletor);
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<AuditoriaDvr[]>(`/api/dvr/auditoria${suffix}`);
}
