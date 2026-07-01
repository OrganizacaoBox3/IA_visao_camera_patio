// Anti-flapping (chattering) — se a MESMA chave re-emite muitas vezes na janela,
// entra em cooldown (off-delay) e é suprimida até o cooldown passar. Opera sobre
// EMISSÕES que já passaram pelo dedup. Retorna true se deve SUPRIMIR.
const { log, FLAP_ENABLED, FLAP_WINDOW_MS, FLAP_THRESHOLD, FLAP_COOLDOWN_MS } = require("./config");
const { flap } = require("./state");

function flapSuppress(key, now) {
  if (!FLAP_ENABLED) return false;
  let st = flap.get(key);
  if (!st) {
    st = { fires: [], cooldownUntil: 0 };
    flap.set(key, st);
  }
  if (now < st.cooldownUntil) {
    log.debug(
      { key, cooldownMs: st.cooldownUntil - now },
      "[alarm] flap: chave em cooldown — suprimida",
    );
    return true;
  }
  while (st.fires.length && now - st.fires[0] > FLAP_WINDOW_MS) st.fires.shift();
  st.fires.push(now);
  if (st.fires.length > FLAP_THRESHOLD) {
    st.cooldownUntil = now + FLAP_COOLDOWN_MS;
    st.fires.length = 0;
    log.warn(
      { key, janelaMs: FLAP_WINDOW_MS, limite: FLAP_THRESHOLD, cooldownMs: FLAP_COOLDOWN_MS },
      "[alarm] flapping detectado — cooldown aplicado",
    );
    return true; // já suprime o disparo que estourou o limite
  }
  return false;
}

module.exports = { flapSuppress };
