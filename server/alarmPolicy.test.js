// Testes das partes DETERMINÍSTICAS da política de alarmes (server/alarmPolicy.js).
// CommonJS (server/ é pacote CJS). Efeitos de persistência são isolados: ALARM_SHELVES_FILE
// aponta p/ um arquivo temporário ANTES do require (nunca toca server/alarm-shelves.json real).
// Determinismo do tempo: vi.useFakeTimers()/setSystemTime fixam Date.now() (usado internamente
// por shelve()/evaluate()); isShelved() recebe `now` explícito.
// vitest é ESM e não pode ser carregado via require() → usamos import. O módulo sob teste
// (alarmPolicy.js) é CommonJS; carregamos via createRequire APÓS definir o env (require é
// chamada em runtime, não hasteada como o import — garante o env antes de ler SHELVES_FILE).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Caminho temporário ÚNICO p/ as shelves — definido ANTES de carregar o módulo.
const SHELVES_FILE = path.join(os.tmpdir(), `alarm-shelves-test-${process.pid}-${Date.now()}.json`);
process.env.ALARM_SHELVES_FILE = SHELVES_FILE;

const policy = require("./alarmPolicy");

const BASE = 1_700_000_000_000; // epoch-ms fixo p/ os testes

beforeEach(() => {
  // Isola estado entre testes (mapas/arrays em memória do singleton de módulo).
  const s = policy._state;
  s.dedup.clear();
  s.floodWin.clear();
  s.floodState.clear();
  s.shelved.clear();
  s.flap.clear();
  s.emitLog.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterAll(() => {
  vi.useRealTimers();
  try {
    fs.unlinkSync(SHELVES_FILE);
  } catch {
    /* arquivo pode não existir */
  }
  try {
    fs.unlinkSync(`${SHELVES_FILE}.tmp`);
  } catch {
    /* idem */
  }
});

describe("classify — palavra-chave → tipo + crítico", () => {
  it("⚠ no texto marca crítico", () => {
    expect(policy.classify("⚠ Doca: parada").critico).toBe(true);
    expect(policy.classify("Doca: parada").critico).toBe(false);
  });
  it("classifica o tipo por palavra-chave", () => {
    expect(policy.classify("uso de celular").tipo).toBe("fadiga");
    expect(policy.classify("no-read na esteira").tipo).toBe("leitura");
    expect(policy.classify("palete no chão").tipo).toBe("objetos");
    expect(policy.classify("movimentação normal").tipo).toBe("atividade"); // default
  });
});

describe("priorityOf — 3 níveis (advisory/high/critical)", () => {
  it("⚠ (meta.critico) → critical", () => {
    const t = "⚠ Doca 3: parada crítica";
    expect(policy.priorityOf(t, policy.classify(t))).toBe("critical");
  });
  it("offline/feed/timeout/falha → high", () => {
    expect(policy.priorityOf("Câmera offline", policy.classify("Câmera offline"))).toBe("high");
    expect(policy.priorityOf("feed caiu", policy.classify("feed caiu"))).toBe("high");
  });
  it("parada/risco/fadiga → high", () => {
    expect(policy.priorityOf("Zona parada há 20min", policy.classify("Zona parada"))).toBe("high");
  });
  it("texto comum sem gatilho → advisory", () => {
    const t = "Taxa de leitura 95%";
    expect(policy.priorityOf(t, policy.classify(t))).toBe("advisory");
  });
});

describe("shelveKeyFor — derivação da chave", () => {
  it("usa campos explícitos (normalizados: trim + lowercase)", () => {
    expect(policy.shelveKeyFor({ cameraId: "Cam 1", zona: "Doca", tipo: "atividade" })).toBe(
      "cam 1|doca|atividade",
    );
  });
  it("payload vazio vira curingas (dimensões não identificadas)", () => {
    // sem cameraId/texto → cameraId fallback "_"; zona/tipo vazios → "*"
    expect(policy.shelveKeyFor({})).toBe("_|*|*");
  });
});

describe("shelve / isShelved / unshelve", () => {
  it("shelve exato cobre só a chave casada e expira sozinho", () => {
    policy.shelve("cam-1|doca|atividade", 60_000);
    expect(policy.isShelved("cam-1", "doca", "atividade", BASE + 1_000)).toBe(
      "cam-1|doca|atividade",
    );
    // chave diferente não é coberta
    expect(policy.isShelved("cam-1", "doca2", "atividade", BASE + 1_000)).toBeNull();
    // após o prazo → expirado
    expect(policy.isShelved("cam-1", "doca", "atividade", BASE + 61_000)).toBeNull();
  });

  it("curinga '*' silencia toda a câmera", () => {
    policy.shelve("cam-x|*|*", 60_000);
    expect(policy.isShelved("cam-x", "qualquer", "fadiga", BASE + 100)).toBe("cam-x|*|*");
    expect(policy.isShelved("cam-y", "qualquer", "fadiga", BASE + 100)).toBeNull();
  });

  it("clampa a duração: piso 1s, default p/ valor inválido, teto p/ valores enormes", () => {
    expect(policy.shelve("k|a|b", 500).ms).toBe(1000); // < piso → 1000
    expect(policy.shelve("k|a|b", 0).ms).toBe(1_800_000); // inválido → default 30min
    expect(policy.shelve("k|a|b", 999_999_999).ms).toBe(14_400_000); // > teto → 4h
  });

  it("unshelve remove e retorna se havia shelve", () => {
    policy.shelve("cam-9|doca|atividade", 60_000);
    expect(policy.listShelved().length).toBe(1);
    expect(policy.unshelve("cam-9|doca|atividade")).toBe(true);
    expect(policy.unshelve("cam-9|doca|atividade")).toBe(false); // já não existia
    expect(policy.isShelved("cam-9", "doca", "atividade", BASE + 100)).toBeNull();
    expect(policy.listShelved().length).toBe(0);
  });
});

describe("evaluate — caminhos determinísticos (com tempo controlado)", () => {
  it("payload sem texto é suprimido", () => {
    expect(policy.evaluate(null)).toBeNull();
    expect(policy.evaluate({ text: "" })).toBeNull();
    expect(policy.evaluate({ text: "   " })).toBeNull();
  });

  it("alarme com chave em shelve é suprimido (null)", () => {
    policy.shelve("cam-z|doca|atividade", 60_000);
    const r = policy.evaluate({
      text: "qualquer coisa",
      cameraId: "cam-z",
      zona: "doca",
      tipo: "atividade",
      ts: BASE,
    });
    expect(r).toBeNull();
  });

  it("alarme novo passa com prioridade classificada", () => {
    const r = policy.evaluate({ text: "Painel: teste", ts: BASE });
    expect(r).not.toBeNull();
    expect(r.priority).toBe("advisory");
    expect(r.text).toBe("Painel: teste");
  });

  it("deduplica repetição da mesma chave na janela e volta a passar após a janela", () => {
    const p = { text: "Painel: repetida", ts: BASE };
    expect(policy.evaluate(p)).not.toBeNull(); // 1ª passa
    expect(policy.evaluate({ ...p })).toBeNull(); // 2ª (mesmo ts) suprimida pelo dedup
    // avança além da janela de dedup (default 60s)
    vi.setSystemTime(BASE + 60_001);
    expect(policy.evaluate({ text: "Painel: repetida" })).not.toBeNull(); // volta a passar
  });
});
