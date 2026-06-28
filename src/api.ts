// Cliente da API HTTP do hub (login já é feito no auth.tsx; aqui ficam as rotas autenticadas).
// Base = mesma origem do hub (prod: nginx faz proxy de /api/; dev: hub em :4000 com CORS).
import { APP_CONFIG } from "./config";

function token(): string | null {
  try { const s = localStorage.getItem("vp-auth"); return s ? JSON.parse(s).token : null; } catch { return null; }
}
function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const t = token(); if (t) h.Authorization = `Bearer ${t}`;
  if (json) h["content-type"] = "application/json";
  return h;
}
// Erro de API com detalhe técnico preservado (status/detail) e MENSAGEM amigável em pt-BR
// (`.message`). A UI mostra `.message`; o detalhe técnico fica só no console (não vaza ao usuário).
export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string, friendly: string) {
    super(friendly);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

// Mapeia status HTTP → mensagem humana em pt-BR (usada só quando o servidor não envia uma).
function friendlyStatus(status: number): string {
  if (status === 401) return "Sessão expirada. Entre novamente.";
  if (status === 403) return "Você não tem permissão para esta ação.";
  if (status === 404) return "Recurso não encontrado.";
  if (status === 409) return "Já existe um registro com esses dados.";
  if (status === 429) return "Muitas solicitações. Aguarde um instante e tente de novo.";
  if (status >= 500) return "Falha no servidor. Tente novamente em instantes.";
  if (status >= 400) return "Não foi possível concluir a solicitação.";
  return "Falha de comunicação com o servidor.";
}

async function parse(res: Response) {
  if (res.ok) return res.status === 204 ? null : res.json();
  let serverMsg: string | null = null;
  try { const e = await res.json(); if (e?.error) serverMsg = String(e.error); } catch { /* sem corpo */ }
  const friendly = serverMsg ?? friendlyStatus(res.status);
  const detail = serverMsg ?? `HTTP ${res.status}`;
  console.error(`[api] ${res.status} ${res.url} — ${detail}`); // detalhe técnico só no console
  throw new ApiError(res.status, detail, friendly);
}

// Garante que toda falha (incl. rede/CORS, que rejeita com TypeError "Failed to fetch")
// chegue à UI como ApiError com mensagem amigável; preserva ApiError já formado pelo parse.
function request<T>(p: Promise<Response>): Promise<T> {
  return p.then(parse).catch((e) => {
    if (e instanceof ApiError) throw e;
    console.error("[api] erro de rede", e);
    throw new ApiError(0, e instanceof Error ? e.message : String(e), "Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.");
  });
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(fetch(APP_CONFIG.net.serverUrl + path, { headers: headers() }));
}
export function apiSend<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return request<T>(fetch(APP_CONFIG.net.serverUrl + path, { method, headers: headers(true), body: body == null ? undefined : JSON.stringify(body) }));
}

// Papel do usuário (RBAC Setup × Live — Onda C item 12): superadmin | engenheiro | usuario.
// Reexporta o tipo canônico de auth.tsx para manter front e API alinhados.
export type { Papel } from "./auth";
import type { Papel } from "./auth";

// ── Meu perfil (qualquer usuário) ──
export type NotifPrefs = { ativo: boolean; somenteCriticos: boolean; tipos: string[] };
export type MeProfile = { id: string; usuario: string; papel: Papel; whatsapp?: string; filtros?: NotifPrefs | null; optInEm?: number | null };
export const getMe = () => apiGet<MeProfile>("/api/me");
export const updateMe = (patch: Partial<{ whatsapp: string; filtros: NotifPrefs; optIn: boolean }>) => apiSend<MeProfile>("PATCH", "/api/me", patch);

// ── Usuários (superadmin) ──
export type AdminUser = { id: string; usuario: string; papel: Papel; ativo: boolean; whatsapp?: string; criadoEm?: number };
export const listUsers = () => apiGet<AdminUser[]>("/api/users");
export const createUser = (u: { usuario: string; senha: string; papel: string }) => apiSend<AdminUser>("POST", "/api/users", u);
export const patchUser = (id: string, patch: Partial<{ ativo: boolean; papel: string; senha: string }>) => apiSend<AdminUser>("PATCH", `/api/users/${id}`, patch);
export const deleteUser = (id: string) => apiSend<{ ok: true }>("DELETE", `/api/users/${id}`);
export const getCameraEnroll = () => apiGet<{ token: string | null }>("/api/camera-enroll");

// ── WhatsApp (superadmin) ──
export type WaStatus = { enabled: boolean; connected: boolean; qr: string | null };
export const getWaStatus = () => apiGet<WaStatus>("/api/wa-status");
export const waTest = (numero: string) => apiSend<{ ok: true }>("POST", "/api/wa-test", { numero });

// ── Configuração de notificações (superadmin) ──
export type NotifTipo = { ativo: boolean; titulo: string; instrucao: string };
export type NotifSettings = { marca: string; incluirLocal: boolean; incluirHora: boolean; incluirRodape: boolean; tipos: Record<string, NotifTipo> };
export const getNotifSettings = () => apiGet<NotifSettings>("/api/notif-settings");
export const saveNotifSettings = (s: NotifSettings) => apiSend<NotifSettings>("PATCH", "/api/notif-settings", s);
export const previewNotif = (s: NotifSettings) => apiSend<Record<string, string>>("POST", "/api/notif-preview", s);

// ── Destinatários WhatsApp (superadmin) ──
export type Recipient = { id: string; nome: string; numero: string; ativo: boolean; somenteCriticos: boolean; tipos: string[] };
export const listRecipients = () => apiGet<Recipient[]>("/api/recipients");
export const createRecipient = (r: { nome: string; numero: string; somenteCriticos?: boolean }) => apiSend<Recipient>("POST", "/api/recipients", r);
export const patchRecipient = (id: string, patch: Partial<{ ativo: boolean; nome: string; numero: string; somenteCriticos: boolean }>) => apiSend<Recipient>("PATCH", `/api/recipients/${id}`, patch);
export const deleteRecipient = (id: string) => apiSend<{ ok: true }>("DELETE", `/api/recipients/${id}`);

// ── Fila de alarmes acionável (Onda B · item 7) — eventos com acknowledge ──
// Consome o backend B1 (contrato-eventos-alarme.md). SÓ METADADOS (LGPD): nunca imagem/frame.
// Eventos ao vivo chegam por socket (`alarm-event`/`alarm-update`); aqui ficam as rotas HTTP.
export type AlarmPriority = "advisory" | "high" | "critical";
export type AlarmState = "new" | "acknowledged" | "forwarded";
// tipo vem da política (atividade|fadiga|leitura|objetos); aceita string p/ ser retrocompatível.
export type AlarmTipo = "atividade" | "fadiga" | "leitura" | "objetos" | (string & {});
export type AlarmEvent = {
  id: string;
  ts: number;
  cameraId?: string;
  cameraLabel?: string;
  zona?: string;
  tipo: AlarmTipo;
  priority: AlarmPriority;
  text: string;
  state: AlarmState;
  ackBy?: string;
  ackAt?: number;
};
export type ListAlarmsParams = { limit?: number; since?: number; state?: AlarmState; priority?: AlarmPriority };

// GET /api/alarms?limit=&since=&state=&priority=  → Array<AlarmEvent> ordenado por ts desc.
export function listAlarms(params?: ListAlarmsParams): Promise<AlarmEvent[]> {
  const q = new URLSearchParams();
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.since != null) q.set("since", String(params.since));
  if (params?.state) q.set("state", params.state);
  if (params?.priority) q.set("priority", params.priority);
  const qs = q.toString();
  return apiGet<AlarmEvent[]>(`/api/alarms${qs ? `?${qs}` : ""}`);
}
// POST /api/alarms/:id/ack — marca como acknowledged (by? default = usuário do token).
export const ackAlarm = (id: string, by?: string) => apiSend<AlarmEvent>("POST", `/api/alarms/${encodeURIComponent(id)}/ack`, by ? { by } : {});
// POST /api/alarms/:id/forward — marca como forwarded (encaminhado).
export const forwardAlarm = (id: string, by?: string) => apiSend<AlarmEvent>("POST", `/api/alarms/${encodeURIComponent(id)}/forward`, by ? { by } : {});

// ── Saúde do sistema de alarmes (ISA-18.2 / EEMUA 191 — racionalização · Onda B) ──
// KPIs do PRÓPRIO sistema de alertas (não dos eventos em si): taxa/min, % de críticos vs. o
// alvo EEMUA (≤5%), contagem por prioridade na janela e na última hora, e shelves ativos.
// Tudo é só métrica/metadado (LGPD): nunca imagem/frame. Auth: logado (leitura).
export type AlarmCounts = Record<AlarmPriority, number>;
export type AlarmMetrics = {
  now: number;               // epoch ms do relógio do servidor (base p/ calcular tempos)
  windowMs: number;          // tamanho da janela de avaliação (ms)
  inWindow: number;          // total de alarmes dentro da janela
  ratePerMin: number;        // taxa média de alarmes por minuto na janela
  criticalPct: number;       // % de críticos sobre o total (0–100)
  criticalTargetPct: number; // alvo de referência (EEMUA 191: ~5%)
  overTarget: boolean;       // true quando criticalPct excede o alvo (vira ruído/sobrecarga)
  lastMinute: number;        // alarmes no último minuto
  lastHour: number;          // alarmes na última hora
  byPriorityWindow: AlarmCounts; // distribuição por prioridade na janela
  byPriorityHour: AlarmCounts;   // distribuição por prioridade na última hora
  shelvedActive: number;     // nº de shelves (silenciamentos) ativos agora
};
// GET /api/alarms/metrics — instantâneo de saúde do sistema de alarmes. Auth: logado.
export const getAlarmMetrics = () => apiGet<AlarmMetrics>("/api/alarms/metrics");

// Shelve = silenciamento TEMPORÁRIO (com expiração automática e registro de quem/por quê) de
// uma classe de alarme. `key` segue o formato `cameraId|zona|tipo`, com `*` como curinga
// (ex.: "cam-1|doca-3|fadiga", "cam-1|*|*", "*|*|leitura").
export type Shelve = {
  key: string;         // padrão de correspondência cameraId|zona|tipo (curinga *)
  since: number;       // epoch ms da criação
  ms: number;          // duração total solicitada (ms)
  expiresAt: number;   // epoch ms em que volta a alarmar
  remainingMs: number; // tempo restante até expirar (ms)
  reason?: string;     // motivo do silenciamento (racionalização/registro)
  by?: string;         // quem silenciou
};
// GET /api/alarms/shelves — shelves ativos. Auth: logado.
export const listShelves = () => apiGet<Shelve[]>("/api/alarms/shelves");
// POST /api/alarms/shelves — cria shelve. Auth: perfil de configuração (canConfigure).
export const createShelve = (s: { key: string; ms?: number; reason?: string }) => apiSend<Shelve>("POST", "/api/alarms/shelves", s);
// DELETE /api/alarms/shelves/:key — remove shelve (key via encodeURIComponent). Auth: canConfigure.
export const deleteShelve = (key: string) => apiSend<{ ok: true }>("DELETE", `/api/alarms/shelves/${encodeURIComponent(key)}`);

// ── Config COMPARTILHADA das câmeras (views + tripwires) — antes em localStorage ──
// Centraliza o que os operadores configuravam localmente, para partilhar entre turnos.
// SÓ geometria/ids/nomes (LGPD). apiSend não tem "PUT"; usamos fetch direto pelo mesmo
// caminho (auth/erro via request()), mantendo retrocompatibilidade do client existente.
function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(fetch(APP_CONFIG.net.serverUrl + path, { method: "PUT", headers: headers(true), body: JSON.stringify(body) }));
}

// VIEWS — layouts salvos do dashboard (lista global). { id, name, cameraIds[] }.
export type SavedView = { id: string; name: string; cameraIds: string[] };
// GET /api/views → SavedView[]. Auth: qualquer usuário autenticado.
export const getViews = () => apiGet<SavedView[]>("/api/views");
// PUT /api/views {views} → substitui a lista inteira; responde a lista salva. Auth: autenticado.
export const saveViews = (views: SavedView[]) => apiPut<SavedView[]>("/api/views", { views });

// TRIPWIRES — linhas de contagem por câmera. coords NORMALIZADAS 0..1.
export type Tripwire = { id: string; a: { x: number; y: number }; b: { x: number; y: number } };
// GET /api/tripwires/:cameraId → Tripwire[]. Auth: qualquer usuário autenticado.
export const getTripwires = (cameraId: string) => apiGet<Tripwire[]>(`/api/tripwires/${encodeURIComponent(cameraId)}`);
// PUT /api/tripwires/:cameraId {tripwires} → substitui as linhas; responde a lista salva.
// Auth: perfil de configuração (engenharia) — coerente com o gate de edição no front.
export const saveTripwires = (cameraId: string, tripwires: Tripwire[]) => apiPut<Tripwire[]>(`/api/tripwires/${encodeURIComponent(cameraId)}`, { tripwires });
