// Testes do guia de instalação das estações (M4 da spec multi-antena): o aviso que separa a
// instalação que QUEBRA o rival radialmente confundível (diagonal, afastada) da que só gasta
// hardware (colada na outra, ou alinhada com o corredor).
import { describe, it, expect } from "vitest";
import { stationGeometryHints, dominantAxisFromRect } from "./station-geometry";

const codes = (hints: { code: string }[]) => hints.map((h) => h.code);
const EIXO_X = { x: 1, y: 0 }; // corredor no eixo X (o lado mais longo)

describe("stationGeometryHints — geometria de instalação (M4)", () => {
  it("instalação BOA (diagonal, bem separada) → nenhum aviso", () => {
    const hints = stationGeometryHints(
      [
        { x: 0, y: 0 },
        { x: 6, y: 5 },
      ],
      EIXO_X,
    );
    expect(hints).toEqual([]);
  });

  it("estações COLINEARES com o corredor → aviso (é a instalação que NÃO quebra o rival)", () => {
    // Ambas sobre o eixo X: quem anda no corredor se afasta das duas ao mesmo tempo — a 2ª antena
    // repete o eixo radial da 1ª e o espelho do vizinho continua de pé.
    const hints = stationGeometryHints(
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
      ],
      EIXO_X,
    );
    expect(codes(hints)).toEqual(["colinear-eixo"]);
  });

  it("quase-colinear (ângulo < 20°) ainda avisa; acima do limiar, cala", () => {
    // 8 m no eixo, 1 m fora dele → ~7,1° → avisa.
    expect(
      codes(
        stationGeometryHints(
          [
            { x: 0, y: 0 },
            { x: 8, y: 1 },
          ],
          EIXO_X,
        ),
      ),
    ).toContain("colinear-eixo");
    // 8 m no eixo, 4 m fora → ~26,6° → a diagonal já é boa o bastante: silêncio.
    expect(
      codes(
        stationGeometryHints(
          [
            { x: 0, y: 0 },
            { x: 8, y: 4 },
          ],
          EIXO_X,
        ),
      ),
    ).toEqual([]);
  });

  it("estações COLADAS uma na outra → aviso de separação (geometria redundante)", () => {
    // 1,4 m de separação (< 2,5 m da M4), na diagonal — o aviso é o de proximidade, não o de eixo.
    const hints = stationGeometryHints(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      EIXO_X,
    );
    expect(codes(hints)).toEqual(["muito-perto"]);
    expect(hints[0].text).toContain("1.4 m"); // o número medido entra no texto do operador
  });

  it("o pior caso acumula os DOIS avisos (coladas E no eixo do corredor)", () => {
    const hints = stationGeometryHints(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      EIXO_X,
    );
    expect(codes(hints)).toEqual(["muito-perto", "colinear-eixo"]);
  });

  it("N > 2: o aviso de eixo olha a extensão PERPENDICULAR (não um par escolhido a dedo)", () => {
    // Três estações espalhadas ao longo do corredor, todas sobre a linha → nenhuma quebra o espelho.
    const naLinha = [
      { x: 0, y: 0 },
      { x: 5, y: 0.2 },
      { x: 10, y: -0.2 },
    ];
    expect(codes(stationGeometryHints(naLinha, EIXO_X))).toEqual(["colinear-eixo"]);
    // A terceira sai da linha (fora do corredor) → a instalação passa a ter eixo radial novo.
    const emTriangulo = [
      { x: 0, y: 0 },
      { x: 5, y: 0.2 },
      { x: 10, y: 6 },
    ];
    expect(codes(stationGeometryHints(emTriangulo, EIXO_X))).toEqual([]);
  });

  it("menos de 2 estações, ou eixo desconhecido → só o que dá p/ afirmar (nunca palpite)", () => {
    expect(stationGeometryHints([{ x: 0, y: 0 }], EIXO_X)).toEqual([]); // 1 antena: sem geometria
    expect(stationGeometryHints([], EIXO_X)).toEqual([]);
    // Sem eixo (câmera não calibrada) o aviso de colinearidade some — o de separação permanece.
    expect(
      codes(
        stationGeometryHints(
          [
            { x: 0, y: 0 },
            { x: 8, y: 0 },
          ],
          null,
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        stationGeometryHints(
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
          null,
        ),
      ),
    ).toEqual(["muito-perto"]);
  });

  it("ponto não-finito é ignorado (nunca NaN no aviso)", () => {
    const hints = stationGeometryHints(
      [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 2 },
        { x: 6, y: 5 },
      ],
      EIXO_X,
    );
    expect(hints).toEqual([]); // sobram 2 pontos válidos, boa geometria
  });
});

describe("dominantAxisFromRect — o corredor presumido é o lado MAIS LONGO", () => {
  it("retângulo mais largo que comprido → eixo X; mais comprido → eixo Y", () => {
    expect(dominantAxisFromRect(10, 3)).toEqual({ x: 1, y: 0 });
    expect(dominantAxisFromRect(3, 10)).toEqual({ x: 0, y: 1 });
    expect(dominantAxisFromRect(5, 5)).toEqual({ x: 1, y: 0 }); // quadrado: empate → X (determinístico)
  });

  it("dimensões inválidas → null (sem palpite, logo sem aviso de colinearidade)", () => {
    expect(dominantAxisFromRect(0, 5)).toBeNull();
    expect(dominantAxisFromRect(Number.NaN, 5)).toBeNull();
    expect(dominantAxisFromRect(-2, 5)).toBeNull();
  });
});
