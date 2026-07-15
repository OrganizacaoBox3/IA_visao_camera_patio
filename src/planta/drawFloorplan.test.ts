// Teste do PURO da folha de desenho: floorplanBounds. Só a lógica de enquadramento (bbox de mundo) —
// o desenho em si (canvas) não é testado aqui. Espelha o espírito dos testes de topdown.
import { describe, expect, it } from "vitest";
import { floorplanBounds } from "./drawFloorplan";
import type { FloorplanView } from "../fusion/floorplan";

const view = (over: Partial<FloorplanView> = {}): FloorplanView => ({
  widthM: 10,
  heightM: 6,
  stations: [],
  tags: [],
  ...over,
});

describe("floorplanBounds", () => {
  it("enquadra a caixa do galpão [0,0]→(w,h) mesmo sem antenas nem tags", () => {
    const b = floorplanBounds(view());
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 });
  });

  it("estende o bbox para incluir antena fora da caixa (a caixa e a antena entram)", () => {
    const b = floorplanBounds(
      view({ stations: [{ id: "A", label: "A", pos: { x: 12, y: -1 }, live: true }] }),
    );
    expect(b).toEqual({ minX: 0, minY: -1, maxX: 12, maxY: 6 });
  });

  it("inclui as tags COM posição e ignora as 'none' (pos null)", () => {
    const b = floorplanBounds(
      view({
        tags: [
          { mac: "1", label: "t1", pos: { x: 3, y: 8 }, fix: "ok", nStations: 3, nearest: null },
          { mac: "2", label: "t2", pos: null, fix: "none", nStations: 1, nearest: null },
        ],
      }),
    );
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 8 });
  });

  it("sem caixa (w/h ≤ 0) e sem pontos → null (o canvas cai no fundo puro)", () => {
    expect(floorplanBounds(view({ widthM: 0, heightM: 0 }))).toBeNull();
  });

  it("sem caixa mas COM antena → enquadra só a antena", () => {
    const b = floorplanBounds(
      view({
        widthM: 0,
        heightM: 0,
        stations: [{ id: "A", label: "A", pos: { x: 5, y: 5 }, live: false }],
      }),
    );
    expect(b).toEqual({ minX: 5, minY: 5, maxX: 5, maxY: 5 });
  });
});
