// Critério de aceite da COSTURA (E1) virado em teste: o chip de saúde identifica a fonte pelo NOME
// cadastrado — o id técnico não some (é o que o operador digita no app), mas fica DISCRETO (muted).
// Render estático (mesmo padrão de src/ui/Panel.test.tsx — sem DOM, sem testing-library).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StationHealthChip } from "./StationHealthChip";

const OK = { alive: true, rssi: -62, driftDb: 0, status: "ok" };
const DOWN = { alive: false, rssi: null, driftDb: null, status: "down" };
const DRIFT = { alive: true, rssi: -70, driftDb: -8, status: "drift" };

describe("StationHealthChip — o NOME da estação, não o id técnico", () => {
  it("estação batizada: mostra o NOME e NÃO o rótulo antigo 'Estação <id>'", () => {
    const html = renderToStaticMarkup(
      <StationHealthChip health={OK} station={{ id: "tc22-a1b2", nome: "Doca 3" }} />,
    );
    expect(html).toContain("Doca 3");
    expect(html).not.toContain("Estação tc22-a1b2"); // o id cru não é mais o rótulo
    expect(html).toContain("-62 dBm");
  });

  it("o id técnico continua visível, porém DISCRETO (muted) — é o que se digita no app", () => {
    const html = renderToStaticMarkup(
      <StationHealthChip health={OK} station={{ id: "tc22-a1b2", nome: "Doca 3" }} />,
    );
    expect(html).toContain("tc22-a1b2");
    expect(html).toMatch(/class="[^"]*text-text-muted[^"]*">tc22-a1b2</); // no papel muted, não em 1º plano
  });

  it("FALLBACK: estação pendente (nome == id) → o id aparece UMA vez só (sem duplicar)", () => {
    const html = renderToStaticMarkup(
      <StationHealthChip health={OK} station={{ id: "tc99-zzzz", nome: "tc99-zzzz" }} />,
    );
    expect(html.match(/tc99-zzzz/g)).toHaveLength(1);
  });

  it("fonte única (sem station): rótulo genérico 'Estação' — retrocompat CA-3", () => {
    const html = renderToStaticMarkup(<StationHealthChip health={OK} />);
    expect(html).toContain("Estação");
    expect(html).toContain("-62 dBm");
  });

  it("estados anormais (going-gray) preservam o nome: sem sinal e drift", () => {
    const down = renderToStaticMarkup(
      <StationHealthChip health={DOWN} station={{ id: "tc22-a1b2", nome: "Doca 3" }} />,
    );
    expect(down).toContain("Doca 3");
    expect(down).toContain("sem sinal");
    expect(down).toContain("text-warn"); // anormalidade = cor (Badge tone="warn")

    const drift = renderToStaticMarkup(
      <StationHealthChip health={DRIFT} station={{ id: "tc22-a1b2", nome: "Doca 3" }} />,
    );
    expect(drift).toContain("Doca 3");
    expect(drift).toContain("drift");
    expect(drift).toContain("-8");
  });
});
