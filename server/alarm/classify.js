// Taxonomia de alarme — classifica o TEXTO de um alerta em { critico, tipo }.
// Vocabulário do NÚCLEO de alarme: política (evaluate), shelve e canais (WhatsApp/preview)
// consomem DAQUI — nenhum canal é dono da taxonomia (ADR-004: a política decide antes deles).
//   critico: presença do marcador "⚠" (é assim que o front sinaliza criticidade no texto).
//   tipo: palavra-chave → fadiga | leitura | objetos | atividade (default).
function classify(text) {
  const t = String(text || "");
  const critico = t.includes("⚠");
  let tipo = "atividade";
  if (/fadiga|celular|bocejo|operador|risco/i.test(t)) tipo = "fadiga";
  else if (/leitura|no-?read|taxa|c[oó]digo/i.test(t)) tipo = "leitura";
  else if (/objeto|presen|carreg|palete|empilhad|caixa/i.test(t)) tipo = "objetos";
  return { critico, tipo };
}

module.exports = { classify };
