// PORT de src/vision/bytetrack.test.ts — os MESMOS cenários, contra o port CJS
// server/analysis/bytetrack.js. Mudanças de comportamento devem ser feitas no TS
// de origem e re-portadas; estes testes garantem a paridade do port.
// vitest é ESM (import); o módulo sob teste é CommonJS → createRequire (padrão
// de server/alarmPolicy.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createByteTracker, iouOf } = require("./bytetrack");

// bbox normalizada a partir do CENTRO (w=0.1, h=0.2 default — proporção "pessoa").
function det(cx, cy, score, w = 0.1, h = 0.2) {
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

  it("SEM histórico de movimento, salto ALÉM do raio de re-associação vira id novo", () => {
    const tk = createByteTracker({ ttlMs: 1500 });
    tk.update([det(0.2, 0.5, 0.6)], 0); // 1 observação: velocidade desconhecida (0)
    // IoU 0 com a última bbox E dist 0.4 > raio (0.12 + 0·dt) → nem o 2º estágio casa.
    // Rodada de REALOCAÇÃO (nasceu track): o antigo sem match NÃO é emitido (anti-rastro)…
    const out = tk.update([det(0.6, 0.5, 0.6)], 350);
    expect(out.map((t) => t.id)).toEqual([2]);
    expect(tk.tracks()).toHaveLength(2); // …mas segue vivo internamente (TTL)
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

describe("createByteTracker — RE-ASSOCIAÇÃO 2º estágio (salto de fonte/gate/probe)", () => {
  // knobs de produção (precision.js 20-22) explícitos — mesmo wiring do engine
  const OPTS = {
    iouThreshold: 0.25,
    ttlMs: 8000,
    reassocDist: 0.12,
    reassocMaxGapMs: 2500,
    lostAfterMisses: 1,
  };

  it("salto MODERADO (gap 2s, deslocamento aquém do previsto) → MESMO id, sem track novo", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 500); // v = +0.05/500ms = 1e-4/ms
    // gap de 2000ms (fonte flaky/probe) e a pessoa DESACELEROU: det em 0.30. A predição
    // foi a 0.45 → IoU pred×det = 0 (1ª passada falha) e IoU observada×det ≈ 0.33 < 0.55
    // (guarda de nascimento não pega — ANTES este caso virava id novo). 2º estágio:
    // dist 0.15 ≤ raio 0.12 + |v|·2000 = 0.32 → re-associa.
    const out = tk.update([det(0.3, 0.5, 0.6)], 2500);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // mesma pessoa, mesmo id
    expect(out[0].cx).toBeCloseTo(0.3, 6); // posição observada aplicada
    expect(tk.tracks()).toHaveLength(1); // nada nasceu
    expect(tk.stats().reassociations).toBe(1);
  });

  it("salto EXTREMO → id novo E o velho some do payload JÁ na rodada do salto (rastro zero)", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.2, 0.5, 0.6)], 500); // parada: v = 0 → raio = só a folga (0.12)
    // dist 0.5 > 0.12 → NÃO re-associa; nasce id 2 e a rodada é de REALOCAÇÃO →
    // o velho sem match nem ganha a graça (1 pessoa = 1 track emitido, nunca 2).
    const r1 = tk.update([det(0.7, 0.5, 0.6)], 1000);
    expect(r1.map((t) => t.id)).toEqual([2]);
    expect(tk.tracks()).toHaveLength(2); // o velho vive INTERNAMENTE (re-identificável até o TTL)
    const r2 = tk.update([det(0.7, 0.5, 0.6)], 1500); // velho: 2ª rodada sem match → LOST
    expect(r2.map((t) => t.id)).toEqual([2]);
    expect(tk.stats().lost).toBe(1);
  });

  it("LOST re-associado volta à emissão com o MESMO id (identidade sobrevive ao gap)", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 500); // v = 1e-4/ms
    expect(tk.update([], 1000)).toHaveLength(1); // 1ª sem match: graça (ainda emitido)
    expect(tk.update([], 1500)).toHaveLength(0); // 2ª sem match: LOST → payload limpo
    // reaparece 2s após o último match, aquém do previsto (pred 0.45; det 0.30; dist 0.15 ≤ 0.32)
    const out = tk.update([det(0.3, 0.5, 0.6)], 2500);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1); // mesmo id — permanência/travessia não reiniciam
    expect(out[0].firstSeen).toBe(0);
    expect(tk.stats()).toEqual({ reassociations: 1, lost: 0 });
  });

  it("AMBIGUIDADE nunca troca identidade: 1 det plausível p/ 2 tracks → id NOVO", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 500); // paradas (v = 0)
    tk.update([], 1000);
    tk.update([], 1500); // ambas LOST
    // det única EQUIDISTANTE (0.1 ≤ raio 0.12 dos dois) → par ambíguo → nasce id 3
    const out = tk.update([det(0.4, 0.5, 0.6)], 2000);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3); // não herda o id de nenhuma das duas sumidas
  });

  it("tamanho INCOMPATÍVEL não re-associa: det 2.5× maior no lugar previsto → id novo", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.3, 0.5, 0.6)], 0);
    tk.update([det(0.3, 0.5, 0.6)], 500);
    tk.update([], 1000); // miss 1
    // mesmo centro (dist 0 ≤ raio) mas 2.5× a escala → é OUTRA coisa, não a pessoa
    const out = tk.update([det(0.3, 0.5, 0.6, 0.25, 0.5)], 1500);
    expect(out.map((t) => t.id)).toEqual([2]); // nasceu novo; o velho (miss 2) é LOST
    expect(tk.stats().reassociations).toBe(0);
  });

  it("gap além de reassocMaxGapMs não re-associa (oclusão longa → id novo, aceito)", () => {
    const tk = createByteTracker(OPTS);
    tk.update([det(0.2, 0.5, 0.6)], 0);
    tk.update([det(0.25, 0.5, 0.6)], 500);
    // 4s depois (> 2.5s): extrapolação não é confiável — id novo mesmo "perto";
    // rodada de realocação → o velho não é emitido (segue interno até o TTL)
    const out = tk.update([det(0.3, 0.5, 0.6)], 4500);
    expect(out.map((t) => t.id)).toEqual([2]);
    expect(out[0].cx).toBeCloseTo(0.3, 6);
    expect(tk.tracks()).toHaveLength(2);
    expect(tk.stats().reassociations).toBe(0);
  });
});

describe("createByteTracker — LIMITAÇÃO DECLARADA: sem re-ID", () => {
  it("cruzamento denso: pessoas que trocam de lugar entre rodadas TROCAM de id (geometria, não aparência)", () => {
    // Duas pessoas paradas; entre duas rodadas LENTAS elas trocam de posição. Sem re-ID por
    // aparência, o IoU casa cada id com a POSIÇÃO mais próxima — os ids ficam nos lugares,
    // ou seja, trocam de dono. Comportamento conhecido/aceito (risco declarado no plano).
    const tk = createByteTracker();
    const r1 = tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 0);
    const idAt03 = r1.find((t) => Math.abs(t.cx - 0.3) < 1e-6).id;
    const idAt05 = r1.find((t) => Math.abs(t.cx - 0.5) < 1e-6).id;
    tk.update([det(0.3, 0.5, 0.6), det(0.5, 0.5, 0.6)], 350); // paradas (v = 0)
    const r3 = tk.update([det(0.5, 0.5, 0.6), det(0.3, 0.5, 0.6)], 700); // trocaram de lugar
    expect(r3).toHaveLength(2); // ninguém nasceu/morreu…
    expect(r3.find((t) => Math.abs(t.cx - 0.3) < 1e-6).id).toBe(idAt03); // …mas o id seguiu o LUGAR
    expect(r3.find((t) => Math.abs(t.cx - 0.5) < 1e-6).id).toBe(idAt05); // (troca de identidade real)
  });
});
