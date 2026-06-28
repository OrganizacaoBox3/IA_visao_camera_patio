// ============================================================================
// Política de alarmes (ISA-18.2 / EEMUA 191) — Onda A, item 2
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
// Toda supressão/colapso é logada (pino) para observabilidade.
//
// ----------------------------------------------------------------------------
// Variáveis de ambiente (todas com defaults sensatos):
//
//   ALARM_POLICY_ENABLED   (default "1")     Liga a política. Se "0"/"false",
//                                            evaluate só classifica e repassa
//                                            (comportamento retrocompatível,
//                                            sem dedup/colapso).
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
// ============================================================================

const { classify } = require("./dispatch");

const log = require("pino")({ name: "alarm", level: process.env.ALARM_LOG_LEVEL || "info" });

const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.ALARM_POLICY_ENABLED ?? "1"));
const DEDUP_MS = Number(process.env.ALARM_DEDUP_MS ?? 60_000);
const FLOOD_WINDOW_MS = Number(process.env.ALARM_FLOOD_WINDOW_MS ?? 15_000);
const FLOOD_THRESHOLD = Number(process.env.ALARM_FLOOD_THRESHOLD ?? 8);
const FLOOD_SUMMARY_MS = Number(process.env.ALARM_FLOOD_SUMMARY_MS ?? 60_000);

// Estado em memória (limpeza preguiçosa para não crescer sem limite).
const dedup = new Map(); // logicalKey -> ts do último envio
const floodWin = new Map(); // cameraId -> array de ts dos alertas recentes
const floodState = new Map(); // cameraId -> { zonas:Set, lastSummaryTs, n }

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
  if (/\boffline\b|sem[\s-]?sinal|sem[\s-]?conex|feed\s+caiu|c[âa]mera.*(caiu|fora)|desconect|timeout|falha/i.test(text)) {
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
  if (cameraId === "_") return makeDecision(text, ts, priority, { cameraId, zona, tipo: meta.tipo, critico: meta.critico });

  let win = floodWin.get(cameraId);
  if (!win) { win = []; floodWin.set(cameraId, win); }
  while (win.length && now - win[0] > FLOOD_WINDOW_MS) win.shift(); // poda janela
  win.push(now);

  const flooding = win.length > FLOOD_THRESHOLD;

  if (!flooding) {
    if (floodState.has(cameraId)) floodState.delete(cameraId); // episódio encerrado
    return makeDecision(text, ts, priority, { cameraId, zona, tipo: meta.tipo, critico: meta.critico });
  }

  // Em inundação: colapsa.
  let st = floodState.get(cameraId);
  if (!st) { st = { zonas: new Set(), lastSummaryTs: 0, n: 0 }; floodState.set(cameraId, st); }
  if (zona) st.zonas.add(zona);
  st.n++;

  if (now - st.lastSummaryTs >= FLOOD_SUMMARY_MS) {
    st.lastSummaryTs = now;
    // breadth da rajada: distintas zonas vistas no colapso ∪ tamanho da janela
    // (a janela inclui os alertas que passaram antes do colapso disparar).
    const nZonas = Math.max(st.zonas.size, win.length);
    const resumo = `⚠ ${cameraId}: rajada de alertas — ${nZonas} zona(s) afetada(s) (possível queda de feed)`;
    log.warn({ cameraId, zonas: nZonas, suprimidos: st.n, janelaMs: FLOOD_WINDOW_MS }, "[alarm] inundação colapsada em resumo");
    return makeDecision(resumo, ts, maxPriority(priority, "critical"), { cameraId, zona: "*", tipo: meta.tipo, critico: true, summary: true, count: nZonas });
  }

  log.debug({ cameraId, suprimidos: st.n }, "[alarm] alerta suprimido (inundação ativa)");
  return null;
}

// Limpeza preguiçosa dos mapas para evitar crescimento ilimitado.
function gc(now) {
  if (dedup.size > 1000) for (const [k, t] of dedup) if (now - t > DEDUP_MS) dedup.delete(k);
  if (floodWin.size > 500) for (const [k, w] of floodWin) if (!w.length || now - w[w.length - 1] > FLOOD_WINDOW_MS) floodWin.delete(k);
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

  // Política desligada → só classifica e repassa (retrocompatível).
  if (!ENABLED) return makeDecision(text, ts, priority, { tipo: meta.tipo, critico: meta.critico });

  const cameraId = pickCamera(p, text);
  const zona = pickZona(p, text);
  const tipo = p.tipo || meta.tipo;
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

  // 2) Supressão de inundação por câmera (+ priorização já calculada).
  return applyFlood(cameraId, zona, text, ts, priority, now, meta);
}

module.exports = { evaluate, classify, priorityOf, _state: { dedup, floodWin, floodState } };
