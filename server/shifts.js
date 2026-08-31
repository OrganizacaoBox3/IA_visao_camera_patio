// Cadastro GLOBAL de TURNOS de trabalho (spec-turnos-por-zona F1). Entidade nomeada, cadastrada
// 1× e atribuída a N zonas (F2, via cam_zones.data). Cache em memória; escrita no Postgres (se
// configurado) ou shifts.json (fallback) — MESMO padrão do bt-tags.js/recipients.js.
// A VALIDAÇÃO DE NEGÓCIO mora AQUI (servidor, não na UI): duração ∈ (0, 24h) com fim ≤ início
// ⇒ +1 dia (D2), dias ⊆ 0..6 não-vazio (D5), pausas dentro da janela e sem sobreposição (D3).
// SÓ config é persistida (LGPD) — nenhum dado de pessoa/imagem.
const fs = require("node:fs");
const { statePath } = require("./state-dir");
const crypto = require("node:crypto");
const db = require("./db");
const clock = require("./shift-clock");

const FILE = statePath("shifts.json");
let list = [];
let usingPg = false;

// LANÇA em falha (disco cheio/permissão) — de propósito: quem chama (create/update/remove) trata e
// FAZ ROLLBACK da memória. Engolir aqui recriaria a "persistência falsa" (a UI mostra o que o disco
// recusou). Escreve a lista INTEIRA, então o chamador já mutou a memória ANTES de chamar.
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
async function persist(t) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into shifts (id,nome,dias,inicio,fim,pausas,ativo,criado_em) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set nome=excluded.nome, dias=excluded.dias, inicio=excluded.inicio,
       fim=excluded.fim, pausas=excluded.pausas, ativo=excluded.ativo`,
    [
      t.id,
      t.nome,
      JSON.stringify(t.dias),
      t.inicio,
      t.fim,
      JSON.stringify(t.pausas),
      t.ativo,
      t.criadoEm ?? Date.now(),
    ],
  );
}
async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from shifts where id=$1", [id]);
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, nome, dias, inicio, fim, pausas, ativo, criado_em as "criadoEm"
         from shifts order by criado_em asc nulls first`,
      );
      list = r.rows;
      usingPg = true;
      console.log(`[shifts] ${list.length} turno(s) do Postgres`);
      return;
    } catch (e) {
      console.error("[shifts] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(a)) list = a;
  } catch {
    list = [];
  }
}

// ── Validação (a regra vive no servidor; a UI só exibe a mensagem) ───────────────────────────
// Recebe a entidade COMPLETA (no update, o candidato já mesclado) e devolve { value } saneado
// ou { error } com mensagem clara p/ o 400. Nada é mutado antes de validar.
function validateShift(input) {
  const nome = String(input.nome ?? "").trim();
  if (!nome) return { error: "nome do turno é obrigatório" };

  const diasIn = Array.isArray(input.dias) ? input.dias.map(Number) : null;
  if (!diasIn || diasIn.length === 0 || diasIn.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    return { error: "dias inválidos — informe ao menos um dia da semana (0=domingo a 6=sábado)" };
  const dias = [...new Set(diasIn)].sort((a, b) => a - b);

  const ini = clock.parseHM(input.inicio);
  if (ini == null) return { error: 'início inválido — use o formato "HH:MM"' };
  const fim = clock.parseHM(input.fim);
  if (fim == null) return { error: 'fim inválido — use o formato "HH:MM"' };
  // D2: fim ≤ início ⇒ +1 dia; o mod 24h dá o teto de 24h de graça. Duração 0 (fim == início)
  // é ambígua (turno vazio × 24h) e o mercado rejeita — CA-7.
  const durMin = clock.durationMin(ini, fim);
  if (durMin === 0)
    return { error: "duração inválida — fim igual ao início dá turno de 0h (turno que vira o dia usa fim menor que o início; máximo 24h)" };

  const pausasIn = input.pausas ?? [];
  if (!Array.isArray(pausasIn)) return { error: "pausas inválidas — esperado uma lista" };
  const pausas = [];
  for (const p of pausasIn) {
    const pIni = clock.parseHM(p && p.inicio);
    if (pIni == null) return { error: 'pausa com início inválido — use o formato "HH:MM"' };
    const dur = Number(p && p.duracaoMin);
    if (!Number.isInteger(dur) || dur <= 0)
      return { error: "pausa com duração inválida — minutos inteiros maiores que zero" };
    // D3: pausa DENTRO da janela do turno (offset relativo ao início absorve o overnight).
    const off = (pIni - ini + 24 * 60) % (24 * 60);
    if (off + dur > durMin)
      return { error: `pausa ${String(p.inicio).trim()} (${dur}min) fora da janela do turno` };
    pausas.push({ inicio: String(p.inicio).trim(), duracaoMin: dur, off });
  }
  pausas.sort((a, b) => a.off - b.off);
  for (let i = 1; i < pausas.length; i++) {
    if (pausas[i].off < pausas[i - 1].off + pausas[i - 1].duracaoMin)
      return { error: `pausas sobrepostas (${pausas[i - 1].inicio} e ${pausas[i].inicio})` };
  }

  return {
    value: {
      nome,
      dias,
      inicio: String(input.inicio).trim(),
      fim: String(input.fim).trim(),
      pausas: pausas.map(({ inicio, duracaoMin }) => ({ inicio, duracaoMin })),
      ativo: input.ativo !== false,
    },
  };
}

// DURÁVEL-PRIMEIRO com ROLLBACK — a garantia contra "persistência falsa" (o turno que aparece na
// tela e some no restart, provado em shifts.test.js): aplica-se otimista à memória, persiste, e
// DESFAZ a memória se a escrita falhar. Um `{ shift }` só retorna quando o dado está DURÁVEL; a
// falha volta a memória ao estado anterior e devolve erro claro (status 503) — o operador nunca é
// enganado por um save que não gravou. Vale p/ PG (upsert) E JSON (saveFile lança).
const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} o turno — a persistência está indisponível; tente novamente`,
  status: 503,
});

async function create(input) {
  const v = validateShift(input || {});
  if (v.error) return { error: v.error };
  const t = {
    id: "sh" + crypto.randomBytes(5).toString("hex"),
    ...v.value,
    criadoEm: Date.now(),
  };
  list.push(t);
  try {
    await persist(t);
  } catch (e) {
    list = list.filter((x) => x !== t); // rollback: remove exatamente o que entrou
    console.error("[shifts] FALHA ao salvar turno (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { shift: t };
}

// PATCH parcial: mescla o patch sobre o existente e revalida a entidade INTEIRA — um patch que
// deixe o turno inconsistente (ex.: fim = início) é rejeitado sem tocar o estado.
async function update(id, patch = {}) {
  const t = list.find((x) => x.id === id);
  if (!t) return { error: "turno não encontrado" };
  const candidato = {
    nome: patch.nome !== undefined ? patch.nome : t.nome,
    dias: patch.dias !== undefined ? patch.dias : t.dias,
    inicio: patch.inicio !== undefined ? patch.inicio : t.inicio,
    fim: patch.fim !== undefined ? patch.fim : t.fim,
    pausas: patch.pausas !== undefined ? patch.pausas : t.pausas,
    ativo: patch.ativo !== undefined ? patch.ativo : t.ativo,
  };
  const v = validateShift(candidato);
  if (v.error) return { error: v.error };
  const before = { ...t }; // snapshot p/ rollback
  Object.assign(t, v.value);
  try {
    await persist(t);
  } catch (e) {
    Object.assign(t, before); // rollback: a edição não gravou → memória volta ao estado anterior
    console.error("[shifts] FALHA ao editar turno (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { shift: t };
}

async function remove(id) {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: true }; // idempotente: nada a remover
  const [removed] = list.splice(idx, 1); // remoção otimista
  try {
    await persistDelete(id);
  } catch (e) {
    list.splice(idx, 0, removed); // rollback: re-insere na posição original
    console.error("[shifts] FALHA ao remover turno (persistência):", e.message);
    return PERSIST_ERROR("remover");
  }
  return { ok: true };
}

module.exports = {
  init,
  create,
  update,
  remove,
  validateShift,
  all: () => list,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
