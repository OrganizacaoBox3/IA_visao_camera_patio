// A ORDEM dos modos do palco é REGRA, não detalhe — e regra sem sensor é comentário.
//
// A regressão que este teste existe para pegar (spec-arquitetura-informacao §1, risco 2): o palco
// cortava `!canConfigure` ANTES DE TUDO. Enquanto todo modo do palco era de engenharia, certo. Com
// a calibração virando modo, MEDIR distância — que na rota /calibracao era EXPLICITAMENTE do
// operador ("A calibração requer perfil de engenharia. Você pode usar o modo Medir.") — passaria a
// ser engolido pelo corte. O bug não faria barulho: o operador clicaria no chão e NADA aconteceria.
// Aqui ele faz barulho.
//
// PODA (spec-zona-unificada F5): "paint" e "rect" saíram do enum. O pincel não existe mais (a
// máscara vive como rasterização interna do polígono) e o retângulo virou o PRESET do polígono —
// o arraste do botão "Zona" agora é do MESMO editor da zona ("polygon"), que também seleciona,
// insere e move. Um alvo a menos = uma ordem a menos para errar.
import { describe, it, expect } from "vitest";
import { stageTarget, sceneLayers, type StageState } from "./useStageModes";

const base: StageState = {
  mode: "full",
  review: false,
  canConfigure: true,
  calActive: false,
  tripwireMode: false,
};

describe("stageTarget — precedência dos modos do palco", () => {
  it("grade (tile) e revisão (cine-loop) não editam nada", () => {
    expect(stageTarget({ ...base, mode: "tile" })).toBe("none");
    expect(stageTarget({ ...base, review: true })).toBe("none");
    // nem mesmo com um modo armado: em revisão o palco mostra o BUFFER, não o vivo
    expect(stageTarget({ ...base, review: true, tripwireMode: true })).toBe("none");
    expect(stageTarget({ ...base, review: true, calActive: true })).toBe("none");
  });

  // ── O TESTE QUE PEGA O BUG ────────────────────────────────────────────────────────────────────
  // Inverta as duas linhas do stageTarget (RBAC acima da calibração) e ESTE caso fica vermelho:
  // devolveria "none" e o operador clicaria no chão sem medir nada.
  it("OPERADOR (sem canConfigure) com o modo calibrar ligado: o palco é da CALIBRAÇÃO (ele MEDE)", () => {
    expect(stageTarget({ ...base, canConfigure: false, calActive: true })).toBe("calibration");
  });

  it("OPERADOR sem calibração ligada não edita nada (RBAC intacto: nem zona, nem linha)", () => {
    expect(stageTarget({ ...base, canConfigure: false })).toBe("none");
    expect(stageTarget({ ...base, canConfigure: false, tripwireMode: true })).toBe("none");
  });

  it("engenharia: a calibração VENCE os demais modos (exclusão mútua — nunca desenha zona por baixo)", () => {
    expect(stageTarget({ ...base, calActive: true, tripwireMode: true })).toBe("calibration");
  });

  it("sem calibração: linha > zona; e SEM modo armado o palco é do editor da ZONA", () => {
    expect(stageTarget({ ...base, tripwireMode: true })).toBe("tripwire");
    // sem modo armado o editor da zona ainda recebe o down: é ele quem SELECIONA a zona, agarra um
    // VÉRTICE, insere pelo MIDPOINT e move a FORMA (spec-zona-unificada F3).
    expect(stageTarget(base)).toBe("polygon");
  });
});

// ── O GATE DE CAMADAS (spec §3.1): entrar em Calibrar desliga TODA camada de operação ─────────────
// Injete a falha (troque `!s.calActive` por `true` no sceneLayers) e o 2º caso fica vermelho: a malha
// SALVA voltaria a empilhar sobre a grade viva — a dupla-grade da queixa do dono.
describe("sceneLayers — quais camadas de operação o palco desenha por modo", () => {
  it("operação (fora de calibrar): TODAS as camadas ligadas", () => {
    const v = sceneLayers({ calActive: false });
    expect(Object.values(v).every(Boolean)).toBe(true);
  });

  it("calibrar: TODA camada de operação cai — inclusive a MALHA SALVA (a 2ª grade)", () => {
    const v = sceneLayers({ calActive: true });
    expect(Object.values(v).some(Boolean)).toBe(false);
    expect(v.calibrationMesh).toBe(false); // explícito: a grade salva NÃO se sobrepõe à viva (SVG)
  });
});
