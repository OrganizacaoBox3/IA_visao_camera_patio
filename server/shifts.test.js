// Testes do store de turnos (shifts.js) — sem Postgres (fallback JSON). Foco na VALIDAÇÃO DE
// SERVIDOR (diretriz: a regra mora no back; a UI só exibe o erro) — CA-7 (duração 0 / 24h),
// D3 (pausas dentro da janela, sem sobreposição), D5 (dias 0..6 não-vazio) — e no CRUD.
// Efeito colateral: create/remove escrevem server/shifts.json (runtime) → limpo no afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const shifts = require("./shifts");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "shifts.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

const base = { nome: "Turno 1", dias: [1, 2, 3, 4, 5], inicio: "06:00", fim: "14:00" };

describe("shifts — create (validação no servidor)", () => {
  it("cria turno diurno com defaults (ativo, pausas vazias) e id próprio", async () => {
    const r = await shifts.create(base);
    expect(r.error).toBeUndefined();
    expect(r.shift.id).toMatch(/^sh/);
    expect(r.shift.ativo).toBe(true);
    expect(r.shift.pausas).toEqual([]);
    expect(r.shift.dias).toEqual([1, 2, 3, 4, 5]);
  });

  it("cria turno OVERNIGHT (22–06, D2) com pausa de madrugada dentro da janela", async () => {
    const r = await shifts.create({
      nome: "Noturno",
      dias: [1],
      inicio: "22:00",
      fim: "06:00",
      pausas: [{ inicio: "02:00", duracaoMin: 30 }],
    });
    expect(r.error).toBeUndefined();
    expect(r.shift.pausas).toEqual([{ inicio: "02:00", duracaoMin: 30 }]);
  });

  it("CA-7: rejeita duração 0 (fim igual ao início — ambíguo entre 0h e 24h)", async () => {
    const r = await shifts.create({ ...base, fim: "06:00" });
    expect(r.error).toMatch(/duração/i);
  });

  it("rejeita nome vazio e horários malformados", async () => {
    expect((await shifts.create({ ...base, nome: "  " })).error).toMatch(/nome/i);
    expect((await shifts.create({ ...base, inicio: "25:00" })).error).toMatch(/início/i);
    expect((await shifts.create({ ...base, fim: "14h00" })).error).toMatch(/fim/i);
  });

  it("D5: rejeita dias vazio/fora de 0..6; deduplica e ordena os válidos", async () => {
    expect((await shifts.create({ ...base, dias: [] })).error).toMatch(/dias/i);
    expect((await shifts.create({ ...base, dias: [7] })).error).toMatch(/dias/i);
    expect((await shifts.create({ ...base, dias: [-1, 2] })).error).toMatch(/dias/i);
    const ok = await shifts.create({ ...base, nome: "Dedup", dias: [5, 1, 5] });
    expect(ok.shift.dias).toEqual([1, 5]);
  });

  it("D3: rejeita pausa FORA da janela do turno (início fora ou estourando o fim)", async () => {
    const fora = await shifts.create({ ...base, pausas: [{ inicio: "15:00", duracaoMin: 30 }] });
    expect(fora.error).toMatch(/fora da janela/i);
    const estoura = await shifts.create({ ...base, pausas: [{ inicio: "13:30", duracaoMin: 60 }] });
    expect(estoura.error).toMatch(/fora da janela/i);
  });

  it("D3: rejeita pausas SOBREPOSTAS entre si (e pausa com duração inválida)", async () => {
    const sobrepostas = await shifts.create({
      ...base,
      pausas: [
        { inicio: "12:00", duracaoMin: 60 },
        { inicio: "12:30", duracaoMin: 30 },
      ],
    });
    expect(sobrepostas.error).toMatch(/sobrepostas/i);
    const durInvalida = await shifts.create({ ...base, pausas: [{ inicio: "12:00", duracaoMin: 0 }] });
    expect(durInvalida.error).toMatch(/duração/i);
  });
});

describe("shifts — update (patch parcial revalida a entidade inteira)", () => {
  it("patch válido aplica; patch que quebra a regra é rejeitado SEM tocar o estado", async () => {
    const r = await shifts.create({ ...base, nome: "Editável" });
    const ok = await shifts.update(r.shift.id, { nome: "Renomeado" });
    expect(ok.shift.nome).toBe("Renomeado");
    // fim = início (duração 0) via patch → 400 e o turno permanece como estava
    const bad = await shifts.update(r.shift.id, { fim: "06:00" });
    expect(bad.error).toMatch(/duração/i);
    const atual = shifts.all().find((s) => s.id === r.shift.id);
    expect(atual.fim).toBe("14:00");
    expect(atual.nome).toBe("Renomeado");
  });

  it("desativar por patch { ativo:false } funciona; id inexistente → erro", async () => {
    const r = await shifts.create({ ...base, nome: "Desativável" });
    expect((await shifts.update(r.shift.id, { ativo: false })).shift.ativo).toBe(false);
    expect((await shifts.update("sh-nao-existe", { nome: "x" })).error).toMatch(/não encontrado/i);
  });
});

describe("shifts — remove", () => {
  it("remove tira da lista", async () => {
    const r = await shifts.create({ ...base, nome: "Remover" });
    await shifts.remove(r.shift.id);
    expect(shifts.all().some((s) => s.id === r.shift.id)).toBe(false);
  });
});

// GATE ANTI-"PERSISTÊNCIA FALSA" (o impedimento que o dono reportou nos turnos): se a escrita
// durável falha (PG fora/drift OU disco), o turno NÃO pode "aparecer" na tela para sumir no
// restart. A memória tem de ficar INTOCADA e o chamador receber erro claro (status 503). Simula-se
// a falha no caminho JSON (o teste roda sem PG) forçando o writeFileSync a lançar — o try/catch de
// create/update/remove é o MESMO nos dois backends, então o PG está coberto por construção.
describe("shifts — persistência atômica (durável-primeiro, com rollback)", () => {
  it("create: escrita falha → memória INTOCADA + erro 503 (nunca persistência falsa)", async () => {
    const antes = shifts.all().length;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const r = await shifts.create({ ...base, nome: "NaoDeveraPersistir" });
    spy.mockRestore();
    expect(r.error).toMatch(/persistência|salvar/i);
    expect(r.status).toBe(503);
    expect(shifts.all().length).toBe(antes); // memória não cresceu
    expect(shifts.all().some((s) => s.nome === "NaoDeveraPersistir")).toBe(false);
  });

  it("update: escrita falha → a edição faz ROLLBACK (o valor antigo permanece)", async () => {
    const r = await shifts.create({ ...base, nome: "Original" });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const bad = await shifts.update(r.shift.id, { nome: "Editado" });
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(shifts.all().find((s) => s.id === r.shift.id).nome).toBe("Original"); // não mudou
  });

  it("remove: escrita falha → o turno PERMANECE na lista (rollback) + erro 503", async () => {
    const r = await shifts.create({ ...base, nome: "NaoRemovivel" });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const bad = await shifts.remove(r.shift.id);
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(shifts.all().some((s) => s.id === r.shift.id)).toBe(true); // ainda lá
    await shifts.remove(r.shift.id); // limpeza (agora sem o spy, grava de verdade)
  });
});
