// Configuração da política de alarmes (envs + defaults) e logger compartilhado.
// Fonte única dos parâmetros lidos do ambiente; todos os submódulos importam daqui
// para que os defaults/thresholds fiquem coerentes.
//
// Variáveis de ambiente (todas com defaults sensatos):
//   ALARM_POLICY_ENABLED   (default "1")     Liga a política. Se "0"/"false",
//                                            evaluate só classifica e repassa
//                                            (retrocompatível, sem dedup/colapso/
//                                            flap). Shelving e métricas continuam.
//   ALARM_DEDUP_MS         (default 60000)   Janela (ms) do dedup temporal.
//   ALARM_FLOOD_WINDOW_MS  (default 15000)   Janela (ms) de contagem de rajada.
//   ALARM_FLOOD_THRESHOLD  (default 8)       Limiar de rajada por câmera.
//   ALARM_FLOOD_SUMMARY_MS (default 60000)   Intervalo mín. entre resumos.
//   ALARM_LOG_LEVEL        (default "info")  Nível do logger pino do módulo.
//   --- Shelving ---
//   ALARM_SHELVE_MAX_MS     (default 14400000 = 4 h)  Teto da duração de um shelve.
//   ALARM_SHELVE_DEFAULT_MS (default 1800000 = 30 min) Duração default do shelve.
//   ALARM_SHELVES_FILE      (default server/alarm-shelves.json) JSON das shelves.
//   --- Métricas / racionalização ---
//   ALARM_RATE_WINDOW_MS    (default 600000 = 10 min) Janela de taxa e % críticos.
//   ALARM_CRITICAL_TARGET_PCT (default 5)    Meta (%) máx. de "critical".
//   ALARM_RATE_MIN_SAMPLE   (default 10)     Amostra mín. antes de avaliar a %.
//   ALARM_RATE_WARN_THROTTLE_MS (default 600000) Throttle do aviso de % crítico.
//   --- Anti-flapping ---
//   ALARM_FLAP_ENABLED      (default "1")    Liga o anti-chattering.
//   ALARM_FLAP_WINDOW_MS    (default 600000 = 10 min) Janela de re-disparos.
//   ALARM_FLAP_THRESHOLD    (default 5)      Limiar de re-disparos p/ cooldown.
//   ALARM_FLAP_COOLDOWN_MS  (default 300000 = 5 min) Duração do cooldown.
const { statePath } = require("../state-dir");

const log = require("pino")({ name: "alarm", level: process.env.ALARM_LOG_LEVEL || "info" });

const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.ALARM_POLICY_ENABLED ?? "1"));
const DEDUP_MS = Number(process.env.ALARM_DEDUP_MS ?? 60_000);
const FLOOD_WINDOW_MS = Number(process.env.ALARM_FLOOD_WINDOW_MS ?? 15_000);
const FLOOD_THRESHOLD = Number(process.env.ALARM_FLOOD_THRESHOLD ?? 8);
const FLOOD_SUMMARY_MS = Number(process.env.ALARM_FLOOD_SUMMARY_MS ?? 60_000);

// Shelving
const SHELVE_MAX_MS = Number(process.env.ALARM_SHELVE_MAX_MS ?? 14_400_000);
const SHELVE_DEFAULT_MS = Number(process.env.ALARM_SHELVE_DEFAULT_MS ?? 1_800_000);
// Arquivo de RUNTIME p/ persistir as shelves ativas (gitignored). O default
// aponta para server/alarm-shelves.json (este módulo vive em server/alarm/, daí
// o ".." para voltar a server/, preservando o caminho histórico).
const SHELVES_FILE =
  process.env.ALARM_SHELVES_FILE || statePath("alarm-shelves.json");

// Métricas / racionalização
const RATE_WINDOW_MS = Number(process.env.ALARM_RATE_WINDOW_MS ?? 600_000);
const CRITICAL_TARGET_PCT = Number(process.env.ALARM_CRITICAL_TARGET_PCT ?? 5);
const RATE_MIN_SAMPLE = Number(process.env.ALARM_RATE_MIN_SAMPLE ?? 10);
const RATE_WARN_THROTTLE_MS = Number(process.env.ALARM_RATE_WARN_THROTTLE_MS ?? 600_000);
const RATE_HISTORY_MS = Math.max(RATE_WINDOW_MS, 3_600_000); // retém >=1 h p/ métrica horária

// Anti-flapping
const FLAP_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.ALARM_FLAP_ENABLED ?? "1"));
const FLAP_WINDOW_MS = Number(process.env.ALARM_FLAP_WINDOW_MS ?? 600_000);
const FLAP_THRESHOLD = Number(process.env.ALARM_FLAP_THRESHOLD ?? 5);
const FLAP_COOLDOWN_MS = Number(process.env.ALARM_FLAP_COOLDOWN_MS ?? 300_000);

module.exports = {
  log,
  ENABLED,
  DEDUP_MS,
  FLOOD_WINDOW_MS,
  FLOOD_THRESHOLD,
  FLOOD_SUMMARY_MS,
  SHELVE_MAX_MS,
  SHELVE_DEFAULT_MS,
  SHELVES_FILE,
  RATE_WINDOW_MS,
  CRITICAL_TARGET_PCT,
  RATE_MIN_SAMPLE,
  RATE_WARN_THROTTLE_MS,
  RATE_HISTORY_MS,
  FLAP_ENABLED,
  FLAP_WINDOW_MS,
  FLAP_THRESHOLD,
  FLAP_COOLDOWN_MS,
};
