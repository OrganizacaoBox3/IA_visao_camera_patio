import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Kpi, KpiRow, Delta } from "./Kpi";

// Mesmo molde de Panel.test/Meter.test: renderToStaticMarkup (sem jsdom).
// O átomo foi MOVIDO de routes/report/KpiRow.tsx (API byte-idêntica); este teste guarda o contrato.
describe("Kpi/KpiRow/Delta — átomo de KPI do Relatório", () => {
  it("Kpi renderiza valor (.v) e rótulo (.l) no cartão .kpi.big", () => {
    const html = renderToStaticMarkup(<Kpi value="42" label="pessoas" />);
    expect(html).toContain('class="kpi big"');
    expect(html).toContain("42");
    expect(html).toContain("pessoas");
  });

  it("KpiRow: grid fixo por default; fit vira auto-fit", () => {
    expect(renderToStaticMarkup(<KpiRow>x</KpiRow>)).toContain('class="kpi-row"');
    expect(renderToStaticMarkup(<KpiRow fit>x</KpiRow>)).toContain("auto-fit");
  });

  it("Delta: null vira travessão mudo; sinal e cor por direção", () => {
    expect(renderToStaticMarkup(<Delta v={null} />)).toContain("—");
    // goodWhenDown default: cair é bom (verde)
    expect(renderToStaticMarkup(<Delta v={-10} />)).toContain("delta good");
    expect(renderToStaticMarkup(<Delta v={10} />)).toContain("delta bad");
    // goodWhenDown=false inverte
    expect(renderToStaticMarkup(<Delta v={10} goodWhenDown={false} />)).toContain("delta good");
  });
});
