// GUARDIÃO DE PERSISTÊNCIA — torna ALTA, no boot, a armadilha silenciosa que fez os turnos do dono
// sumirem: "Postgres CONFIGURADO, mas um store caiu no fallback JSON".
//
// Por que isso é uma armadilha de PERDA DE DADOS: quando o PG está configurado mas a tabela de um
// store não existe (schema não aplicado / sem permissão de DDL), o store cai no arquivo .json —
// EM SILÊNCIO (uma linha de log fácil de perder). Esse .json NÃO sobrevive a um redeploy sem volume
// persistente, então o dado gravado some no próximo deploy. Este módulo transforma esse silêncio
// num alerta impossível de ignorar no boot (e num estado consultável por /api/health).
//
// PURO no núcleo (summarize) — testável sem I/O; report() só formata + loga.

/**
 * @param {boolean} pgConfigured  db.configured() — o PG está setado no ambiente?
 * @param {Record<string,"pg"|"json">} backends  store → backend efetivo (store.persistence())
 * @returns {{ pgConfigured:boolean, backends:object, onJson:string[], danger:boolean }}
 *   danger = PG configurado E ≥1 store no JSON (o combo que perde dado no redeploy).
 */
function summarize(pgConfigured, backends) {
  const onJson = Object.keys(backends)
    .filter((k) => backends[k] === "json")
    .sort();
  return { pgConfigured, backends, onJson, danger: !!pgConfigured && onJson.length > 0 };
}

// Loga o resumo dos backends e, no combo de perigo, um banner de alerta. `log` injetável p/ teste.
function report(pgConfigured, backends, log = console) {
  const s = summarize(pgConfigured, backends);
  const linha = Object.keys(backends)
    .map((k) => `${k}=${backends[k]}`)
    .join(" ");
  log.log(`[persistência] backends: ${linha || "(nenhum store)"}`);
  if (s.danger) {
    log.warn(
      [
        "",
        "⚠️  ================ ALERTA DE PERSISTÊNCIA — RISCO DE PERDA DE DADOS ================",
        "⚠️  O Postgres está CONFIGURADO, mas estes stores caíram no fallback JSON:",
        `⚠️      ${s.onJson.join(", ")}`,
        "⚠️  Um arquivo .json NÃO sobrevive a um redeploy sem volume persistente — o que for",
        "⚠️  gravado nesses stores SOME no próximo deploy (foi o que aconteceu com os turnos).",
        '⚠️  Causa provável: a tabela não existe no Postgres. Procure "[<store>] Postgres',
        '⚠️  indisponível, usando JSON" e "[db] falha ao conectar/inicializar" nos logs acima.',
        "⚠️  Conserte aplicando o server/schema.sql (o usuário do PG precisa de CREATE TABLE).",
        "⚠️  ================================================================================",
        "",
      ].join("\n"),
    );
  }
  return s;
}

module.exports = { summarize, report };
