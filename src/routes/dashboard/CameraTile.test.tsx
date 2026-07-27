import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui";
import { HUB_TRACKS_STALE_MS, type HubAnalysis } from "../../types/analysis";
import { CameraTile, violatedZoneLabels } from "./CameraTile";

// ── GATE do sinal de ZONA RESTRITA VIOLADA no tile da grade ───────────────────────────────────
// BUG QUE ORIGINOU O TESTE: com transporte "auto" + go2rtc no ar (o DEFAULT do produto) o tile vira
// <video-stream>, o CameraWorkspace NÃO monta e o overlay desenha só caixas de pessoa — a violação
// de área restrita (o alarme mais grave que o produto gera, 24/7 pelo motor do hub) ficava
// VISUALMENTE IDÊNTICA a qualquer outra parte da imagem na tela que o operador olha o dia inteiro.
// O dado já chegava (`analysis-tracks.zonesProibidas`, passthrough consertado no useDashboardSocket).
//
// Sem jsdom (padrão da casa): markup por SSR. O estado inicial do sinal é calculado no LAZY INIT do
// useState — que roda no SSR —, então o render real do componente é exercitado aqui; o setInterval
// (que só reavalia o relógio) é a cola fina, e a decisão que ele reavalia é a função PURA abaixo.

const FRESH = 1_000_000;

const analysis = (over?: Partial<HubAnalysis>): HubAnalysis => ({
  ts: Date.now(),
  tracks: [],
  zones: [],
  ...over,
});

describe("violatedZoneLabels — o tri-estado (não sei · quieta · violada)", () => {
  it("presenca:true ⇒ devolve o RÓTULO da zona violada", () => {
    const a = analysis({
      zonesProibidas: [
        { id: "z1", label: "Doca Norte", people: 1, presenca: true },
        { id: "z2", label: "Expedição", people: 0, presenca: false },
      ],
    });
    expect(violatedZoneLabels(a, a.ts)).toEqual(["Doca Norte"]);
  });

  it("todas presenca:false ⇒ [] (sei, e está quieta — silêncio legítimo)", () => {
    const a = analysis({
      zonesProibidas: [{ id: "z1", label: "Doca", people: 0, presenca: false }],
    });
    expect(violatedZoneLabels(a, a.ts)).toEqual([]);
  });

  it("câmera SEM zona restrita ([]) ⇒ [] — distinto de 'não sei'", () => {
    const a = analysis({ zonesProibidas: [] });
    expect(violatedZoneLabels(a, a.ts)).toEqual([]);
  });

  it("campo AUSENTE (hub antigo) ⇒ null: 'não sei' ≠ 'tudo bem'", () => {
    const a = analysis();
    expect(violatedZoneLabels(a, a.ts)).toBeNull();
    expect(violatedZoneLabels(null, FRESH)).toBeNull();
    expect(violatedZoneLabels(undefined, FRESH)).toBeNull();
  });

  it("payload STALE ⇒ null mesmo com presenca:true (indicador crítico não trava aceso)", () => {
    const a: HubAnalysis = {
      ...analysis({ zonesProibidas: [{ id: "z1", label: "Doca", people: 1, presenca: true }] }),
      ts: FRESH,
    };
    // Fresco acende…
    expect(violatedZoneLabels(a, FRESH + HUB_TRACKS_STALE_MS)).toEqual(["Doca"]);
    // …e o MESMO payload, um tique além do gate, apaga. Motor reiniciando ≠ violação eterna.
    expect(violatedZoneLabels(a, FRESH + HUB_TRACKS_STALE_MS + 1)).toBeNull();
    expect(violatedZoneLabels(a, FRESH + 60_000)).toBeNull();
  });

  it("zona sem label cai no genérico — NUNCA no id (detalhe interno, como o id de track)", () => {
    const a = analysis({
      zonesProibidas: [{ id: "zona-42", label: "", people: 1, presenca: true }],
    });
    expect(violatedZoneLabels(a, a.ts)).toEqual(["Área restrita"]);
    expect(violatedZoneLabels(a, a.ts)?.join()).not.toContain("42");
  });
});

// ── Render do tile ────────────────────────────────────────────────────────────────────────────

const CAM = { id: "cam-1", label: "Docas" };

function tile(getHubAnalysis?: () => HubAnalysis | null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CameraTile
        camera={CAM}
        isOpen={false}
        isFadiga={false}
        getFrame={() => null}
        tripwiresRev={0}
        status={undefined}
        analysisEngine="hub"
        getHubAnalysis={getHubAnalysis}
        transport="webrtc" // o caminho do bug: go2rtc no ar ⇒ sem CameraWorkspace no tile
        onOpen={() => {}}
        onAlert={() => {}}
      />
    </TooltipProvider>,
  );
}

/** Conteúdo da região viva (sr-only role=status) — o que a AT anuncia. */
function liveText(html: string): string {
  return /<span class="sr-only" role="status">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "<ausente>";
}

describe("CameraTile — sinal de zona restrita VIOLADA (tile WebRTC/go2rtc)", () => {
  it("VIOLADA ⇒ acende o contorno crítico + nomeia a(s) zona(s)", () => {
    const html = tile(() =>
      analysis({
        zonesProibidas: [
          { id: "z1", label: "Doca Norte", people: 1, presenca: true },
          { id: "z2", label: "Câmara Fria", people: 2, presenca: true },
          { id: "z3", label: "Pátio", people: 0, presenca: false },
        ],
      }),
    );
    expect(html).toContain('data-violada="1"');
    expect(html).toContain("var(--state-critical)"); // contorno saturado no tile inteiro
    expect(html).toContain("VIOLADA");
    expect(html).toContain("Doca Norte");
    expect(html).toContain("Câmara Fria");
    expect(html).not.toContain("Pátio"); // zona armada e quieta não entra no sinal
    // A11y: cor não é o único canal — a palavra está no texto visível E na região viva.
    expect(liveText(html)).toBe("Área restrita violada em Docas: Doca Norte, Câmara Fria.");
  });

  it("tudo presenca:false ⇒ NADA (armada é operação normal; going-gray)", () => {
    const html = tile(() =>
      analysis({ zonesProibidas: [{ id: "z1", label: "Doca Norte", people: 0, presenca: false }] }),
    );
    expect(html).toContain('data-violada="0"');
    expect(html).not.toContain("VIOLADA");
    expect(html).not.toContain("Doca Norte");
    expect(html).not.toContain("var(--state-critical)");
    expect(liveText(html)).toBe("");
  });

  it("campo AUSENTE (hub antigo) ⇒ nada aceso E nenhuma afirmação de normalidade", () => {
    const html = tile(() => analysis());
    expect(html).not.toContain("VIOLADA");
    expect(html).not.toContain("var(--state-critical)");
    // O tile não pode dizer "está tudo bem" quando não sabe: nem badge ARMADA, nem OK/normal.
    expect(html).not.toMatch(/ARMADA|sem viola|tudo bem|normalidade|área restrita ok/i);
    expect(liveText(html)).toBe(""); // região viva EXISTE (p/ a AT anunciar depois) e está VAZIA
  });

  it("payload STALE ⇒ o sinal APAGA (motor reiniciando não é violação eterna)", () => {
    const stale = analysis({
      ts: Date.now() - HUB_TRACKS_STALE_MS - 1,
      zonesProibidas: [{ id: "z1", label: "Doca Norte", people: 1, presenca: true }],
    });
    const html = tile(() => stale);
    expect(html).toContain('data-violada="0"');
    expect(html).not.toContain("VIOLADA");
    expect(html).not.toContain("Doca Norte");
    expect(liveText(html)).toBe("");
  });

  it("câmera sem análise (sem getter) ⇒ tile intocado", () => {
    const html = tile(undefined);
    expect(html).toContain("cam-tile");
    expect(html).not.toContain("VIOLADA");
    expect(liveText(html)).toBe("");
  });

  it("NENHUM número sobre a imagem: `people` não vaza para o sinal (invariante da casa)", () => {
    const html = tile(() =>
      analysis({ zonesProibidas: [{ id: "z9", label: "Expedição", people: 7, presenca: true }] }),
    );
    const pill = /<span style="position:absolute[\s\S]*?<\/span><\/span>/.exec(html)?.[0] ?? "";
    expect(pill).toContain("VIOLADA");
    expect(pill).toContain("Expedição");
    // TEXTO do sinal (sem tags/atributos de estilo): nem a contagem (7) nem o id da zona (z9)
    // podem vazar para cima da imagem — contagem vive no PAINEL.
    const texto = pill.replace(/<[^>]*>/g, "");
    expect(texto).toContain("VIOLADA");
    expect(texto).not.toMatch(/\d/);
    expect(liveText(html)).not.toMatch(/\d/);
    expect(html).not.toContain("z9");
  });
});
