// Testes de unidade do ByteTrack-lite (bytetrack.ts) — lógica PURA, determinística
// (timestamps explícitos, geometria fixa). Cobrem os cenários da auditoria do
// plano-contagem-pessoas: rodada lenta (predição), score oscilante (2ª passada),
// oclusão curta, nascimento só com score alto e a LIMITAÇÃO declarada (sem re-ID).
import { describe, it, expect } from "vitest";
import { createByteTracker, iouOf, type TrackerDet } from "./bytetrack";

// bbox normalizada a partir do CENTRO (w=0.1, h=0.2 default — proporção "pessoa").
function det(cx: number, cy: number, score: number, w = 0.1, h = 0.2): TrackerDet {
  return { score, bbox: [cx - w / 2, cy - h / 2, w, h] };
}

describe("iouOf", () => {
  it("1 para caixas idênticas; 0 sem interseção", () => {
    expect(iouOf([0.1, 0.1, 0.2, 0.2], [0.1, 0.1, 0.2, 0.2])).toBeCloseTo(1, 6);
    expect(iouOf([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
  });
  it("interseção parcial: valor entre 0 e 1 (metade sobreposta → 1/3)", () => {
    // [0..0.2]×[0..0.2] vs [0.1..0.3]×[0..0.2]: inter 0.1×0.2, união 0.06 → 1/3
    expect(iouOf([0, 0, 0.2, 0.2], [0.1, 0, 0.2, 0.2])).toBeCloseTo(1 / 3, 6);
  });
});

describe("createByteTracker — nascimento e morte", () => {
  it("nascimento EXIGE score alto: detecção baixa sozinha nunca cria track", () => {
    const tk = createByteTracker({ highScore: 0.4 });
    expect(tk.update([det(0.3, 0.5, 0.3)], 0)).toHaveLength(0);
    expect(tk.update([det(0.3, 0.5, 0.39)], 350)).toHaveLength(0);
    expect(tk.tracks()).toHaveLength(0);
  });

  it("score alto nasce track com id, firstSeen e foot (bottom-center do bbox)", () => {
    const tk = createByteTracker({ highScore: 0.4 });
    const [t] = tk.update([{ score: 0.6, bbox: [0.4, 0.2, 0.2, 0.6] }], 100);
    expect(t.id).toBe(1);
    expect(t.cx).toBeCloseTo(0.5, 6);
    expect(t.cy).toBeCloseTo(0.5, 6);
    expect(t.foot).toEqual({ x: 0.5, y: 0.8 }); // pé ≠ centróide (bbox alto)
    expect(t.firstSeen).toBe(100);
    expect(t.lastSeen).toBe(100);
  });

  it("morte por TTL: track sem associação além de ttlMs é removido", () => {
    const tk = createByteTracker({ ttlMs: 1500 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    expect(tk.update([], 1400)).toHaveLength(1); // dentro do TTL: sobrevive (oclusão)
    expect(tk.update([], 1600)).toHaveLength(0); // 1600 > 1500 → morre
  });

  it("highScore pode ser sobreposto por update (perfil longo alcance em runtime)", () => {
    const tk = createByteTracker({ highScore: 0.4 });
    expect(tk.update([det(0.3, 0.5, 0.35)], 0, 0.3)).toHaveLength(1); // 0.35 ≥ 0.3 (LR)
  });

  it("reset descarta os tracks", () => {
    const tk = createByteTracker();
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.reset();
    expect(tk.tracks()).toHaveLength(0);
  });
});

describe("createByteTracker — associação (1ª passada, IoU)", () => {
  it("movimento contínuo mantém o id e atualiza posição/score/lastSeen", () => {
    const tk = createByteTracker();
    tk.update([det(0.2, 0.5, 0.6)], 0);
    const [t] = tk.update([det(0.25, 0.5, 0.7)], 350);
    expect(t.id).toBe(1);
    expect(t.cx).toBeCloseTo(0.25, 6);
    expect(t.score).toBe(0.7);
    expect(t.firstSeen).toBe(0); // preservado
    expect(t.lastSeen).toBe(350);
    expect(tk.tracks()).toHaveLength(1); // associou — não nasceu segundo track
  });

  it("SEM histórico de movimento, salto além do raio de re-associação vira id novo", () => {
    const tk = createByteTracker({ ttlMs: 1500, reassocDist: 0.12 });
    tk.update([det(0.2, 0.5, 0.6)], 0); // 1 observação: velocidade desconhecida (0)
    // IoU 0 com a última bbox E distância 0.4 > raio (0.12 + 0·gap) → nem o 2º estágio casa.
    const out = tk.update([det(0.6, 0.5, 0.6)], 350);
    // Rodada de REALOCAÇÃO (nascimento): a graça é suspensa — o antigo congelado seria o
    // próprio rastro, então só o novo é emitido; o antigo segue vivo INTERNAMENTE (TTL).
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
    expect(tk.tracks().map((t) => t.id).sort()).toEqual([1, 2]);
  });
});

describe("createByteTracker — predição linear (rodada lenta)", () => {
  it("com velocidade estabelecida, gap de ~1s ainda associa (id sobrevive à rodada lenta)", () => {
    const tk = createByteTracker({ iouThreshold: 0.25, ttlMs: 1500 });
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 350); // v ≈ +0.05/350ms
    // rodada LENTA: 1000ms depois, o alvo andou +0.143 (0.05/350×1000) — IoU com a última
    // bbox observada (cx 0.25) seria ZERO; a bbox PREDITA (cx ≈ 0.393) recupera o par.
    const out = tk.update([det(0.39, 0.5, 0.6)], 1350);
    expect(out).toHaveLength(1); // NÃO virou track novo de cada lado
    expect(out[0].id).toBe(1);
    expect(out[0].cx).toBeCloseTo(0.39, 6); // posição reportada é a OBSERVADA
  });

  it("track sem par NÃO anda sozinho: posição reportada fica na última observada", () => {
    const tk = createByteTracker();
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 350);
    const [t] = tk.update([], 700); // oclusão: predição é só gate, não posição
    expect(t.cx).toBeCloseTo(0.25, 6);
  });
});

describe("createByteTracker — 2ª passada (score baixo sustenta)", () => {
  it("score oscilante alto→baixo→alto mantém o MESMO id (a rodada baixa sustenta)", () => {
    const tk = createByteTracker({ highScore: 0.4, iouThreshold: 0.25 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    const mid = tk.update([det(0.33, 0.5, 0.22)], 350); // pessoa pequena/oclusa: score 0.22
    expect(mid).toHaveLength(1);
    expect(mid[0].id).toBe(1);
    expect(mid[0].cx).toBeCloseTo(0.33, 6); // sustentou E atualizou a posição
    expect(mid[0].lastSeen).toBe(350); // não envelheceu p/ o TTL
    const out = tk.update([det(0.36, 0.5, 0.7)], 700);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // id contínuo alto→baixo→alto
  });

  it("detecção baixa que NÃO casa com track algum é descartada (não nasce, não ressuscita)", () => {
    const tk = createByteTracker({ highScore: 0.4 });
    tk.update([det(0.2, 0.5, 0.6)], 0);
    const out = tk.update([det(0.8, 0.5, 0.3)], 350); // longe do track: 2ª passada não casa
    expect(out).toHaveLength(1); // só o track original
    expect(out[0].cx).toBeCloseTo(0.2, 6); // intocado
  });

  it("1ª passada tem prioridade: com alta E baixa sobre o mesmo track, a ALTA associa", () => {
    const tk = createByteTracker({ highScore: 0.4 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    const out = tk.update([det(0.31, 0.5, 0.7), det(0.3, 0.5, 0.2)], 350);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0.7); // ficou com a detecção alta; a baixa sobrou e foi descartada
  });
});

describe("createByteTracker — GUARDA DE NASCIMENTO (bug de campo: 1 pessoa ≠ 2 tracks)", () => {
  it("associação perdida em 1 rodada NÃO vira 2 pessoas: det sobreposta recupera o track", () => {
    // Velocidade estabelecida "para a direita"; a pessoa PARA. A predição foge da
    // observação (IoU det×pred < 0.25 → associação falha), mas a det continua em
    // cima da última bbox OBSERVADA (IoU > 0.55). Antes: nascia track 2 e a cena
    // reportava 2 pessoas por até ttlMs. Agora: o track existente é ATUALIZADO.
    const tk = createByteTracker({ iouThreshold: 0.25, ttlMs: 1500, birthIouThreshold: 0.55 });
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 350); // v ≈ +0.05/350ms
    // t=1050 (rodada lenta, dt=700): pred cx ≈ 0.35; a pessoa quase parou (det cx=0.27)
    // → IoU det×pred ≈ 0.11 (< 0.25, associação FALHA); IoU det×observada ≈ 0.67 (> 0.55).
    const out = tk.update([det(0.27, 0.5, 0.6)], 1050);
    expect(out).toHaveLength(1); // NÃO nasceu segundo track
    expect(out[0].id).toBe(1);
    expect(out[0].cx).toBeCloseTo(0.27, 6); // associação recuperada: posição atualizada
    expect(out[0].lastSeen).toBe(1050);
  });

  it("caixa DUPLICADA na mesma rodada (2 dets altas sobre a mesma pessoa) não nasce 2×", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55 });
    // 1ª rodada, tracker vazio: a 1ª det nasce; a 2ª (quase idêntica, IoU ≫ 0.55) é descartada.
    const r1 = tk.update([det(0.3, 0.5, 0.8), det(0.31, 0.5, 0.6)], 0);
    expect(r1).toHaveLength(1);
    // rodada seguinte: track pareado pela det A; det B duplicada não nasce nem rouba o track.
    const r2 = tk.update([det(0.3, 0.5, 0.8), det(0.31, 0.5, 0.6)], 350);
    expect(r2).toHaveLength(1);
    expect(r2[0].id).toBe(1);
    expect(r2[0].score).toBe(0.8); // ficou com a associação da det de maior IoU/score
  });

  it("RECALL preservado: 2 pessoas realmente próximas (IoU < 0.55) nascem as duas", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55 });
    // lado a lado com sobreposição moderada: IoU ≈ 0.25 < 0.55 → são 2 pessoas mesmo
    const out = tk.update([det(0.3, 0.5, 0.8), det(0.36, 0.5, 0.7)], 0);
    expect(out).toHaveLength(2);
  });
});

// 2º EIXO da guarda (2026-07-25 — o bug "2 caixas na MESMA pessoa" reincidiu por outra porta):
// a query duplicada do detector é caixa PARCIAL (cabeça/torso) CONTIDA na inteira — IoU baixo
// passa pelo birthIouThreshold. A CONTENÇÃO (inter/área da menor) a pega. Medição que mandou o
// conserto pra cá (e não pro NMS): gate do hub perdeu 4,4pp de recall com contenção no NMS —
// pessoa parcialmente contida em cena densa é gente REAL; aqui só não NASCE track duplicado.
describe("createByteTracker — GUARDA por CONTENÇÃO (caixa parcial não nasce 2º track)", () => {
  const inteira = (score: number) => ({ score, bbox: [0.3, 0.2, 0.2, 0.6] as [number, number, number, number] });
  const parcial = (score: number) => ({ score, bbox: [0.34, 0.22, 0.1, 0.18] as [number, number, number, number] }); // "cabeça/torso": contenção ~1, IoU ~0.15

  it("det PARCIAL contida junto da inteira: só 1 track (duplicata descartada)", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0.7 });
    tk.update([inteira(0.8)], 0);
    const out = tk.update([inteira(0.8), parcial(0.5)], 350);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].score).toBe(0.8); // a inteira sustenta o track; a parcial morreu na guarda
  });

  it("SÓ a parcial na rodada: RECUPERA o track livre (mesmo id), não nasce id novo", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0.7 });
    tk.update([inteira(0.8)], 0);
    // IoU parcial×track ~0.15 (< 0.25: associação falha) e tamanho incompatível p/ o 2º
    // estágio (h 0.6→0.18) — SÓ a contenção acusa "mesma pessoa" e recupera a associação.
    const out = tk.update([parcial(0.6)], 350);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].lastSeen).toBe(350);
  });

  it("RECALL: pessoa ATRÁS meio visível (contenção < 0.7) NASCE — a guarda não engole gente real", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0.7 });
    tk.update([inteira(0.8)], 0);
    // sobreposição parcial: contenção ~0.43, IoU ~0.16 → 2ª pessoa de verdade
    const atras = { score: 0.7, bbox: [0.44, 0.25, 0.14, 0.4] as [number, number, number, number] };
    const out = tk.update([inteira(0.8), atras], 350);
    expect(out).toHaveLength(2);
  });

  it("birthContainment: 0 DESLIGA o eixo (comportamento antigo — parcial nasce)", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0 });
    tk.update([inteira(0.8)], 0);
    const out = tk.update([inteira(0.8), parcial(0.5)], 350);
    expect(out).toHaveLength(2); // documenta o escape hatch (e o bug que a guarda mata)
  });
});

describe("createByteTracker — oclusão curta", () => {
  it("some 1 rodada (dentro do TTL) e reaparece no lugar → MESMO id, firstSeen preservado", () => {
    const tk = createByteTracker({ ttlMs: 1500 });
    tk.update([det(0.4, 0.5, 0.6)], 0);
    expect(tk.update([], 350)).toHaveLength(1); // ocluso, vivo
    const out = tk.update([det(0.42, 0.5, 0.6)], 700);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].firstSeen).toBe(0); // dwell/permanência não reinicia
  });
});

describe("createByteTracker — stream que SALTA (espelho F1: re-assoc 2º estágio + LOST)", () => {
  it("salto MODERADO (dentro do raio folga+|v|·gap) re-associa: MESMO id", () => {
    // Pessoa parada; o stream trava e salta: a det reaparece deslocada 0.10 — IoU 0 com a
    // bbox predita (as caixas só se tocam na borda), mas cabe na FOLGA do raio (0.12, v=0)
    // e o par é inequívoco → 2º estágio re-associa (antes: id novo + rastro do antigo).
    const tk = createByteTracker({ iouThreshold: 0.25, ttlMs: 1500, reassocDist: 0.12 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350); // parada: v = 0 → previsto = última observada
    const out = tk.update([det(0.4, 0.5, 0.6)], 700); // salto: IoU 0, dist 0.10 ≤ 0.12
    expect(out).toHaveLength(1); // NÃO nasceu segundo track
    expect(out[0].id).toBe(1);
    expect(out[0].cx).toBeCloseTo(0.4, 6);
    expect(out[0].firstSeen).toBe(0); // continuidade real (dwell preservado)
    expect(out[0].lastSeen).toBe(700);
  });

  it("o raio CRESCE com |v|·gap: engasgo de stream no meio de uma caminhada re-associa", () => {
    // Caminhada com velocidade estabelecida (+0.03/500ms) e engasgo de 1.5s. A det volta a
    // 0.13 do centro PREVISTO — além da folga parada (0.12), mas dentro do raio dt-aware
    // 0.12 + |v|·gap = 0.12 + 0.09 = 0.21. É o cenário "salto moderado ≤2.5s" do eval (F1).
    const tk = createByteTracker({ iouThreshold: 0.25, ttlMs: 8000, reassocMaxGapMs: 2500 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.33, 0.5, 0.6)], 500); // v = +0.03/500ms
    const out = tk.update([det(0.55, 0.5, 0.6)], 2000); // previsto cx≈0.42; dist 0.13; IoU 0
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].cx).toBeCloseTo(0.55, 6);
  });

  it("gap além de reassocMaxGapMs NÃO tenta o 2º estágio (salto velho demais → id novo)", () => {
    const tk = createByteTracker({ ttlMs: 8000, reassocDist: 0.12, reassocMaxGapMs: 2500 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350);
    // dist 0.08 caberia na folga, mas gap = 3000ms > 2500 → não re-associa; nasce id novo
    // (rodada de realocação: só o novo é emitido; o antigo segue interno até o TTL).
    const out = tk.update([det(0.38, 0.5, 0.6)], 3350);
    expect(out.map((t) => t.id)).toEqual([2]);
    expect(out[0].cx).toBeCloseTo(0.38, 6);
    expect(tk.tracks().map((t) => t.id).sort()).toEqual([1, 2]); // id 1 vivo internamente
  });

  it("tamanho INCOMPATÍVEL (dimensão >2×) não re-associa — escala não muda tão rápido", () => {
    const tk = createByteTracker({ ttlMs: 1500, reassocDist: 0.12 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350);
    // dist 0.11 ≤ 0.12 (e IoU 0.23 < 0.25 — 1ª passada falha), mas a det tem w 2.5× a do
    // track → é OUTRA coisa, não a pessoa: nasce id novo (emitido só ele, realocação).
    const out = tk.update([det(0.41, 0.5, 0.6, 0.25, 0.2)], 700);
    expect(out.map((t) => t.id)).toEqual([2]);
    const internal = tk.tracks();
    expect(internal.map((t) => t.id).sort()).toEqual([1, 2]);
    expect(internal.find((t) => t.id === 1)!.cx).toBeCloseTo(0.3, 6); // id 1 não foi puxado
  });

  it("salto EXTREMO → id NOVO na hora e SEM rastro: o antigo sai da emissão já na rodada do salto", () => {
    const tk = createByteTracker({ ttlMs: 1500, reassocDist: 0.12, lostAfterMisses: 1 });
    tk.update([det(0.2, 0.5, 0.6)], 0);
    const r2 = tk.update([det(0.7, 0.5, 0.6)], 350); // dist 0.5 > raio → não re-associa
    // Rodada de REALOCAÇÃO (nascimento): a graça é suspensa — o antigo congelado em 0.2 é
    // exatamente o rastro do bug de campo, então NÃO é emitido (antes: 2 caixas até o TTL).
    expect(r2).toHaveLength(1);
    expect(r2[0].id).toBe(2);
    const r3 = tk.update([det(0.7, 0.5, 0.6)], 700); // 2ª falta consecutiva do antigo → LOST
    expect(r3).toHaveLength(1);
    expect(r3[0].id).toBe(2);
    expect(tk.tracks()).toHaveLength(2); // snapshot INTERNO: o LOST segue vivo p/ re-identificar
  });

  it("oclusão SEM realocação mantém a GRAÇA: 1 rodada sem par ainda é emitida", () => {
    // O contraponto do teste acima: em rodada SEM nascimento/re-associação, 1 falta é
    // flicker comum do detector — a caixa segura 1 rodada p/ presença/ocupação não piscar.
    const tk = createByteTracker({ ttlMs: 1500, lostAfterMisses: 1 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    expect(tk.update([], 350)).toHaveLength(1); // graça
    expect(tk.update([], 700)).toHaveLength(0); // 2ª falta: LOST
  });

  it("AMBIGUIDADE (1 det plausível p/ 2 tracks) NÃO re-associa — não troca id", () => {
    // Dois tracks sem par e uma det equidistante dos dois centros previstos (0.1 de cada,
    // dentro do raio de ambos): re-associar seria chute de identidade → nasce id novo e os
    // antigos seguem onde foram vistos (internos na rodada da realocação). Id errado é pior
    // que id novo.
    const tk = createByteTracker({ iouThreshold: 0.25, reassocDist: 0.12 });
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 350); // paradas (v = 0)
    const out = tk.update([det(0.4, 0.5, 0.6)], 700); // IoU 0 com ambos; dist 0.1 p/ ambos
    expect(out.map((t) => t.id)).toEqual([3]); // NASCEU (realocação: antigos não emitidos)
    expect(out[0].cx).toBeCloseTo(0.4, 6);
    const internal = tk.tracks();
    expect(internal).toHaveLength(3);
    expect(internal.find((t) => t.id === 1)!.cx).toBeCloseTo(0.3, 6); // ninguém teletransportado
    expect(internal.find((t) => t.id === 2)!.cx).toBeCloseTo(0.5, 6);
  });

  it("re-associação RESTAURA track LOST: mesmo id/firstSeen, volta a ser emitido", () => {
    const tk = createByteTracker({ ttlMs: 1500, reassocDist: 0.12, lostAfterMisses: 1 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350);
    expect(tk.update([], 700)).toHaveLength(1); // 1ª falta: graça, ainda emitido
    expect(tk.update([], 1050)).toHaveLength(0); // 2ª falta: LOST — some do desenho/ocupação…
    expect(tk.tracks()).toHaveLength(1); // …mas vive INTERNAMENTE dentro do TTL
    const out = tk.update([det(0.38, 0.5, 0.6)], 1400); // dist 0.08 ≤ folga; gap 1050 ≤ 2500
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // MESMO id — não nasceu track novo
    expect(out[0].firstSeen).toBe(0); // permanência não reinicia
    expect(out[0].cx).toBeCloseTo(0.38, 6);
  });

  it("score BAIXO não re-associa por distância (continuidade através de salto exige score alto)", () => {
    const tk = createByteTracker({ highScore: 0.4, reassocDist: 0.12 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350);
    const out = tk.update([det(0.4, 0.5, 0.3)], 700); // dist 0.10 caberia, mas score baixo
    expect(out).toHaveLength(1);
    expect(out[0].cx).toBeCloseTo(0.3, 6); // track intocado (não foi puxado pelo salto fraco)
    expect(out[0].lastSeen).toBe(350);
  });

  it("reassocDist: 0 DESLIGA o 2º estágio (salto moderado volta a virar id novo)", () => {
    const tk = createByteTracker({ ttlMs: 1500, reassocDist: 0 });
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 350);
    const out = tk.update([det(0.4, 0.5, 0.6)], 700); // mesmo salto do 1º teste do bloco
    expect(out.map((t) => t.id)).toEqual([2]); // sem estágio → nasceu id novo (realocação)
    expect(tk.tracks().map((t) => t.id).sort()).toEqual([1, 2]);
  });
});

// ── F3 — ESTADO ESTACIONÁRIO (spec-tracking-pessoa-parada §2 C2 / CA-1..CA-7).
// PARIDADE (CA-7): a POLÍTICA é a MESMA de server/analysis/bytetrack.js (bloco espelhado
// lá, com os mesmos nomes de caso); os KNOBS diferem por CADÊNCIA — aqui a rodada é
// ~350ms (entra em parado com 3 observações estáveis); no hub, sob o gate de movimento, a
// cena estática só é inferida no probe de 6s (2 observações ≈ 12s).
describe("createByteTracker — ESTADO ESTACIONÁRIO (parado é estado, não morte)", () => {
  const OPTS = {
    highScore: 0.4,
    iouThreshold: 0.25,
    ttlMs: 1500, // TTL de RELÓGIO do móvel (o que matava a pessoa parada em ~3s no front)
    reassocDist: 0.12,
    reassocMaxGapMs: 2500,
    lostAfterMisses: 1,
    stationaryTolerance: 0.01,
    stationaryEnterRounds: 3,
    stationaryMaxMisses: 3,
    stationaryMaxMs: 0,
  };
  const R = 350; // rodada do front (~3fps)

  /** Anda até 0.5 (2 observações → velocidade estabelecida) e PARA lá; N rodadas paradas. */
  function arrive(tk: ReturnType<typeof createByteTracker>, stillRounds = 3) {
    tk.update([det(0.45, 0.5, 0.8)], R);
    tk.update([det(0.5, 0.5, 0.8)], 2 * R); // v = +0.05/350ms — a caminhada que a predição extrapola
    for (let k = 0; k < stillRounds; k++) tk.update([det(0.5, 0.5, 0.8)], (3 + k) * R);
    return tk;
  }

  it("HIPÓTESE DE PARADA: det no lugar da última observação sustenta o track, mesmo com a predição envelhecida e score BAIXO", () => {
    // A pessoa CHEGA andando e PARA; a rodada seguinte é LENTA (1,4s — perfil LR full) e o
    // detector só dá 0.30 (< highScore). A predição levou a caixa p/ 0.5 + 0.05/350×1400 =
    // 0.70: IoU 0 com a det. Antes: nenhuma passada casava (score baixo não nasce nem
    // re-associa por distância) → o track morria e o id/dwell zeravam. Agora a 2ª passada
    // tenta também a caixa CONGELADA (IoU 1.0) → sustenta.
    const tk = createByteTracker(OPTS);
    tk.update([det(0.45, 0.5, 0.8)], R);
    tk.update([det(0.5, 0.5, 0.8)], 2 * R);
    const out = tk.update([det(0.5, 0.5, 0.3)], 2 * R + 1400);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // MESMO id — a permanência não zera
    expect(out[0].score).toBe(0.3); // sustentado pela 2ª passada (score baixo NÃO nasce)
    expect(tk.tracks()).toHaveLength(1);
  });

  it("ENTRA no estado após N observações estáveis e ZERA a velocidade (caixa congelada)", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.45, 0.5, 0.8)], R);
    tk.update([det(0.5, 0.5, 0.8)], 2 * R);
    expect(tk.update([det(0.5, 0.5, 0.8)], 3 * R)[0].stationary).toBe(false); // 1ª estável
    expect(tk.update([det(0.5, 0.5, 0.8)], 4 * R)[0].stationary).toBe(false); // 2ª estável
    const out = tk.update([det(0.5, 0.5, 0.8)], 5 * R); // 3ª estável → ESTACIONÁRIO
    expect(out[0].stationary).toBe(true);
    expect(out[0].id).toBe(1);
  });

  it("JITTER de bbox não acorda o estacionário (tolerância medida contra a ÂNCORA)", () => {
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5
    // treme ±0.008 (< 0.01) em torno da âncora: segue parado, sem re-armar o estado
    expect(tk.update([det(0.508, 0.5, 0.8)], 6 * R)[0].stationary).toBe(true);
    expect(tk.update([det(0.492, 0.5, 0.8)], 7 * R)[0].stationary).toBe(true);
    // …mas ANDAR de verdade (0.03 > tolerância) devolve o track ao regime MÓVEL
    const out = tk.update([det(0.53, 0.5, 0.8)], 8 * R);
    expect(out[0].stationary).toBe(false);
    expect(out[0].id).toBe(1);
  });

  it("morte por EVIDÊNCIA, não por relógio: rodada LENTA (3× o TTL) não mata o parado", () => {
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5
    // gap de 5s (aba em background/stall de stream) — 3× o ttlMs de 1500. O relógio não
    // roda p/ o estacionário; a rodada que não rodou não conta como miss.
    const out = tk.update([det(0.5, 0.5, 0.8)], 5 * R + 5000);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // sobrevive (antes: morto pelo TTL → id novo, dwell zerado)
    expect(out[0].firstSeen).toBe(R);
  });

  it("parado sem match segue DESENHADO/contando presença: a zona fica OCIOSA, nunca VAZIA", () => {
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5
    for (let k = 6; k <= 8; k++) {
      const out = tk.update([], k * R); // detector cego em 3 rodadas (recall intermitente)
      expect(out).toHaveLength(1);
      expect(out[0].cx).toBeCloseTo(0.5, 6); // congelada onde foi vista
    }
    const back = tk.update([det(0.5, 0.5, 0.8)], 9 * R);
    expect(back[0].id).toBe(1); // re-detecção volta ao MESMO id (o dwell nunca zerou)
    expect(back[0].firstSeen).toBe(R);
  });

  it("anti-ghost: passadas M rodadas ANALISADAS sem match (e o piso do relógio), o parado MORRE", () => {
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5, último match em 5×R
    for (let k = 6; k <= 8; k++) expect(tk.update([], k * R)).toHaveLength(1); // 3 misses: graça
    expect(tk.update([], 9 * R)).toHaveLength(0); // 4º miss > M → sai do desenho/ocupação…
    expect(tk.tracks()).toHaveLength(1); // …mas ainda vivo: o relógio (1400ms < ttl 1500) é PISO
    expect(tk.update([], 10 * R)).toHaveLength(0); // evidência (5 misses) E relógio (1750 > 1500)
    expect(tk.tracks()).toHaveLength(0); // → morreu de vez (sem fantasma imortal)
  });

  it("CENA MOVIMENTADA: oclusão de M rodadas ANALISADAS não mata o parado antes do relógio (id sobrevive)", () => {
    // O contraponto do teste acima e a razão do PISO: com outra pessoa/empilhadeira em
    // quadro, TODA rodada é analisada (~3fps) — só a evidência mataria a pessoa parada em
    // ~1,4s de oclusão, MAIS cedo que o TTL de hoje. Com o piso, ela some do desenho (a
    // caixa congelada não fica de enfeite) mas o ID sobrevive e a re-detecção o recupera.
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5, último match em 5×R
    for (let k = 6; k <= 9; k++) tk.update([], k * R); // 4 rodadas ocluso (1400ms < ttl 1500)
    const back = tk.update([det(0.5, 0.5, 0.8)], 9 * R + 100); // reaparece dentro do TTL
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(1); // MESMO id — o dwell/permanência não zerou
    expect(back[0].firstSeen).toBe(R);
  });

  it("ANTI-HIJACK: pessoa NOVA no raio do 2º estágio não herda o id do parado", () => {
    const tk = arrive(createByteTracker(OPTS)); // A: ESTACIONÁRIO em 0.5
    // Rodada em que o detector NÃO vê A (parada/oclusa) e B aparece a 0.12 dela — dentro do
    // raio do 2º estágio (folga 0.12 + |v|·gap, com |v| = 0). Sem a exclusão do estacionário,
    // B herdaria o id de A e arrastaria a caixa dela p/ cima de si.
    const out = tk.update([det(0.62, 0.5, 0.8)], 6 * R);
    expect(out.map((t) => t.id)).toEqual([2]); // B nasce com id NOVO (e A, refutada, não é desenhada)
    expect(tk.tracks().find((t) => t.id === 1)!.cx).toBeCloseTo(0.5, 6); // A não foi arrastada
  });

  it("ANTI-RASTRO: parado sem match em rodada de REALOCAÇÃO sai do desenho (e não volta na seguinte)", () => {
    // Contraponto do teste de presença: se a det da pessoa apareceu em OUTRO lugar, a caixa
    // congelada é o próprio RASTRO — o track é REFUTADO e some até re-associar (sem o flag
    // pegajoso ele voltaria na rodada seguinte: a graça do estacionário é longa).
    const tk = arrive(createByteTracker(OPTS)); // ESTACIONÁRIO em 0.5
    expect(tk.update([det(0.9, 0.5, 0.8)], 6 * R).map((t) => t.id)).toEqual([2]); // saltou p/ longe
    expect(tk.update([det(0.9, 0.5, 0.8)], 7 * R).map((t) => t.id)).toEqual([2]); // não volta
  });

  it("TETO opcional (stationaryMaxMs): 0 = sem teto (o parado VISTO nunca morre por relógio)", () => {
    const tk = arrive(createByteTracker(OPTS)); // stationaryMaxMs: 0
    const out = tk.update([det(0.5, 0.5, 0.8)], 3600_000); // 1h de permanência, re-visto
    expect(out[0].id).toBe(1);
    expect(out[0].firstSeen).toBe(R); // a permanência NÃO zera
  });
});

describe("createByteTracker — LIMITAÇÃO DECLARADA: sem re-ID", () => {
  it("cruzamento denso: pessoas que trocam de lugar entre rodadas TROCAM de id (geometria, não aparência)", () => {
    // Duas pessoas paradas; entre duas rodadas LENTAS elas trocam de posição. Sem re-ID por
    // aparência, o IoU casa cada id com a POSIÇÃO mais próxima — os ids ficam nos lugares,
    // ou seja, trocam de dono. Comportamento conhecido/aceito (risco declarado no plano).
    const tk = createByteTracker();
    const r1 = tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 0);
    const idAt03 = r1.find((t) => Math.abs(t.cx - 0.3) < 1e-6)!.id;
    const idAt05 = r1.find((t) => Math.abs(t.cx - 0.5) < 1e-6)!.id;
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 350); // paradas (v = 0)
    const r3 = tk.update([det(0.5, 0.5, 0.6), det(0.3, 0.5, 0.6)], 700); // trocaram de lugar
    expect(r3).toHaveLength(2); // ninguém nasceu/morreu…
    expect(r3.find((t) => Math.abs(t.cx - 0.3) < 1e-6)!.id).toBe(idAt03); // …mas o id seguiu o LUGAR
    expect(r3.find((t) => Math.abs(t.cx - 0.5) < 1e-6)!.id).toBe(idAt05); // (troca de identidade real)
  });
});

// ── EXTENSÃO POR RODADA (bug de campo 2026-07-26 — frame m09 da bancada visual) ──────────────
// Em movimento o detector FRAGMENTA a pessoa: hipótese LARGA (corpo+braço, 0.80) + rosto (0.51)
// + MÃO isolada (0.60, DISJUNTA do rosto). Track na caixa do ROSTO: a larga morre por contenção,
// mas a mão não toca o rosto e nascia "2ª pessoa". A larga descartada AMPLIA a extensão do track
// na rodada (nascimentos em ordem de score) → a mão cai dentro dela e morre na guarda.
describe("createByteTracker — EXTENSÃO por rodada (fragmentos de corpo não viram pessoas)", () => {
  const rosto = { score: 0.84, bbox: [0.18, 0.24, 0.45, 0.75] as [number, number, number, number] };
  const larga = { score: 0.8, bbox: [0.17, 0.24, 0.83, 0.75] as [number, number, number, number] };
  const mao = { score: 0.6, bbox: [0.84, 0.65, 0.16, 0.24] as [number, number, number, number] }; // dentro da LARGA, fora do ROSTO

  it("cenário m09 REAL: rosto trackeado + [larga, mão, rosto] na rodada → 1 pessoa só", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0.7 });
    tk.update([rosto], 0); // track nasce com a caixa do rosto
    const out = tk.update([larga, mao, { ...rosto, score: 0.51 }], 350);
    expect(out).toHaveLength(1); // larga → extensão; mão → contida na extensão; rosto → contido
    expect(out[0].id).toBe(1);
  });

  it("a extensão NÃO persiste entre rodadas: pessoa real onde a mão estava nasce depois", () => {
    const tk = createByteTracker({ birthIouThreshold: 0.55, birthContainment: 0.7 });
    tk.update([rosto], 0);
    // rodada COM o rosto presente (track fica na caixa do ROSTO): larga vira extensão, mão morre
    expect(tk.update([rosto, larga, mao], 350)).toHaveLength(1);
    // rodada seguinte SEM a larga: track/pred = ROSTO (a extensão morreu com a rodada) — uma
    // pessoa REAL surgindo onde a mão estava é DISJUNTA do rosto → NASCE (recall preservado)
    const out = tk.update([rosto, { score: 0.7, bbox: [0.8, 0.55, 0.2, 0.4] }], 700);
    expect(out).toHaveLength(2);
  });
});
