// loginThrottle.js — trava de brute-force do /api/login. Janela DESLIZANTE em memória,
// SEM dependência (padrão da casa: crypto nativo + node:http bastam). Conta tentativas
// FALHAS por chave (IP): ao atingir `max` dentro de `windowMs`, bloqueia com 429 até a
// janela esvaziar. Login OK zera a chave. Clock injetável → teste determinístico.
//
// Escopo honesto: mitiga brute-force de UMA origem (o caso comum). Atrás de proxy único
// (nginx no homolog) a chave é o IP do X-Forwarded-For (1º hop) — ver clientIp em routes/auth.js.
// NÃO é rate-limit distribuído (sem Redis); reinicia com o processo. Suficiente p/ o alvo.
"use strict";

function createLoginThrottle({ max = 10, windowMs = 15 * 60 * 1000, clock = () => Date.now() } = {}) {
  const hits = new Map(); // key -> number[] (timestamps das falhas ainda dentro da janela)

  // Timestamps de falha ainda válidos (dentro da janela); poda os expirados de passagem.
  function recent(key, t) {
    const arr = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
    if (arr.length) hits.set(key, arr);
    else hits.delete(key);
    return arr;
  }

  return {
    // Chamado ANTES de autenticar. Bloqueia se já estourou; NÃO registra tentativa.
    check(key) {
      const t = clock();
      const arr = recent(key, t);
      if (arr.length >= max) {
        const retryAfterMs = windowMs - (t - arr[0]); // até a falha mais antiga sair da janela
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      return { allowed: true };
    },
    // Registra uma tentativa FALHA (chamado após credencial inválida).
    fail(key) {
      const t = clock();
      const arr = recent(key, t);
      arr.push(t);
      hits.set(key, arr);
    },
    // Login OK → limpa a chave (o usuário legítimo não fica preso por falhas anteriores).
    succeed(key) {
      hits.delete(key);
    },
    _size() {
      return hits.size; // introspecção p/ teste
    },
  };
}

module.exports = { createLoginThrottle };
