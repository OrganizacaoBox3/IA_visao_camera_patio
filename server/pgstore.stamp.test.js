// CARIMBO DE TURNO no INGEST (spec-turnos-por-zona F3/F5) — o sensor da régua do relatório.
// O que está sob teste: o ingest (server/pgstore.js) é o CHOKE POINT de todos os produtores de
// histórico e é ELE que resolve o turno (fonte única: shift-clock) e o grava na linha — o motor
// não carimba mais nada (o `shiftOf` hardcoded 06/14/22 morreu do hub).
//
// Os três estados que o relatório distingue (src/report/calc/common.ts) e que este arquivo trava:
//   shiftId "sh…"  → DENTRO de um turno cadastrado
//   shiftId null   → resolvido e FORA de turno (D7)  — sentinela '' no banco
//   campo AUSENTE  → SEM carimbo (zona 24/7, cadastro vazio, dado antigo) = comportamento de hoje
// Colapsar "sem carimbo" em "fora de turno" inventaria ociosidade-fora-de-turno em cima de TODO
// o histórico legado — é a regressão que estes testes existem para barrar.
//
// Hermético: DATA_HIST_PATH aponta o flush p/ um tmp (NÃO toca o data-hist.json real) e as envs
// de PG são removidas ANTES do require (db.configured() resolve na carga) → fallback JSON.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_HIST_PATH = path.join(tmpdir(), `vp-hist-stamp-${process.pid}.json`);
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGDATABASE;
delete process.env.VISAO_DB;

const require = createRequire(import.meta.url);
const store = require("./pgstore");

const HOUR = 3_600_000;
const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;
const at = (iso) => Date.parse(iso);

// Fuso do SITE (D6) — Brasil sem DST: UTC-3 o ano todo. O relógio do PROCESSO é irrelevante.
const TZ = "America/Sao_Paulo";
const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6];

// Turno NOITE 22:00–06:00 seg–sex, com pausa 02:00 (+30min) — o caso que quebra tudo que é
// ingênuo: vira o dia (D1/D2), a pausa é interna (D3) e a borda é meio-aberta (D4).
const NOITE = {
  id: "shN",
  nome: "Noite",
  dias: [1, 2, 3, 4, 5],
  inicio: "22:00",
  fim: "06:00",
  pausas: [{ inicio: "02:00", duracaoMin: 30 }],
  ativo: true,
};
// Grade que CORTA a hora ao meio (armadilha 4): a virada é 14:30 — no MEIO do bucket das 14h.
const T1 = { id: "shA", nome: "Turno 1", dias: TODOS_OS_DIAS, inicio: "06:00", fim: "14:30", pausas: [] };
const T2 = { id: "shB", nome: "Turno 2", dias: TODOS_OS_DIAS, inicio: "14:30", fim: "22:00", pausas: [] };

// Cadastro + zonas injetáveis por teste (as fontes reais fazem I/O — aqui são de mentira).
let cadastro = [];
let zonasDaCam = [];
store._setStampSources({
  getZones: () => zonasDaCam,
  allShifts: () => cadastro,
  tz: () => TZ,
});

// Zona de atividade COM turnos atribuídos (F2) × zona 24/7 (sem shiftIds) = comportamento atual.
const zona = (id, shiftIds) => ({ id, label: id === "z0" ? "Livre" : "Doca", modo: "atividade", shiftIds });

async function sample(zoneId, ts, over = {}) {
  vi.spyOn(Date, "now").mockReturnValue(ts); // o sample é carimbado com o "agora" da gravação
  await store.ingest("ativ", "samples", {
    cameraId: "cam1",
    samples: [
      {
        zoneId,
        label: "Doca",
        atividade: "Separação",
        idleMs: 0,
        frames: 10,
        activeFrames: 6,
        people: 2,
        ...over,
      },
    ],
  });
}
const alerta = (zoneId, ts, over = {}) =>
  store.ingest("ativ", "alert", {
    cameraId: "cam1",
    cameraLabel: "Câmera 1",
    zoneId,
    area: "Doca",
    atividade: "Separação",
    ts,
    durationMin: 11,
    ...over,
  });
const cruzamento = (ts, over = {}) =>
  store.ingest("flow", "cross", {
    cameraId: "cam1",
    cameraLabel: "Porta",
    tripwireId: "tw1",
    dir: "in",
    ts,
    ...over,
  });

const ativBuckets = () => store.buckets("ativ");
const one = async (kind = "ativ") => {
  const b = await store.buckets(kind);
  expect(b).toHaveLength(1);
  return b[0];
};

beforeEach(async () => {
  cadastro = [];
  zonasDaCam = [];
  await store.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("carimbo — DEFAULT SEGURO: sem turno aplicável, NADA muda (CA-5)", () => {
  it("zona sem shiftIds (24/7): id do bucket segue com 3 segmentos e a linha sai SEM carimbo", async () => {
    cadastro = [NOITE]; // o cadastro existe, mas esta zona não foi atribuída a turno nenhum
    zonasDaCam = [zona("z0", [])];
    const ts = at("2026-07-15T06:00:00Z"); // 03:00 de quarta em SP — dentro do NOITE, se valesse
    await sample("z0", ts);

    const b = await one();
    expect(b.id).toBe(`cam1|z0|${hourOf(ts)}`); // MESMA linha de hoje (zero migração de dado)
    expect("shiftId" in b).toBe(false); // AUSENTE — nunca null (null significaria "fora do turno")
    expect("inPause" in b).toBe(false);
    expect(b.samples).toBe(10);
  });

  it("cadastro VAZIO: zona com shiftIds órfãos (turno excluído) volta a 24/7 — fail-open", async () => {
    cadastro = [];
    zonasDaCam = [zona("z1", ["shN"])]; // id DANGLING
    await sample("z1", at("2026-07-15T06:00:00Z"));
    const b = await one();
    expect(b.id).toBe(`cam1|z1|${hourOf(at("2026-07-15T06:00:00Z"))}`);
    expect("shiftId" in b).toBe(false);
  });

  it("turno DESATIVADO não é grade: a zona volta a 24/7 (nunca 'tudo fora do turno')", async () => {
    cadastro = [{ ...NOITE, ativo: false }];
    zonasDaCam = [zona("z1", ["shN"])];
    await sample("z1", at("2026-07-15T18:00:00Z"));
    expect("shiftId" in (await one())).toBe(false);
  });
});

describe("carimbo — DENTRO do turno (CA-1: overnight + businessDate + dupla escrita)", () => {
  it("03:00 de QUARTA no turno 22:00–06:00 → businessDate = TERÇA (dia em que o turno INICIOU)", async () => {
    cadastro = [NOITE];
    zonasDaCam = [zona("z1", ["shN"])];
    const ts = at("2026-07-15T06:00:00Z"); // quarta 03:00 em SP
    await sample("z1", ts);

    const b = await one();
    expect(b.shiftId).toBe("shN");
    expect(b.shift).toBe("Noite"); // dupla escrita: o campo legado agora é o NOME do turno
    expect(b.businessDate).toBe("2026-07-14"); // TERÇA — D1
    expect(b.inPause).toBe(false);
    expect(b.id).toBe(`cam1|z1|${hourOf(ts)}|shN`); // turno na CHAVE do bucket
  });

  it("PAUSA (02:00–02:30) vira bucket PRÓPRIO com inPause=true (vazio esperado — D3)", async () => {
    cadastro = [NOITE];
    zonasDaCam = [zona("z1", ["shN"])];
    const naPausa = at("2026-07-15T05:15:00Z"); // 02:15 em SP
    const foraDaPausa = at("2026-07-15T05:45:00Z"); // 02:45 em SP — MESMA hora-bucket
    await sample("z1", naPausa);
    await sample("z1", foraDaPausa);

    const bs = await ativBuckets();
    expect(bs).toHaveLength(2); // a pausa não se mistura com o trabalho dentro do mesmo bucket
    expect(hourOf(naPausa)).toBe(hourOf(foraDaPausa)); // …e é a MESMA hora
    const pausa = bs.find((b) => b.inPause === true);
    expect(pausa.id).toBe(`cam1|z1|${hourOf(naPausa)}|shN~p`);
    expect(bs.find((b) => b.inPause === false).id).toBe(`cam1|z1|${hourOf(naPausa)}|shN`);
  });
});

describe("carimbo — FORA do turno é INFORMAÇÃO, não ausência dela (D7)", () => {
  it("instante fora da grade da zona → shiftId null (não ausente) e rótulo 'Fora de turno'", async () => {
    cadastro = [NOITE];
    zonasDaCam = [zona("z1", ["shN"])];
    const ts = at("2026-07-15T18:00:00Z"); // 15:00 em SP — o NOITE nem começou
    await sample("z1", ts);

    const b = await one();
    expect("shiftId" in b).toBe(true);
    expect(b.shiftId).toBeNull(); // resolvido e FORA (o relatório NÃO conta como ociosidade)
    expect(b.shift).toBe("Fora de turno");
    expect(b.inPause).toBe(false);
    expect(b.id).toBe(`cam1|z1|${hourOf(ts)}|fora`);
  });
});

describe("chave do bucket — a hora sozinha é grosseira demais (armadilha 4)", () => {
  it("turno que vira 14:30 CORTA o bucket das 14h: 2 turnos, MESMA hora, 2 buckets", async () => {
    cadastro = [T1, T2];
    zonasDaCam = [zona("z1", ["shA", "shB"])];
    const antes = at("2026-07-15T17:20:00Z"); // 14:20 em SP → Turno 1
    const depois = at("2026-07-15T17:40:00Z"); // 14:40 em SP → Turno 2 (mesma hora-bucket)
    await sample("z1", antes, { frames: 10, activeFrames: 10 });
    await sample("z1", depois, { frames: 10, activeFrames: 0 });

    const bs = await ativBuckets();
    expect(hourOf(antes)).toBe(hourOf(depois)); // a hora é a mesma…
    expect(bs).toHaveLength(2); // …mas o turno não: sem a dimensão de turno, os dois se somariam
    expect(bs.map((b) => b.shiftId).sort()).toEqual(["shA", "shB"]);
    expect(bs.find((b) => b.shiftId === "shA")).toMatchObject({ activeSamples: 10, shift: "Turno 1" });
    expect(bs.find((b) => b.shiftId === "shB")).toMatchObject({ activeSamples: 0, shift: "Turno 2" });
  });

  it("samples do MESMO turno na mesma hora acumulam no MESMO bucket (a chave não fragmenta à toa)", async () => {
    cadastro = [T1, T2];
    zonasDaCam = [zona("z1", ["shA", "shB"])];
    await sample("z1", at("2026-07-15T17:00:00Z")); // 14:00 em SP
    await sample("z1", at("2026-07-15T17:10:00Z")); // 14:10 em SP
    const b = await one();
    expect(b.shiftId).toBe("shA");
    expect(b.samples).toBe(20);
  });
});

describe("alerta de ociosidade — cai no MESMO bucket dos samples (a chave tem que bater)", () => {
  it("alerta é carimbado com o SEU ts e a grade da SUA zona → bucket do turno, não bucket órfão", async () => {
    cadastro = [NOITE];
    zonasDaCam = [zona("z1", ["shN"])];
    const ts = at("2026-07-15T06:00:00Z"); // 03:00 de quarta em SP
    await sample("z1", ts);
    await alerta("z1", ts, { shift: "Noite (hint legado do cliente)" });

    const b = await one(); // UM bucket: o alerta não criou uma linha sem amostras ao lado
    expect(b.id).toBe(`cam1|z1|${hourOf(ts)}|shN`);
    expect(b.alerts).toBe(1);
    expect(b.samples).toBe(10);

    const [ev] = await store.events("ativ");
    expect(ev.shiftId).toBe("shN");
    expect(ev.shift).toBe("Noite"); // o carimbo do servidor SOBRESCREVE o hint do cliente
    expect(ev.businessDate).toBe("2026-07-14");
  });

  it("zona 24/7: o alerta segue no bucket legado de 3 segmentos (comportamento de hoje)", async () => {
    cadastro = [NOITE];
    zonasDaCam = [zona("z0", [])];
    const ts = at("2026-07-15T06:00:00Z");
    await sample("z0", ts);
    await alerta("z0", ts, { shift: "Noite" });
    const b = await one();
    expect(b.id).toBe(`cam1|z0|${hourOf(ts)}`);
    expect(b.alerts).toBe(1);
    const [ev] = await store.events("ativ");
    expect("shiftId" in ev).toBe(false);
    expect(ev.shift).toBe("Noite"); // sem carimbo, o rótulo do produtor é preservado
  });
});

describe("flow (tripwire) — a linha não tem zona: a referência é a grade GLOBAL do cadastro", () => {
  it("com cadastro: o evento de cruzamento sai carimbado (shiftId + businessDate + nome)", async () => {
    cadastro = [NOITE];
    await cruzamento(at("2026-07-15T06:00:00Z"));
    const [ev] = await store.events("flow");
    expect(ev.shiftId).toBe("shN");
    expect(ev.shift).toBe("Noite");
    expect(ev.businessDate).toBe("2026-07-14");
  });

  it("sem cadastro: NÃO carimba e preserva o `shift` que o produtor mandou (retrocompat)", async () => {
    cadastro = [];
    await cruzamento(at("2026-07-15T06:00:00Z"), { shift: "Noite" });
    const [ev] = await store.events("flow");
    expect("shiftId" in ev).toBe(false);
    expect(ev.shift).toBe("Noite");
  });
});

describe("CA-6 — quem decide é o SITE_TZ, não o relógio do processo", () => {
  it("o MESMO instante cai DENTRO do turno em São Paulo e FORA em UTC (a borda é 06:00 local)", async () => {
    cadastro = [NOITE];
    const ts = at("2026-07-15T06:00:00Z"); // 03:00 em SP · 06:00 em UTC = fim do turno (D4)
    expect(store.shiftStampOf(ts, cadastro, "America/Sao_Paulo")).toMatchObject({
      shiftId: "shN",
      businessDate: "2026-07-14",
    });
    expect(store.shiftStampOf(ts, cadastro, "UTC")).toMatchObject({ shiftId: "", shift: "Fora de turno" });
  });
});

describe("decodeStamp — os 3 estados na LEITURA (o contrato do relatório)", () => {
  it("string = dentro · sentinela '' = FORA (null) · NULL = sem carimbo (campo AUSENTE)", () => {
    expect(store.decodeStamp({ shiftId: "shN", inPause: true, businessDate: "2026-07-14" })).toEqual({
      shiftId: "shN",
      inPause: true,
      businessDate: "2026-07-14",
    });
    expect(store.decodeStamp({ shiftId: "", inPause: null, businessDate: null })).toEqual({
      shiftId: null, // FORA do turno (D7)
      inPause: false,
      businessDate: null,
    });
    const semCarimbo = store.decodeStamp({ shiftId: null, inPause: null, businessDate: null, shift: "Manhã" });
    expect("shiftId" in semCarimbo).toBe(false); // linha antiga: ausência de INFORMAÇÃO
    expect("inPause" in semCarimbo).toBe(false);
    expect(semCarimbo.shift).toBe("Manhã"); // …mas o rótulo legado do dado antigo continua legível
  });

  it("não MUTA a linha original (as do fallback JSON são o estado vivo em memória)", () => {
    const row = { shiftId: "", inPause: null };
    const out = store.decodeStamp(row);
    expect(row.shiftId).toBe(""); // o sentinela segue intacto no store
    expect(out.shiftId).toBeNull();
  });
});

describe("ativBucketId — a chave", () => {
  it("sem carimbo = id LEGADO de 3 segmentos; com carimbo, o turno entra como 4º", () => {
    expect(store.ativBucketId("cam1", "z1", 100, null)).toBe("cam1|z1|100");
    expect(store.ativBucketId("cam1", "z1", 100, { shiftId: "shN", inPause: false })).toBe("cam1|z1|100|shN");
    expect(store.ativBucketId("cam1", "z1", 100, { shiftId: "shN", inPause: true })).toBe("cam1|z1|100|shN~p");
    expect(store.ativBucketId("cam1", "z1", 100, { shiftId: "", inPause: false })).toBe("cam1|z1|100|fora");
  });
});
