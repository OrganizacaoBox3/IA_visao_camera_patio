import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExibicaoLayers } from "./ExibicaoPopover";
import { CamDrawer } from "./CamDrawer";
import { TooltipProvider } from "../ui";
import { APP_CONFIG } from "../config";

// CONTROLE NEGATIVO da F3 (spec-tela-camera §3-C): a config-de-exibição foi consolidada num POPOVER
// e SAIU da aba "Camadas". Este teste PINA as duas metades da mudança:
//  1. os toggles de exibição VIVEM no corpo do popover (ExibicaoLayers) — HUD/Malha/Anéis/Caixas/…;
//  2. a aba "Camadas" NÃO existe mais no drawer — sem modo, o painel mostra as sub-abas de observação
//     DIRETO (o nível "Observação × Camadas" da F2 sumiu).
// Sem jsdom (padrão da casa): markup por SSR. O Popover portala seu conteúdo, então SSR do popover
// inteiro não o captura — por isso o CORPO é um componente à parte (ExibicaoLayers), testado direto.
// O "abre e mostra" no browser real é coberto pelo e2e (app.spec.ts "Exibição é um POPOVER").

const layersProps = (over?: { calibAvailable?: boolean; floorAvailable?: boolean }) => ({
  hud: false,
  setHud: () => {},
  calib: { hasCalibration: over?.calibAvailable ?? true, on: false, setOn: () => {} },
  floor: { available: over?.floorAvailable ?? true, on: false, setOn: () => {} },
  layers: { ...APP_CONFIG.overlay.layers },
  setLayers: () => {},
  conf: APP_CONFIG.overlay.confidenceThreshold,
  setConf: () => {},
  preset: { active: "atividade" as const, dirty: false, apply: () => {} },
  canConfigure: true,
  longRange: false,
  onLongRangeChange: () => {},
});

// TooltipProvider é obrigatório para SSR dos HelpTip/Tooltip do corpo (Radix exige contexto).
const body = (over?: { calibAvailable?: boolean; floorAvailable?: boolean }) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ExibicaoLayers {...layersProps(over)} />
    </TooltipProvider>,
  );

describe("ExibicaoLayers — os toggles de exibição vivem no POPOVER (não na aba)", () => {
  it("reúne os toggles hoje partidos: HUD/Malha/Anéis (KPI bar) + Caixas/Máscara/Zonas/Heatmap (Camadas)", () => {
    const h = body();
    // vindos da barra de KPIs:
    expect(h).toContain("HUD (telemetria)");
    expect(h).toContain("Malha da calibração");
    expect(h).toContain("Anéis das antenas");
    // vindos da antiga aba Camadas:
    expect(h).toContain("Caixas / detecções");
    expect(h).toContain("Máscara (área pintada)");
    expect(h).toContain("Zonas (retângulos)");
    expect(h).toContain("Heatmap de ocupação");
    // config de detecção (preset + confiança + longo alcance) — não se perdeu:
    expect(h).toContain("Confiança mínima");
    expect(h).toContain("Preset ativo");
    expect(h).toContain("Longo alcance / Panorâmica");
  });

  it("going-gray preservado: Malha/Anéis SOMEM quando a fonte não existe (sem calibração/BLE)", () => {
    const h = body({ calibAvailable: false, floorAvailable: false });
    expect(h).not.toContain("Malha da calibração");
    expect(h).not.toContain("Anéis das antenas");
    // mas os overlays base seguem lá (não dependem de fonte):
    expect(h).toContain("Caixas / detecções");
    expect(h).toContain("HUD (telemetria)");
  });

  it("Longo alcance só p/ engenharia (canConfigure=false → some)", () => {
    const h = renderToStaticMarkup(
      <TooltipProvider>
        <ExibicaoLayers {...layersProps()} canConfigure={false} />
      </TooltipProvider>,
    );
    expect(h).not.toContain("Longo alcance / Panorâmica");
    expect(h).toContain("Caixas / detecções"); // o resto permanece
  });
});

describe("CamDrawer — a aba 'Camadas' saiu; observação vira o painel direto", () => {
  const drawerProps = {
    mode: null,
    tab: "presenca" as const,
    onTab: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zonas: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    linhas: {} as any,
    timeline: [],
    presence: { now: 0, peak: 0, dwell: 0 },
    paused: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cal: {} as any,
    onCalibrate: () => {},
    diag: { status: "idle" } as never,
  };

  it("sem modo de edição, o drawer mostra 'Seção de observação' DIRETO — sem nível 'Camadas'", () => {
    const h = renderToStaticMarkup(
      <TooltipProvider>
        <CamDrawer {...drawerProps} />
      </TooltipProvider>,
    );
    // a sub-tablist de observação é o painel direto (não um filho de "Aba do painel"):
    expect(h).toContain('aria-label="Seção de observação"');
    expect(h).toContain("Pessoas");
    expect(h).toContain("Por quê");
    expect(h).toContain("Timeline");
    // NEGATIVO: nenhuma aba "Camadas" e nenhum nível "Aba do painel"/"Observação" acima.
    expect(h).not.toContain("Camadas");
    expect(h).not.toContain('aria-label="Aba do painel"');
  });
});
