import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("reserva uma linha inteira para título e subtítulo no mobile", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Planta BLE" subtitle="Localização aproximada por Bluetooth">
        <button type="button">Concluir</button>
      </PageHeader>,
    );

    expect(html).toContain("max-[640px]:basis-full");
    expect(html).toContain("max-[640px]:shrink-0");
    expect(html).toContain("Planta BLE");
    expect(html).toContain("Localização aproximada por Bluetooth");
    expect(html).toContain('class="ml-auto flex items-center gap-3 max-[640px]:gap-2"');
    expect(html).toContain(">Concluir</button>");
  });

  it("não cria uma linha vazia de ações quando não há children", () => {
    const withoutChildren = renderToStaticMarkup(<PageHeader title="Planta BLE" />);
    const withFalseChild = renderToStaticMarkup(
      <PageHeader title="Planta BLE">{false}</PageHeader>,
    );

    expect(withoutChildren).not.toContain("ml-auto");
    expect(withFalseChild).not.toContain("ml-auto");
  });
});
