// Testes do pool multi-fonte (source-pool.ts) — o merge que conserta o REF QUE PISCA (spec
// multi-antena F4): o hub emite 1 envelope por POST de estação; sem merge, o consumidor alternava
// entre lista-só-A e lista-só-B. Aqui: união das fontes vivas, substituição POR fonte, poda de
// staleness (15 s, espelho do store do servidor) e a regressão CA-3 (1 fonte = conteúdo idêntico
// ao comportamento antigo de "último envelope"). Determinístico — `now` é injetado, sem timers.
import { describe, it, expect } from "vitest";
import { mergeSourceBatch, SOURCE_STALE_MS, type SourceBatch } from "./source-pool";

type R = { mac: string; rssi: number };
const r = (mac: string, rssi: number): R => ({ mac, rssi });

describe("mergeSourceBatch — o pool NÃO pisca entre fontes (o bug do ref)", () => {
  it("envelopes alternados A/B/A: o pool carrega SEMPRE as duas fontes vivas (nunca só a última)", () => {
    const sources = new Map<string, SourceBatch<R>>();
    // O mundo do bug: cada envelope traz SÓ a varredura de uma estação.
    const p1 = mergeSourceBatch(sources, "est-a", [r("AA", -50)], 0);
    expect(p1).toEqual([r("AA", -50)]); // só A chegou até aqui
    const p2 = mergeSourceBatch(sources, "est-b", [r("AA", -72)], 500);
    // Antes do fix, aqui o pool seria lista-só-B. Agora: as DUAS séries da MESMA tag coexistem.
    expect(p2).toEqual([r("AA", -50), r("AA", -72)]);
    const p3 = mergeSourceBatch(sources, "est-a", [r("AA", -48)], 1000);
    // A varredura nova da est-a substitui SÓ a fatia dela; a est-b permanece (não some entre posts).
    expect(p3).toEqual([r("AA", -48), r("AA", -72)]);
  });

  it("ordem ESTÁVEL de 1ª aparição da fonte: re-post não muda a posição da fatia no pool", () => {
    const sources = new Map<string, SourceBatch<R>>();
    mergeSourceBatch(sources, "est-a", [r("AA", -50)], 0);
    mergeSourceBatch(sources, "est-b", [r("BB", -60)], 100);
    // est-a re-posta DEPOIS da est-b, mas segue vindo primeiro (desempates rio abaixo — ex. o
    // align() do associador — ficam determinísticos).
    const pool = mergeSourceBatch(sources, "est-a", [r("AA", -51)], 200);
    expect(pool.map((x) => x.mac)).toEqual(["AA", "BB"]);
  });
});

describe("mergeSourceBatch — CA-3: com UMA fonte o pool é a varredura corrente (como sempre foi)", () => {
  it("cada envelope substitui o pool inteiro — inclusive tag que sumiu do batch e batch vazio", () => {
    const sources = new Map<string, SourceBatch<R>>();
    expect(mergeSourceBatch(sources, "", [r("AA", -40), r("BB", -55)], 0)).toEqual([
      r("AA", -40),
      r("BB", -55),
    ]);
    // BB saiu da varredura seguinte → sai do pool JÁ (sem lingering: a fatia da fonte é substituída
    // inteira — o comportamento antigo de "último envelope", bit-idêntico com 1 fonte).
    expect(mergeSourceBatch(sources, "", [r("AA", -42)], 500)).toEqual([r("AA", -42)]);
    // Batch vazio também substitui (useTagFusion pula o tick com pool vazio, como sempre).
    expect(mergeSourceBatch(sources, "", [], 1000)).toEqual([]);
  });
});

describe("mergeSourceBatch — poda de staleness POR fonte (15 s, espelho do store do servidor)", () => {
  it("fonte calada além de SOURCE_STALE_MS some do pool (e do estado) no próximo merge — M6", () => {
    const sources = new Map<string, SourceBatch<R>>();
    mergeSourceBatch(sources, "est-b", [r("BB", -70)], 0);
    // No limiar exato (15 s) a fonte ainda vive (poda é `> STALE_MS`, como no servidor)…
    const atEdge = mergeSourceBatch(sources, "est-a", [r("AA", -50)], SOURCE_STALE_MS);
    expect(atEdge).toEqual([r("BB", -70), r("AA", -50)]);
    // …1 ms além, a est-b é podada do pool E do estado (degradação natural — o motor segue com A).
    const past = mergeSourceBatch(sources, "est-a", [r("AA", -52)], SOURCE_STALE_MS + 1);
    expect(past).toEqual([r("AA", -52)]);
    expect(sources.has("est-b")).toBe(false);
    expect(sources.has("est-a")).toBe(true);
  });
});
