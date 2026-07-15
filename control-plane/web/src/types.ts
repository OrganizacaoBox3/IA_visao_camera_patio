// Contrato de API — fixo entre as frentes (docs/analises/spec-control-plane-fase2.md §"Contrato").

export type ScopeType = "platform" | "partner" | "cliente" | "site";

export interface Scope {
  scope_type: ScopeType;
  scope_id: string | null;
  role: string;
}

export interface User {
  id: string;
  email: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  scope: Scope;
}

export interface Partner {
  id: string;
  nome: string;
}

export interface Cliente {
  id: string;
  partner_id: string;
  nome: string;
}

export interface Site {
  id: string;
  cliente_id: string;
  nome: string;
  last_seen: number | null;
  online: boolean;
  alarms24h: number;
}

export interface Overview {
  scope: Scope;
  partners: Partner[];
  clientes: Cliente[];
  sites: Site[];
}

// meta é o resto do evento do hub (câmera/zona/prioridade/…) — só metadados (LGPD).
export interface AlarmMeta {
  id?: string;
  cameraId?: string;
  cameraLabel?: string;
  zona?: string;
  priority?: string;
  text?: string;
  state?: string;
  [k: string]: unknown;
}

export interface Alarm {
  id: string;
  tipo: string;
  ts: number;
  meta: AlarmMeta | null;
}

export interface AlarmsResponse {
  alarms: Alarm[];
}

// ── cadastro (GERENCIAR) ──
// As listas do CRUD (GET /api/<col>) devolvem ARRAYS crus (ver control-plane/routes.js).
// O Site do CRUD NÃO tem online/alarms24h (isso é do /overview) — por isso um tipo à parte.
export interface AdminSite {
  id: string;
  cliente_id: string;
  nome: string;
  last_seen: number | null;
}

// POST /api/sites devolve o site + a site_key CRUA (a credencial do hub) — UMA única vez.
export interface SiteCreated extends AdminSite {
  site_key: string;
}

export interface AdminUser {
  id: string;
  email: string;
  ativo?: boolean;
}

export interface Membership {
  id: string;
  user_id: string;
  scope_type: ScopeType;
  scope_id: string | null;
  role: string;
}
