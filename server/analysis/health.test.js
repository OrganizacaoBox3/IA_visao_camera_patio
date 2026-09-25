// Testes da SAÚDE por câmera (server/analysis/health.js) — o antídoto do falso-OK do MONITOR:
// "câmera parada", "vídeo chegando mas IA não analisou", "IA atrasada" e "cena vazia" produziam a
// MESMA tela (contagem 0, nenhum aviso). Cada estado aqui nasceu de um desses casos reais.
//
// O que estes testes PROVAM (não descrevem):
//  1. cada estado dispara pelo sinal que o define — e com o NÚMERO medido no veredito;
//  2. a PRECEDÊNCIA (sem-video > instável > ia-parada > ia-atrasada > linha) — sintoma grave
//     explica os de baixo, e reportar os dois juntos diluiria o sinal;
//  3. o caminho SAUDÁVEL devolve "ok" com o mesmo rigor (aviso que vira decoração é ignorado);
//  4. sinal AUSENTE nunca vira acusação ("sem sinal", não "falhou") — acusar sem medir é o
//     oposto de separar medição de inferência.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyCamera, summarize, observeFrame, DEFAULTS, RETOMADA_GAP_MS } = require("./health");

// Câmera SAUDÁVEL de referência: frame agora, inferência agora, cadência na meta.
const NOW = 1_000_000;
const saudavel = (over = {}) => ({
  now: NOW,
  lastFrameAt: NOW - 200,
  lastInferAt: NOW - 500,
  fps: 1,
  targetFps: 1,
  frameAgeP50: 120,
  maxGapMs: 900,
  retomadas1m: 0,
  hasTripwire: false,
  analiseLigada: true,
  ...over,
});

describe("classifyCamera — caminho saudável (silêncio é informação)", () => {
  it("todos os sinais na meta → ok, sem motivo alarmista", () => {
    const h = classifyCamera(saudavel());
    expect(h.estado).toBe("ok");
    expect(h.motivo).toBe("dentro do esperado");
  });

  it("o veredito SEMPRE carrega o medido (número que o sustenta, não só o rótulo)", () => {
    const h = classifyCamera(saudavel({ fps: 0.85, frameAgeP50: 137.4 }));
    expect(h.medido).toMatchObject({ fps: 0.85, targetFps: 1, frameAgeP50: 137, semFrameMs: 200 });
  });

  it("gate de movimento pulando rodada em cena estática NÃO é IA parada (folga do fator)", () => {
    // 1fps × fator 6 = 6s, com piso de 12s: um probe a cada ~6s (cena estática) fica ok.
    const h = classifyCamera(saudavel({ lastInferAt: NOW - 6_500 }));
    expect(h.estado).toBe("ok");
  });
});

describe("classifyCamera — 1. sem-video (a IA não tem o que ver)", () => {
  it("nenhum frame além do limite → sem-video, com o tempo medido no motivo", () => {
    const h = classifyCamera(saudavel({ lastFrameAt: NOW - 20_000 }));
    expect(h.estado).toBe("sem-video");
    expect(h.motivo).toContain("20s");
    expect(h.desde).toBe(NOW - 20_000);
  });

  it("logo abaixo do limite ainda NÃO acusa (câmera lenta ≠ câmera morta)", () => {
    const h = classifyCamera(saudavel({ lastFrameAt: NOW - (DEFAULTS.semVideoMs - 1) }));
    expect(h.estado).not.toBe("sem-video");
  });

  it("PRECEDÊNCIA: sem frame E sem inferência → reporta sem-video (que explica o resto)", () => {
    const h = classifyCamera(saudavel({ lastFrameAt: NOW - 30_000, lastInferAt: NOW - 30_000 }));
    expect(h.estado).toBe("sem-video");
  });
});

describe("classifyCamera — 2. video-instavel (chega, mas picado)", () => {
  it("retomadas em série → instável, nomeando quantas", () => {
    const h = classifyCamera(saudavel({ retomadas1m: DEFAULTS.instavelRetomadas }));
    expect(h.estado).toBe("video-instavel");
    expect(h.motivo).toContain("retomadas");
  });

  it("lacuna grande entre frames → instável, com a lacuna medida", () => {
    const h = classifyCamera(saudavel({ maxGapMs: 12_000 }));
    expect(h.estado).toBe("video-instavel");
    expect(h.motivo).toContain("12s");
  });

  it("os dois sintomas juntos aparecem no MESMO motivo (não escolhe um e esconde o outro)", () => {
    const h = classifyCamera(saudavel({ retomadas1m: 5, maxGapMs: 20_000 }));
    expect(h.motivo).toContain("retomadas");
    expect(h.motivo).toContain("lacuna");
  });

  it("retomada isolada (abaixo do piso) não vira aviso", () => {
    const h = classifyCamera(saudavel({ retomadas1m: DEFAULTS.instavelRetomadas - 1 }));
    expect(h.estado).toBe("ok");
  });
});

describe("classifyCamera — 3. ia-parada (o caso que mais engana: vídeo bom, número congelado)", () => {
  it("frame fresco + inferência sumida → ia-parada", () => {
    const h = classifyCamera(saudavel({ lastInferAt: NOW - 60_000 }));
    expect(h.estado).toBe("ia-parada");
    expect(h.motivo).toContain("vídeo chegando");
    expect(h.motivo).toContain("60s");
    expect(h.desde).toBe(NOW - 60_000);
  });

  it("o limite ESCALA com a cadência pedida (câmera focada a 6fps acusa antes que a de 1fps)", () => {
    // 6fps → 6×(1000/6)=1000ms, mas o PISO de 12s manda: 13s acusa, 11s não.
    const focada = { targetFps: 6, lastInferAt: NOW - 13_000 };
    expect(classifyCamera(saudavel(focada)).estado).toBe("ia-parada");
    expect(classifyCamera(saudavel({ ...focada, lastInferAt: NOW - 11_000 })).estado).not.toBe(
      "ia-parada",
    );
  });

  it("câmera FORA da análise (fadiga/motor off) não é acusada de IA parada", () => {
    const h = classifyCamera(saudavel({ lastInferAt: NOW - 600_000, analiseLigada: false }));
    expect(h.estado).toBe("ok");
    expect(h.motivo).toContain("não cobre");
  });
});

describe("classifyCamera — 4. ia-atrasada (mede, mas não acompanha o vídeo)", () => {
  it("frame analisado velho → atrasada, com o atraso em segundos", () => {
    const h = classifyCamera(saudavel({ frameAgeP50: 5_000 }));
    expect(h.estado).toBe("ia-atrasada");
    expect(h.motivo).toContain("5.0s de atraso");
  });

  it("cadência muito abaixo da meta → atrasada, mostrando medido × pedido", () => {
    const h = classifyCamera(saudavel({ fps: 0.15, targetFps: 6 }));
    expect(h.estado).toBe("ia-atrasada");
    expect(h.motivo).toContain("0.15 de 6");
  });

  it("cadência levemente abaixo da meta NÃO é atraso (ruído não é anormalidade)", () => {
    const h = classifyCamera(saudavel({ fps: 0.8, targetFps: 1 }));
    expect(h.estado).toBe("ok");
  });

  it("PRECEDÊNCIA: ia-parada vence ia-atrasada (parou é mais grave que atrasou)", () => {
    const h = classifyCamera(saudavel({ lastInferAt: NOW - 60_000, frameAgeP50: 9_000 }));
    expect(h.estado).toBe("ia-parada");
  });
});

// ── GATE DE MOVIMENTO × "ia-atrasada" (2026-09-24) ────────────────────────────────────────────
// ACHADO #1 (benchmark local, engine real + worker real): com o gate de movimento ligado (o
// default), uma câmera ociosa de VERDADE (cena parada) roda só no PROBE — no máximo 1/probeMs.
// Contra a meta NOMINAL (não-gateada) isso é SEMPRE < atrasoFpsRatio(0.25): 1000/6000=0.167 <
// 0.25. Sem `gateFloorFps`, TODA câmera ociosa com o gate ligado reportaria "ia-atrasada" para
// sempre — o gate reduz a cadência DE PROPÓSITO, e o check antigo não sabia disso. É a MESMA
// classe do bug do gate de turno (health.js §"dormindoPorTurno"), agora no gate de movimento.
//
// ACHADO #2 (mesmo benchmark, 2ª rodada): o piso CRU (sem folga) ainda disparava na 1ª
// avaliação de saúde de uma câmera RECÉM-LIGADA — a janela de `fps` (rounds/60) ainda não
// tinha 60s de vida (só ~5 rodadas reais até o 1º tick de HEALTH_TICK_MS=30s), então o fps
// OBSERVADO ficava artificialmente baixo por conta do RELÓGIO, não por economia nem por falha.
// `gateFloorSlack` (4×) absorve esse boot sem deixar de pegar um pool travado de verdade —
// telemetry.js manda o piso CRU (1 inferência por probe, sem fudge); a folga é 100% aqui.
describe("classifyCamera — gateFloorFps: o gate de movimento não pode virar falso-atraso", () => {
  it("fps só abaixo da meta NOMINAL, mas ACIMA do piso do gate (com folga) → ok", () => {
    // Câmera normal (não focada): probeMs=6000 → piso cru = 1000/6000 = 0.1667; /gateFloorSlack(4) = 0.0417.
    const h = classifyCamera(saudavel({ fps: 0.15, targetFps: 1, gateFloorFps: 0.1667 }));
    expect(h.estado).toBe("ok");
  });

  it("fps abaixo do piso COM folga → ia-atrasada (não é boot nem economia, é problema real)", () => {
    const h = classifyCamera(saudavel({ fps: 0.03, targetFps: 1, gateFloorFps: 0.1667 }));
    expect(h.estado).toBe("ia-atrasada");
    expect(h.motivo).toContain("0.03 de 1");
  });

  it("sem gateFloorFps (gate desligado, ou caller antigo) → comportamento de SEMPRE, sem folga inventada", () => {
    const h = classifyCamera(saudavel({ fps: 0.15, targetFps: 1 }));
    expect(h.estado).toBe("ia-atrasada"); // idêntico ao teste "cadência muito abaixo da meta"
  });

  it("fps EXATAMENTE no piso COM folga → ok (corte inclusivo, a favor do nunca-cego)", () => {
    // piso cru 0.16 / slack 4 = 0.04 exato.
    const h = classifyCamera(saudavel({ fps: 0.04, targetFps: 1, gateFloorFps: 0.16 }));
    expect(h.estado).toBe("ok");
  });

  it("câmera FOCADA: piso cru maior (probeFocusMs, mais curto) — mesma folga, meta diferente", () => {
    // Focada: probeFocusMs=2000 → piso cru = 1000/2000 = 0.5; /4 = 0.125.
    const h = classifyCamera(saudavel({ fps: 0.15, targetFps: 6, gateFloorFps: 0.5 }));
    expect(h.estado).toBe("ok"); // 0.15 < 6*0.25=1.5 (abaixo da meta nominal) mas ≥ 0.125 (piso com folga)
  });

  it("`medido.gateFloorFps` viaja no veredito (transparência: o número que justificou 'ok')", () => {
    const h = classifyCamera(saudavel({ fps: 0.15, targetFps: 1, gateFloorFps: 0.1667 }));
    expect(h.medido.gateFloorFps).toBe(0.17); // arredondado a 2 casas (r2) — o CRU, não o com-folga
  });

  it("PRECEDÊNCIA intacta: ia-parada ainda vence, gateFloorFps não cega parada de verdade", () => {
    const h = classifyCamera(
      saudavel({ lastInferAt: NOW - 60_000, fps: 0.15, targetFps: 1, gateFloorFps: 0.1667 }),
    );
    expect(h.estado).toBe("ia-parada");
  });
});

describe("classifyCamera — 5. linha-sem-cadencia (in/out 0 que parece 'ninguém passou')", () => {
  it("câmera COM linha e cadência insuficiente → aviso explícito, com o piso e o medido", () => {
    const h = classifyCamera(saudavel({ hasTripwire: true, fps: 0.3, targetFps: 0.4 }));
    expect(h.estado).toBe("linha-sem-cadencia");
    expect(h.motivo).toContain("travessia");
    expect(h.motivo).toContain("0.3");
  });

  it("mesma cadência SEM linha configurada não gera aviso (não existe travessia a perder)", () => {
    const h = classifyCamera(saudavel({ hasTripwire: false, fps: 0.3, targetFps: 0.4 }));
    expect(h.estado).toBe("ok");
  });

  it("com linha e cadência suficiente → ok", () => {
    const h = classifyCamera(saudavel({ hasTripwire: true, fps: 2, targetFps: 2 }));
    expect(h.estado).toBe("ok");
  });
});

describe("classifyCamera — sinal ausente NUNCA vira acusação", () => {
  it("objeto vazio → ok com 'sem sinal' (não 'sem-video')", () => {
    const h = classifyCamera({ now: NOW });
    expect(h.estado).toBe("ok");
    expect(h.motivo).toBe("sem sinal");
  });

  it("sinais nulos/torto degradam pro default seguro, sem lançar", () => {
    for (const s of [
      { now: NOW, lastFrameAt: null, fps: null },
      { now: NOW, lastFrameAt: NaN, lastInferAt: "ontem", fps: "rápido" },
      {},
    ])
      expect(() => classifyCamera(s)).not.toThrow();
  });

  it("frame medido mas inferência DESCONHECIDA não acusa ia-parada", () => {
    const h = classifyCamera({ now: NOW, lastFrameAt: NOW - 100, analiseLigada: true });
    expect(h.estado).toBe("ok");
  });
});

describe("classifyCamera — limites sobrescrevíveis (ops pina sem tocar na lógica)", () => {
  it("semVideoMs customizado muda o veredito do MESMO sinal", () => {
    const sinal = saudavel({ lastFrameAt: NOW - 5_000 });
    expect(classifyCamera(sinal).estado).toBe("ok");
    expect(classifyCamera(sinal, { semVideoMs: 3_000 }).estado).toBe("sem-video");
  });
});

describe("summarize — resumo da frota", () => {
  it("conta por estado e lista só as problemáticas (com motivo)", () => {
    const s = summarize({
      cam1: { estado: "ok", motivo: "dentro do esperado" },
      cam2: { estado: "sem-video", motivo: "nenhum frame há 40s" },
      cam3: { estado: "ia-parada", motivo: "vídeo chegando, mas nenhuma análise há 30s" },
      cam4: { estado: "ok", motivo: "dentro do esperado" },
    });
    expect(s.total).toBe(4);
    expect(s.contagem).toEqual({ ok: 2, "sem-video": 1, "ia-parada": 1 });
    expect(s.problemas.map((p) => p.id).sort()).toEqual(["cam2", "cam3"]);
    expect(s.problemas.find((p) => p.id === "cam2").motivo).toContain("40s");
  });

  it("frota saudável → nenhum problema listado", () => {
    expect(summarize({ cam1: { estado: "ok" } }).problemas).toEqual([]);
  });

  it("frota vazia não quebra", () => {
    expect(summarize()).toEqual({ total: 0, contagem: {}, problemas: [] });
  });
});

// observeFrame: o SINAL de instabilidade que o hub não tinha (lacuna/retomada por câmera).
// Roda no caminho MAIS quente (todo frame, dois pontos de entrada) → é O(1), sem array; por
// isso o teste cobre também a virada de JANELA, que é onde um contador sem poda mentiria.
describe("observeFrame — lacuna e retomada de vídeo (O(1) por frame)", () => {
  it("1º frame da câmera não inventa lacuna", () => {
    const st = {};
    observeFrame(st, 1000);
    expect(st.frameGapMax).toBe(0);
    expect(st.frameRetomadas).toBe(0);
  });

  it("guarda a MAIOR lacuna da janela (não a última)", () => {
    const st = { lastFrameAt: 0 };
    st.lastFrameAt = 1000;
    observeFrame(st, 1500); // 500ms
    st.lastFrameAt = 1500;
    observeFrame(st, 9000); // 7500ms ← maior
    st.lastFrameAt = 9000;
    observeFrame(st, 9200); // 200ms
    expect(st.frameGapMax).toBe(7500);
  });

  it("conta como RETOMADA só a lacuna ≥ limiar (soluço curto não conta)", () => {
    const st = { lastFrameAt: 1000 };
    observeFrame(st, 1000 + RETOMADA_GAP_MS - 1); // abaixo: não conta
    expect(st.frameRetomadas).toBe(0);
    st.lastFrameAt = 20_000;
    observeFrame(st, 20_000 + RETOMADA_GAP_MS); // no limiar: conta
    expect(st.frameRetomadas).toBe(1);
  });

  it("a janela VIRA: lacuna velha não fica pendurada (o número vale pelo último minuto)", () => {
    const st = { lastFrameAt: 1000 };
    observeFrame(st, 10_000); // lacuna de 9s na 1ª janela
    expect(st.frameGapMax).toBe(9000);
    expect(st.frameRetomadas).toBe(1);
    // Janela seguinte, com vídeo saudável: o 9s de antes NÃO pode continuar acusando.
    // (o próprio salto de janela conta como uma lacuna nova — é o sinal de "voltou";
    //  o que se prova aqui é que ele não SOMA com o histórico anterior.)
    st.frameGapAt = 200_000;
    st.frameGapMax = 0;
    st.frameRetomadas = 0;
    st.lastFrameAt = 200_000;
    observeFrame(st, 200_200); // 200ms
    expect(st.frameGapMax).toBe(200);
    expect(st.frameRetomadas).toBe(0);
  });

  it("o SALTO de janela mede a lacuna nova (vídeo que voltou depois de minutos)", () => {
    const st = { lastFrameAt: 10_000, frameGapAt: 10_000, frameGapMax: 0, frameRetomadas: 0 };
    observeFrame(st, 200_000); // 190s sem frame e voltou
    expect(st.frameGapMax).toBe(190_000);
    expect(st.frameRetomadas).toBe(1);
  });

  it("frame fora de ordem (gap ≤ 0) não afirma nada", () => {
    const st = { lastFrameAt: 5000, frameGapAt: 5000, frameGapMax: 0, frameRetomadas: 0 };
    observeFrame(st, 4000); // relógio andou pra trás / frame atrasado
    expect(st.frameGapMax).toBe(0);
    expect(st.frameRetomadas).toBe(0);
  });

  it("alimenta o classifyCamera: 3 retomadas medidas viram video-instavel", () => {
    const st = { lastFrameAt: 0 };
    for (const t of [10_000, 20_000, 30_000]) {
      st.lastFrameAt = t - 6_000; // cada frame chega 6s depois do anterior
      observeFrame(st, t);
    }
    const h = classifyCamera({
      now: 30_100,
      lastFrameAt: 30_000,
      lastInferAt: 30_000,
      fps: 1,
      targetFps: 1,
      maxGapMs: st.frameGapMax,
      retomadas1m: st.frameRetomadas,
      analiseLigada: true,
    });
    expect(st.frameRetomadas).toBe(3);
    expect(h.estado).toBe("video-instavel");
  });
});

// ── GATE DE TURNO × SAÚDE (2026-09-22) ───────────────────────────────────────────────────────
// O bug que estes testes travam, e que impedia ligar o `ANALYSIS_SHIFT_GATE` em produção:
// a câmera dormindo pelo gate CONTINUA recebendo frame (o gate corta a inferência, não o
// vídeo), então ela chegava aqui com frame fresco e `lastInferAt` velho — a definição literal
// de "ia-parada". MEDIDO antes do conserto: 15 câmeras fora do turno → 16 incidentes abertos e
// UM alarme de FROTA `critical`, renotificado a cada 30min a noite inteira. Todo dia.
//
// O contrapeso, testado junto e igualmente importante: dormir NÃO pode cegar a saúde. Feed
// morto é falha real independente do turno — só a inferência parada é que passa a ser esperada.
describe("classifyCamera — câmera dormindo pelo gate de turno", () => {
  const T = 1_700_000_000_000;
  // Frame fresco + inferência parada há 20min: o padrão de uma câmera dormindo.
  const dormindo = {
    now: T,
    lastFrameAt: T - 500,
    lastInferAt: T - 20 * 60_000,
    fps: 0,
    targetFps: 1,
    frameAgeP50: 300,
    maxGapMs: 900,
    retomadas1m: 0,
    analiseLigada: true,
  };

  it("SEM o sinal do gate, o mesmo dado vira 'ia-parada' — é o bug que isto conserta", () => {
    expect(classifyCamera(dormindo).estado).toBe("ia-parada");
  });

  it("fora da janela de turno é 'ok' — a câmera faz o que foi mandada fazer", () => {
    const v = classifyCamera({ ...dormindo, dormindoPorTurno: true, motivoDoSono: "fora-janela" });
    expect(v.estado).toBe("ok");
    expect(v.motivo).toMatch(/fora da janela de turno/);
  });

  it("SEM TURNO atribuído tem motivo PRÓPRIO — é pendência de config, não economia", () => {
    // Somados num texto só, um parque inteiro sem turno leria como economia bem-sucedida.
    const v = classifyCamera({ ...dormindo, dormindoPorTurno: true, motivoDoSono: "sem-turno" });
    expect(v.estado).toBe("ok");
    expect(v.motivo).toMatch(/nenhum turno atribuído/);
  });

  it("dormir não CEGA a saúde: feed morto continua sendo 'sem-video'", () => {
    // Precedência preservada — perder vídeo é falha real, esteja a câmera no turno ou não.
    const v = classifyCamera({
      ...dormindo,
      lastFrameAt: T - 60_000,
      dormindoPorTurno: true,
      motivoDoSono: "fora-janela",
    });
    expect(v.estado).toBe("sem-video");
  });

  it("dormir não CEGA a saúde: vídeo picado continua sendo 'video-instavel'", () => {
    const v = classifyCamera({
      ...dormindo,
      retomadas1m: 5,
      dormindoPorTurno: true,
      motivoDoSono: "fora-janela",
    });
    expect(v.estado).toBe("video-instavel");
  });

  it("o veredito continua carregando os NÚMEROS que o sustentam", () => {
    const v = classifyCamera({ ...dormindo, dormindoPorTurno: true, motivoDoSono: "fora-janela" });
    expect(v.medido.semInferMs).toBe(20 * 60_000);
    expect(v.medido.fps).toBe(0);
  });

  it("`dormindoPorTurno` só vale como TRUE explícito (undefined/false não mudam nada)", () => {
    expect(classifyCamera({ ...dormindo, dormindoPorTurno: false }).estado).toBe("ia-parada");
    expect(classifyCamera({ ...dormindo, dormindoPorTurno: undefined }).estado).toBe("ia-parada");
  });
});
