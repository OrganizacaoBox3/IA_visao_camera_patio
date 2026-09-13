// Canal WhatsApp — disparo de alertas. recipients é a fonte única: cada número pertence a
// um usuário, que define o escopo de câmeras no instante do envio.
// A taxonomia (tipo + crítico) vem do NÚCLEO de alarme (alarm/classify) — o canal só
// formata/filtra/envia; quem decide o QUE enviar é a política (ADR-004).
const users = require("./users");
const recipients = require("./recipients");
const whatsapp = require("./whatsapp");
const settings = require("./settings");
const { classify } = require("./alarm/classify");
const { ENABLED: POLICY_ENABLED } = require("./alarm/config");
const {
  perfilDe,
  clienteRecebe,
  limparParaCliente,
  localParaCliente,
} = require("./alarm/audience");

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

// Apresentação da PRIORIDADE na mensagem. Três níveis, um por linha de gravidade — o operador
// distingue no relance da notificação, sem abrir. "ATENÇÃO" (e não "Alta") é o vocabulário que
// o dono usa; o mesmo rótulo vale na UI (src/types/alarm.ts) — mudou aqui, muda lá.
const CABECALHO = {
  critical: { emoji: "🔴", rotulo: "CRÍTICO" },
  high: { emoji: "🟡", rotulo: "ATENÇÃO" },
  advisory: { emoji: "🔵", rotulo: "INFORMATIVO" },
};

/**
 * Mensagem do WhatsApp. `perfil` escolhe a REDAÇÃO, não o conteúdo do alarme:
 *   "equipe"  — completa (local, instrução, rodapé, vocabulário de gravidade). Quem opera
 *               precisa do detalhe para agir.
 *   "cliente" — curta, em português comum, sem interno. Ver server/alarm/audience.js.
 * Default "equipe" para não alterar nenhum chamador antigo (a rota de preview inclusive).
 */
function formatWhatsApp(text, meta, ts, s = settings.get(), perfil = "equipe") {
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
  // CABEÇALHO EM 3 NÍVEIS (2026-09-13). Era binário (🔴 ALERTA / 🟡 Aviso) e decidido por
  // `meta.critico`, que vinha do "⚠" no texto — ou seja, 83% das mensagens chegavam com 🔴.
  // Quem manda agora é a PRIORIDADE da política (alarm/severity.js); o binário sobrou só como
  // fallback p/ chamada sem prioridade (rota de preview em routes/notif.js).
  const nivel = CABECALHO[meta.priority] || (meta.critico ? CABECALHO.critical : CABECALHO.high);
  const titulo = tcfg.titulo || TIPO_TITULO_DEFAULT[meta.tipo] || "Operação";

  // ── CLIENTE: três linhas, sem jargão ────────────────────────────────────────────────────
  // O que aconteceu · onde · quando. Sem "CRÍTICO/ATENÇÃO" (vocabulário de engenharia de
  // alarme, que não diz nada a quem contrata), sem instrução interna de operação, sem id de
  // câmera e sem endpoint. O emoji sozinho já distingue urgência — e o que a pessoa lê no
  // aviso do celular, sem abrir, passa a ser a FRASE, não o cabeçalho.
  if (perfil === "cliente") {
    // `body` aqui já tem a instrução interna anexada acima; para o cliente ela não vai, então
    // a limpeza parte do texto do alarme, não do corpo montado para a equipe.
    const cru = String(text || "");
    const i2 = cru.indexOf(": ");
    const semLocal = i2 > 0 && i2 < 60 ? cru.slice(i2 + 2) : cru;
    const base =
      meta.tipo === "fadiga" && FADIGA_DETALHE[semLocal.trim()]
        ? FADIGA_DETALHE[semLocal.trim()]
        : semLocal;
    // O `local` vem do prefixo "X: " do texto e às vezes é o ID CRU da câmera (quando o
    // emissor não resolveu o rótulo). Id interno não sai para fora: `localParaCliente` o
    // descarta e mantém o resto ("cam-ab12 · Doca 1" → "Doca 1").
    const localCli = localParaCliente(local);
    const frase = limparParaCliente(base, localCli) || `${titulo}.`;
    const rodape = [s.incluirHora ? quando : null, s.incluirRodape ? s.marca : null]
      .filter(Boolean)
      .join(" · ");
    return [
      `${nivel.emoji} *${titulo}${localCli ? ` · ${localCli}` : ""}*`,
      frase,
      rodape ? `_${rodape}_` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  // ── EQUIPE: a mensagem completa, exatamente como sempre foi ─────────────────────────────
  const linhas = [
    `${nivel.emoji} *${nivel.rotulo} — ${titulo}*`,
    s.incluirLocal && local ? `📍 ${local}` : null,
    s.incluirHora ? `🕒 ${quando}` : null,
    "",
    body,
    s.incluirRodape ? "" : null,
    s.incluirRodape ? `_${s.marca} · notificação automática_` : null,
  ];
  return linhas.filter((l) => l !== null).join("\n");
}

// ── QUEM PODE RECEBER, POR TIPO DE ALARME (2026-09-09) ───────────────────────────────────────
// Decisão do dono: alarme de VÍDEO/INSTABILIDADE/saúde da IA vai SÓ para a administração. É
// falha de INFRAESTRUTURA nossa (câmera caída, pool de análise afogado, rede oscilando) — não é
// evento de operação, e mandá-lo para o operador ou para o CLIENTE é ruído sobre quem não tem
// como agir. Os alarmes de OPERAÇÃO (atividade, presença, fadiga, leitura, objetos) seguem
// exatamente como estavam: sem restrição de papel aqui, filtrados só pelas preferências do
// destinatário e pelo escopo de câmeras do papel "cliente".
//
// Env ALERT_PAPEIS_SAUDE permite ampliar sem deploy (ex.: "superadmin,engenheiro").
const PAPEIS_SAUDE = String(process.env.ALERT_PAPEIS_SAUDE || "superadmin")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const PAPEIS_POR_TIPO = { saude: PAPEIS_SAUDE };

/** O PAPEL do dono do número pode receber este tipo de alarme? (tipo sem regra = todos). */
function papelPodeReceber(papel, tipo) {
  const permitidos = PAPEIS_POR_TIPO[String(tipo || "").toLowerCase()];
  return !permitidos || permitidos.includes(String(papel || "").toLowerCase());
}

function passes(f, meta) {
  if (f.somenteCriticos && !meta.critico) return false;
  if (Array.isArray(f.tipos) && f.tipos.length && !f.tipos.includes(meta.tipo)) return false;
  return true;
}

// Monta a lista única de números a notificar (dedupe por número). O dono precisa existir e estar
// ativo. `cameraId` escopa o papel "cliente" pelas câmeras atuais dele; equipe recebe de todas.
function targets(meta, cameraId) {
  const map = new Map(); // numero -> { nome, perfil }
  for (const r of recipients.all()) {
    const owner = users.getById(r.userId);
    if (!owner || !owner.ativo || !r.ativo || !r.numero || !r.optInEm) continue;
    if (owner.papel === "cliente" && !users.canSeeCamera(owner, cameraId)) continue;
    // O CLIENTE recebe MENOS, de propósito (metade do "mais limpo"): só atenção/crítico, nunca
    // informativo, e nunca resumo de rajada — que é sintoma de infraestrutura, não evento de
    // operação. A regra mora em alarm/audience.js, numa função só, testada. Sem isto, o canal
    // de quem contrata vira registro de ciclo de vida do nosso sistema.
    if (perfilDe(owner.papel) === "cliente" && !clienteRecebe(meta)) continue;
    // Restrição por PAPEL do tipo de alarme (saúde → só administração). Vem ANTES das
    // preferências do destinatário: preferência não concede acesso que o papel não tem.
    if (!papelPodeReceber(owner.papel, meta && meta.tipo)) continue;
    if (!passes({ somenteCriticos: r.somenteCriticos, tipos: r.tipos }, meta)) continue;
    // O PERFIL viaja com o destino: é ele que escolhe a redação no envio. Número repetido
    // entre um cliente e alguém da equipe mantém o PRIMEIRO perfil visto (o dedupe por número
    // já era assim) — caso de borda que não existe no cadastro real, onde cada número pertence
    // a um usuário só.
    if (!map.has(r.numero)) map.set(r.numero, { nome: r.nome, perfil: perfilDe(owner.papel) });
  }
  return [...map.entries()].map(([numero, v]) => ({ numero, nome: v.nome, perfil: v.perfil }));
}

// priority (advisory|high|critical) é opcional e vem da política de alarmes (alarmPolicy).
// Quando informado, ele tem precedência sobre a heurística local: "critical" força o
// cabeçalho de alerta (🔴) e expõe meta.priority p/ futuros consumidores. `cameraId` roteia
// o alarme só aos clientes alocados àquela câmera (targets) — ver nota acima.
function dispatchAlert(text, ts, priority, cameraId) {
  if (!text || !whatsapp.enabled() || !whatsapp.status().connected) return;
  const meta = classify(text);
  // A prioridade da política MANDA, sem escape-hatch. A condição antiga
  // (`priority === "advisory" && !text.includes("⚠")`) deixava um informativo com "⚠" no texto
  // sair como 🔴 — era o "⚠" decidindo gravidade de novo, uma camada abaixo.
  if (priority) {
    meta.priority = priority;
    meta.critico = priority === "critical";
  }
  const cfg = settings.get();
  if (cfg.tipos[meta.tipo] && cfg.tipos[meta.tipo].ativo === false) return; // tipo desligado pelo superadmin
  // UMA MENSAGEM POR PÚBLICO (2026-09-13), montada sob demanda e reaproveitada: a equipe
  // recebe a completa, o cliente a curta. Antes era um texto só para todo mundo — e o cliente
  // recebia id de câmera, endpoint e jargão de engenharia de alarme.
  const msgPorPerfil = new Map();
  const msgDe = (perfil) => {
    if (!msgPorPerfil.has(perfil))
      msgPorPerfil.set(perfil, formatWhatsApp(text, meta, ts, cfg, perfil));
    return msgPorPerfil.get(perfil);
  };
  const now = Date.now();
  for (const t of targets(meta, cameraId)) {
    // Dedup de canal (nº|texto) = REDE DE SEGURANÇA do modo ALARM_POLICY_ENABLED=0 (sem a
    // política, ninguém deduplicou ainda). Com a política LIGADA (default), o dedup mora num
    // lugar só — alarm/state.dedup — e este mapa fica inerte (não checa nem acumula).
    if (!POLICY_ENABLED) {
      const key = `${t.numero}|${text}`;
      if (sent.has(key) && now - sent.get(key) < DEDUP_MS) continue;
      sent.set(key, now);
    }
    whatsapp
      .sendText(t.numero, msgDe(t.perfil))
      .catch((e) => console.error(`[dispatch] envio falhou p/ ${t.nome}:`, e.message));
  }
  if (sent.size > 800) for (const [k, t] of sent) if (now - t > DEDUP_MS) sent.delete(k);
}

module.exports = { dispatchAlert, targets, formatWhatsApp, papelPodeReceber, PAPEIS_POR_TIPO };
