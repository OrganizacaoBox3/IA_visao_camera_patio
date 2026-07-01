// MÉTRICAS / RACIONALIZAÇÃO (EEMUA 191). Conta alarmes EMITIDOS (não os
// suprimidos) por janela e por prioridade, expostos via metrics() para uma
// futura tela de "saúde de alarmes". Avisa (pino, com throttle) se a % de
// "critical" exceder a meta na janela.
const {
  log,
  RATE_WINDOW_MS,
  CRITICAL_TARGET_PCT,
  RATE_MIN_SAMPLE,
  RATE_WARN_THROTTLE_MS,
  RATE_HISTORY_MS,
} = require("./config");
const { emitLog } = require("./state");
const { listShelved } = require("./shelve");

let lastRateWarnTs = 0; // throttle do aviso de % crítico

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

module.exports = { pruneEmitLog, recordEmit, metrics };
