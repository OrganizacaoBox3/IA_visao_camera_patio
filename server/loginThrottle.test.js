// Trava de brute-force do login (server/loginThrottle.js) — auditoria docs/analises/saude/01-*, R-A.
// Clock injetável → sem timers reais. Prova de sensibilidade: bloqueia após `max`, expira
// pela janela, zera no sucesso, e chaves (IPs) distintas não interferem.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLoginThrottle } = require("./loginThrottle");

describe("createLoginThrottle — janela deslizante por chave", () => {
  it("permite até `max` falhas e bloqueia a partir da (max+1)ª na mesma janela", () => {
    let now = 1000;
    const t = createLoginThrottle({ max: 3, windowMs: 1000, clock: () => now });
    for (let i = 0; i < 3; i++) {
      expect(t.check("ip1").allowed).toBe(true); // ainda permitido
      t.fail("ip1");
    }
    const blocked = t.check("ip1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("a janela deslizante libera quando as falhas antigas expiram", () => {
    let now = 0;
    const t = createLoginThrottle({ max: 2, windowMs: 1000, clock: () => now });
    t.fail("ip1"); // t=0
    now = 500;
    t.fail("ip1"); // t=500 → 2 falhas na janela
    expect(t.check("ip1").allowed).toBe(false);
    now = 1001; // a 1ª falha (t=0) saiu da janela de 1000ms; sobra 1 → liberado
    expect(t.check("ip1").allowed).toBe(true);
  });

  it("login OK (succeed) zera a chave — o usuário legítimo não fica preso", () => {
    let now = 0;
    const t = createLoginThrottle({ max: 2, windowMs: 10_000, clock: () => now });
    t.fail("ip1");
    t.fail("ip1");
    expect(t.check("ip1").allowed).toBe(false);
    t.succeed("ip1"); // acertou a senha
    expect(t.check("ip1").allowed).toBe(true);
    expect(t._size()).toBe(0);
  });

  it("chaves distintas (IPs) não interferem entre si", () => {
    let now = 0;
    const t = createLoginThrottle({ max: 1, windowMs: 10_000, clock: () => now });
    t.fail("ip1");
    expect(t.check("ip1").allowed).toBe(false);
    expect(t.check("ip2").allowed).toBe(true); // outro IP, contador próprio
  });

  it("retryAfterSec encolhe conforme a janela avança", () => {
    let now = 0;
    const t = createLoginThrottle({ max: 1, windowMs: 10_000, clock: () => now });
    t.fail("ip1"); // t=0
    const a = t.check("ip1").retryAfterSec; // ~10s
    now = 6000;
    const b = t.check("ip1").retryAfterSec; // ~4s
    expect(b).toBeLessThan(a);
  });
});
