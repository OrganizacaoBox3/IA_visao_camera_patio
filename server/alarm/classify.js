// Taxonomia de alarme — classifica o TEXTO de um alerta em { critico, tipo }.
// Vocabulário do NÚCLEO de alarme: política (evaluate), shelve e canais (WhatsApp/preview)
// consomem DAQUI — nenhum canal é dono da taxonomia (ADR-004: a política decide antes deles).
//   critico: presença do marcador "⚠" (é assim que o front sinaliza criticidade no texto).
//   tipo: palavra-chave → presenca | fadiga | leitura | objetos | atividade (default).
// Quando o payload traz `tipo` EXPLÍCITO, ele vence esta heurística (alarmPolicy.evaluate:
// `p.tipo || meta.tipo`) — o texto é só o fallback dos emissores legados.
function classify(text) {
  const t = String(text || "");
  const critico = t.includes("⚠");
  let tipo = "atividade";
  // "presenca" ANTES de "objetos": o padrão antigo de objetos casa o prefixo "presen…" — a
  // violação de zona PROIBIDA (spec alerta-por-atividade E1) tem tipo PRÓPRIO p/ a chave de
  // dedup `cam|zona|tipo` não colidir com atividade/objetos na mesma zona (armadilha A3).
  // "presen[çc]a" (não o prefixo solto): "objeto presente" continua caindo em objetos.
  if (/presen[çc]a|proibid/i.test(t)) tipo = "presenca";
  else if (/fadiga|celular|bocejo|operador|risco/i.test(t)) tipo = "fadiga";
  else if (/leitura|no-?read|taxa|c[oó]digo/i.test(t)) tipo = "leitura";
  else if (/objeto|presen|carreg|palete|empilhad|caixa/i.test(t)) tipo = "objetos";
  return { critico, tipo };
}

module.exports = { classify };
