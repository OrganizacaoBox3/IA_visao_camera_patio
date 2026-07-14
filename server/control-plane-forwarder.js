// Forwarder do control-plane (spec-control-plane §4 / Fase 1) — o hub SILO se registra e
// encaminha METADADOS de alarme ao control-plane POOL. Molde do alerts.js/Andon: POST fail-soft
// por evento (o plane cair NÃO derruba o hub).
//
// ADITIVO e "env ausente → INERTE" (a disciplina da casa p/ db/CAMERA_TOKEN/Andon): sem
// CP_URL/SITE_ID/SITE_KEY, nada é tentado nem logado por evento — só 1 log no boot dizendo desligado.
//
// LGPD (ADR-002): encaminha SÓ o ev de METADADOS de events.record — NUNCA frame, NUNCA o texto
// cru do Andon. O payload é uma whitelist explícita ({id,ts,cameraId,cameraLabel,zona,tipo,
// priority,text,state}); qualquer campo extra que apareça no ev fica de fora por construção.
//
// ENV:
//   CP_URL          base do control-plane (ex.: https://plane.exemplo)
//   SITE_ID         id deste site no plane (header x-site-id)
//   SITE_KEY        credencial CRUA do site (header x-site-key; o plane compara com o HASH guardado)
//   CP_HEARTBEAT_MS (default 300000 = 5min) cadência do heartbeat
//   CP_TIMEOUT_MS   (default 5000) timeout curto por request (fail-soft — o plane lento não trava o hub)
const CP_URL = (process.env.CP_URL || "").trim().replace(/\/+$/, "");
const SITE_ID = (process.env.SITE_ID || "").trim();
const SITE_KEY = (process.env.SITE_KEY || "").trim();
const HEARTBEAT_MS = Math.max(30_000, Number(process.env.CP_HEARTBEAT_MS) || 300_000);
const TIMEOUT_MS = Math.max(500, Number(process.env.CP_TIMEOUT_MS) || 5_000);

/** Ligado só quando os três envs existem. Ausente qualquer um → INERTE. */
function enabled() {
  return !!(CP_URL && SITE_ID && SITE_KEY);
}

// POST fail-soft com timeout curto: NUNCA relança (o plane offline/lento não pode derrubar nem
// travar o hub). Retorna true só quando o plane respondeu 2xx.
async function postJson(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CP_URL}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-site-id": SITE_ID,
        "x-site-key": SITE_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) console.error(`[control-plane] ${pathname} respondeu HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`[control-plane] falha em ${pathname}:`, e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Whitelist LGPD: só os campos de METADADOS do events.record. Garante que nem frame nem texto
// cru do Andon vazem, ainda que o ev ganhe campos novos no futuro.
function lgpdSafe(ev) {
  return {
    id: ev.id,
    ts: ev.ts,
    cameraId: ev.cameraId,
    cameraLabel: ev.cameraLabel,
    zona: ev.zona,
    tipo: ev.tipo,
    priority: ev.priority,
    text: ev.text,
    state: ev.state,
  };
}

/** Encaminha UM evento de alarme (metadados) ao plane. Fail-soft e inerte-sem-env. */
async function forwardAlarm(ev) {
  if (!enabled() || !ev) return;
  await postJson("/api/ingest/alarm", lgpdSafe(ev));
}

/** Bate o heartbeat no plane (mesma auth). Fail-soft e inerte-sem-env. */
async function heartbeat() {
  if (!enabled()) return;
  await postJson("/api/site/heartbeat", { ts: Date.now() });
}

let timer = null;
/**
 * Liga o heartbeat: dispara um no boot + a cada HEARTBEAT_MS. Inerte-sem-env (só loga o desligado).
 * O timer é unref() — não segura o processo vivo no shutdown/teste. Retorna o handle (ou null).
 */
function startHeartbeat() {
  if (!enabled()) {
    console.log("[control-plane] desligado (defina CP_URL, SITE_ID e SITE_KEY para ligar)");
    return null;
  }
  console.log(
    `[control-plane] ATIVO — site ${SITE_ID} → ${CP_URL} (heartbeat a cada ${Math.round(HEARTBEAT_MS / 1000)}s)`,
  );
  void heartbeat();
  timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { enabled, forwardAlarm, heartbeat, startHeartbeat, stopHeartbeat };
