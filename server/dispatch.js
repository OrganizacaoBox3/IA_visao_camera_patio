// Disparo de alertas → WhatsApp. Destinatários de DUAS fontes (dedupe por número):
//   1) lista do superadmin (recipients.json) — números avulsos;
//   2) usuários com número no /perfil + opt-in + "receber" ativo.
// Classifica o texto (tipo + crítico) por palavra-chave e respeita o filtro de cada destino.
const users = require("./users");
const recipients = require("./recipients");
const whatsapp = require("./whatsapp");
const settings = require("./settings");

const DEDUP_MS = Number(process.env.ALERT_DEDUP_MS ?? 60_000);
const sent = new Map(); // `${numero}|${text}` -> ts

function classify(text) {
  const t = String(text || "");
  const critico = t.includes("⚠");
  let tipo = "atividade";
  if (/fadiga|celular|bocejo|operador|risco/i.test(t)) tipo = "fadiga";
  else if (/leitura|no-?read|taxa|c[oó]digo/i.test(t)) tipo = "leitura";
  else if (/objeto|presen|carreg|palete|empilhad|caixa/i.test(t)) tipo = "objetos";
  return { critico, tipo };
}

// Mensagem PROFISSIONAL para WhatsApp (markdown do WA: *negrito* / _itálico_), configurável pelo superadmin.
const FADIGA_DETALHE = { Fadiga: "Possível fadiga/sonolência detectada.", Celular: "Uso de celular detectado.", Duplo: "Fadiga e uso de celular detectados.", OK: "Operador normalizado." };

function formatWhatsApp(text, meta, ts, s = settings.get()) {
  const tcfg = (s.tipos && s.tipos[meta.tipo]) || {};
  let body = String(text || "").replace(/^[\s⚠️!]+/, "").trim(); // remove o "⚠ " inicial
  let local = "";
  const i = body.indexOf(": ");
  if (i > 0 && i < 60) { local = body.slice(0, i).trim(); body = body.slice(i + 2).trim(); }
  if (meta.tipo === "fadiga" && FADIGA_DETALHE[body]) body = FADIGA_DETALHE[body];
  body = body.replace(/^([a-zà-ú])/, (m) => m.toUpperCase()); // capitaliza letra inicial (não mexe em emoji)
  if (tcfg.instrucao) body += `\n\n${tcfg.instrucao}`;
  const quando = new Date(ts || Date.now()).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const linhas = [
    `${meta.critico ? "🔴" : "🟡"} *${meta.critico ? "ALERTA" : "Aviso"} — ${tcfg.titulo || "Operação"}*`,
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

function dispatchAlert(text, ts) {
  if (!text || !whatsapp.enabled() || !whatsapp.status().connected) return;
  const meta = classify(text);
  const cfg = settings.get();
  if (cfg.tipos[meta.tipo] && cfg.tipos[meta.tipo].ativo === false) return; // tipo desligado pelo superadmin
  const msg = formatWhatsApp(text, meta, ts, cfg); // mensagem profissional (não o texto cru do toast)
  const now = Date.now();
  for (const t of targets(meta)) {
    const key = `${t.numero}|${text}`;
    if (sent.has(key) && now - sent.get(key) < DEDUP_MS) continue;
    sent.set(key, now);
    whatsapp.sendText(t.numero, msg).catch((e) => console.error(`[dispatch] envio falhou p/ ${t.nome}:`, e.message));
  }
  if (sent.size > 800) for (const [k, t] of sent) if (now - t > DEDUP_MS) sent.delete(k);
}

module.exports = { dispatchAlert, classify, targets, formatWhatsApp };
