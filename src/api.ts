// Cliente da API HTTP do hub (login já é feito no auth.tsx; aqui ficam as rotas autenticadas).
// Base = mesma origem do hub (prod: nginx faz proxy de /api/; dev: hub em :4000 com CORS).
import { APP_CONFIG } from "./config";

function token(): string | null {
  try {
    const s = localStorage.getItem("vp-auth");
    return s ? JSON.parse(s).token : null;
  } catch {
    return null;
  }
}
function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const t = token();
  if (t) h.Authorization = `Bearer ${t}`;
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
  try {
    const e = await res.json();
    if (e?.error) serverMsg = String(e.error);
  } catch {
    /* sem corpo */
  }
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
    throw new ApiError(
      0,
      e instanceof Error ? e.message : String(e),
      "Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.",
    );
  });
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(fetch(APP_CONFIG.net.serverUrl + path, { headers: headers() }));
}
export function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(
    fetch(APP_CONFIG.net.serverUrl + path, {
      method,
      headers: headers(true),
      body: body == null ? undefined : JSON.stringify(body),
    }),
  );
}

// ── Status da persistência do histórico (contrato ADITIVO da frente server) ──
// GET /api/data/status → { persistence: "pg" | "json", counts?: {...} }. Num hub antigo a rota
// não existe (404/erro): quem chama trata como "desconhecido" e mantém o comportamento atual.
export type DataPersistence = "pg" | "json";
export type DataStatus = { persistence: DataPersistence; counts?: Record<string, number> };
export const getDataStatus = () => apiGet<DataStatus>("/api/data/status");

// Papel do usuário (RBAC Setup × Live — Onda C item 12): superadmin | engenheiro | usuario.
// Reexporta o tipo canônico de auth.tsx para manter front e API alinhados.
export type { Papel } from "./auth";
import type { Papel } from "./auth";

// ── Meu perfil (qualquer usuário) ──
export type NotifPrefs = { ativo: boolean; somenteCriticos: boolean; tipos: string[] };
export type MeProfile = {
  id: string;
  usuario: string;
  papel: Papel;
  whatsapp?: string;
  filtros?: NotifPrefs | null;
  optInEm?: number | null;
};
export const getMe = () => apiGet<MeProfile>("/api/me");
export const updateMe = (
  patch: Partial<{ whatsapp: string; filtros: NotifPrefs; optIn: boolean }>,
) => apiSend<MeProfile>("PATCH", "/api/me", patch);

// ── Usuários (superadmin) ──
export type AdminUser = {
  id: string;
  usuario: string;
  papel: Papel;
  ativo: boolean;
  whatsapp?: string;
  criadoEm?: number;
};
export const listUsers = () => apiGet<AdminUser[]>("/api/users");
export const createUser = (u: { usuario: string; senha: string; papel: string }) =>
  apiSend<AdminUser>("POST", "/api/users", u);
export const patchUser = (
  id: string,
  patch: Partial<{ ativo: boolean; papel: string; senha: string }>,
) => apiSend<AdminUser>("PATCH", `/api/users/${id}`, patch);
export const deleteUser = (id: string) => apiSend<{ ok: true }>("DELETE", `/api/users/${id}`);
export const getCameraEnroll = () => apiGet<{ token: string | null }>("/api/camera-enroll");

// ── WhatsApp (superadmin) ──
export type WaStatus = { enabled: boolean; connected: boolean; qr: string | null };
export const getWaStatus = () => apiGet<WaStatus>("/api/wa-status");
export const waTest = (numero: string) => apiSend<{ ok: true }>("POST", "/api/wa-test", { numero });

// ── Configuração de notificações (superadmin) ──
export type NotifTipo = { ativo: boolean; titulo: string; instrucao: string };
export type NotifSettings = {
  marca: string;
  incluirLocal: boolean;
  incluirHora: boolean;
  incluirRodape: boolean;
  tipos: Record<string, NotifTipo>;
};
export const getNotifSettings = () => apiGet<NotifSettings>("/api/notif-settings");
export const saveNotifSettings = (s: NotifSettings) =>
  apiSend<NotifSettings>("PATCH", "/api/notif-settings", s);
export const previewNotif = (s: NotifSettings) =>
  apiSend<Record<string, string>>("POST", "/api/notif-preview", s);

// ── Destinatários WhatsApp (superadmin) ──
export type Recipient = {
  id: string;
  nome: string;
  numero: string;
  ativo: boolean;
  somenteCriticos: boolean;
  tipos: string[];
};
export const listRecipients = () => apiGet<Recipient[]>("/api/recipients");
export const createRecipient = (r: { nome: string; numero: string; somenteCriticos?: boolean }) =>
  apiSend<Recipient>("POST", "/api/recipients", r);
export const patchRecipient = (
  id: string,
  patch: Partial<{ ativo: boolean; nome: string; numero: string; somenteCriticos: boolean }>,
) => apiSend<Recipient>("PATCH", `/api/recipients/${id}`, patch);
export const deleteRecipient = (id: string) =>
  apiSend<{ ok: true }>("DELETE", `/api/recipients/${id}`);

// ── Fila de alarmes acionável (Onda B · item 7) — eventos com acknowledge ──
// Consome o backend B1 (contrato-eventos-alarme.md). SÓ METADADOS (LGPD): nunca imagem/frame.
// Eventos ao vivo chegam por socket (`alarm-event`/`alarm-update`); aqui ficam as rotas HTTP.
// Tipo canônico do evento de alarme: fonte ÚNICA em src/types/alarm.ts (R2.2). Re-exportado aqui
// para RETROCOMPATIBILIDADE — DashboardPage/AlarmHealthPage importam estes tipos via `../api` e
// continuam funcionando sem alteração. (Mesmo padrão do re-export de `Papel` acima.)
export type { AlarmEvent, AlarmPriority, AlarmState, AlarmTipo } from "./types/alarm";
import type { AlarmEvent, AlarmPriority, AlarmState } from "./types/alarm";
export type ListAlarmsParams = {
  limit?: number;
  since?: number;
  state?: AlarmState;
  priority?: AlarmPriority;
};

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
export const ackAlarm = (id: string, by?: string) =>
  apiSend<AlarmEvent>("POST", `/api/alarms/${encodeURIComponent(id)}/ack`, by ? { by } : {});
// POST /api/alarms/:id/forward — marca como forwarded (encaminhado).
export const forwardAlarm = (id: string, by?: string) =>
  apiSend<AlarmEvent>("POST", `/api/alarms/${encodeURIComponent(id)}/forward`, by ? { by } : {});

// ── Saúde do sistema de alarmes (ISA-18.2 / EEMUA 191 — racionalização · Onda B) ──
// KPIs do PRÓPRIO sistema de alertas (não dos eventos em si): taxa/min, % de críticos vs. o
// alvo EEMUA (≤5%), contagem por prioridade na janela e na última hora, e shelves ativos.
// Tudo é só métrica/metadado (LGPD): nunca imagem/frame. Auth: logado (leitura).
export type AlarmCounts = Record<AlarmPriority, number>;
export type AlarmMetrics = {
  now: number; // epoch ms do relógio do servidor (base p/ calcular tempos)
  windowMs: number; // tamanho da janela de avaliação (ms)
  inWindow: number; // total de alarmes dentro da janela
  ratePerMin: number; // taxa média de alarmes por minuto na janela
  criticalPct: number; // % de críticos sobre o total (0–100)
  criticalTargetPct: number; // alvo de referência (EEMUA 191: ~5%)
  overTarget: boolean; // true quando criticalPct excede o alvo (vira ruído/sobrecarga)
  lastMinute: number; // alarmes no último minuto
  lastHour: number; // alarmes na última hora
  byPriorityWindow: AlarmCounts; // distribuição por prioridade na janela
  byPriorityHour: AlarmCounts; // distribuição por prioridade na última hora
  shelvedActive: number; // nº de shelves (silenciamentos) ativos agora
};
// GET /api/alarms/metrics — instantâneo de saúde do sistema de alarmes. Auth: logado.
export const getAlarmMetrics = () => apiGet<AlarmMetrics>("/api/alarms/metrics");

// Shelve = silenciamento TEMPORÁRIO (com expiração automática e registro de quem/por quê) de
// uma classe de alarme. `key` segue o formato `cameraId|zona|tipo`, com `*` como curinga
// (ex.: "cam-1|doca-3|fadiga", "cam-1|*|*", "*|*|leitura").
export type Shelve = {
  key: string; // padrão de correspondência cameraId|zona|tipo (curinga *)
  since: number; // epoch ms da criação
  ms: number; // duração total solicitada (ms)
  expiresAt: number; // epoch ms em que volta a alarmar
  remainingMs: number; // tempo restante até expirar (ms)
  reason?: string; // motivo do silenciamento (racionalização/registro)
  by?: string; // quem silenciou
};
// GET /api/alarms/shelves — shelves ativos. Auth: logado.
export const listShelves = () => apiGet<Shelve[]>("/api/alarms/shelves");
// POST /api/alarms/shelves — cria shelve. Auth: perfil de configuração (canConfigure).
export const createShelve = (s: { key: string; ms?: number; reason?: string }) =>
  apiSend<Shelve>("POST", "/api/alarms/shelves", s);
// DELETE /api/alarms/shelves/:key — remove shelve (key via encodeURIComponent). Auth: canConfigure.
export const deleteShelve = (key: string) =>
  apiSend<{ ok: true }>("DELETE", `/api/alarms/shelves/${encodeURIComponent(key)}`);

// ── Config COMPARTILHADA das câmeras (views + tripwires) — antes em localStorage ──
// Centraliza o que os operadores configuravam localmente, para partilhar entre turnos.
// SÓ geometria/ids/nomes (LGPD). apiSend não tem "PUT"; usamos fetch direto pelo mesmo
// caminho (auth/erro via request()), mantendo retrocompatibilidade do client existente.
function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(
    fetch(APP_CONFIG.net.serverUrl + path, {
      method: "PUT",
      headers: headers(true),
      body: JSON.stringify(body),
    }),
  );
}

// TRIPWIRES — linhas de contagem por câmera. coords NORMALIZADAS 0..1.
export type Tripwire = { id: string; a: { x: number; y: number }; b: { x: number; y: number } };
// GET /api/tripwires/:cameraId → Tripwire[]. Auth: qualquer usuário autenticado.
export const getTripwires = (cameraId: string) =>
  apiGet<Tripwire[]>(`/api/tripwires/${encodeURIComponent(cameraId)}`);
// PUT /api/tripwires/:cameraId {tripwires} → substitui as linhas; responde a lista salva.
// Auth: perfil de configuração (engenharia) — coerente com o gate de edição no front.
export const saveTripwires = (cameraId: string, tripwires: Tripwire[]) =>
  apiPut<Tripwire[]>(`/api/tripwires/${encodeURIComponent(cameraId)}`, { tripwires });

// ── ZONES + CAMCONFIG (config de câmera) — COMPARTILHADAS, por câmera ──────────
// Antes em localStorage (vp-zones-<id> / vp-camcfg-<id>); agora centralizadas para
// partilhar entre turnos. Reusa os tipos canônicos de src/zones.ts e src/cameraConfig.ts
// (fonte única — sem duplicar) e os re-exporta para os consumidores importarem via `../api`.
// SÓ geometria/ids/config (LGPD). GET: qualquer autenticado; PUT: perfil de configuração.
export type { Zone } from "./zones";
export type { CameraCfg } from "./cameraConfig";
import type { Zone } from "./zones";
import type { CameraCfg } from "./cameraConfig";

// GET /api/zones/:cameraId → Zone[]. Auth: qualquer usuário autenticado.
export const getZones = (cameraId: string) =>
  apiGet<Zone[]>(`/api/zones/${encodeURIComponent(cameraId)}`);
// PUT /api/zones/:cameraId {zones} → substitui as zonas; responde a lista salva.
// Auth: perfil de configuração (engenharia) — coerente com o gate de edição no front.
export const saveZones = (cameraId: string, zones: Zone[]) =>
  apiPut<Zone[]>(`/api/zones/${encodeURIComponent(cameraId)}`, { zones });

// GET /api/camconfig/:cameraId → CameraCfg | null (null quando nunca salva → aplicar
// defaults no front). Auth: qualquer usuário autenticado.
export const getCamConfig = (cameraId: string) =>
  apiGet<CameraCfg | null>(`/api/camconfig/${encodeURIComponent(cameraId)}`);
// PUT /api/camconfig/:cameraId {config} → substitui a config; responde a config salva.
// Auth: perfil de configuração (engenharia).
export const saveCamConfig = (cameraId: string, config: CameraCfg) =>
  apiPut<CameraCfg>(`/api/camconfig/${encodeURIComponent(cameraId)}`, { config });

// ── CALIBRAÇÃO de homografia (px normalizado 0..1 ↔ metros) — COMPARTILHADA, por câmera ──
// Mede distância real no chão em metros e projeta o pé da pessoa no plano (base da fusão de tag
// BLE — analises/tags-bluetooth/00-avaliacao-e-plano.md §3). H é computada no cliente por
// src/vision/homography.ts; o hub valida (≥4 pontos, matriz 3×3) e persiste. SÓ números (LGPD).
import type { Matrix3, Vec2 } from "./vision/homography";
export type { Matrix3, Vec2 } from "./vision/homography";
export type CalibrationPoint = { px: Vec2; world: Vec2 };
// station (opcional): ponto de imagem (normalizado 0..1) do chão onde a estação BLE fica — origem
// da correlação RSSI×distância da fusão tag↔pessoa. Ausente = comportamento atual (aditivo). SÓ números.
export type CameraCalibration = { points: CalibrationPoint[]; H: Matrix3; updatedAt: number; station?: Vec2 };
// GET /api/calibration/:cameraId → CameraCalibration | null (null = nunca calibrada). Auth: autenticado.
export const getCalibration = (cameraId: string) =>
  apiGet<CameraCalibration | null>(`/api/calibration/${encodeURIComponent(cameraId)}`);
// PUT /api/calibration/:cameraId {calibration} → substitui; responde a calibração salva.
// Auth: perfil de configuração (engenharia).
export const saveCalibration = (cameraId: string, calibration: CameraCalibration) =>
  apiPut<CameraCalibration>(`/api/calibration/${encodeURIComponent(cameraId)}`, { calibration });

// ── Leituras BLE ao vivo (identidade aumentada por tag — analises/tags-bluetooth/00...) ──────
// A estação varre BLE e reporta ao hub; o hub enriquece com o rótulo cadastrado e RELAYA aos
// painéis via socket `bt-readings`. Este GET é só a SEMENTE (snapshot do que dá pra ver agora)
// para um painel que abre depois — o vivo vem pelo socket. SÓ metadados/RSSI (LGPD): efêmero,
// nunca persistido. `rotulo` = nome da pessoa/tag cadastrada, ou null se a tag não é conhecida.
export type BtReading = { mac: string; rotulo: string | null; rssi: number; stationId?: string };
// GET /api/bt/readings → BtReading[] (as tags visíveis agora). Auth: qualquer autenticado.
export const getBtReadings = () => apiGet<BtReading[]>("/api/bt/readings");

// ── CADASTRO de tags (definir QUEM é a tag: rótulo/pessoa por nome do BT/MAC) ──────────────────
// A estação vê a tag pelo MAC/nome; o cadastro liga isso a um rótulo (a pessoa). Persistido (config).
// Auth de escrita: perfil de configuração (engenharia/superadmin) — coerente com câmeras/zonas.
export type BtTag = { id: string; btName: string; rotulo: string; ativo: boolean; criadoEm: number };
export const getBtTags = () => apiGet<BtTag[]>("/api/bt-tags");
export const createBtTag = (btName: string, rotulo: string) =>
  apiSend<BtTag>("POST", "/api/bt-tags", { btName, rotulo });
export const updateBtTag = (id: string, patch: { rotulo?: string; ativo?: boolean; btName?: string }) =>
  apiSend<BtTag>("PATCH", `/api/bt-tags/${encodeURIComponent(id)}`, patch);
export const deleteBtTag = (id: string) =>
  apiSend<{ ok: true }>("DELETE", `/api/bt-tags/${encodeURIComponent(id)}`);

// ── Câmeras IP/RTSP dinâmicas (superadmin) — contrato-multicamera.md §3 ──────────────────────
// CRUD das câmeras adicionadas em runtime pela UI (persistidas em server/cameras.json). Após
// POST/PATCH/DELETE, a grade se atualiza SOZINHA pelos eventos socket `cameras`/`camera-status`
// que a DashboardPage já escuta — o client só dispara a chamada HTTP.
// SEGURANÇA/LGPD: `url` é SENSÍVEL (pode conter credenciais user:pass). NUNCA logar a url; ao
// exibir/editar, mascarar as credenciais (maskCameraUrl). O contrato aceita rtsp/rtsps/http(s).
export type CameraTransport = "tcp" | "udp" | "http" | "auto"; // só relevante p/ rtsp
export type Camera = {
  id: string;
  label: string;
  url: string; // rtsp:// | rtsps:// | http(s):// — SENSÍVEL (credenciais)
  transport?: CameraTransport;
  fps?: number; // 1–30
  width?: number; // 160–1920
  quality?: number; // 1–31 (menor = melhor)
  enabled: boolean;
  criadoEm: number; // epoch-ms
};
// Corpo do POST (label opcional; url obrigatória). PATCH aceita qualquer subconjunto.
export type NewCamera = {
  label?: string;
  url: string;
  transport?: CameraTransport;
  fps?: number;
  width?: number;
  quality?: number;
  enabled?: boolean;
};

// Validação de URL no cliente (espelha o backend): deve começar com rtsp/rtsps/http/https.
// Bloqueia o POST antes de ir à rede quando a url é inválida.
const CAMERA_URL_RE = /^(rtsps?|https?):\/\/\S+/i;
export function isValidCameraUrl(url: string): boolean {
  return CAMERA_URL_RE.test((url ?? "").trim());
}

// Mascara as credenciais (user:pass@) da url para exibição — mostra o host, oculta o segredo.
// Ex.: rtsp://admin:1234@10.0.0.5:554/stream → rtsp://***@10.0.0.5:554/stream.
// Se não houver credenciais, retorna a url inalterada (só host/caminho, não sensível).
export function maskCameraUrl(url: string): string {
  const s = (url ?? "").trim();
  if (!s) return "";
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, (_m, scheme) => `${scheme}***@`);
}

// GET /api/cameras → Camera[] (url completa; tratar como sensível). Auth: superadmin.
export const listCameras = () => apiGet<Camera[]>("/api/cameras");
// POST /api/cameras → 201 Camera | 400 {error}. Auth: superadmin.
export const createCamera = (body: NewCamera) => apiSend<Camera>("POST", "/api/cameras", body);
// PATCH /api/cameras/:id → 200 Camera. Auth: superadmin.
export const updateCamera = (id: string, patch: Partial<NewCamera>) =>
  apiSend<Camera>("PATCH", `/api/cameras/${encodeURIComponent(id)}`, patch);
// DELETE /api/cameras/:id → 200 {ok:true}. Auth: superadmin.
export const deleteCamera = (id: string) =>
  apiSend<{ ok: true }>("DELETE", `/api/cameras/${encodeURIComponent(id)}`);
