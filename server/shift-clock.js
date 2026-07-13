// Resolução de TURNO — módulo PURO e fonte ÚNICA (spec-turnos-por-zona §3): dado um instante,
// o cadastro de turnos e o fuso do SITE, responde "em qual turno esse instante cai?".
// Overnight/borda/pausa são resolvidos AQUI e em nenhum outro lugar (mata a armadilha 1 — duas
// fontes de turno divergindo). Convenções de mercado (spec §1):
//   D1 — o turno pertence ao dia em que INICIA (businessDate).
//   D2 — fim ≤ início ⇒ termina no dia seguinte; duração = (fim − início) mod 24h, > 0.
//   D4 — instante exatamente na borda pertence ao turno que INICIA nele (janela [início, fim)).
//   D6 — wall-clock no fuso IANA do SITE (SITE_TZ), via Intl — NUNCA getHours() do processo
//        (o relógio do hub pode estar em outro fuso; o turno é como a OPERAÇÃO pensa).

const DAY_MIN = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Fuso IANA do galpão (não do processo). Brasil sem DST desde 2019; se voltar, o Intl absorve.
function siteTz() {
  return process.env.SITE_TZ || "America/Sao_Paulo";
}

// "HH:MM" → minutos desde a meia-noite, ou null se malformado (aceita "7:05"; rejeita "24:00").
function parseHM(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Duração do turno em minutos (D2): fim ≤ início ⇒ +1 dia. 0 = inválido (rejeitado no cadastro).
function durationMin(inicioMin, fimMin) {
  return (fimMin - inicioMin + DAY_MIN) % DAY_MIN;
}

// ── Wall-clock no fuso do site (Intl, com cache de formatter por tz — chamado por sample) ──
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23", // força hora 00–23 (sem o "24:00" do h24)
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Componentes locais do instante no fuso dado: data civil, dia-da-semana e ms desde a meia-noite
// LOCAL. Os ms dentro do segundo vêm do próprio ts (offsets IANA são múltiplos de minuto).
function wallClock(ts, tz) {
  const p = {};
  for (const part of fmt(tz).formatToParts(ts)) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    weekday: WEEKDAY[p.weekday],
    dayMs:
      Number(p.hour) * 3_600_000 +
      Number(p.minute) * 60_000 +
      Number(p.second) * 1000 +
      ((ts % 1000) + 1000) % 1000,
  };
}

// Data civil "YYYY-MM-DD" recuando `days` dias — aritmética de calendário pura (via Date UTC,
// sem fuso: os componentes já estão no fuso do site).
function isoDateMinusDays(y, m, d, days) {
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

// O instante (relativo ao início do turno) cai numa pausa? Janela [início, fim) como no turno.
function inPauseOf(shift, inicioMin, elapsedMs) {
  for (const p of shift.pausas || []) {
    const pIni = parseHM(p && p.inicio);
    const durMin = Number(p && p.duracaoMin);
    if (pIni == null || !(durMin > 0)) continue;
    const offMs = ((pIni - inicioMin + DAY_MIN) % DAY_MIN) * 60_000;
    if (elapsedMs >= offMs && elapsedMs < offMs + durMin * 60_000) return true;
  }
  return false;
}

// resolveShift(ts, shifts, siteTz) → { shiftId, businessDate, inPause } | null (fora de turno).
// Testa cada turno ATIVO em DUAS âncoras: iniciando HOJE (no fuso do site) e iniciando ONTEM
// (overnight ainda aberto). Janela meio-aberta [início, início+duração) implementa a borda D4.
// Se mais de um turno cobre o instante (overlap — barrado por zona na F2, mas a lista aqui é
// global), vence o que INICIOU por último (generalização determinística da própria D4).
function resolveShift(ts, shifts, tz = siteTz()) {
  if (!Number.isFinite(ts) || !Array.isArray(shifts) || shifts.length === 0) return null;
  const wc = wallClock(ts, tz);
  let best = null;
  for (const s of shifts) {
    if (!s || s.ativo === false || !Array.isArray(s.dias)) continue;
    const ini = parseHM(s.inicio);
    const fim = parseHM(s.fim);
    if (ini == null || fim == null) continue;
    const durMs = durationMin(ini, fim) * 60_000;
    if (durMs <= 0) continue; // duração 0 é inválida (D2) — defensivo contra dado antigo/corrompido
    for (const back of [0, 1]) {
      // back=0: turno iniciando hoje; back=1: overnight iniciado ontem (dia-da-semana de ontem)
      if (!s.dias.includes((wc.weekday - back + 7) % 7)) continue;
      const elapsedMs = wc.dayMs + back * DAY_MS - ini * 60_000;
      if (elapsedMs < 0 || elapsedMs >= durMs) continue;
      if (!best || elapsedMs < best.elapsedMs) best = { shift: s, ini, back, elapsedMs };
    }
  }
  if (!best) return null;
  return {
    shiftId: best.shift.id,
    businessDate: isoDateMinusDays(wc.y, wc.m, wc.d, best.back), // D1: dia em que INICIOU
    inPause: inPauseOf(best.shift, best.ini, best.elapsedMs),
  };
}

module.exports = { resolveShift, parseHM, durationMin, siteTz };
