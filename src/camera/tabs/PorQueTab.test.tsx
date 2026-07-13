// A TELA DO PORQUÊ (bug B8) — o que este teste PINA é o CONTRATO COM O OPERADOR, não o layout:
//
//  1. O CASO DOMINANTE DO PRODUTO (41,9% do silêncio medido em campo, IC 33,7–50,5%): pessoa
//     PARADA. A tela tem de mostrar O NÚMERO E A RÉGUA — "0,003" contra "0,15" — e dizer, em
//     português, que o método precisa de MOVIMENTO. Um "não identificado" mudo treina o operador a
//     não confiar no sistema; este é o teste que impede a regressão para o mudo.
//  2. A ÂNCORA (bug B5): a tag cadastrada como âncora NESTA câmera é permanentemente inassociável
//     aqui — hoje, em silêncio. A tela DIZ, e diz o que fazer.
//  3. A PORTA ZERO (bug B7): sem pistas do motor do hub a fusão NEM RODA (9 h de gravação com 0
//     tracks e ~6.500 leituras/h, 100% silenciosas). A tela DIZ.
//  4. Going-gray: o elo que barrou nunca é só-cor — tem ícone (forma) E texto ("barrou aqui").
//
// Sem jsdom: markup por SSR (renderToStaticMarkup), o padrão da casa (ver VertexTable.test.tsx).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui";
import { PorQueTab, eloStates, fmt3 } from "./PorQueTab";
import type { FunnelDiagnosis, PersonFunnel } from "../../fusion/useFunnelDiagnosis";
import type { FunnelVerdict, PairFunnel } from "../../fusion/associate";

const THRESHOLDS = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  minMovement: 0.15, // a régua REAL do motor (DEFAULTS de associate.ts)
  minMargin: 0,
};

const pair = (verdict: FunnelVerdict, over: Partial<PairFunnel> = {}): PairFunnel => ({
  trackId: 7,
  tag: "Cristhyano",
  distSamples: 16,
  rssiSamples: 16,
  alignedSamples: 16,
  spanMs: 8000,
  movVar: 0.003, // a MEDIANA medida na gravação de campo — 50× ABAIXO do gate
  corr: -0.2,
  score: 0.2,
  margin: null,
  verdict,
  thresholds: THRESHOLDS,
  ...over,
});

const person = (over: Partial<PersonFunnel> = {}): PersonFunnel => ({
  trackId: 7,
  best: pair("lowMovement"),
  candidates: 1,
  rawReadings: 16,
  distinctReadings: 4,
  ...over,
});

const diag = (over: Partial<FunnelDiagnosis> = {}): FunnelDiagnosis => ({
  running: true,
  hubTracks: 1,
  tagsHeard: 1,
  anchors: [],
  people: [person()],
  warmingUp: false,
  windowMs: 8000,
  ...over,
});

// O HelpTip é um Radix Tooltip — exige o Provider (a app o monta na raiz; aqui, no SSR, montamos).
const html = (d: FunnelDiagnosis) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <PorQueTab diag={d} />
    </TooltipProvider>,
  );
// O SSR escapa as aspas/acentos como entidades; comparar em texto limpo é o que interessa aqui.
const text = (d: FunnelDiagnosis) =>
  html(d)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("PorQueTab — o caso DOMINANTE: a pessoa está parada (41,9% do silêncio em campo)", () => {
  it("mostra O NÚMERO e A RÉGUA (0,003 contra 0,15) — não um 'não identificado' mudo", () => {
    const t = text(diag());
    expect(t).toContain("0,003"); // a variância medida
    expect(t).toContain("0,15"); // o limiar que ela não alcança
    expect(t).toContain("A pessoa está parada");
    expect(t).toMatch(/Sem movimento não há o que comparar/);
    expect(t).toMatch(/O que fazer:/); // o veredito é ACIONÁVEL, não um beco sem saída
  });

  it("REGRA 8: separa leitura RECEBIDA de leitura DISTINTA (o cru mente ~4× para cima)", () => {
    const t = text(diag());
    expect(t).toContain("16 leitura(s) recebida(s)");
    expect(t).toContain("4 distinta(s)");
    expect(t).toMatch(/o resto é cópia do valor anterior/);
  });

  it("going-gray: o elo que barrou tem TEXTO, não só cor", () => {
    const t = text(diag());
    expect(t).toContain("Movimento: barrou aqui."); // sr-only, legível por leitor de tela
    expect(t).toContain("Rádio: passou.");
    expect(t).toContain("Evidência: não avaliado."); // a cadeia é ordenada: depois do gate, nada rodou
  });

  it("série constante (bloco A, 31,0%): movVar=null vira frase honesta, não 'NaN'", () => {
    const t = text(diag({ people: [person({ best: pair("constantSeries", { movVar: null, corr: null }) })] })); // prettier-ignore
    expect(t).toContain("O sinal da tag não mudou");
    expect(t).toMatch(/não calculável/);
    expect(t).not.toContain("NaN");
    expect(t).not.toContain("null");
  });
});

describe("PorQueTab — os silêncios estruturais que ninguém via", () => {
  it("B5 (âncora): diz que a tag é âncora AQUI e que ela nunca associará, e o que fazer", () => {
    const t = text(diag({ anchors: [{ mac: "AA:BB:CC:DD:CE:8B", label: "Tag 4" }] }));
    expect(t).toContain("Tag 4");
    expect(t).toMatch(/ÂNCORA desta câmera/);
    expect(t).toMatch(/nunca será associada/);
    expect(t).toMatch(/remova-a das âncoras na aba Calibrar/);
  });

  it("B7 (porta zero): sem pistas do motor do hub, avisa que a fusão NEM RODA", () => {
    const t = text(diag({ hubTracks: null }));
    expect(t).toMatch(/motor de análise do hub não está entregando pistas/);
    expect(t).toMatch(/nenhuma tag será associada/);
  });

  it("sem tag no ar: o elo RÁDIO é o veredito (não inventa funil)", () => {
    const t = text(diag({ tagsHeard: 0, people: [person({ best: null, rawReadings: 0 })] }));
    expect(t).toContain("sem tag no ar");
    expect(t).toContain("Rádio: barrou aqui.");
    expect(t).toMatch(/nenhuma tag BLE foi ouvida/);
  });

  it("ninguém em cena / diagnóstico desligado: estado vazio honesto", () => {
    expect(text(diag({ hubTracks: 0, people: [] }))).toMatch(/Ninguém em cena/);
    expect(text(diag({ running: false }))).toMatch(/Diagnóstico desligado/);
  });

  it("identificou: o funil também mostra o SUCESSO (a cadeia inteira verde)", () => {
    const t = text(
      diag({ people: [person({ best: pair("SPOKE", { corr: -0.91, score: 0.91 }) })] }),
    );
    expect(t).toContain("Identificada");
    expect(t).toContain("-0,91"); // a correlação que falou
    expect(t).toContain("Evidência: passou.");
  });
});

describe("eloStates — a cadeia é ORDENADA: o que veio depois do gate NÃO foi avaliado", () => {
  it("nunca reprova um elo que o motor não chegou a rodar", () => {
    expect(eloStates("lowMovement")).toEqual({
      radio: "ok",
      movimento: "blocked",
      evidencia: "skipped", // mentira seria dizer "evidência fraca": ela nem foi calculada
    });
    expect(eloStates("rssiSamples<minSamples")).toEqual({
      radio: "blocked",
      movimento: "skipped",
      evidencia: "skipped",
    });
    expect(eloStates("belowMinMargin")).toEqual({
      radio: "ok",
      movimento: "ok",
      evidencia: "blocked",
    });
    expect(eloStates("SPOKE")).toEqual({ radio: "ok", movimento: "ok", evidencia: "ok" });
  });
});

describe("fmt3 — pt-BR (a variância vive na 3ª casa: sem ela o número desaparece)", () => {
  it("0.003 → 0,003 (não '0,00', não '0.003')", () => {
    expect(fmt3(0.003)).toBe("0,003");
    expect(fmt3(0.15)).toBe("0,150");
  });
});
