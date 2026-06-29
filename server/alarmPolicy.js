// ============================================================================
// Política de alarmes (ISA-18.2 / EEMUA 191) — Onda A, item 2 + Onda C, item 14
// ----------------------------------------------------------------------------
// Filtro/agregador aplicado ANTES do envio aos canais (Andon webhook em
// alerts.js e WhatsApp em dispatch.js). O objetivo é tratar o Andon/WhatsApp
// como um SISTEMA DE ALARME (acionável, priorizado, sem inundação) e não como
// um stream cru de eventos — o antídoto contra "alerta falso em massa".
//
// O ponto de entrada é evaluate(p). Ele recebe o mesmo payload do socket
// "alert" ({ text, ts, [cameraId], [zona], [tipo] }) e devolve UMA decisão:
//   • null                        → alerta suprimido (não envia a nenhum canal)
//   • { text, ts, priority, ... } → alerta a enviar (texto pode ser um RESUMO
//                                    de causa-raiz quando houve inundação)
// A decisão é tomada UMA vez e roteada para os dois canais, garantindo que os
// contadores de inundação não sejam contados em dobro.
//
// Mecanismos implementados:
//   1) Deduplicação temporal — suprime repetições da MESMA chave lógica
//      (`${cameraId}|${zona}|${tipo}`) dentro de uma janela com TTL.
//      Generaliza o dedup-por-texto que já existia em alerts.js/dispatch.js.
//   2) Supressão de inundação (flood suppression) — quando uma câmera dispara
//      muitos alertas em rajada (ex.: feed caiu → todas as zonas viram VAZIA),
//      colapsa em UM alerta de resumo/causa-raiz ("N zonas afetadas na câmera
//      X") em vez de N alertas individuais.
//   3) Priorização em 3 níveis (advisory / high / critical) anexada como
//      `priority` ao resultado. Meta de design (EEMUA 191): manter a fração de
//      alertas "critical" baixa — recomendação ≤ 5% do total. Isso é alcançado
//      reservando `critical` para condições que exigem intervenção imediata
//      (marcador ⚠ / falha de feed / resumo de inundação) e classificando o
//      resto como `high` (atenção) ou `advisory` (informativo).
//
// Refinamento "produto maduro" (Onda C, item 14) — camadas ADICIONAIS,
// retrocompatíveis (a assinatura/retorno de evaluate() não muda):
//   4) Shelving com expiração (ISA-18.2) — silenciar temporariamente uma chave
//      de alarme (`cameraId|zona|tipo`, com curinga "*" por segmento) por uma
//      duração; enquanto "shelved" a chave é suprimida e o shelve EXPIRA
//      sozinho. Útil para manutenção/limpeza programada. Funções: shelve(),
//      unshelve(), listShelved(), isShelved(), shelveKeyFor().
//      PERSISTÊNCIA: as shelves ATIVAS sobrevivem a reinício (gravadas em
//      server/alarm-shelves.json e restauradas no boot) — manutenção programada
//      não pode ser "esquecida" por um deploy/restart. Ainda NÃO é compartilhado
//      entre instâncias (cada processo tem seu arquivo; coordenação multi-
//      instância via Postgres fica para outra onda, conforme ADR-005).
//   5) Métricas de taxa / racionalização (EEMUA 191) — contadores em memória
//      de alarmes EMITIDOS por janela e por prioridade, expostos via metrics()
//      para uma futura tela de "saúde de alarmes". Loga um aviso (pino) quando
//      a fração de "critical" excede a meta (default 5%) na janela.
//   6) Anti-flapping (chattering) — se a MESMA chave re-dispara muitas vezes
//      numa janela (toggla rápido), aplica um cooldown (off-delay) suprimindo
//      a chave por um intervalo, evitando "metralhadora" de alertas.
//
// Toda supressão/colapso é logada (pino) para observabilidade.
//
// ----------------------------------------------------------------------------
// Variáveis de ambiente (todas com defaults sensatos):
//
//   ALARM_POLICY_ENABLED   (default "1")     Liga a política. Se "0"/"false",
//                                            evaluate só classifica e repassa
//                                            (comportamento retrocompatível,
//                                            sem dedup/colapso/flap). Shelving e
//                                            métricas continuam ativos (são
//                                            camadas opt-in/observacionais).
//   ALARM_DEDUP_MS         (default 60000)   Janela (ms) do dedup temporal por
//                                            chave lógica. Repetição da mesma
//                                            chave dentro da janela é suprimida.
//   ALARM_FLOOD_WINDOW_MS  (default 15000)   Janela (ms) deslizante de contagem
//                                            de rajada por câmera.
//   ALARM_FLOOD_THRESHOLD  (default 8)       Nº de alertas da MESMA câmera na
//                                            janela acima do qual a câmera entra
//                                            em "modo inundação" e os alertas
//                                            passam a ser colapsados em resumo.
//   ALARM_FLOOD_SUMMARY_MS (default 60000)   Intervalo mínimo (ms) entre dois
//                                            resumos de inundação da mesma
//                                            câmera (evita repetir o resumo a
//                                            cada novo alerta da rajada).
//   ALARM_LOG_LEVEL        (default "info")  Nível do logger pino deste módulo.
//
//   --- Shelving (item 4) ---
//   ALARM_SHELVE_MAX_MS     (default 14400000 = 4 h)  Teto da duração de um
//                                            shelve (clamp de segurança p/ que
//                                            ninguém silencie "para sempre").
//   ALARM_SHELVE_DEFAULT_MS (default 1800000 = 30 min) Duração usada quando
//                                            shelve() é chamado sem ms.
//
//   --- Métricas / racionalização (item 5) ---
//   ALARM_RATE_WINDOW_MS    (default 600000 = 10 min) Janela usada para taxa e
//                                            % de críticos (alinha com a métrica
//                                            EEMUA "pico ≤10 alarmes/10 min").
//   ALARM_CRITICAL_TARGET_PCT (default 5)    Meta (%) máx. de alarmes "critical"
//                                            na janela; acima disso loga aviso.
//   ALARM_RATE_MIN_SAMPLE   (default 10)     Mín. de alarmes na janela antes de
//                                            avaliar a % de críticos (evita
//                                            falso positivo com amostra pequena).
//   ALARM_RATE_WARN_THROTTLE_MS (default 600000) Intervalo mín. entre dois
//                                            avisos de "% crítico acima da meta".
//
//   --- Anti-flapping (item 6) ---
//   ALARM_FLAP_ENABLED      (default "1")    Liga o anti-chattering.
//   ALARM_FLAP_WINDOW_MS    (default 600000 = 10 min) Janela de contagem de
//                                            re-disparos da mesma chave.
//   ALARM_FLAP_THRESHOLD    (default 5)      Nº de emissões da mesma chave na
//                                            janela acima do qual entra cooldown.
//   ALARM_FLAP_COOLDOWN_MS  (default 300000 = 5 min) Duração do cooldown
//                                            (off-delay) em que a chave é
//                                            suprimida após detectar chattering.
//
//   --- Persistência das shelves (item 7) ---
//   ALARM_SHELVES_FILE      (default server/alarm-shelves.json) Caminho do JSON
//                                            local que persiste as shelves ATIVAS.
// ============================================================================
//
// PERSISTÊNCIA (apenas as SHELVES sobrevivem a reinício):
//   Somente o conjunto de shelves ATIVAS é persistido em disco (JSON local). O
//   motivo é semântico: um shelve representa uma decisão DELIBERADA do operador
//   de silenciar um alarme durante manutenção/limpeza programada — essa intenção
//   precisa sobreviver a deploy/restart/crash; caso contrário um restart no meio
//   da manutenção ressuscitaria a enxurrada de alertas que o operador silenciou.
//   As demais estruturas (dedup, floodWin/floodState, flap, emitLog/métricas)
//   permanecem VOLÁTEIS de propósito: são janelas deslizantes de curtíssimo prazo
//   e contadores observacionais — após um restart o estado correto é "começar
//   limpo" (re-derivado naturalmente do fluxo de eventos), e persisti-los só
//   adicionaria risco de estado obsoleto/corrompido sem benefício operacional.
//
//   Arquivo: server/alarm-shelves.json  → é conteúdo de RUNTIME (efêmero,
//   específico da instância). DEVE entrar no .gitignore (junto de alarms.json,
//   camcfg.json etc., conforme ADR-005). Não versione este arquivo.
//
//   Robustez: a escrita é atômica (grava em arquivo temporário e renomeia por
//   cima) e shelves expiradas são podadas ANTES de gravar. Toda I/O é envolvida
//   em try/catch e qualquer falha é apenas logada via pino — uma falha de disco
//   NUNCA pode derrubar a política de alarmes. A restauração ocorre de forma
//   preguiçosa/idempotente no require do módulo (não exige mudança em index.js);
//   há também init() exportado para quem preferir inicialização explícita.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");
const { classify } = require("./dispatch");

const log = require("pino")({ name: "alarm", level: process.env.ALARM_LOG_LEVEL || "info" });

const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.ALARM_POLICY_ENABLED ?? "1"));
const DEDUP_MS = Number(process.env.ALARM_DEDUP_MS ?? 60_000);
const FLOOD_WINDOW_MS = Number(process.env.ALARM_FLOOD_WINDOW_MS ?? 15_000);
const FLOOD_THRESHOLD = Number(process.env.ALARM_FLOOD_THRESHOLD ?? 8);
const FLOOD_SUMMARY_MS = Number(process.env.ALARM_FLOOD_SUMMARY_MS ?? 60_000);

// Shelving
const SHELVE_MAX_MS = Number(process.env.ALARM_SHELVE_MAX_MS ?? 14_400_000);
const SHELVE_DEFAULT_MS = Number(process.env.ALARM_SHELVE_DEFAULT_MS ?? 1_800_000);
// Arquivo de RUNTIME para persistir as shelves ativas (deve ser gitignored).
const SHELVES_FILE = process.env.ALARM_SHELVES_FILE || path.join(__dirname, "alarm-shelves.json");

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

// Estado em memória (limpeza preguiçosa para não crescer sem limite).
const dedup = new Map(); // logicalKey -> ts do último envio
const floodWin = new Map(); // cameraId -> array de ts dos alertas recentes
const floodState = new Map(); // cameraId -> { zonas:Set, lastSummaryTs, n }
const shelved = new Map(); // shelveKey (normalizada) -> { expiresAt, since, ms, reason }
const flap = new Map(); // logicalKey -> { fires:[ts...], cooldownUntil }
const emitLog = []; // [{ ts, priority }] de alarmes EMITIDOS (para metrics())
let lastRateWarnTs = 0; // throttle do aviso de % crítico

// ---------------------------------------------------------------------------
// Derivação de chave lógica a partir do payload (com fallback por texto).
// O painel hoje emite só { text, ts }; quando vierem cameraId/zona/tipo
// explícitos eles têm prioridade.
// ---------------------------------------------------------------------------
function pickCamera(p, text) {
  if (p.cameraId) return String(p.cameraId).trim();
  const i = text.indexOf(": ");
  if (i > 0 && i < 60) return text.slice(0, i).trim(); // padrão "Local: mensagem"
  return "_";
}

function pickBody(p, text) {
  const i = text.indexOf(": ");
  if (i > 0 && i < 60) return text.slice(i + 2).trim();
  return text;
}

function pickZona(p, text) {
  if (p.zona) return String(p.zona).trim().toLowerCase();
  const m = text.match(/\b(zona|área|area|doca|setor)\s*[:#]?\s*([\wà-ú-]+)/i);
  if (m) return `${m[1]}${m[2]}`.toLowerCase();
  return "";
}

// Prioridade em 3 níveis. critical é reservado (mantém o % baixo, meta ≤5%).
function priorityOf(text, meta) {
  if (meta.critico) return "critical"; // marcador ⚠ no texto
  if (
    /\boffline\b|sem[\s-]?sinal|sem[\s-]?conex|feed\s+caiu|c[âa]mera.*(caiu|fora)|desconect|timeout|falha/i.test(
      text,
    )
  ) {
    return "high";
  }
  if (/parad|parou|risco|fadiga|sonol/i.test(text)) return "high";
  return "advisory";
}

function maxPriority(a, b) {
  const rank = { advisory: 0, high: 1, critical: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function makeDecision(text, ts, priority, extra) {
  return Object.assign({ text, ts, priority, summary: false }, extra);
}

// ---------------------------------------------------------------------------
// Supressão de inundação por câmera. Retorna a decisão (pass-through, resumo
// colapsado) ou null (suprimido por já estar colapsado na janela).
// ---------------------------------------------------------------------------
function applyFlood(cameraId, zona, text, ts, priority, now, meta) {
  // Sem câmera identificável não dá para agrupar com segurança → repassa.
  if (cameraId === "_")
    return makeDecision(text, ts, priority, {
      cameraId,
      zona,
      tipo: meta.tipo,
      critico: meta.critico,
    });

  let win = floodWin.get(cameraId);
  if (!win) {
    win = [];
    floodWin.set(cameraId, win);
  }
  while (win.length && now - win[0] > FLOOD_WINDOW_MS) win.shift(); // poda janela
  win.push(now);

  const flooding = win.length > FLOOD_THRESHOLD;

  if (!flooding) {
    if (floodState.has(cameraId)) floodState.delete(cameraId); // episódio encerrado
    return makeDecision(text, ts, priority, {
      cameraId,
      zona,
      tipo: meta.tipo,
      critico: meta.critico,
    });
  }

  // Em inundação: colapsa.
  let st = floodState.get(cameraId);
  if (!st) {
    st = { zonas: new Set(), lastSummaryTs: 0, n: 0 };
    floodState.set(cameraId, st);
  }
  if (zona) st.zonas.add(zona);
  st.n++;

  if (now - st.lastSummaryTs >= FLOOD_SUMMARY_MS) {
    st.lastSummaryTs = now;
    // breadth da rajada: distintas zonas vistas no colapso ∪ tamanho da janela
    // (a janela inclui os alertas que passaram antes do colapso disparar).
    const nZonas = Math.max(st.zonas.size, win.length);
    const resumo = `⚠ ${cameraId}: rajada de alertas — ${nZonas} zona(s) afetada(s) (possível queda de feed)`;
    log.warn(
      { cameraId, zonas: nZonas, suprimidos: st.n, janelaMs: FLOOD_WINDOW_MS },
      "[alarm] inundação colapsada em resumo",
    );
    return makeDecision(resumo, ts, maxPriority(priority, "critical"), {
      cameraId,
      zona: "*",
      tipo: meta.tipo,
      critico: true,
      summary: true,
      count: nZonas,
    });
  }

  log.debug({ cameraId, suprimidos: st.n }, "[alarm] alerta suprimido (inundação ativa)");
  return null;
}

// ---------------------------------------------------------------------------
// SHELVING (ISA-18.2) — silenciar temporariamente uma chave, com expiração.
// Chave: "cameraId|zona|tipo". Cada segmento aceita "*" como curinga (ex.:
// "cam-doca-1|*|*" silencia TODA a câmera durante a manutenção). Segmentos são
// normalizados (trim + lowercase). Estado em memória, PERSISTIDO em disco
// (alarm-shelves.json) para sobreviver a reinício.
// ---------------------------------------------------------------------------
function normSeg(s) {
  const v = String(s ?? "")
    .trim()
    .toLowerCase();
  return v === "" ? "*" : v; // segmento vazio vira curinga (silencia a dimensão)
}

// Normaliza uma chave de shelve livre ("cam|zona|tipo", curingas opcionais) em
// exatamente 3 segmentos. Faltando segmentos → completados com "*".
function normShelveKey(key) {
  const parts = String(key ?? "").split("|");
  const cam = normSeg(parts[0]);
  const zona = normSeg(parts[1]);
  const tipo = normSeg(parts[2]);
  return `${cam}|${zona}|${tipo}`;
}

// --- Persistência das shelves (JSON local, resiliente) ----------------------
// Só as SHELVES são persistidas (ver cabeçalho). Escrita atômica + try/catch;
// falha de I/O nunca derruba a política — apenas loga via pino.

// Grava as shelves ATIVAS (poda expiradas antes). Atômico: escreve em .tmp e
// renomeia por cima, evitando arquivo parcial/corrompido se o processo morrer
// no meio da escrita.
function saveShelves() {
  try {
    const now = Date.now();
    const arr = [];
    for (const [k, info] of shelved) {
      if (now >= info.expiresAt) {
        shelved.delete(k);
        continue;
      } // poda expiradas
      arr.push({
        key: k,
        expiresAt: info.expiresAt,
        since: info.since,
        ms: info.ms,
        reason: info.reason,
        by: info.by,
      });
    }
    const tmp = `${SHELVES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, SHELVES_FILE);
  } catch (e) {
    log.error(
      { err: e.message, file: SHELVES_FILE },
      "[alarm] falha ao persistir shelves (ignorada)",
    );
  }
}

// Lê o JSON, descarta shelves já expiradas e repovoa o Map. Idempotente: pode
// ser chamada várias vezes (no require e/ou via init()) sem efeito colateral.
function loadShelves() {
  try {
    const raw = fs.readFileSync(SHELVES_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    let restored = 0,
      expired = 0;
    for (const it of arr) {
      if (!it || typeof it.key !== "string") continue;
      const k = normShelveKey(it.key);
      const expiresAt = Number(it.expiresAt);
      if (!Number.isFinite(expiresAt) || now >= expiresAt) {
        expired++;
        continue;
      } // descarta expiradas
      shelved.set(k, {
        expiresAt,
        since: Number(it.since) || now,
        ms: Number(it.ms) || expiresAt - now,
        reason: String(it.reason ?? ""),
        by: String(it.by ?? ""),
      });
      restored++;
    }
    if (restored || expired)
      log.info({ restored, expired, file: SHELVES_FILE }, "[alarm] shelves restauradas do disco");
  } catch (e) {
    // ENOENT (arquivo ainda não existe) é normal no primeiro boot → silencioso.
    if (e.code !== "ENOENT")
      log.error(
        { err: e.message, file: SHELVES_FILE },
        "[alarm] falha ao restaurar shelves (ignorada)",
      );
  }
}

let _loaded = false;
// Restauração preguiçosa/idempotente. Chamada no require (não exige init() em
// index.js) e também exportada como init() para inicialização explícita.
function init() {
  if (_loaded) return;
  _loaded = true;
  loadShelves();
}

// Constrói a chave de shelve (não-curinga) a partir de um payload de alerta,
// usando a MESMA derivação de cameraId/zona/tipo do evaluate(). Útil para a UI
// montar a chave a silenciar a partir de um alerta exibido.
function shelveKeyFor(p) {
  const text = String((p && p.text) || "").trim();
  const cameraId = pickCamera(p || {}, text);
  const zona = pickZona(p || {}, text);
  const tipo = (p && p.tipo) || (text ? classify(text).tipo : "");
  return `${normSeg(cameraId)}|${normSeg(zona)}|${normSeg(tipo)}`;
}

function segMatch(pattern, actual) {
  return pattern === "*" || pattern === actual;
}

// Verifica se um alarme (cameraId/zona/tipo) está coberto por algum shelve
// ativo. Poda os expirados. Retorna a chave de shelve casada ou null.
function isShelved(cameraId, zona, tipo, now = Date.now()) {
  if (!shelved.size) return null;
  const aCam = normSeg(cameraId);
  const aZona = normSeg(zona);
  const aTipo = normSeg(tipo);
  for (const [k, info] of shelved) {
    if (now >= info.expiresAt) {
      shelved.delete(k);
      continue;
    }
    const [pCam, pZona, pTipo] = k.split("|");
    if (segMatch(pCam, aCam) && segMatch(pZona, aZona) && segMatch(pTipo, aTipo)) return k;
  }
  return null;
}

/**
 * Silencia temporariamente uma chave de alarme. PERSISTIDO em disco
 * (alarm-shelves.json) — sobrevive a reinício do processo.
 * @param {string} key  "cameraId|zona|tipo" (cada segmento aceita "*").
 * @param {number} [ms] Duração; default ALARM_SHELVE_DEFAULT_MS, clamp em
 *                      [1000, ALARM_SHELVE_MAX_MS].
 * @param {{reason?:string, by?:string}} [opts]
 * @returns {{key:string, ms:number, since:number, expiresAt:number, reason:string, by:string}}
 */
function shelve(key, ms, opts = {}) {
  const now = Date.now();
  const k = normShelveKey(key);
  let dur = Number(ms);
  if (!Number.isFinite(dur) || dur <= 0) dur = SHELVE_DEFAULT_MS;
  dur = Math.max(1000, Math.min(dur, SHELVE_MAX_MS));
  const info = {
    expiresAt: now + dur,
    since: now,
    ms: dur,
    reason: String(opts.reason ?? ""),
    by: String(opts.by ?? ""),
  };
  shelved.set(k, info);
  log.info({ key: k, ms: dur, by: info.by, reason: info.reason }, "[alarm] shelve aplicado");
  saveShelves(); // persiste o conjunto alterado (resiliente: nunca lança)
  return Object.assign({ key: k }, info);
}

/** Remove um shelve (cancela o silêncio). @returns {boolean} havia shelve. */
function unshelve(key) {
  const k = normShelveKey(key);
  const had = shelved.delete(k);
  if (had) {
    log.info({ key: k }, "[alarm] unshelve");
    saveShelves();
  } // persiste só se mudou
  return had;
}

/** Lista os shelves ATIVOS (poda expirados). @returns {Array} */
function listShelved() {
  const now = Date.now();
  const out = [];
  for (const [k, info] of shelved) {
    if (now >= info.expiresAt) {
      shelved.delete(k);
      continue;
    }
    out.push({
      key: k,
      since: info.since,
      ms: info.ms,
      expiresAt: info.expiresAt,
      remainingMs: info.expiresAt - now,
      reason: info.reason,
      by: info.by,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ANTI-FLAPPING (chattering) — se a MESMA chave re-emite muitas vezes na janela,
// entra em cooldown (off-delay) e é suprimida até o cooldown passar. Opera sobre
// EMISSÕES que já passaram pelo dedup. Retorna true se deve SUPRIMIR.
// ---------------------------------------------------------------------------
function flapSuppress(key, now) {
  if (!FLAP_ENABLED) return false;
  let st = flap.get(key);
  if (!st) {
    st = { fires: [], cooldownUntil: 0 };
    flap.set(key, st);
  }
  if (now < st.cooldownUntil) {
    log.debug(
      { key, cooldownMs: st.cooldownUntil - now },
      "[alarm] flap: chave em cooldown — suprimida",
    );
    return true;
  }
  while (st.fires.length && now - st.fires[0] > FLAP_WINDOW_MS) st.fires.shift();
  st.fires.push(now);
  if (st.fires.length > FLAP_THRESHOLD) {
    st.cooldownUntil = now + FLAP_COOLDOWN_MS;
    st.fires.length = 0;
    log.warn(
      { key, janelaMs: FLAP_WINDOW_MS, limite: FLAP_THRESHOLD, cooldownMs: FLAP_COOLDOWN_MS },
      "[alarm] flapping detectado — cooldown aplicado",
    );
    return true; // já suprime o disparo que estourou o limite
  }
  return false;
}

// ---------------------------------------------------------------------------
// MÉTRICAS / RACIONALIZAÇÃO (EEMUA 191). Conta alarmes EMITIDOS (não os
// suprimidos) por janela e por prioridade. Avisa se % crítico > meta.
// ---------------------------------------------------------------------------
function pruneEmitLog(now) {
  while (emitLog.length && now - emitLog[0].ts > RATE_HISTORY_MS) emitLog.shift();
}

function recordEmit(priority, now) {
  emitLog.push({ ts: now, priority });
  pruneEmitLog(now);
  // Avalia a meta de % crítico na janela (com throttle do aviso).
  let inWin = 0,
    crit = 0;
  for (let i = emitLog.length - 1; i >= 0; i--) {
    if (now - emitLog[i].ts > RATE_WINDOW_MS) break;
    inWin++;
    if (emitLog[i].priority === "critical") crit++;
  }
  if (inWin >= RATE_MIN_SAMPLE) {
    const pct = (crit / inWin) * 100;
    if (pct > CRITICAL_TARGET_PCT && now - lastRateWarnTs >= RATE_WARN_THROTTLE_MS) {
      lastRateWarnTs = now;
      log.warn(
        {
          criticalPct: Number(pct.toFixed(1)),
          metaPct: CRITICAL_TARGET_PCT,
          janelaMs: RATE_WINDOW_MS,
          amostra: inWin,
        },
        "[alarm] % de alarmes críticos acima da meta (EEMUA 191)",
      );
    }
  }
}

/**
 * Snapshot da saúde do sistema de alarmes (para futura tela). Em memória.
 * @returns {{now:number, windowMs:number, inWindow:number, ratePerMin:number,
 *   criticalPct:number, criticalTargetPct:number, overTarget:boolean,
 *   lastMinute:number, lastHour:number, byPriorityWindow:object,
 *   byPriorityHour:object, shelvedActive:number}}
 */
function metrics() {
  const now = Date.now();
  pruneEmitLog(now);
  const winP = { advisory: 0, high: 0, critical: 0 };
  const hourP = { advisory: 0, high: 0, critical: 0 };
  let inWin = 0,
    lastMin = 0,
    lastHour = 0;
  for (const e of emitLog) {
    const age = now - e.ts;
    if (age <= 3_600_000) {
      lastHour++;
      if (hourP[e.priority] != null) hourP[e.priority]++;
    }
    if (age <= 60_000) lastMin++;
    if (age <= RATE_WINDOW_MS) {
      inWin++;
      if (winP[e.priority] != null) winP[e.priority]++;
    }
  }
  const ratePerMin = Number((inWin / (RATE_WINDOW_MS / 60_000)).toFixed(2));
  const criticalPct = inWin ? Number(((winP.critical / inWin) * 100).toFixed(1)) : 0;
  return {
    now,
    windowMs: RATE_WINDOW_MS,
    inWindow: inWin,
    ratePerMin,
    criticalPct,
    criticalTargetPct: CRITICAL_TARGET_PCT,
    overTarget: inWin >= RATE_MIN_SAMPLE && criticalPct > CRITICAL_TARGET_PCT,
    lastMinute: lastMin,
    lastHour,
    byPriorityWindow: winP,
    byPriorityHour: hourP,
    shelvedActive: listShelved().length,
  };
}

// Limpeza preguiçosa dos mapas para evitar crescimento ilimitado.
function gc(now) {
  if (dedup.size > 1000) for (const [k, t] of dedup) if (now - t > DEDUP_MS) dedup.delete(k);
  if (floodWin.size > 500)
    for (const [k, w] of floodWin)
      if (!w.length || now - w[w.length - 1] > FLOOD_WINDOW_MS) floodWin.delete(k);
  if (flap.size > 1000)
    for (const [k, st] of flap)
      if (
        now >= st.cooldownUntil &&
        (!st.fires.length || now - st.fires[st.fires.length - 1] > FLAP_WINDOW_MS)
      )
        flap.delete(k);
}

/**
 * Avalia um alerta e devolve a decisão de envio (ou null se suprimido).
 * @param {{text:string, ts?:number, cameraId?:string, zona?:string, tipo?:string}} p
 * @returns {null | {text:string, ts:number, priority:string, summary:boolean, cameraId?:string, zona?:string, tipo?:string, critico?:boolean, count?:number}}
 */
function evaluate(p) {
  if (!p) return null;
  const text = String(p.text || "").trim();
  if (!text) return null;
  const ts = p.ts || Date.now();
  const now = Date.now();
  const meta = classify(text);
  const priority = priorityOf(text, meta);

  const cameraId = pickCamera(p, text);
  const zona = pickZona(p, text);
  const tipo = p.tipo || meta.tipo;

  // 0) Shelving — silêncio temporário (manutenção). Camada anterior a tudo;
  //    vale mesmo com a política desligada (é uma ação explícita do operador).
  const sk = isShelved(cameraId, zona, tipo, now);
  if (sk) {
    log.debug(
      { key: sk, cameraId, zona, tipo },
      "[alarm] shelved: alerta suprimido (silêncio temporário)",
    );
    return null;
  }

  // Política desligada → só classifica e repassa (retrocompatível),
  // contabilizando a emissão para as métricas.
  if (!ENABLED) {
    recordEmit(priority, now);
    return makeDecision(text, ts, priority, { tipo: meta.tipo, critico: meta.critico });
  }

  // Chave lógica: cameraId|zona|tipo. Sem zona identificável, usa o corpo da
  // mensagem para não colapsar mensagens distintas (mantém o dedup conservador).
  const zonaKey = zona || pickBody(p, text);
  const key = `${cameraId}|${zonaKey}|${tipo}`;

  // 1) Deduplicação temporal por chave lógica.
  const prev = dedup.get(key);
  if (prev && now - prev < DEDUP_MS) {
    log.debug({ key }, "[alarm] dedup: repetição suprimida na janela");
    return null;
  }
  dedup.set(key, now);
  gc(now);

  // 1b) Anti-flapping — suprime chattering da mesma chave (off-delay/cooldown).
  if (flapSuppress(key, now)) return null;

  // 2) Supressão de inundação por câmera (+ priorização já calculada).
  const decision = applyFlood(cameraId, zona, text, ts, priority, now, meta);

  // 3) Métricas: contabiliza apenas alarmes EMITIDOS (decisão não-nula).
  if (decision) recordEmit(decision.priority, now);

  return decision;
}

// Restauração preguiçosa no require — repovoa as shelves persistidas SEM exigir
// que index.js chame init(). Idempotente; envolto em try/catch por segurança.
try {
  init();
} catch (e) {
  log.error({ err: e.message }, "[alarm] init() falhou (ignorada)");
}

module.exports = {
  evaluate,
  classify,
  priorityOf,
  // Inicialização explícita opcional (restauração também ocorre no require).
  init,
  // Shelving (persistido em disco; ver alarm-shelves.json)
  shelve,
  unshelve,
  listShelved,
  isShelved,
  shelveKeyFor,
  // Métricas / racionalização (voláteis — não persistidas por design)
  metrics,
  _state: { dedup, floodWin, floodState, shelved, flap, emitLog },
};
