// Contrato do FALLBACK JSON do histórico (sem Postgres) — auditoria analises/saude/01-*.
// Barra regressão SILENCIOSA do caminho que roda no homolog/dev quando o PG cai: ingest →
// buckets/events round-trip, na MESMA forma camelCase dos SELECTs (o front não distingue PG de
// JSON). Antes só flushIntervalMs (puro) era testado; o round-trip do store não tinha sensor.
//
// Hermético: DATA_HIST_PATH aponta o flush p/ um tmp (NÃO toca o data-hist.json real) e as envs
// de PG são removidas ANTES do require (db.configured() é resolvido na carga) → fallback garantido.
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_HIST_PATH = path.join(tmpdir(), `vp-hist-fallback-${process.pid}.json`);
delete process.env.DATABASE_URL; // db.configured() = DATABASE_URL || (PGHOST && PGDATABASE)
delete process.env.PGHOST;
delete process.env.PGDATABASE;
delete process.env.VISAO_DB;

const require = createRequire(import.meta.url);
const store = require("./pgstore");

const HOUR = 3_600_000;
const NOW = Date.now();
const H = Math.floor(NOW / HOUR) * HOUR; // hora corrente (dentro da retenção — não é podada)
// ts a alguns segundos DENTRO da hora H (longe da borda → mesmo bucket, determinístico).
const cross = (dir, offsetMs) => ({
  ts: H + offsetMs,
  cameraId: "cam-x",
  cameraLabel: "Porta",
  tripwireId: "tw1",
  dir,
  shift: "A",
});

describe("pgstore — contrato do fallback JSON (sem Postgres)", () => {
  beforeAll(async () => {
    await store.clear(); // slate limpo (independe de arquivo pré-existente)
  });

  it("status() reporta persistence='json' quando não há Postgres", async () => {
    expect((await store.status()).persistence).toBe("json");
  });

  it("ingest de flow:cross agrega o bucket (in/out) na forma do contrato", async () => {
    await store.ingest("flow", "cross", cross("in", 1000));
    await store.ingest("flow", "cross", cross("in", 2000));
    await store.ingest("flow", "cross", cross("out", 3000));

    const buckets = await store.buckets("flow");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      id: `cam-x|tw1|${H}`,
      cameraId: "cam-x",
      cameraLabel: "Porta",
      tripwireId: "tw1",
      hourStart: H,
      in: 2, // duas entradas
      out: 1, // uma saída
    });
  });

  it("events() devolve as linhas cruas ordenadas por ts desc (como o SQL)", async () => {
    const events = await store.events("flow");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ dir: "out", cameraId: "cam-x", tripwireId: "tw1" }); // ts mais alto 1º
    expect(events.map((e) => e.ts)).toEqual([H + 3000, H + 2000, H + 1000]);
    expect(events.every((e) => e.cameraLabel === "Porta")).toBe(true);
  });

  it("status().counts reflete o nº de buckets por kind", async () => {
    const s = await store.status();
    expect(s.counts.flow).toBe(1);
    expect(s.counts.ativ).toBe(0);
  });

  it("kind desconhecido degrada p/ vazio (não lança)", async () => {
    expect(await store.buckets("inexistente")).toEqual([]);
    expect(await store.events("inexistente")).toEqual([]);
  });

  it("clear() zera memória (buckets e eventos)", async () => {
    await store.clear();
    expect(await store.buckets("flow")).toHaveLength(0);
    expect(await store.events("flow")).toHaveLength(0);
    expect((await store.status()).counts.flow).toBe(0);
  });
});
