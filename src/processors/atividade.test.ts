// Testes do filtro de EXCLUSÃO na origem (filterExcludedPersons) e do efeito
// downstream no `occupied` do AtividadeProcessor (OCIOSA×VAZIA). Fixa a correção
// da fronteira: um FP mascarado (pessoa cujo PÉ cai em zona de exclusão) deixa de
// contar como "ocupada" numa zona de atividade SOBREPOSTA — antes o filtro só
// removia o TRACK, mas ctx.dets levava a caixa crua ao cálculo de ocupação.
import { describe, it, expect } from "vitest";
import {
  AtividadeProcessor,
  filterExcludedPersons,
  type AtividadeCtx,
  type AtividadeZone,
  type ExclusionZone,
} from "./atividade";
import type { Detection } from "../vision/model";

// Frame 100×100 → bbox em pixels = coordenada normalizada × 100 (leitura direta).
const FW = 100;
const FH = 100;

function person(bbox: [number, number, number, number], score = 0.9): Detection {
  return { class: "person", score, bbox };
}

// Contexto mínimo p/ exercitar SÓ a ocupação (sem motion): luma/prev nulos, sem tracks.
function ctxWith(dets: Detection[]): AtividadeCtx {
  return {
    now: 0,
    frameDt: 0,
    paused: false,
    luma: null,
    prev: null,
    pw: 0,
    ph: 0,
    dets,
    frameW: FW,
    frameH: FH,
    tracks: [],
    sampleFlow: false,
    recEmit: false,
  };
}

// Zona de atividade cobrindo o centro do frame (0.3..0.7 em x e y).
const ativZone: AtividadeZone = {
  id: "z1",
  label: "Doca 1",
  x: 0.3,
  y: 0.3,
  w: 0.4,
  h: 0.4,
  idleAlertMs: 60_000,
  sensitivity: 5,
  atividade: "Carga",
};

// Zona de exclusão no rodapé central (0.3..0.7 em x, 0.6..0.9 em y) — pega o PÉ.
const exclZone: ExclusionZone = { x: 0.3, y: 0.6, w: 0.4, h: 0.3 };

// bbox cujo CENTRO cai na zona de atividade (0.5,0.5) e cujo PÉ cai na exclusão (0.5,0.7).
const bboxCenterInZoneFootInExcl: [number, number, number, number] = [45, 30, 10, 40];

describe("filterExcludedPersons — filtro de exclusão na origem", () => {
  it("lista de exclusão vazia → devolve os dets sem cópia (identidade)", () => {
    const dets = [person(bboxCenterInZoneFootInExcl)];
    expect(filterExcludedPersons(dets, [], FW, FH)).toBe(dets);
  });

  it("remove a PESSOA cujo pé cai na zona de exclusão", () => {
    const dets = [person(bboxCenterInZoneFootInExcl)];
    expect(filterExcludedPersons(dets, [exclZone], FW, FH)).toHaveLength(0);
  });

  it("mantém a pessoa cujo pé cai FORA da zona de exclusão", () => {
    // pé em (0.5, 0.5): acima da exclusão (y ≥ 0.6) → não exclui
    const dets = [person([45, 30, 10, 20])]; // foot y = (30+20)/100 = 0.5
    expect(filterExcludedPersons(dets, [exclZone], FW, FH)).toHaveLength(1);
  });

  it("NÃO exclui não-pessoas (veículos de occupancyClasses seguem contando)", () => {
    const truck: Detection = { class: "truck", score: 0.9, bbox: bboxCenterInZoneFootInExcl };
    expect(filterExcludedPersons([truck], [exclZone], FW, FH)).toHaveLength(1);
  });

  it("mask-aware: pé no retângulo mas fora da máscara pintada → NÃO exclui", () => {
    // máscara só na metade esquerda da exclusão (nx < 0.5); pé em x=0.5 fica de fora
    const masked: ExclusionZone = { ...exclZone, contains: (nx) => nx < 0.5 };
    const dets = [person(bboxCenterInZoneFootInExcl)]; // pé x = 0.5
    expect(filterExcludedPersons(dets, [masked], FW, FH)).toHaveLength(1);
    // deslocando o pé p/ x = 0.45 (dentro da máscara) → exclui
    const left = [person([40, 30, 10, 40])]; // pé x = (40+5)/100 = 0.45
    expect(filterExcludedPersons(left, [masked], FW, FH)).toHaveLength(0);
  });
});

describe("AtividadeProcessor.occupied — FP mascarado deixa de contar ocupação", () => {
  it("sem filtro, o FP marca a zona sobreposta como ocupada (estado ANTERIOR ao fix)", () => {
    const proc = new AtividadeProcessor(0);
    const r = proc.process(ativZone, ctxWith([person(bboxCenterInZoneFootInExcl)]));
    expect(r.view.occupied).toBe(true);
  });

  it("com o filtro de exclusão na origem, a MESMA detecção não conta ocupação", () => {
    const filtered = filterExcludedPersons([person(bboxCenterInZoneFootInExcl)], [exclZone], FW, FH);
    const proc = new AtividadeProcessor(0);
    const r = proc.process(ativZone, ctxWith(filtered));
    expect(r.view.occupied).toBe(false);
  });
});
