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
    autoMask: null,
    window: { frames: 0, zones: new Map() },
    rounds: [],
    detsLog: [],
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
    expect(Object.keys(payload).sort()).toEqual(["cameraId", "latencyMs", "tracks", "ts", "zones"]);
    expect(payload.cameraId).toBe("cam1");
    expect(payload.ts).toBe(1000);
    expect(payload.latencyMs).toBe(0); // sem inflightTs (frame não despachado neste unitário) → 0
    expect(Object.keys(payload.tracks[0]).sort()).toEqual(["bbox", "cx", "cy", "id", "score", "vx", "vy", "zone"]);
    expect(payload.tracks[0]).not.toHaveProperty("firstSeen"); // interno do tracker não vaza
    expect(payload.zones).toEqual([{ id: "z1", label: "Doca", people: 1, occupied: true }]);
  });

  it("latencyMs = emissão(now) − ts da CAPTURA do frame despachado (compensação do overlay lag)", () => {
    const st = makeSt();
    st.inflightTs = 700; // dispatchToWorker registrou a captura em t=700
    pipeline.processRound(st, [person(0.5, 0.8)], 1000); // emitido em now=1000
    expect(deps.emitTracks.mock.calls[0][0].latencyMs).toBe(300); // 1000 − 700
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
