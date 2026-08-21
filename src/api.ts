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
// Mede distância real no chão em metros e projeta o pé da pessoa no plano. H é computada no
// cliente por src/vision/homography.ts; o hub valida (≥4 pontos, matriz 3×3) e persiste.
// SÓ números (LGPD). (Os campos BLE — mac/station/stations/refTag — migraram com a fusão para
// o repo mvp_trilateracao_BLE; ADR-018. O contrato do hub é aditivo: removê-los aqui não quebra.)
import type { Matrix3, Vec2 } from "./vision/homography";
export type { Matrix3, Vec2 } from "./vision/homography";
export type CalibrationPoint = { px: Vec2; world: Vec2 };
export type CameraCalibration = {
  points: CalibrationPoint[];
  H: Matrix3;
  updatedAt: number;
};
// GET /api/calibration/:cameraId → CameraCalibration | null (null = nunca calibrada). Auth: autenticado.
export const getCalibration = (cameraId: string) =>
  apiGet<CameraCalibration | null>(`/api/calibration/${encodeURIComponent(cameraId)}`);
// PUT /api/calibration/:cameraId {calibration} → substitui; responde a calibração salva.
// Auth: perfil de configuração (engenharia).
export const saveCalibration = (cameraId: string, calibration: CameraCalibration) =>
  apiPut<CameraCalibration>(`/api/calibration/${encodeURIComponent(cameraId)}`, { calibration });

// (A superfície BLE — BtReading/getBtReadings*/TagLocation/BtTag/BtStation/Floorplan/
//  Fingerprint — migrou para o repo mvp_trilateracao_BLE; ADR-018.)

// ── TURNOS de trabalho (cadastro GLOBAL — spec-turnos-por-zona F1) ────────────────────────────
// Fonte única do "quando a área deveria estar trabalhando". A VALIDAÇÃO DE NEGÓCIO mora no
// SERVIDOR (duração/dias/pausas — server/shifts.js): o client só transporta e a UI exibe o erro
// que o hub devolver (400 com mensagem). `dias` = dias da semana em que o turno INICIA
// (0=dom..6=sáb — D1/D5); `inicio`/`fim` = "HH:MM" wall-clock do site; fim ≤ início ⇒ o turno
// termina no dia seguinte (D2 — a UI mostra "+1 dia"). GET: qualquer autenticado; escrita:
// perfil de configuração (canConfigure).
export type ShiftPausa = { inicio: string; duracaoMin: number };
export type Shift = {
  id: string;
  nome: string;
  dias: number[];
  inicio: string;
  fim: string;
  pausas: ShiftPausa[];
  ativo: boolean;
  criadoEm: number;
};
// Corpo do POST (pausas/ativo opcionais). PATCH aceita qualquer subconjunto — o servidor
// revalida a entidade inteira mesclada (patch inconsistente → 400, estado intacto).
export type NewShift = {
  nome: string;
  dias: number[];
  inicio: string;
  fim: string;
  pausas?: ShiftPausa[];
  ativo?: boolean;
};
export const getShifts = () => apiGet<Shift[]>("/api/shifts");
export const createShift = (s: NewShift) => apiSend<Shift>("POST", "/api/shifts", s);
export const updateShift = (id: string, patch: Partial<NewShift>) =>
  apiSend<Shift>("PATCH", `/api/shifts/${encodeURIComponent(id)}`, patch);
export const deleteShift = (id: string) =>
  apiSend<{ ok: true }>("DELETE", `/api/shifts/${encodeURIComponent(id)}`);

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

// ── Câmeras CONECTADAS agora (as da grade da central) — busca do shell ───────────────────────
// GET /api/cameras/connected → { cameras: [{ id, label, online }] }. Diferente do registro
// /api/cameras (superadmin-only, com url SENSÍVEL), esta lista é só identidade+estado — sem url —
// e vale para QUALQUER autenticado; inclui nós locais/webcam que não têm cadastro IP.
export type ConnectedCamera = { id: string; label: string; online: boolean };
export const getConnectedCameras = () =>
  apiGet<{ cameras: ConnectedCamera[] }>("/api/cameras/connected");

// ── SAÚDE DO MOTOR DE ANÁLISE (ADR-009) — GET /api/analysis/status ───────────────────────────
// O motor mede muita coisa e, até esta onda, NINGUÉM no front consumia: motor desligado, worker
// morrendo em loop, gate cegando a câmera e Postgres caído se pareciam todos com "0 pessoas".
// Falso-OK — a classe que a doutrina põe acima de erro. Este é o cliente do sensor.
//
// O shape é CONTRATO ADITIVO do hub (server/analysis/telemetry.js, com telemetry.test.js
// travando-o lá). AQUI ele é lido DEFENSIVAMENTE: tudo que nasceu depois do primeiro corte
// (`gate`, `autoscale`, `worker`, `tracker`, `autoMask`, `go2rtcPull`) é OPCIONAL no tipo —
// um hub mais antigo não manda, e "campo ausente" tem de virar "não sei", nunca "está bom".
// SÓ NÚMEROS/METADADOS (LGPD): nenhuma imagem trafega por aqui.
// Auth: qualquer usuário autenticado (requireAuth em server/routes/analysis.js).

/** Pool de workers de inferência (worker-host.stats()). */
export type AnalysisWorker = {
  ready: boolean; // ≥1 worker pronto
  size: number; // workers no pool
  readyCount: number; // quantos estão prontos AGORA
  cpuPct: number; // agregado do pool (soma dos N; 100% = 1 core inteiro)
  respawns: number; // reinícios acumulados desde o boot do hub
  pids?: (number | null)[];
  workers?: {
    id: number;
    ready: boolean;
    pid: number | null;
    cpuPct: number;
    respawns: number;
    load: number;
  }[];
};

/** Auto-dimensionamento do modelo (autoscale.js): tier ativo + histerese. */
export type AnalysisAutoscale = {
  mode: "auto" | "pin"; // "pin" = fixado por ANALYSIS_MODEL/PATH
  tier: "n" | "s" | "m" | null; // null sob override de path (fora do catálogo)
  pin: string | null; // por que está fixo, se estiver
  choked: number; // janelas afogadas acumuladas (rumo a rebaixar)
  idle: number; // janelas folgadas acumuladas (rumo a subir)
  lastSwitchAt: number;
};

/** Sensor do gate de movimento POR CÂMERA — janela rolante de 60 SEGUNDOS (não "última hora"). */
export type AnalysisGate = {
  /** Rodadas PULADAS com ≥1 track vivo NÃO estacionário: cegueira medida, não opinião. */
  skipMoving1m: number;
  ratioP50: number;
  ratioP95: number;
  /** Motivo de cada rodada da janela (gateada ou não). A SOMA = total de rodadas em 60s. */
  reasons1m: Record<string, number>;
};

/**
 * IDADE DO QUADRO no despacho ao worker (transporte câmera→hub, SEM o custo da inferência —
 * esse é o `lastMs`). `null` no payload = nenhuma rodada despachada na janela de 60s (câmera
 * parada ou gateada), que NÃO é o mesmo que idade zero.
 */
export type AnalysisFrameAge = {
  p50: number; // mediana, ms
  p90: number; // ms
  n: number; // rodadas medidas na janela
  /** 2ª metade da janela menos a 1ª, em ms. **Positivo e grande = FILA** (o atraso acumula) —
   *  fila não aparece na mediana, aparece na tendência. Ver server/analysis/telemetry.js. */
  trend: number;
};

export type AnalysisCamera = {
  fps: number; // inferências CONCLUÍDAS por segundo nos últimos 60s (0 = nada analisado)
  targetFps: number; // cadência efetiva pretendida (foco > linha > normal; 0 se fadiga)
  focused: boolean;
  queue: number;
  skipped1m: number; // rodadas puladas pelo gate em 60s (economia + cegueira somadas)
  skippedTotal?: number;
  motion: number; // último ratio de movimento (0..1)
  gate?: AnalysisGate;
  lastMs: number; // duração da última inferência
  frameAge?: AnalysisFrameAge | null; // idade captura→despacho (aditivo — hubs antigos não mandam)
  dets1m: number;
  excluded1m: number; // pessoas suprimidas por zona de exclusão (60s)
  automasked1m?: number; // pessoas suprimidas pela auto-máscara (60s)
  autoMask?: { mode: string; suppressed: number; suggestions?: unknown[] };
  longRange?: boolean;
  fadiga: boolean; // câmera modo=Operador: analisada NO NAVEGADOR, não no hub (por desenho)
  source?: string; // "relay" | "go2rtc"
  tracker?: { reassoc1m: number; reassocTotal: number; lost: number };
};

export type AnalysisStatus = {
  enabled: boolean; // motor ligado no hub
  model: string; // arquivo do modelo ativo
  targetFps: number;
  lineFps: number;
  focusFps: number;
  focused: string[];
  autoMask?: { mode: string };
  motionGate: {
    enabled: boolean;
    ratio: number;
    probeMs: number;
    probeFocusMs: number;
    thumb: string;
    skipped1m: number;
    skippedTotal: number;
  };
  autoscale?: AnalysisAutoscale;
  worker?: AnalysisWorker;
  go2rtcPull?: {
    active: boolean;
    mode: string;
    streams: number;
    transport?: string;
    streaming?: number;
  };
  /** Uma entrada por câmera VIVA no motor. Câmera sem frame há >5 min SAI daqui (prune). */
  perCamera: Record<string, AnalysisCamera>;
};

// GET /api/analysis/status — instantâneo do motor. Auth: logado.
export const getAnalysisStatus = () => apiGet<AnalysisStatus>("/api/analysis/status");

// ── Ponte DVR (suporte) — plano-hub.md §Frontend + contratos §3/§4/§5 ─────────────────────────
// Domínio DVR do hub: o SUPORTE lista os DVRs por cliente, abre a web do DVR pelo túnel (nova aba)
// e encerra a sessão de acesso; a Auditoria registra quem fez o quê. Auth: Bearer do hub (o gate de
// papel é `superadmin`, como Usuários) — NÃO há auth nova aqui: o coletor tem trilha própria
// (x-coletor-*, no app), fora do front do suporte. SÓ metadados/hash (LGPD/invariante 6): marca/
// modelo/ip/porta + estado de sessão; a CREDENCIAL do DVR nunca trafega (contratos §3, §8 Leitura A).
export type DvrSessaoStatus = "ativa" | "encerrada";

// Sessão de acesso remoto (contratos §4). Existindo e `ativa`, há túnel e a web do DVR é alcançável
// em https://<hostPublico> — que DEVE abrir em NOVA ABA, nunca em iframe (contratos §5).
export type DvrSessao = {
  id: string;
  status: DvrSessaoStatus; // ⚠ o campo é `status` (não `estado`) — contratos §4
  hostPublico: string; // subdomínio por DVR: slug(cliente)-<dvr>.dvr.box3.software
  remotePort?: number;
  aberta_em?: number; // epoch ms
  ultima_atividade?: number;
  encerrada_em?: number | null;
};

// DVR cadastrado por um coletor de um cliente (contratos §3: marca/modelo/ip/porta; sem senha).
export type DvrItem = {
  id: string;
  cliente_id: string; // campo-tag do agrupamento por cliente (plano-hub.md)
  cliente_nome?: string;
  coletor_id?: string;
  marca: string;
  modelo: string;
  ip: string;
  porta?: number;
  sessao?: DvrSessao | null; // sessão ATIVA quando existe; null/ausente ⇒ sem acesso aberto
};
// GET /api/dvr/dvrs → DVRs visíveis ao técnico (o servidor filtra por canAccess). Auth: superadmin.
export const listDvrs = () => apiGet<DvrItem[]>("/api/dvr/dvrs");
// POST /api/dvr/sessao/:id/encerrar → encerra a sessão pelo técnico (idempotente — contratos §4).
export const encerrarDvrSessao = (sessaoId: string) =>
  apiSend<{ ok: true }>("POST", `/api/dvr/sessao/${encodeURIComponent(sessaoId)}/encerrar`);

// Auditoria append-only (contratos §4/§5): abrir/encerrar/timeout/acesso do técnico/registro do DVR.
// Só metadados. `ts` = "quando"; `ator` = "quem"; `coletor_id` = "qual coletor".
export type DvrAuditItem = {
  id: string;
  ts: number; // epoch ms
  acao: string; // sessao.abrir | sessao.encerrar | sessao.timeout | acesso.tecnico | dvr.registrar | dvr.atualizar
  ator?: string;
  coletor_id?: string;
  cliente_id?: string;
  dvr_id?: string;
  detalhe?: string;
};
// GET /api/dvr/auditoria?coletor= → eventos ordenados por ts desc. `coletor` opcional (o UI também
// filtra no cliente a partir dos coletores presentes). Auth: superadmin.
export function listDvrAuditoria(params?: { coletor?: string }): Promise<DvrAuditItem[]> {
  const q = new URLSearchParams();
  if (params?.coletor) q.set("coletor", params.coletor);
  const qs = q.toString();
  return apiGet<DvrAuditItem[]>(`/api/dvr/auditoria${qs ? `?${qs}` : ""}`);
}

// Enrollment (contratos §3/§8): cria um coletor (liga empresa Box3 ↔ cliente do visão) e EMITE um
// enrollmentToken de USO ÚNICO + curta validade. O token cru sai UMA vez, aqui — vai no QR que o leigo
// escaneia no app; o hub guarda só o hash. `cliente_id` + `empresa_id_box3` são obrigatórios.
export type NovoColetor = {
  cliente_id: string;
  empresa_id_box3: string;
  nome?: string;
};
export type DvrColetorCriado = {
  id: string;
  cliente_id: string;
  empresa_id_box3: string;
  nome?: string;
  enrollmentToken: string; // SENSÍVEL: uso único; só aparece nesta resposta (vai no QR). Nunca relogar.
  expira: number; // epoch ms — quando o enrollmentToken expira.
};
// POST /api/dvr/coletores → cria o coletor e devolve o enrollmentToken. Auth: superadmin.
export const criarDvrColetor = (dados: NovoColetor) =>
  apiSend<DvrColetorCriado>("POST", "/api/dvr/coletores", dados);
