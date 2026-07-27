// A tradução já é testada em engineHealth.test.ts; AQUI se prova que ela chega à TELA — e,
// principalmente, o que NÃO chega. Render de servidor (renderToStaticMarkup, sem DOM e sem
// dependência nova), no mesmo desenho do honest-empty.test.tsx.
//
// O risco que este arquivo cobre: alguém "melhora" a vista e a faixa volta a pintar calmaria por
// cima de um estado ruim (um `?? "ok"`, um fallback verde, um catch que engole). O gate quebra.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { EngineHealthView } from "./SaudeMotorPanel";
import { buildEngineHealth } from "./engineHealth";
import type { AnalysisStatus } from "../../api";

const html = (el: ReactElement) => renderToStaticMarkup(el);
/** O TEXTO que o operador lê (sem tags/atributos) — assert negativo em HTML cru é armadilha. */
const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const healthy: AnalysisStatus = {
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
  worker: { ready: true, size: 2, readyCount: 2, cpuPct: 40, respawns: 0 },
  perCamera: {
    "cam-1": {
      fps: 1,
      targetFps: 1,
      focused: false,
      queue: 0,
      skipped1m: 8,
      motion: 0.02,
      gate: { skipMoving1m: 0, ratioP50: 0.01, ratioP95: 0.05, reasons1m: { motion: 52, skip: 8 } },
      lastMs: 110,
      dets1m: 24,
      excluded1m: 0,
      fadiga: false,
    },
  },
};

const view = (
  args: Parameters<typeof buildEngineHealth>[0],
  opts: { canConfigure?: boolean } = {},
) => (
  <EngineHealthView
    health={buildEngineHealth(args)}
    status={args.status}
    canConfigure={opts.canConfigure ?? false}
  />
);

// ── O ESTADO RUIM NÃO PODE SER PINTADO DE CALMO ──────────────────────────────────────────────
describe("consulta falhando", () => {
  const el = view({ status: null, error: "Não foi possível conectar ao servidor.", cameras: null });

  it("declara a impossibilidade de consultar, com o detalhe técnico do erro", () => {
    const out = text(el);
    expect(out).toContain("Não foi possível consultar a saúde do motor");
    expect(out).toContain("conectar ao servidor");
    expect(out).toContain("não é estado bom");
  });

  it("ASSERT NEGATIVO: nada de normalidade na tela", () => {
    const out = text(el);
    expect(out).not.toContain("Motor rodando");
    expect(out).not.toContain("Nenhuma anormalidade");
    expect(out).not.toContain("sendo analisada");
  });

  it("a faixa é marcada como 'unknown' — não herda o visual do estado ok", () => {
    expect(html(el)).toContain('data-level="unknown"');
    expect(html(el)).not.toContain('data-level="ok"');
  });

  it("sem status não há detalhe técnico nem para quem configura (não há o que detalhar)", () => {
    expect(
      text(view({ status: null, error: "falhou", cameras: null }, { canConfigure: true })),
    ).not.toContain("Detalhe técnico");
  });
});

describe("motor desligado", () => {
  const el = view({ status: { ...healthy, enabled: false }, error: null, cameras: [] });

  it("a manchete e a consequência para o dado aparecem na tela", () => {
    const out = text(el);
    expect(out).toContain("Motor de análise DESLIGADO");
    expect(out).toContain("Nenhuma contagem de pessoas está sendo gravada");
  });

  it("ASSERT NEGATIVO: nenhuma frase de normalidade sobreviveu ao render", () => {
    expect(text(el)).not.toContain("Motor rodando");
    expect(html(el)).toContain('data-level="down"');
  });
});

// ── GOING-GRAY: o estado saudável não desenha lista nem acende cor ───────────────────────────
describe("motor saudável", () => {
  const el = view({ status: healthy, error: null, cameras: [] });

  it("uma linha neutra e NENHUM achado", () => {
    const out = text(el);
    expect(out).toContain("Motor rodando — 1 de 1 câmera sendo analisada");
    expect(html(el)).toContain('data-level="ok"');
    expect(html(el)).not.toContain("eh-finding"); // lista de achados não existe
  });

  it("o carimbo da escala está na cara: esta faixa não obedece ao filtro de período", () => {
    const out = text(el);
    expect(out).toContain("agora · janela de 1 min");
    expect(out).toContain("atualiza a cada 20s");
  });
});

// ── RBAC: o achado é de todos; o número cru é de quem configura ──────────────────────────────
describe("RBAC do detalhe técnico", () => {
  const blind: AnalysisStatus = {
    ...healthy,
    worker: { ready: true, size: 2, readyCount: 2, cpuPct: 88, respawns: 4 },
  };
  const args: Parameters<typeof buildEngineHealth>[0] = {
    status: blind,
    error: null,
    cameras: [],
  };

  it("operador (sem canConfigure) LÊ o achado — é o que muda a confiança dele no número", () => {
    const out = text(view(args));
    expect(out).toContain("reiniciou 4 vezes");
    expect(out).toContain("sem nenhuma contagem");
  });

  it("…e NÃO vê o número cru (cpu/fps/p95): não decide nada de operação", () => {
    const out = text(view(args));
    expect(out).not.toContain("Detalhe técnico");
    expect(out).not.toContain("88%");
    expect(out).not.toContain("dfine_s.onnx");
  });

  it("engenheiro/superadmin ganha a porta do detalhe (fechada por padrão — não é manchete)", () => {
    const out = text(view(args, { canConfigure: true }));
    expect(out).toContain("Detalhe técnico");
    expect(out).not.toContain("dfine_s.onnx"); // colapsado: o número cru não polui a leitura
  });
});

// ── O nome da câmera, não o id cru ───────────────────────────────────────────────────────────
describe("achado por câmera", () => {
  it("usa o rótulo da central e diz o que o gate fez com o dado daquela câmera", () => {
    const el = view({
      status: {
        ...healthy,
        perCamera: {
          "cam-1": {
            ...healthy.perCamera["cam-1"],
            gate: {
              skipMoving1m: 41,
              ratioP50: 0.002,
              ratioP95: 0.004,
              reasons1m: { motion: 19, skip: 41 },
            },
          },
        },
      },
      error: null,
      cameras: [{ id: "cam-1", label: "Doca 3", online: true }],
    });
    const out = text(el);
    expect(out).toContain("Doca 3");
    expect(out).not.toContain("cam-1");
    expect(out).toContain("41 de 60 rodadas");
    expect(out).toContain("último minuto");
    expect(out).not.toContain("última hora");
  });
});
