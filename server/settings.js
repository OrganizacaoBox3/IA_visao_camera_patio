// Configuração das NOTIFICAÇÕES (superadmin): marca, o que a mensagem mostra e, por tipo de alerta,
// se notifica + título + instrução extra. Cache em memória; persiste no Postgres (app_settings id='notif')
// se configurado, ou em notif-settings.json (fallback). Usada pelo dispatch (settings.get(), sync).
const fs = require("node:fs");
const { statePath } = require("./state-dir");
const db = require("./db");
const { clampMs } = require("./alarm/intervals");

const FILE = statePath("notif-settings.json");
let usingPg = false;

const DEFAULTS = {
  marca: "Visão Computacional",
  incluirLocal: true,
  incluirHora: true,
  incluirRodape: true,
  // INTERVALO DE RENOTIFICAÇÃO de incidente aberto (ms). Enquanto o problema persiste, o
  // operador é LEMBRADO nesta cadência — sem que se abra incidente novo (health-incidents.js).
  // Era fixo em 30 min e só mudável por env, ou seja: inalcançável para quem usa o sistema.
  // Agora é config de notificação, do mesmo dono (superadmin) que já define marca e títulos.
  renotifyMs: 30 * 60_000,
  tipos: {
    atividade: { ativo: true, titulo: "Operação · Parada de área", instrucao: "" },
    fadiga: { ativo: true, titulo: "Segurança · Operador", instrucao: "" },
    leitura: { ativo: true, titulo: "Expedição · Leitura", instrucao: "" },
    objetos: { ativo: true, titulo: "Pátio · Objetos", instrucao: "" },
    presenca: { ativo: true, titulo: "Segurança · Área proibida", instrucao: "" },
  },
};

// Normaliza/valida um objeto de settings (mesclado sobre os defaults). UI envia o objeto completo.
function normalize(p) {
  p = p || {};
  const tipos = {};
  for (const k of Object.keys(DEFAULTS.tipos)) {
    const src = (p.tipos || {})[k] || {};
    tipos[k] = {
      ativo: src.ativo !== false,
      titulo: String(src.titulo || DEFAULTS.tipos[k].titulo).slice(0, 80),
      instrucao: String(src.instrucao || "").slice(0, 300),
    };
  }
  return {
    marca: String(p.marca || DEFAULTS.marca).slice(0, 80),
    incluirLocal: p.incluirLocal !== false,
    incluirHora: p.incluirHora !== false,
    incluirRodape: p.incluirRodape !== false,
    // clampMs devolve null no que não é número — aí vale o default. Valor fora dos limites é
    // PRESO (1min..24h), nunca rejeitado: config salva e ignorada em silêncio é pior que
    // config ajustada, porque o usuário acha que configurou.
    renotifyMs: clampMs(p.renotifyMs) ?? DEFAULTS.renotifyMs,
    tipos,
  };
}

let cur = normalize(DEFAULTS); // default sync até o init (dispatch nunca vê undefined)

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query("select data from app_settings where id='notif'");
      if (r.rows.length) cur = normalize(r.rows[0].data);
      else
        await db.query(
          "insert into app_settings (id,data) values ('notif',$1) on conflict (id) do nothing",
          [JSON.stringify(cur)],
        );
      usingPg = true;
      console.log("[settings] notificações do Postgres");
      return;
    } catch (e) {
      console.error("[settings] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    cur = normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    cur = normalize(DEFAULTS);
  }
}

function get() {
  return cur;
}
async function update(patch) {
  cur = normalize(patch);
  if (usingPg) {
    try {
      await db.query(
        "insert into app_settings (id,data) values ('notif',$1) on conflict (id) do update set data=excluded.data",
        [JSON.stringify(cur)],
      );
    } catch (e) {
      console.error("[settings] falha ao salvar no PG:", e.message);
    }
  } else {
    try {
      fs.writeFileSync(FILE, JSON.stringify(cur, null, 2));
    } catch (e) {
      console.error("[settings] falha ao salvar:", e.message);
    }
  }
  return cur;
}

module.exports = {
  init,
  get,
  update,
  normalize,
  DEFAULTS,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
