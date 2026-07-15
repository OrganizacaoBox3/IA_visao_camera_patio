// Cliente de API do portal. Base URL configurável (VITE_CP_API); vazia = same-origin (dev usa
// o proxy /api do vite; prod serve a SPA do próprio control-plane). Guarda o token em memória +
// sessionStorage (sobrevive a F5 na mesma aba; não vaza p/ outras abas/persistência longa).
// 401 → limpa a sessão e avisa quem escuta (App volta ao login).

import type {
  AlarmsResponse,
  LoginResponse,
  Overview,
  Scope,
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
  opts: { limit?: number; since?: number } = {},
): Promise<AlarmsResponse> {
  const limit = opts.limit ?? 50;
  const since = opts.since ?? 0;
  const qs = new URLSearchParams({ limit: String(limit), since: String(since) });
  return request<AlarmsResponse>(`/api/sites/${encodeURIComponent(siteId)}/alarms?${qs}`);
}
