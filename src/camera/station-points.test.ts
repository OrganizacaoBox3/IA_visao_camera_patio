// O INVARIANTE da multi-antena na calibração: `station` (campo legado, singular) é SEMPRE o ponto
// da estação PRINCIPAL. Quem lê `station` é o hub/motor (a origem da `dist` da pista) — se a UI o
// deixasse incoerente, a câmera mediria distância do ponto errado e NADA falharia alto: os rótulos
// só ficariam piores. Cada teste abaixo confere o invariante depois da transição.
import { describe, it, expect } from "vitest";
import {
  adoptStationPoints,
  placeStationPoint,
  setPrincipalStation,
  removeStationPoint,
  type StationPointsState,
} from "./station-points";

const A = { x: 0.2, y: 0.8 };
const B = { x: 0.9, y: 0.3 };
const C = { x: 0.5, y: 0.5 };

/** O invariante, escrito uma vez só. */
const invariante = (s: StationPointsState) => {
  if (s.principalId === null) return true;
  return s.station !== null && s.station === s.stations[s.principalId];
};

describe("adoptStationPoints — carga da calibração salva", () => {
  it("casa a principal pelo ponto que o campo legado espelha", () => {
    const s = adoptStationPoints({ "est-a": A, "est-b": B }, B);
    expect(s.principalId).toBe("est-b"); // o legado apontava p/ B
    expect(s.station).toEqual(B);
    expect(invariante(s)).toBe(true);
  });

  it("legado que NÃO casa (painel mais velho) → adota a 1ª e RE-SINCRONIZA o legado", () => {
    const s = adoptStationPoints({ "est-a": A, "est-b": B }, C); // C não é ponto de ninguém
    expect(s.principalId).toBe("est-a"); // ordem estável
    expect(s.station).toEqual(A); // curado: o legado passa a espelhar a principal
    expect(invariante(s)).toBe(true);
  });

  it("sem estações (mundo de 1 antena) → o ponto legado segue sozinho, intacto (retrocompat)", () => {
    const s = adoptStationPoints(undefined, C);
    expect(s.stations).toEqual({});
    expect(s.principalId).toBeNull();
    expect(s.station).toEqual(C); // nada foi inventado nem apagado
    expect(adoptStationPoints({}, null).station).toBeNull();
  });

  it("ponto torto no payload é descartado (nunca vira NaN na homografia)", () => {
    const s = adoptStationPoints(
      { boa: A, nan: { x: Number.NaN, y: 0.1 }, inf: { x: 1, y: Number.POSITIVE_INFINITY } },
      A,
    );
    expect(Object.keys(s.stations)).toEqual(["boa"]);
    expect(invariante(s)).toBe(true);
  });
});

describe("placeStationPoint — marcar/mover o ponto de uma estação", () => {
  const vazio: StationPointsState = { stations: {}, principalId: null, station: null };

  it("a PRIMEIRA estação marcada vira a principal (e o legado nasce apontando p/ ela)", () => {
    const s = placeStationPoint(vazio, "est-a", A);
    expect(s.principalId).toBe("est-a");
    expect(s.station).toEqual(A);
    expect(invariante(s)).toBe(true);
  });

  it("marcar a SEGUNDA não rouba a principal — e o legado não se mexe", () => {
    const s = placeStationPoint(placeStationPoint(vazio, "est-a", A), "est-b", B);
    expect(s.principalId).toBe("est-a");
    expect(s.station).toEqual(A); // continua na principal
    expect(s.stations["est-b"]).toEqual(B);
    expect(invariante(s)).toBe(true);
  });

  it("mover a PRINCIPAL arrasta o legado junto (é o mesmo ponto físico)", () => {
    const s1 = placeStationPoint(placeStationPoint(vazio, "est-a", A), "est-b", B);
    const s2 = placeStationPoint(s1, "est-a", C); // arrastou a antena principal
    expect(s2.station).toEqual(C);
    expect(invariante(s2)).toBe(true);
  });

  it("id vazio (nenhuma estação declarada no hub) → mexe só no ponto legado", () => {
    const s = placeStationPoint(vazio, "", C);
    expect(s.stations).toEqual({});
    expect(s.principalId).toBeNull();
    expect(s.station).toEqual(C); // exatamente o comportamento pré-multi-antena
  });
});

describe("setPrincipalStation / removeStationPoint", () => {
  const duas = placeStationPoint(
    placeStationPoint({ stations: {}, principalId: null, station: null }, "est-a", A),
    "est-b",
    B,
  );

  it("trocar a principal leva o legado junto", () => {
    const s = setPrincipalStation(duas, "est-b");
    expect(s.principalId).toBe("est-b");
    expect(s.station).toEqual(B);
    expect(invariante(s)).toBe(true);
  });

  it("remover a PRINCIPAL passa a referência p/ quem sobrou", () => {
    const s = removeStationPoint(duas, "est-a");
    expect(s.stations).toEqual({ "est-b": B });
    expect(s.principalId).toBe("est-b");
    expect(s.station).toEqual(B);
    expect(invariante(s)).toBe(true);
  });

  it("remover uma NÃO-principal não mexe na referência", () => {
    const s = removeStationPoint(duas, "est-b");
    expect(s.principalId).toBe("est-a");
    expect(s.station).toEqual(A);
    expect(invariante(s)).toBe(true);
  });

  it("remover a ÚLTIMA zera o legado (ponto de estação que não existe mais seria mentira)", () => {
    const s = removeStationPoint(removeStationPoint(duas, "est-b"), "est-a");
    expect(s.stations).toEqual({});
    expect(s.principalId).toBeNull();
    expect(s.station).toBeNull();
    expect(invariante(s)).toBe(true);
  });

  it("remover id inexistente é no-op (mesma referência de estado)", () => {
    expect(removeStationPoint(duas, "fantasma")).toBe(duas);
  });
});
