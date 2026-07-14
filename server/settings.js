// Configuração das NOTIFICAÇÕES (superadmin): marca, o que a mensagem mostra e, por tipo de alerta,
// se notifica + título + instrução extra. Cache em memória; persiste no Postgres (app_settings id='notif')
// se configurado, ou em notif-settings.json (fallback). Usada pelo dispatch (settings.get(), sync).
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");

const FILE = path.join(__dirname, "notif-settings.json");
let usingPg = false;

const DEFAULTS = {
  marca: "Visão de Pátio",
  incluirLocal: true,
  incluirHora: true,
  incluirRodape: true,
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
