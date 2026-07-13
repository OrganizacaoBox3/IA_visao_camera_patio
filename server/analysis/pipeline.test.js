// Testes do PIPELINE POR RODADA — a lógica de domínio do motor (exclusão →
// automask → tracking → contagem → zonas → ingest → emit) que antes só era
// exercitável subindo o engine inteiro (worker+IPC). Aqui roda com dets
// sintéticos e os módulos REAIS de tracker/counter/zonas (integração de domínio).
// vitest é ESM; os módulos são CommonJS → createRequire (padrão da pasta).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPipeline, shiftOf } = require("./pipeline");
const { createByteTracker } = require("./bytetrack");
const { createCounter } = require("./counting");
const { createAutoMask, amCell } = require("./automask");

// Estado mínimo por câmera (espelha os campos que o pipeline usa do createState do engine).
function makeSt(over = {}) {
  return {
    id: "cam1",
    tracker: createByteTracker({
      highScore: 0.35,
      iouThreshold: 0.25,
      birthIouThreshold: 0.55,
      ttlMs: 8000,
      // anti-rastro/salto — espelho do engine (precision.js 20-22)
      reassocDist: 0.12,
      reassocMaxGapMs: 2500,
      lostAfterMisses: 1,
    }),
    counter: createCounter(over.tripwires || [], {
      minMove: 0.01,
      ttl: 8000,
      maxDist: 0.35,
      debounceMs: 800,
      minCrossingFrames: 2,
    }),
    zonesAtiv: [],
    zonesExcl: [],
    zonesProib: [], // modo "proibida" — presença vigiada (presence-alert.js)
    autoMask: null,
    window: { frames: 0, zones: new Map() },
    rounds: [],
    detsLog: [],
    lastTracks: null, // snapshot p/ re-emissão coasting (C1)
    lastMs: 0,
    ...over,
  };
}

// detecção de pessoa com PÉ em (cx, footY) — bbox [x,y,w,h] normalizado.
const person = (cx, footY, score = 0.9, w = 0.1, h = 0.4) => ({
  class: "person",
  score,
  bbox: [cx - w / 2, footY - h, w, h],
});

let deps;
let pipeline;
beforeEach(() => {
  deps = {
    highScore: 0.35,
    ingest: vi.fn(() => Promise.resolve()),
    hasViewers: vi.fn(() => true),
    emitTracks: vi.fn(),
    cameraLabelOf: vi.fn(() => "Câmera 1"),
    raiseAlarm: vi.fn(), // produtor server-side (presença em zona proibida)
  };
  pipeline = createPipeline(deps);
});

const emittedTracks = (call = 0) => deps.emitTracks.mock.calls[call][0].tracks;

describe("processRound — filtro de entrada", () => {
  it("só 'person' com bbox válido entra; o resto é ignorado sem quebrar", () => {
    const st = makeSt();
    pipeline.processRound(
      st,
      [person(0.5, 0.8), { class: "chair", score: 0.9, bbox: [0, 0, 0.1, 0.1] }, null, { class: "person", score: 0.9 }],
      1000,
    );
    expect(st.detsLog[0].n).toBe(1); // 1 pessoa contada na rodada
    expect(emittedTracks()).toHaveLength(1);
  });

  it("emite TODA rodada com espectador, inclusive vazia (apaga as caixas no dashboard)", () => {
    const st = makeSt();
    pipeline.processRound(st, [], 1000);
    expect(deps.emitTracks).toHaveBeenCalledTimes(1);
    expect(emittedTracks()).toEqual([]); // 0 tracks
  });

  it("SEM espectador (hasViewers=false) o payload nem é montado — mas a janela/ingest seguem", () => {
    deps.hasViewers.mockReturnValue(false);
    const st = makeSt({ zonesAtiv: [{ id: "z1", label: "Doca", x: 0, y: 0, w: 1, h: 1 }] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(deps.emitTracks).not.toHaveBeenCalled();
    expect(st.window.frames).toBe(1); // indicador não depende de espectador (24/7)
  });

  it("payload do `analysis-tracks` tem o SHAPE do contrato (campos internos não vazam)", () => {
    const st = makeSt({ zonesAtiv: [{ id: "z1", label: "Doca", x: 0, y: 0, w: 1, h: 1 }] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    const payload = deps.emitTracks.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["cameraId", "latencyMs", "tracks", "ts", "zones", "zonesProibidas"]);
    expect(payload.cameraId).toBe("cam1");
    expect(payload.ts).toBe(1000);
    expect(payload.latencyMs).toBe(0); // sem 4º arg (latencyMs) → default 0
    expect(Object.keys(payload.tracks[0]).sort()).toEqual(["bbox", "cx", "cy", "id", "score", "vx", "vy", "zone"]);
    expect(payload.tracks[0]).not.toHaveProperty("firstSeen"); // interno do tracker não vaza
    expect(payload.zones).toEqual([{ id: "z1", label: "Doca", people: 1, occupied: true }]);
    expect(payload.zonesProibidas).toEqual([]); // câmera sem zona proibida → campo presente, vazio
  });

  it("latencyMs vem do 4º parâmetro (medido no worker-host: Date.now − ts de captura) — vai no payload", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.5, 0.8)], 1000, 300); // captura em now=1000, latência 300ms
    expect(deps.emitTracks.mock.calls[0][0].latencyMs).toBe(300);
  });
});

describe("processRound — zona de exclusão (pé-âncora)", () => {
  it("det com o PÉ na zona de exclusão é descartada ANTES do tracking (conta em detsLog.x)", () => {
    const st = makeSt({ zonesExcl: [{ x: 0.4, y: 0.7, w: 0.2, h: 0.2 }] }); // pé (0.5,0.8) cai aqui
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(st.detsLog[0]).toMatchObject({ n: 0, x: 1 });
    expect(emittedTracks()).toEqual([]); // não virou track/overlay
  });

  it("det com o pé FORA da zona segue normal", () => {
    const st = makeSt({ zonesExcl: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(st.detsLog[0]).toMatchObject({ n: 1, x: 0 });
  });
});

describe("processRound — auto-máscara (contrato roundObserver)", () => {
  it("célula aprendida como objeto fixo SUPRIME a det (conta em detsLog.a) e segue aprendendo", () => {
    const am = createAutoMask();
    am.suppressed.add(amCell(0.5, 0.8)); // como após uma janela aprendida (modo default: hide)
    const st = makeSt({ autoMask: am });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(st.detsLog[0]).toMatchObject({ n: 0, a: 1 });
    expect(am.cells.size).toBe(1); // aprendeu MESMO suprimindo (objeto presente segue confirmado)
    expect(am.rounds).toBe(1); // rodada fechada via observer.close
  });

  it("sem autoMask (feature off) nada é suprimido nem aprendido", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(st.detsLog[0]).toMatchObject({ n: 1, a: 0 });
  });
});

describe("processRound — tracking (nascimento pelo highScore)", () => {
  it("score ≥ highScore nasce track; score baixo sozinho NÃO nasce", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.3, 0.8, 0.3)], 1000); // 0.3 < 0.35 → não nasce
    expect(emittedTracks(0)).toEqual([]);
    pipeline.processRound(st, [person(0.7, 0.8, 0.4)], 2000); // 0.4 ≥ 0.35 → nasce
    expect(emittedTracks(1)).toHaveLength(1);
  });
});

describe("processRound — política LOST (anti-rastro na emissão)", () => {
  const zone = { id: "z1", label: "Doca", x: 0, y: 0, w: 1, h: 1 };

  it("track sem match há 2 rodadas SOME do analysis-tracks e da zona (rastro morre em ≤1 rodada)", () => {
    const st = makeSt({ zonesAtiv: [zone] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    pipeline.processRound(st, [], 2000); // 1ª sem match: graça — oclusão de 1 rodada não pisca
    expect(emittedTracks(1)).toHaveLength(1);
    pipeline.processRound(st, [], 3000); // 2ª sem match: LOST → fora do payload E da ocupação
    expect(emittedTracks(2)).toEqual([]);
    expect(deps.emitTracks.mock.calls[2][0].zones).toEqual([
      { id: "z1", label: "Doca", people: 0, occupied: false },
    ]);
    expect(st.window.zones.get("z1")).toMatchObject({ active: 2, peak: 1 }); // rodada LOST não conta presença
  });

  it("re-associação devolve o MESMO id ao payload (salto moderado não vira track novo) e registra a métrica", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.2, 0.8)], 0);
    pipeline.processRound(st, [person(0.25, 0.8)], 500); // v = 1e-4/ms
    const id = emittedTracks(1)[0].id;
    pipeline.processRound(st, [], 1000);
    pipeline.processRound(st, [], 1500); // LOST → payload vazio (sem rastro)
    expect(emittedTracks(3)).toEqual([]);
    pipeline.processRound(st, [person(0.3, 0.8)], 2500); // volta aquém do previsto, dentro do raio
    expect(emittedTracks(4)).toHaveLength(1);
    expect(emittedTracks(4)[0].id).toBe(id); // identidade sobreviveu ao salto
    expect(st.detsLog[st.detsLog.length - 1].r).toBe(1); // delta de re-associação → reassoc1m
  });
});

describe("emitCoasting — re-emissão no skip do gate (C1 da spec de tracking)", () => {
  it("rodada pulada re-emite o ÚLTIMO payload com ts fresco e coasting:true (tracks preservados)", () => {
    const st = makeSt({ zonesAtiv: [{ id: "z1", label: "Doca", x: 0, y: 0, w: 1, h: 1 }] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000); // inferência → snapshot
    pipeline.emitCoasting(st, 2000); // rodada gateada (skip) → re-emissão
    expect(deps.emitTracks).toHaveBeenCalledTimes(2);
    const coasted = deps.emitTracks.mock.calls[1][0];
    expect(coasted.coasting).toBe(true); // flag ADITIVA — nenhum campo removido
    expect(coasted.ts).toBe(2000); // ts ATUALIZADO (o interpolador do front não expira)
    expect(coasted.cameraId).toBe("cam1");
    expect(coasted.tracks).toEqual(deps.emitTracks.mock.calls[0][0].tracks); // último estado congelado
    expect(coasted.zones).toEqual([{ id: "z1", label: "Doca", people: 1, occupied: true }]);
  });

  it("rodada de INFERÊNCIA emite payload normal SEM campo coasting", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(deps.emitTracks.mock.calls[0][0]).not.toHaveProperty("coasting");
  });

  it("sem snapshot (nunca inferiu com espectador) o skip não emite nada", () => {
    const st = makeSt();
    pipeline.emitCoasting(st, 1000);
    expect(deps.emitTracks).not.toHaveBeenCalled();
  });

  it("sem espectador no momento do skip não gasta banda (hasViewers=false)", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.5, 0.8)], 1000); // snapshot existe
    deps.hasViewers.mockReturnValue(false);
    pipeline.emitCoasting(st, 2000);
    expect(deps.emitTracks).toHaveBeenCalledTimes(1); // só a inferência original
  });

  it("inferência SEM espectador INVALIDA o snapshot — coasting nunca re-emite estado velho", () => {
    const st = makeSt();
    pipeline.processRound(st, [person(0.5, 0.8)], 1000); // snapshot da rodada 1
    deps.hasViewers.mockReturnValue(false);
    pipeline.processRound(st, [], 2000); // inferiu sem espectador → tracks mudaram, snapshot morre
    deps.hasViewers.mockReturnValue(true);
    pipeline.emitCoasting(st, 3000);
    expect(deps.emitTracks).toHaveBeenCalledTimes(1); // nada re-emitido (payload de 1000 seria mentira)
  });
});

describe("processRound — zona proibida (produtor server-side de presença — CA-4)", () => {
  const proib = { id: "p1", label: "Área Restrita", modo: "proibida", presencaAlertMs: 10_000, x: 0, y: 0, w: 1, h: 1 };

  it("pessoa sustentada ≥ dwell dispara raiseAlarm UMA vez com o payload estruturado", () => {
    const st = makeSt({ zonesProib: [proib] });
    // Observações esparsas (0/6s/12s) — como o gate de movimento entrega (probe ≤6s):
    // o dwell conta do INÍCIO da permanência, rodada pulada não reseta.
    pipeline.processRound(st, [person(0.5, 0.8)], 0);
    pipeline.processRound(st, [person(0.5, 0.8)], 6000);
    expect(deps.raiseAlarm).not.toHaveBeenCalled(); // 6s < 10s
    pipeline.processRound(st, [person(0.5, 0.8)], 12_000); // 12s ≥ 10s → VIOLADA
    expect(deps.raiseAlarm).toHaveBeenCalledTimes(1);
    expect(deps.raiseAlarm.mock.calls[0][0]).toEqual({
      text: "⚠ Câmera 1: presença em área proibida (Área Restrita) há 12s",
      ts: 12_000,
      cameraId: "cam1",
      cameraLabel: "Câmera 1",
      zona: "Área Restrita",
      tipo: "presenca",
    });
    pipeline.processRound(st, [person(0.5, 0.8)], 20_000); // segue lá → MESMO evento, sem re-alerta
    expect(deps.raiseAlarm).toHaveBeenCalledTimes(1);
  });

  it("travessia curta (< dwell) não alerta — o contador reseta na saída", () => {
    const st = makeSt({ zonesProib: [proib] });
    pipeline.processRound(st, [person(0.5, 0.8)], 0);
    pipeline.processRound(st, [person(0.5, 0.8)], 4000); // 4s < 10s
    pipeline.processRound(st, [], 6000); // 1ª sem det: graça LOST ainda conta (6s < 10s, sem alerta)
    pipeline.processRound(st, [], 7000); // 2ª sem det: LOST → 0 pessoas → contador RESETA
    pipeline.processRound(st, [person(0.5, 0.8)], 8000); // voltou — dwell recomeça do zero
    expect(deps.raiseAlarm).not.toHaveBeenCalled();
  });
});

describe("processRound — zonesProibidas no payload (contrato ADITIVO — o canvas acende VIOLADA)", () => {
  const proib = { id: "p1", label: "Área Restrita", modo: "proibida", presencaAlertMs: 10_000, x: 0, y: 0, w: 1, h: 1 };
  const lastPayload = () => deps.emitTracks.mock.calls.at(-1)[0];

  it("ARMADA (permanência aquém do dwell) projeta presenca:false COM a contagem — não é people>0 cru", () => {
    const st = makeSt({ zonesProib: [proib] });
    pipeline.processRound(st, [person(0.5, 0.8)], 0); // 0s < 10s — máquina segue armada
    expect(lastPayload().zonesProibidas).toEqual([{ id: "p1", label: "Área Restrita", presenca: false, people: 1 }]);
    expect(deps.raiseAlarm).not.toHaveBeenCalled();
  });

  it("VIOLADA (≥ dwell) projeta presenca:true; saída dentro da histerese SEGUE acesa com people:0", () => {
    const st = makeSt({ zonesProib: [proib] });
    pipeline.processRound(st, [person(0.5, 0.8)], 0);
    pipeline.processRound(st, [person(0.5, 0.8)], 12_000); // 12s ≥ 10s → VIOLADA
    expect(lastPayload().zonesProibidas).toEqual([{ id: "p1", label: "Área Restrita", presenca: true, people: 1 }]);
    pipeline.processRound(st, [], 13_000); // 1ª sem det: graça LOST — track ainda emitido (people 1)
    pipeline.processRound(st, [], 14_000); // 2ª: LOST → 0 pessoas, 2s < off-delay 5s → segue VIOLADA
    expect(lastPayload().zonesProibidas).toEqual([{ id: "p1", label: "Área Restrita", presenca: true, people: 0 }]);
  });

  it("coasting re-emite zonesProibidas com o estado da ÚLTIMA inferência (semântica C1)", () => {
    const st = makeSt({ zonesProib: [proib] });
    pipeline.processRound(st, [person(0.5, 0.8)], 0);
    pipeline.processRound(st, [person(0.5, 0.8)], 12_000); // VIOLADA na última inferência
    pipeline.emitCoasting(st, 15_000); // rodada pulada pelo gate → snapshot congelado
    const coasted = lastPayload();
    expect(coasted.coasting).toBe(true);
    expect(coasted.zonesProibidas).toEqual([{ id: "p1", label: "Área Restrita", presenca: true, people: 1 }]);
  });

  it("zona removida (camcfg-updated kind:'zones') some do payload na inferência seguinte", () => {
    const st = makeSt({ zonesProib: [proib] });
    pipeline.processRound(st, [person(0.5, 0.8)], 0);
    expect(lastPayload().zonesProibidas).toHaveLength(1);
    st.zonesProib = []; // recarga: a zona saiu da config…
    st.lastTracks = null; // …e o engine invalida o snapshot (coasting não vaza a geometria antiga)
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(lastPayload().zonesProibidas).toEqual([]);
  });
});

describe("processRound — contagem de linha → ingest flow (contrato do relatório)", () => {
  // linha vertical em x=0.5 orientada p/ que esquerda→direita conte "in"
  const wire = { id: "w1", a: { x: 0.5, y: 1 }, b: { x: 0.5, y: 0 } };

  it("travessia sustentada (histerese 2 rodadas) emite ingest('flow','cross', shape exato)", () => {
    const st = makeSt({ tripwires: [wire] });
    // bbox largo (w=0.3) p/ o passo manter IoU ≥ 0.25 entre rodadas (mesmo id de track)
    pipeline.processRound(st, [person(0.4, 0.8, 0.9, 0.3)], 1000); // ancora à esquerda
    pipeline.processRound(st, [person(0.55, 0.8, 0.9, 0.3)], 2000); // cruza → pendência (1ª sustentação)
    expect(deps.ingest).not.toHaveBeenCalled(); // histerese ainda não confirmou
    pipeline.processRound(st, [person(0.6, 0.8, 0.9, 0.3)], 3000); // sustenta o lado novo → CONTA
    expect(deps.ingest).toHaveBeenCalledTimes(1);
    const [kind, sub, payload] = deps.ingest.mock.calls[0];
    expect(kind).toBe("flow");
    expect(sub).toBe("cross");
    expect(payload).toEqual({
      cameraId: "cam1",
      cameraLabel: "Câmera 1", // veio do cameraLabelOf injetado
      tripwireId: "w1",
      dir: "in",
      ts: expect.any(Number),
      shift: shiftOf(new Date(payload.ts).getHours()),
    });
  });

  it("sem cruzamento → nenhum ingest de flow", () => {
    const st = makeSt({ tripwires: [wire] });
    pipeline.processRound(st, [person(0.3, 0.8)], 1000);
    pipeline.processRound(st, [person(0.32, 0.8)], 2000); // não cruza
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});

describe("processRound — zonas de atividade (janela + overlay)", () => {
  const zone = { id: "z1", label: "Doca", atividade: "Separação", x: 0, y: 0, w: 1, h: 1 };

  it("pessoa na zona: acumula janela (frames/active/peak) e atribui no overlay", () => {
    const st = makeSt({ zonesAtiv: [zone] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    expect(st.window.frames).toBe(1);
    expect(st.window.zones.get("z1")).toEqual({ label: "Doca", atividade: "Separação", active: 1, peak: 1 });
    const payload = deps.emitTracks.mock.calls[0][0];
    expect(payload.tracks[0].zone).toBe("Doca");
    expect(payload.zones).toEqual([{ id: "z1", label: "Doca", people: 1, occupied: true }]);
  });

  it("rodada sem pessoa conta frame da janela (activePct honesto) sem ativar a zona", () => {
    const st = makeSt({ zonesAtiv: [zone] });
    pipeline.processRound(st, [], 1000);
    expect(st.window.frames).toBe(1);
    expect(st.window.zones.get("z1")).toEqual({ label: "Doca", atividade: "Separação", active: 0, peak: 0 });
  });

  it("track em OCLUSÃO (dentro do TTL) segue contando na zona — rodada sem det não zera presença", () => {
    const st = makeSt({ zonesAtiv: [zone] });
    pipeline.processRound(st, [person(0.5, 0.8)], 1000);
    pipeline.processRound(st, [], 2000); // sem det: o track vive pelo TTL e segue atribuído
    expect(st.window.frames).toBe(2);
    expect(st.window.zones.get("z1")).toMatchObject({ active: 2, peak: 1 });
  });

  it("pico (peak) guarda o MÁXIMO de pessoas simultâneas da janela", () => {
    const st = makeSt({ zonesAtiv: [zone] });
    pipeline.processRound(st, [person(0.3, 0.8), person(0.7, 0.8)], 1000); // 2 pessoas
    pipeline.processRound(st, [person(0.3, 0.8)], 2000); // 1 pessoa
    expect(st.window.zones.get("z1")).toMatchObject({ active: 2, peak: 2 });
  });
});

describe("processRound — logs rolantes (janela 60s)", () => {
  it("poda rounds/detsLog além de 60s", () => {
    const st = makeSt({ rounds: [1000], detsLog: [{ t: 1000, n: 1, x: 0, a: 0 }] });
    pipeline.processRound(st, [], 70_000); // 1000 < 70000-60000 → sai
    expect(st.rounds).toEqual([70_000]);
    expect(st.detsLog).toHaveLength(1);
    expect(st.detsLog[0].t).toBe(70_000);
  });
});

describe("flushWindows — ingest 'ativ'/'samples' (contrato do relatório)", () => {
  it("janela acumulada vira samples com o shape exato e a janela reinicia", () => {
    const st = makeSt();
    st.window = {
      frames: 5,
      zones: new Map([["z1", { label: "Doca", atividade: "Separação", active: 3, peak: 2 }]]),
    };
    pipeline.flushWindows(new Map([["cam1", st]]));
    expect(deps.ingest).toHaveBeenCalledWith("ativ", "samples", {
      cameraId: "cam1",
      samples: [
        {
          zoneId: "z1",
          label: "Doca",
          atividade: "Separação",
          idleMs: 0, // ociosidade por motion é do front — contrato
          frames: 5,
          activeFrames: 3,
          people: 2, // pico da janela → people_peak
        },
      ],
    });
    expect(st.window.frames).toBe(0);
    expect(st.window.zones.size).toBe(0);
  });

  it("janela vazia (sem frames ou sem zonas) NÃO gera ingest", () => {
    const a = makeSt(); // frames 0
    const b = makeSt();
    b.window = { frames: 3, zones: new Map() }; // frames mas sem zona
    pipeline.flushWindows(new Map([["a", a], ["b", b]]));
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});

describe("shiftOf — turno da fábrica (duplicação declarada com src/report/calc/common.ts)", () => {
  it("6-13 Manhã · 14-21 Tarde · 22-5 Noite", () => {
    expect(shiftOf(6)).toBe("Manhã");
    expect(shiftOf(13)).toBe("Manhã");
    expect(shiftOf(14)).toBe("Tarde");
    expect(shiftOf(21)).toBe("Tarde");
    expect(shiftOf(22)).toBe("Noite");
    expect(shiftOf(5)).toBe("Noite");
  });
});
