// Testes da histerese de presença de zona — os critérios de aceite da spec-zona-trabalho-ble.md
// (CA-1 decisão estável, CA-2 honestidade) virando gate, como manda a casa.
import { describe, expect, it } from "vitest";
import {
  initZoneTrack,
  readZonePresence,
  updateZoneTrack,
  ZONE_PRESENCE_DEFAULTS,
  type ZoneConfidence,
  type ZoneTrackState,
} from "./zone-presence";

/** Aplica uma sequência de observações espaçadas de 2 s (o poll real da Planta BLE). */
function feed(
  s: ZoneTrackState,
  seq: Array<{ zona: string | null; conf: ZoneConfidence }>,
  t0 = 1_000,
  stepMs = 2_000,
): { state: ZoneTrackState; lastTs: number } {
  let st = s;
  let ts = t0;
  for (const o of seq) {
    st = updateZoneTrack(st, { ts, zona: o.zona, confianca: o.conf }, ZONE_PRESENCE_DEFAULTS);
    ts += stepMs;
  }
  return { state: st, lastTs: ts - stepMs };
}

const A = (conf: ZoneConfidence = "alta") => ({ zona: "Mesa 1", conf });
const B = (conf: ZoneConfidence = "alta") => ({ zona: "Doca", conf });
const NADA = (conf: ZoneConfidence = "nenhuma") => ({ zona: null, conf });

describe("zone-presence — histerese de entrada (CA-1)", () => {
  it("estado inicial é fora", () => {
    const p = readZonePresence(initZoneTrack(1_000), 1_000);
    expect(p.estado).toBe("fora");
    expect(p.zona).toBeNull();
  });

  it("NÃO entra com 2 polls; entra com 3 consecutivos da mesma zona", () => {
    const dois = feed(initZoneTrack(0), [A(), A()]);
    expect(readZonePresence(dois.state, dois.lastTs).estado).toBe("fora");

    const tres = feed(initZoneTrack(0), [A(), A(), A()]);
    const p = readZonePresence(tres.state, tres.lastTs);
    expect(p.estado).toBe("na-zona");
    expect(p.zona).toBe("Mesa 1");
  });

  it("`desde` é a PRIMEIRA observação da sequência que confirmou (o 'há N min' nasce honesto)", () => {
    const r = feed(initZoneTrack(0), [A(), A(), A()], 1_000, 2_000); // obs em 1000, 3000, 5000
    const p = readZonePresence(r.state, r.lastTs);
    expect(p.desde).toBe(1_000);
  });

  it("streak precisa ser CONSECUTIVA da mesma zona (A, B, A, A não entra em nenhuma)", () => {
    const r = feed(initZoneTrack(0), [A(), B(), A(), A()]);
    expect(readZonePresence(r.state, r.lastTs).estado).toBe("fora");
  });

  it("o mesmo instante reamostrado não aumenta a streak", () => {
    let state = initZoneTrack(999);
    const observation = { ts: 1_000, zona: "Mesa 1", confianca: "alta" as const };
    state = updateZoneTrack(state, observation);
    state = updateZoneTrack(state, observation);
    state = updateZoneTrack(state, observation);
    expect(state.streak).toBe(1);
    expect(readZonePresence(state, 1_000).estado).toBe("fora");
  });

  it("medição fora de ordem é ignorada", () => {
    const state = updateZoneTrack(initZoneTrack(999), {
      ts: 2_000,
      zona: "Mesa 1",
      confianca: "alta",
    });
    expect(
      updateZoneTrack(state, { ts: 1_500, zona: "Doca", confianca: "alta" }),
    ).toBe(state);
  });
});

describe("zone-presence — honestidade (CA-2)", () => {
  it("confiança baixa NUNCA conta para entrar, mesmo sustentada", () => {
    const r = feed(
      initZoneTrack(0),
      Array.from({ length: 10 }, () => A("baixa")),
    );
    expect(readZonePresence(r.state, r.lastTs).estado).toBe("fora");
  });

  it("confiança media qualifica (é o piso de entrada)", () => {
    const r = feed(initZoneTrack(0), [A("media"), A("media"), A("media")]);
    expect(readZonePresence(r.state, r.lastTs).estado).toBe("na-zona");
  });
});

describe("zone-presence — estabilidade e saída", () => {
  it("1 poll divergente NÃO derruba a zona confirmada", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()]);
    const r = feed(conf.state, [NADA(), A()], conf.lastTs + 2_000);
    const p = readZonePresence(r.state, r.lastTs);
    expect(p.estado).toBe("na-zona");
    expect(p.zona).toBe("Mesa 1");
  });

  it("sai para 'fora' após 3 polls sem qualificação", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()]);
    const r = feed(conf.state, [NADA(), NADA("baixa"), NADA()], conf.lastTs + 2_000);
    const p = readZonePresence(r.state, r.lastTs);
    expect(p.estado).toBe("fora");
    expect(p.zona).toBeNull();
  });

  it("troca de zona A→B após 3 polls consecutivos de B, com `desde` da 1ª obs de B", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()], 1_000); // termina em ts=5000
    const r = feed(conf.state, [B(), B(), B()], 7_000);
    const p = readZonePresence(r.state, r.lastTs);
    expect(p.estado).toBe("na-zona");
    expect(p.zona).toBe("Doca");
    expect(p.desde).toBe(7_000);
  });

  it("reforço da zona confirmada zera a divergência em curso (B, B, A, B, B não troca)", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()]);
    const r = feed(conf.state, [B(), B(), A(), B(), B()], conf.lastTs + 2_000);
    const p = readZonePresence(r.state, r.lastTs);
    expect(p.zona).toBe("Mesa 1");
  });
});

describe("zone-presence — TTL de incerto", () => {
  it("sem observações além do TTL → 'incerto', preservando a última zona conhecida", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()]);
    const depois = conf.lastTs + ZONE_PRESENCE_DEFAULTS.ttlIncertoMs + 1;
    const p = readZonePresence(conf.state, depois);
    expect(p.estado).toBe("incerto");
    expect(p.zona).toBe("Mesa 1"); // última informação conhecida, não apagada
  });

  it("observação nova qualificada retoma o estado sem re-histerese (a zona seguia confirmada)", () => {
    const conf = feed(initZoneTrack(0), [A(), A(), A()]);
    const tsVolta = conf.lastTs + ZONE_PRESENCE_DEFAULTS.ttlIncertoMs + 5_000;
    const st = updateZoneTrack(conf.state, { ts: tsVolta, zona: "Mesa 1", confianca: "alta" });
    const p = readZonePresence(st, tsVolta);
    expect(p.estado).toBe("na-zona");
    expect(p.zona).toBe("Mesa 1");
  });
});
