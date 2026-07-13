// Canal WhatsApp — disparo de alertas. Destinatários de DUAS fontes (dedupe por número):
//   1) lista do superadmin (recipients.json) — números avulsos;
//   2) usuários com número no /perfil + opt-in + "receber" ativo.
// A taxonomia (tipo + crítico) vem do NÚCLEO de alarme (alarm/classify) — o canal só
// formata/filtra/envia; quem decide o QUE enviar é a política (ADR-004).
const users = require("./users");
const recipients = require("./recipients");
const whatsapp = require("./whatsapp");
const settings = require("./settings");
const { classify } = require("./alarm/classify");
const { ENABLED: POLICY_ENABLED } = require("./alarm/config");

const DEDUP_MS = Number(process.env.ALERT_DEDUP_MS ?? 60_000);
const sent = new Map(); // `${numero}|${text}` -> ts (SÓ usado com a política desligada; ver dispatchAlert)

// Mensagem PROFISSIONAL para WhatsApp (markdown do WA: *negrito* / _itálico_), configurável pelo superadmin.
const FADIGA_DETALHE = {
  Fadiga: "Possível fadiga/sonolência detectada.",
  Celular: "Uso de celular detectado.",
  Duplo: "Fadiga e uso de celular detectados.",
  OK: "Operador normalizado.",
};

// Título DEFAULT de tipo NOVO ainda sem entrada em settings.tipos — o normalize() de settings.js
// só conhece os 4 tipos herdados (atividade/fadiga/leitura/objetos), então uma entrada salva p/
// "presenca" seria descartada lá. Até settings.js ganhar a entrada própria (pendência da spec
// alerta-por-atividade), o título default do canal vive aqui; instrução/desligamento por tipo
// ficam indisponíveis p/ ele (o alarme SEMPRE sai — fail-safe p/ violação de área proibida).
const TIPO_TITULO_DEFAULT = { presenca: "Segurança · Área proibida" };

function formatWhatsApp(text, meta, ts, s = settings.get()) {
  const tcfg = (s.tipos && s.tipos[meta.tipo]) || {};
  let body = String(text || "")
    .replace(/^(?:[\s!]|\u26A0|\uFE0F)+/u, "")
    .trim(); // remove o "⚠ " inicial (⚠=U+26A0, ️=U+FE0F variation selector)
  let local = "";
  const i = body.indexOf(": ");
  if (i > 0 && i < 60) {
    local = body.slice(0, i).trim();
    body = body.slice(i + 2).trim();
  }
  if (meta.tipo === "fadiga" && FADIGA_DETALHE[body]) body = FADIGA_DETALHE[body];
  body = body.replace(/^([a-zà-ú])/, (m) => m.toUpperCase()); // capitaliza letra inicial (não mexe em emoji)
  if (tcfg.instrucao) body += `\n\n${tcfg.instrucao}`;
  const quando = new Date(ts || Date.now()).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
  const linhas = [
    `${meta.critico ? "🔴" : "🟡"} *${meta.critico ? "ALERTA" : "Aviso"} — ${tcfg.titulo || TIPO_TITULO_DEFAULT[meta.tipo] || "Operação"}*`,
    s.incluirLocal && local ? `📍 ${local}` : null,
    s.incluirHora ? `🕒 ${quando}` : null,
    "",
    body,
    s.incluirRodape ? "" : null,
    s.incluirRodape ? `_${s.marca} · notificação automática_` : null,
  ];
  return linhas.filter((l) => l !== null).join("\n");
}

function passes(f, meta) {
  if (f.somenteCriticos && !meta.critico) return false;
  if (Array.isArray(f.tipos) && f.tipos.length && !f.tipos.includes(meta.tipo)) return false;
  return true;
}

// monta a lista única de números a notificar (dedupe por número)
function targets(meta) {
  const map = new Map(); // numero -> nome
  for (const r of recipients.all()) {
    if (!r.ativo || !r.numero) continue;
    if (!passes({ somenteCriticos: r.somenteCriticos, tipos: r.tipos }, meta)) continue;
    map.set(r.numero, r.nome);
  }
  for (const u of users.all()) {
    if (!u.ativo || !u.whatsapp || !u.optInEm) continue;
    const f = u.filtros || { ativo: true, somenteCriticos: false, tipos: [] };
    if (!f.ativo || !passes(f, meta)) continue;
    if (!map.has(u.whatsapp)) map.set(u.whatsapp, u.usuario);
  }
  return [...map.entries()].map(([numero, nome]) => ({ numero, nome }));
}

// priority (advisory|high|critical) é opcional e vem da política de alarmes (alarmPolicy).
// Quando informado, ele tem precedência sobre a heurística local: "critical" força o
// cabeçalho de alerta (🔴) e expõe meta.priority p/ futuros consumidores.
function dispatchAlert(text, ts, priority) {
  if (!text || !whatsapp.enabled() || !whatsapp.status().connected) return;
  const meta = classify(text);
  if (priority) {
    meta.priority = priority;
    if (priority === "critical") meta.critico = true;
    else if (priority === "advisory" && !text.includes("⚠")) meta.critico = false;
  }
  const cfg = settings.get();
  if (cfg.tipos[meta.tipo] && cfg.tipos[meta.tipo].ativo === false) return; // tipo desligado pelo superadmin
  const msg = formatWhatsApp(text, meta, ts, cfg); // mensagem profissional (não o texto cru do toast)
  const now = Date.now();
  for (const t of targets(meta)) {
    // Dedup de canal (nº|texto) = REDE DE SEGURANÇA do modo ALARM_POLICY_ENABLED=0 (sem a
    // política, ninguém deduplicou ainda). Com a política LIGADA (default), o dedup mora num
    // lugar só — alarm/state.dedup — e este mapa fica inerte (não checa nem acumula).
    if (!POLICY_ENABLED) {
      const key = `${t.numero}|${text}`;
      if (sent.has(key) && now - sent.get(key) < DEDUP_MS) continue;
      sent.set(key, now);
    }
    whatsapp
      .sendText(t.numero, msg)
      .catch((e) => console.error(`[dispatch] envio falhou p/ ${t.nome}:`, e.message));
  }
  if (sent.size > 800) for (const [k, t] of sent) if (now - t > DEDUP_MS) sent.delete(k);
}

module.exports = { dispatchAlert, targets, formatWhatsApp };
