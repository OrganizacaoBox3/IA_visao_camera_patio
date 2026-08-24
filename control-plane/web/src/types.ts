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

// ── PONTE DVR (UI do técnico, C-fe) ──
// Espelha GET /api/dvr/dvrs (control-plane/routes.js): DVR + contexto (coletor/cliente) + a
// sessão ATIVA (quando há túnel). O fluxo: quem ABRE a sessão é o COLETOR (app); o técnico só
// LISTA, e para uma sessão ativa abre a web do DVR em NOVA ABA (host_publico) ou ENCERRA.

// Sessão ativa anexada a um DVR (só o que a UI precisa; status é "ativa" quando presente aqui).
export interface DvrSessao {
  sessaoId: string;
  status: "ativa" | "encerrada";
  remotePort: number;
  hostPublico: string;
  aberta_em: number;
  ultima_atividade: number | null;
}

export interface Dvr {
  id: string;
  coletor_id: string;
  coletor_nome: string | null;
  empresa_id_box3: string;
  coletor_revogado: boolean;
  cliente_id: string;
  cliente_nome: string;
  partner_id: string | null;
  marca: string | null;
  modelo: string | null;
  ip: string | null;
  porta: number | null;
  criado_em: number;
  atualizado_em: number | null;
  // null = sem túnel ativo. Só com sessao != null a UI oferece "Abrir DVR" (nova aba) / "Encerrar".
  sessao: DvrSessao | null;
}

// Espelha GET /api/dvr/auditoria: quem/qual/quando (enrollment, registro, sessão, acesso do técnico).
export interface AuditoriaDvr {
  id: number;
  ator: string;
  dvr_id: string | null;
  coletor_id: string | null;
  coletor_nome: string | null;
  cliente_id: string | null;
  acao: string;
  detalhe: Record<string, unknown> | null;
  em: number;
}
