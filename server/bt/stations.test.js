// Testes do registro de ESTAÇÕES BLE (stations.js) — sem Postgres (fallback JSON). Foco na lógica
// NOVA: AUTO-DESCOBERTA (seen), validação de id/nome NO SERVIDOR e o PATCH do operador.
// Efeito colateral: seen/update/remove escrevem server/bt/stations.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const stations = require("./stations");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "stations.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

describe("stations — auto-descoberta (a estação NASCE ao postar)", () => {
  it("id desconhecido → registra PENDENTE (nome = o próprio id), ativo, com primeira/última vez", async () => {
    const r = await stations.seen("tc22-a1b2", 1000);
    expect(r.criada).toBe(true);
    expect(r.station).toMatchObject({
      id: "tc22-a1b2",
      nome: "tc22-a1b2", // pendente: o operador ainda vai batizar
      ativo: true,
      primeiraVezEm: 1000,
      ultimaVezEm: 1000,
    });
    expect(stations.get("tc22-a1b2")).toBeTruthy();
  });

  it("POST repetido NÃO recria nem sobrescreve o nome — só carimba ultimaVezEm", async () => {
    await stations.seen("tc22-repete", 1000);
    await stations.update("tc22-repete", { nome: "Doca 3" });
    const r = await stations.seen("tc22-repete", 9000);
    expect(r.criada).toBe(false);
    expect(r.station.nome).toBe("Doca 3"); // o batismo do operador é soberano
    expect(r.station.primeiraVezEm).toBe(1000); // append-only: a primeira vez não muda
    expect(r.station.ultimaVezEm).toBe(9000);
    expect(stations.all().filter((s) => s.id === "tc22-repete")).toHaveLength(1);
  });

  it("id fora do formato do app → { error } e NADA é registrado (nunca lança)", async () => {
    for (const bad of ["", "  ", "com espaço", "a".repeat(33), "ponto.virgula", null, undefined]) {
      const r = await stations.seen(bad, 1000);
      expect(r.error).toBeTruthy();
      expect(r.station).toBeUndefined();
    }
    expect(stations.all().some((s) => s.id === "ponto.virgula")).toBe(false);
  });
});

describe("stations — PATCH do operador (validação NO SERVIDOR)", () => {
  it("renomeia e (des)ativa", async () => {
    await stations.seen("est-patch", 1000);
    expect((await stations.update("est-patch", { nome: "  Expedição  " })).station.nome).toBe(
      "Expedição",
    ); // trim no servidor
    expect((await stations.update("est-patch", { ativo: false })).station.ativo).toBe(false);
  });

  it("nome vazio, nome > 60 chars e ativo não-booleano são rejeitados (estado intacto)", async () => {
    await stations.seen("est-val", 1000);
    await stations.update("est-val", { nome: "Doca 1" });
    expect((await stations.update("est-val", { nome: "   " })).error).toMatch(/obrigatório/i);
    expect((await stations.update("est-val", { nome: "x".repeat(61) })).error).toMatch(/60/);
    expect((await stations.update("est-val", { ativo: "sim" })).error).toMatch(/booleano/i);
    expect(stations.get("est-val").nome).toBe("Doca 1"); // nada mudou
    expect(stations.get("est-val").ativo).toBe(true);
  });

  it("estação inexistente → erro de não encontrada (vira 404 na rota)", async () => {
    expect((await stations.update("nao-existe", { nome: "X" })).error).toBe(
      "estação não encontrada",
    );
  });
});

describe("stations — remove + nameOf", () => {
  it("remove tira da lista", async () => {
    await stations.seen("est-remover", 1000);
    expect((await stations.remove("est-remover")).removida).toBe(true);
    expect(stations.get("est-remover")).toBeNull();
    expect((await stations.remove("est-remover")).removida).toBe(false); // idempotente
  });

  it("nameOf devolve o nome amigável (fallback = o id, p/ a estação ainda pendente)", async () => {
    await stations.seen("est-nome", 1000);
    expect(stations.nameOf("est-nome")).toBe("est-nome"); // pendente
    await stations.update("est-nome", { nome: "Portaria" });
    expect(stations.nameOf("est-nome")).toBe("Portaria");
    expect(stations.nameOf("desconhecida")).toBe("desconhecida"); // nunca fica vazio
  });
});

// GATE ANTI-"PERSISTÊNCIA FALSA": falha de escrita durável não pode deixar estação/edição só em
// memória (some no restart). update/remove viram 503 (a rota faz surface); a estação NOVA em `seen`
// faz rollback (sem estação-fantasma) — o write-behind do ultimaVezEm é a única exceção (best-effort).
describe("stations — persistência atômica (durável-primeiro, com rollback)", () => {
  const failWrite = () =>
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });

  it("seen (estação NOVA): escrita falha → NENHUMA estação-fantasma + erro 503", async () => {
    const antes = stations.all().length;
    const spy = failWrite();
    const r = await stations.seen("est-fantasma", 1000);
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(stations.get("est-fantasma")).toBeNull();
    expect(stations.all().length).toBe(antes);
  });

  it("update: escrita falha → ROLLBACK (o nome antigo permanece) + 503", async () => {
    await stations.seen("est-upd-fail", 1000);
    await stations.update("est-upd-fail", { nome: "Doca 9" });
    const spy = failWrite();
    const bad = await stations.update("est-upd-fail", { nome: "Editado" });
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(stations.get("est-upd-fail").nome).toBe("Doca 9");
  });

  it("remove: escrita falha → a estação PERMANECE (rollback) + 503", async () => {
    await stations.seen("est-rm-fail", 1000);
    const spy = failWrite();
    const bad = await stations.remove("est-rm-fail");
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(stations.get("est-rm-fail")).toBeTruthy();
    await stations.remove("est-rm-fail"); // limpeza (grava de verdade)
  });
});
