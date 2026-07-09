// Testes do inflight.js — controle de inferências em voo por câmera (paralelismo do foco).
// Cobre: limite de concorrência, liberação de slot (abort), guarda de órfã e de ORDEM de captura.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInflightSlots } = require("./inflight");

describe("createInflightSlots — limite de concorrência", () => {
  it("serial (max=1): 1 em voo bloqueia o próximo até liberar", () => {
    const s = createInflightSlots();
    expect(s.canBegin(1)).toBe(true);
    s.begin(1);
    expect(s.count()).toBe(1);
    expect(s.canBegin(1)).toBe(false); // ocupado
    s.settle(1, 100); // respondeu
    expect(s.count()).toBe(0);
    expect(s.canBegin(1)).toBe(true); // livre de novo
  });

  it("paralelo (max=3): até 3 em voo, o 4º espera", () => {
    const s = createInflightSlots();
    s.begin(1);
    s.begin(2);
    s.begin(3);
    expect(s.count()).toBe(3);
    expect(s.canBegin(3)).toBe(false); // cheio
    s.settle(2, 100); // um respondeu
    expect(s.canBegin(3)).toBe(true); // abriu vaga
  });

  it("canBegin trata max inválido como 1 (nunca trava de vez nem libera infinito)", () => {
    const s = createInflightSlots();
    expect(s.canBegin(0)).toBe(true); // 0 vazio → cabe 1
    s.begin(1);
    expect(s.canBegin(0)).toBe(false);
    expect(s.canBegin(-5)).toBe(false);
  });
});

describe("createInflightSlots — liberação de slot", () => {
  it("abort libera sem aplicar (worker morreu / dropped / erro) e é idempotente", () => {
    const s = createInflightSlots();
    s.begin(7);
    s.abort(7);
    expect(s.count()).toBe(0);
    s.abort(7); // 2ª vez não estoura contador
    expect(s.count()).toBe(0);
  });

  it("abort NÃO mexe na guarda de ordem (frame descartado não avança o relógio aplicado)", () => {
    const s = createInflightSlots();
    s.begin(1);
    s.abort(1); // dropped/erro no ts 500 — mas não aplicou
    s.begin(2);
    expect(s.settle(2, 300)).toBe(true); // 300 ainda aplica (o abort não fixou 500)
  });
});

describe("createInflightSlots — guarda de órfã e de ORDEM de captura", () => {
  it("settle de jobId desconhecido = órfã → false (respawn/prune)", () => {
    const s = createInflightSlots();
    expect(s.settle(999, 100)).toBe(false);
  });

  it("resposta FORA DE ORDEM (frame mais velho depois do mais novo) é descartada", () => {
    const s = createInflightSlots();
    s.begin(1); // captura t=100
    s.begin(2); // captura t=200
    expect(s.settle(2, 200)).toBe(true); // o mais novo aplica primeiro
    expect(s.settle(1, 100)).toBe(false); // o mais velho chegou depois → DESCARTA (não regride o tracker)
    expect(s.count()).toBe(0); // mas o slot foi liberado nos dois casos
  });

  it("em ordem: cada captura mais nova aplica", () => {
    const s = createInflightSlots();
    s.begin(1);
    s.begin(2);
    expect(s.settle(1, 100)).toBe(true);
    expect(s.settle(2, 200)).toBe(true);
  });

  it("captura IGUAL à última aplicada é descartada (só estritamente mais nova aplica)", () => {
    const s = createInflightSlots();
    s.begin(1);
    s.begin(2);
    expect(s.settle(1, 100)).toBe(true);
    expect(s.settle(2, 100)).toBe(false); // mesmo ts → não reaplica
  });
});
