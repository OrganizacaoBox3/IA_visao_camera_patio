// Estado em memória compartilhado pela política de alarmes. Fonte única de
// verdade p/ que os submódulos permaneçam coerentes (todos mutam ESTES objetos).
// Limpeza preguiçosa (ver gc() em alarmPolicy.js) evita crescimento ilimitado.
//
// Só o conjunto `shelved` é persistido em disco (ver persist.js) — representa uma
// decisão deliberada do operador. As demais estruturas são VOLÁTEIS de propósito:
// janelas deslizantes de curtíssimo prazo / contadores observacionais, cujo
// estado correto após um restart é "começar limpo".
const dedup = new Map(); // logicalKey -> ts do último envio
const floodWin = new Map(); // cameraId -> array de ts dos alertas recentes
const floodState = new Map(); // cameraId -> { zonas:Set, lastSummaryTs, n }
const shelved = new Map(); // shelveKey (normalizada) -> { expiresAt, since, ms, reason, by }
const flap = new Map(); // logicalKey -> { fires:[ts...], cooldownUntil }
const emitLog = []; // [{ ts, priority }] de alarmes EMITIDOS (para metrics())

module.exports = { dedup, floodWin, floodState, shelved, flap, emitLog };
