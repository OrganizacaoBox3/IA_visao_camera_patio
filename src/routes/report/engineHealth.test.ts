// A TRADUÇÃO estado→mensagem é onde mora o valor desta feature — logo é onde mora o teste.
// O eixo do arquivo NÃO é "a string está certa": é "um estado ruim NUNCA sai como normalidade".
// Por isso quase todo bloco tem um ASSERT NEGATIVO (o que não pode aparecer é tão contrato
// quanto o que aparece — mesmo desenho do honest-empty.test.tsx).
import { describe, it, expect } from "vitest";
import {
  buildEngineHealth,
  roundsIn,
  GATE_BLIND_MIN,
  GATE_BLIND_RATIO,
  type EngineHealth,
} from "./engineHealth";
import type { AnalysisCamera, AnalysisStatus } from "../../api";

// Câmera SAUDÁVEL: analisando a 1 fps, gate pulando só cena parada (skipMoving1m = 0).
function cam(over: Partial<AnalysisCamera> = {}): AnalysisCamera {
  return {
    fps: 1,
    targetFps: 1,
    focused: false,
    queue: 0,
    skipped1m: 10,
    motion: 0.02,
    gate: { skipMoving1m: 0, ratioP50: 0.01, ratioP95: 0.08, reasons1m: { motion: 50, skip: 10 } },
    lastMs: 120,
    dets1m: 30,
    excluded1m: 0,
    fadiga: false,
    ...over,
  };
}

function status(over: Partial<AnalysisStatus> = {}): AnalysisStatus {
  return {
    enabled: true,
    model: "dfine_s.onnx",
    targetFps: 1,
    lineFps: 2,
    focusFps: 6,
    focused: [],
    motionGate: {
      enabled: true,
      ratio: 0.005,
      probeMs: 6000,
      probeFocusMs: 2000,
      thumb: "64x36",
      skipped1m: 10,
      skippedTotal: 100,
    },
    autoscale: { mode: "auto", tier: "s", pin: null, choked: 0, idle: 0, lastSwitchAt: 0 },
    worker: { ready: true, size: 2, readyCount: 2, cpuPct: 45, respawns: 0 },
    perCamera: { "cam-1": cam() },
    ...over,
  };
}

/** Todo o texto que o operador LÊ, concatenado — base dos asserts negativos. */
const readable = (h: EngineHealth) =>
  [h.headline, h.meaning, ...h.findings.flatMap((f) => [f.camera ?? "", f.what, f.soWhat])].join(
    " · ",
  );

/** Nenhuma das frases que o painel usa para dizer "está tudo bem" pode aparecer. */
function expectNoNormality(h: EngineHealth) {
  const t = readable(h);
  expect(t).not.toContain("Motor rodando");
  expect(t).not.toContain("Nenhuma anormalidade");
  expect(h.level).not.toBe("ok");
}

// ── Caminho normal (o gate não pode ter apagado o estado saudável) ───────────────────────────
describe("motor saudável", () => {
  const h = buildEngineHealth({ status: status(), error: null, cameras: [] });

  it("é 'ok', sem nenhum achado — going-gray: normalidade não gera linha", () => {
    expect(h.level).toBe("ok");
    expect(h.findings).toEqual([]);
    expect(h.analyzing).toBe(1);
    expect(h.expected).toBe(1);
  });

  it("a manchete é ESCOPADA ao que foi medido, não um 'tudo certo'", () => {
    expect(h.headline).toBe("Motor rodando — 1 de 1 câmera sendo analisada");
    expect(h.meaning).toContain("último minuto");
  });
});

// ── 1. MOTOR DESLIGADO ───────────────────────────────────────────────────────────────────────
describe("motor desligado", () => {
  const h = buildEngineHealth({
    status: status({ enabled: false }),
    error: null,
    cameras: [{ id: "cam-1", label: "Doca 3", online: true }],
  });

  it("a manchete diz DESLIGADO e o significado diz que nada está sendo gravado", () => {
    expect(h.level).toBe("down");
    expect(h.headline).toBe("Motor de análise DESLIGADO");
    expect(h.meaning).toContain("Nenhuma contagem de pessoas está sendo gravada");
  });

  it("explica o falso-OK: o vídeo continua, e é por isso que a tela parece normal", () => {
    const f = h.findings.find((x) => x.id === "engine-off");
    expect(f?.level).toBe("down");
    expect(f?.soWhat).toContain("vídeo");
  });

  it("ASSERT NEGATIVO: nenhuma frase de normalidade, e nada de ruído por câmera", () => {
    expectNoNormality(h);
    // Motor off ⇒ um achado só. Listar 12 câmeras "sem análise" seria despejo, não tradução.
    expect(h.findings).toHaveLength(1);
  });
});

// ── 2. GATE CEGANDO A CÂMERA ─────────────────────────────────────────────────────────────────
describe("gate pulando rodadas COM gente em movimento", () => {
  const blind = (skipMoving1m: number, motion = 50, skip = 10) =>
    buildEngineHealth({
      status: status({
        perCamera: {
          "cam-1": cam({
            gate: { skipMoving1m, ratioP50: 0.002, ratioP95: 0.01, reasons1m: { motion, skip } },
          }),
        },
      }),
      error: null,
      cameras: [{ id: "cam-1", label: "Doca 3", online: true }],
    });

  it("41 de 60 rodadas cegas viram aviso — com o nome da câmera, não o id", () => {
    const h = blind(41, 19, 41);
    const f = h.findings.find((x) => x.id === "cam-gate-blind:cam-1");
    expect(h.level).toBe("warn");
    expect(f?.camera).toBe("Doca 3");
    expect(f?.what).toContain("41 de 60");
    expect(f?.soWhat).toContain("atrasando");
  });

  it("o texto carimba a janela REAL (60s) — nunca 'na última hora'", () => {
    const t = readable(blind(41, 19, 41));
    expect(t).toContain("último minuto");
    expect(t).not.toContain("última hora");
  });

  it("pulo com a cena PARADA é economia, não cegueira: nenhum achado", () => {
    const h = blind(0);
    expect(h.level).toBe("ok");
    expect(h.findings).toEqual([]);
  });

  it("o limiar é PROPORÇÃO + piso absoluto (2 pulos numa janela de 4 não decidem nada)", () => {
    expect(blind(2, 2, 2).findings).toEqual([]); // 2 < GATE_BLIND_MIN, ainda que 50%
    expect(blind(GATE_BLIND_MIN, 597, 3).findings).toEqual([]); // 3 pulos em 600 rodadas = 0,5%
    expect(GATE_BLIND_RATIO).toBeLessThan(1);
  });

  it("hub antigo sem o bloco `gate`: nada é afirmado sobre cegueira", () => {
    const h = buildEngineHealth({
      status: status({ perCamera: { "cam-1": cam({ gate: undefined }) } }),
      error: null,
      cameras: [],
    });
    expect(h.findings.some((f) => f.id.startsWith("cam-gate-blind"))).toBe(false);
    expect(roundsIn(cam({ gate: undefined }))).toBeNull();
  });
});

// ── 3. WORKER MORRENDO EM LOOP ───────────────────────────────────────────────────────────────
describe("pool de inferência", () => {
  it("respawns > 0 viram aviso que fala de BURACO na contagem, não de processo", () => {
    const h = buildEngineHealth({
      status: status({ worker: { ready: true, size: 2, readyCount: 2, cpuPct: 90, respawns: 7 } }),
      error: null,
      cameras: [],
    });
    const f = h.findings.find((x) => x.id === "worker-respawn");
    expect(h.level).toBe("warn");
    expect(f?.what).toContain("7 vezes");
    expect(f?.soWhat).toContain("sem nenhuma contagem");
  });

  it("nenhum worker pronto é FALHA (down), com manchete própria", () => {
    const h = buildEngineHealth({
      status: status({ worker: { ready: false, size: 2, readyCount: 0, cpuPct: 0, respawns: 3 } }),
      error: null,
      cameras: [],
    });
    expect(h.level).toBe("down");
    expect(h.headline).toContain("sem nenhum processo de análise pronto");
    expectNoNormality(h);
  });

  it("pool parcial (1 de 2) é aviso — analisa, mas mais devagar do que deveria", () => {
    const h = buildEngineHealth({
      status: status({ worker: { ready: true, size: 2, readyCount: 1, cpuPct: 60, respawns: 0 } }),
      error: null,
      cameras: [],
    });
    expect(h.findings.find((x) => x.id === "worker-partial")?.level).toBe("warn");
  });
});

// ── 4. ENDPOINT FALHANDO ⇒ DESCONHECIDO (o teste-âncora do falso-OK) ─────────────────────────
describe("consulta ao /api/analysis/status falhando", () => {
  const h = buildEngineHealth({
    status: null,
    error: "Não foi possível conectar ao servidor.",
    cameras: null,
  });

  it("o nível é 'unknown' — nunca 'ok', nunca uma tela verde", () => {
    expect(h.level).toBe("unknown");
    expect(h.headline).toBe("Não foi possível consultar a saúde do motor");
  });

  it("ASSERT NEGATIVO: nenhuma frase de normalidade em nenhum campo do retorno", () => {
    expectNoNormality(h);
    expect(readable(h)).not.toContain("sendo analisada");
    // Nada de contagem inventada e nenhum achado rebaixado a "info" (que a UI pinta como calmo).
    expect(h.expected).toBe(0);
    expect(h.findings.every((f) => f.level === "down")).toBe(true);
  });

  it("diz explicitamente que desconhecido ≠ bom, e preserva o detalhe técnico", () => {
    expect(h.meaning).toContain("não é estado bom");
    expect(h.findings[0].what).toContain("conectar ao servidor");
  });

  it("um status que ainda não voltou também é 'unknown' (nunca zero disfarçado de calmaria)", () => {
    const p = buildEngineHealth({ status: null, error: null, cameras: null });
    expect(p.level).toBe("unknown");
    expect(p.analyzing).toBe(0);
    expectNoNormality(p);
  });

  it("erro tem precedência sobre um payload velho em mãos", () => {
    const stale = buildEngineHealth({ status: status(), error: "Sessão expirada.", cameras: [] });
    expect(stale.level).toBe("unknown");
    expectNoNormality(stale);
  });
});

// ── 5. CÂMERA SEM ANÁLISE ────────────────────────────────────────────────────────────────────
describe("câmera parada", () => {
  it("sem frame nenhum: falha, e o texto avisa que a imagem pode seguir na tela", () => {
    const h = buildEngineHealth({
      status: status({
        perCamera: {
          "cam-1": cam({
            fps: 0,
            gate: { skipMoving1m: 0, ratioP50: 0, ratioP95: 0, reasons1m: {} },
          }),
        },
      }),
      error: null,
      cameras: [{ id: "cam-1", label: "Doca 3", online: true }],
    });
    const f = h.findings.find((x) => x.id === "cam-no-frames:cam-1");
    expect(f?.level).toBe("down");
    expect(f?.soWhat).toContain("central");
    expect(h.headline).toBe("1 de 1 câmera sem análise agora");
    expectNoNormality(h);
  });

  it("frames chegando e nenhuma análise concluída é OUTRO achado (outra causa)", () => {
    const h = buildEngineHealth({
      status: status({ perCamera: { "cam-1": cam({ fps: 0 }) } }),
      error: null,
      cameras: [],
    });
    expect(h.findings.map((f) => f.id)).toContain("cam-idle:cam-1");
  });

  it("online na central e invisível para o motor: o falso-OK clássico vira achado", () => {
    const h = buildEngineHealth({
      status: status({ perCamera: {} }),
      error: null,
      cameras: [
        { id: "cam-9", label: "Expedição", online: true },
        { id: "cam-8", label: "Desligada", online: false },
      ],
    });
    const ids = h.findings.map((f) => f.id);
    expect(ids).toContain("cam-unseen:cam-9");
    expect(ids).not.toContain("cam-unseen:cam-8"); // offline já é sabido; não é surpresa
    expect(h.crossChecked).toBe(true);
  });

  it("sem a lista da central o cruzamento NÃO roda — e o retorno declara isso", () => {
    const h = buildEngineHealth({ status: status(), error: null, cameras: null });
    expect(h.crossChecked).toBe(false);
    expect(h.findings.some((f) => f.id.startsWith("cam-unseen"))).toBe(false);
  });

  it("motor ligado sem nenhuma câmera é falha declarada, não silêncio", () => {
    const h = buildEngineHealth({ status: status({ perCamera: {} }), error: null, cameras: [] });
    expect(h.level).toBe("down");
    expect(h.findings.map((f) => f.id)).toContain("no-cameras");
    expectNoNormality(h);
  });
});

// ── 6. ZEROS ESTRUTURAIS (info) — explicar o zero é parte de não mentir ──────────────────────
describe("zeros que NÃO são falha", () => {
  it("câmera em modo Operador: o zero dela não é pátio vazio", () => {
    const h = buildEngineHealth({
      status: status({ perCamera: { "cam-1": cam({ fadiga: true, fps: 0, targetFps: 0 }) } }),
      error: null,
      cameras: [{ id: "cam-1", label: "Posto 7", online: true }],
    });
    const f = h.findings.find((x) => x.id === "cam-fadiga:cam-1");
    expect(f?.level).toBe("info");
    expect(f?.camera).toBe("Posto 7");
    // `info` não rebaixa a saúde geral (não é anormalidade) e a câmera não entra nas "esperadas".
    expect(h.level).toBe("ok");
    expect(h.expected).toBe(0);
  });

  it("site 100% modo Operador: a manchete DIZ que o hub não conta nada (nunca '0 de 0')", () => {
    const h = buildEngineHealth({
      status: status({ perCamera: { "cam-1": cam({ fadiga: true, fps: 0, targetFps: 0 }) } }),
      error: null,
      cameras: [],
    });
    expect(h.headline).toBe("Motor rodando — nenhuma câmera é analisada pelo hub");
    expect(h.meaning).toContain("não produz");
    expect(h.headline).not.toContain("0 de 0");
  });

  it("modelo N por PIN é informação; N por rebaixamento sob carga é AVISO", () => {
    const pinned = buildEngineHealth({
      status: status({
        autoscale: { mode: "pin", tier: "n", pin: "n", choked: 0, idle: 0, lastSwitchAt: 0 },
      }),
      error: null,
      cameras: [],
    });
    expect(pinned.findings.find((f) => f.id === "model-pinned-light")?.level).toBe("info");
    expect(pinned.level).toBe("ok");

    const auto = buildEngineHealth({
      status: status({
        autoscale: { mode: "auto", tier: "n", pin: null, choked: 4, idle: 0, lastSwitchAt: 1 },
      }),
      error: null,
      cameras: [],
    });
    const f = auto.findings.find((x) => x.id === "model-downgraded");
    expect(auto.level).toBe("warn");
    expect(f?.soWhat).toContain("MENOR");
  });

  it("auto-máscara que escondeu detecção é declarada (quem esconde, mostra que escondeu)", () => {
    const h = buildEngineHealth({
      status: status({
        perCamera: {
          "cam-1": cam({ automasked1m: 4, autoMask: { mode: "hide", suppressed: 2 } }),
        },
      }),
      error: null,
      cameras: [],
    });
    const f = h.findings.find((x) => x.id === "cam-automask:cam-1");
    expect(f?.level).toBe("info");
    expect(f?.what).toContain("4 detecções");
    expect(h.level).toBe("ok"); // info não é anormalidade
  });
});

// ── 7. ORDEM E ESTABILIDADE ──────────────────────────────────────────────────────────────────
describe("ordenação", () => {
  it("o que quebra o dado vem primeiro (down → warn → info)", () => {
    const h = buildEngineHealth({
      status: status({
        worker: { ready: true, size: 1, readyCount: 1, cpuPct: 30, respawns: 2 },
        perCamera: {
          "cam-1": cam({ fadiga: true }),
          "cam-2": cam({
            fps: 0,
            gate: { skipMoving1m: 0, ratioP50: 0, ratioP95: 0, reasons1m: {} },
          }),
        },
      }),
      error: null,
      cameras: [],
    });
    expect(h.findings.map((f) => f.level)).toEqual(["down", "warn", "info"]);
  });

  it("a mesma entrada dá exatamente a mesma saída (pura — sem relógio, sem Math.random)", () => {
    const input = { status: status(), error: null, cameras: [] };
    expect(buildEngineHealth(input)).toEqual(buildEngineHealth(input));
  });
});
