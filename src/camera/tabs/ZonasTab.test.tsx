// Gate FIM-A-FIM do aviso de detector: não basta a função pura devolver o aviso — a ZONA tem de
// RENDERIZÁ-LO. (Molde da casa: renderToStaticMarkup, sem jsdom — ver ui/Kpi.test.tsx.)
//
// O par positivo/negativo é o teste inteiro: com o andaime coco + o default ["caixa"] o aviso
// aparece; com o OWL-ViT de pé ele SOME. Sem o assert negativo, um aviso permanente passaria — e
// aviso permanente é ruído que treina o operador a ignorar o painel.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ZonasTab } from "./ZonasTab";
import { TooltipProvider } from "../../ui";
import { withDefaults } from "../../zones";
import type { ObjBackend } from "../../objects/detector";
import type { ZoneResult } from "../draw";

// A casca do app já monta o TooltipProvider uma vez na raiz; aqui ele é só o ambiente mínimo.
function html(objBackend: ObjBackend, selectedClasses: string[]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ZonasTab
        zonesLoading={false}
        zones={[withDefaults({ modo: "objetos", label: "Expedição", selectedClasses }, "cam1")]}
        canConfigure
        panel={new Map<string, ZoneResult>()}
        hist={() => []}
        legend={[]}
        setCfgZoneId={() => {}}
        removeZone={() => {}}
        objBackend={objBackend}
      />
    </TooltipProvider>,
  );
}

describe("ZonasTab — zona de Objetos declara o estado do detector", () => {
  it("coco + ['caixa'] (o default da zona): renderiza o aviso de contagem estruturalmente 0", () => {
    const h = html("coco", ["caixa"]);
    expect(h).toContain("não detecta Caixa");
    expect(h).toContain("do detector, não da cena");
    expect(h).toContain('role="alert"'); // anormalidade é anunciada, não só colorida
  });

  it("owlvit: NENHUM aviso (o assert negativo — o aviso não pode virar decoração)", () => {
    const h = html("owlvit", ["caixa"]);
    expect(h).not.toContain("Detector");
    expect(h).not.toContain('role="alert"');
    expect(h).toContain("Total em cena"); // ... e o painel de objetos segue inteiro
  });

  it("indisponível: aviso mesmo com a classe que o andaime enxergaria", () => {
    expect(html("indisponível", ["pessoa"])).toContain("Detector indisponível");
  });

  it("o aviso é do modo OBJETOS: uma zona de atividade não o mostra, qualquer que seja o backend", () => {
    const h = renderToStaticMarkup(
      <TooltipProvider>
        <ZonasTab
          zonesLoading={false}
          zones={[withDefaults({ modo: "atividade", label: "Doca" }, "cam1")]}
          canConfigure
          panel={new Map<string, ZoneResult>()}
          hist={() => []}
          legend={[]}
          setCfgZoneId={() => {}}
          removeZone={() => {}}
          objBackend="indisponível"
        />
      </TooltipProvider>,
    );
    expect(h).not.toContain("Detector");
  });
});
