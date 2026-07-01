// Derivação e normalização de chaves a partir do payload de alerta.
// O painel hoje emite só { text, ts }; quando vierem cameraId/zona/tipo
// explícitos eles têm prioridade. Segmentos de shelve são normalizados
// (trim + lowercase; vazio vira curinga "*").

function pickCamera(p, text) {
  if (p.cameraId) return String(p.cameraId).trim();
  const i = text.indexOf(": ");
  if (i > 0 && i < 60) return text.slice(0, i).trim(); // padrão "Local: mensagem"
  return "_";
}

function pickBody(p, text) {
  const i = text.indexOf(": ");
  if (i > 0 && i < 60) return text.slice(i + 2).trim();
  return text;
}

function pickZona(p, text) {
  if (p.zona) return String(p.zona).trim().toLowerCase();
  const m = text.match(/\b(zona|área|area|doca|setor)\s*[:#]?\s*([\wà-ú-]+)/i);
  if (m) return `${m[1]}${m[2]}`.toLowerCase();
  return "";
}

function normSeg(s) {
  const v = String(s ?? "")
    .trim()
    .toLowerCase();
  return v === "" ? "*" : v; // segmento vazio vira curinga (silencia a dimensão)
}

// Normaliza uma chave de shelve livre ("cam|zona|tipo", curingas opcionais) em
// exatamente 3 segmentos. Faltando segmentos → completados com "*".
function normShelveKey(key) {
  const parts = String(key ?? "").split("|");
  const cam = normSeg(parts[0]);
  const zona = normSeg(parts[1]);
  const tipo = normSeg(parts[2]);
  return `${cam}|${zona}|${tipo}`;
}

function segMatch(pattern, actual) {
  return pattern === "*" || pattern === actual;
}

module.exports = { pickCamera, pickBody, pickZona, normSeg, normShelveKey, segMatch };
