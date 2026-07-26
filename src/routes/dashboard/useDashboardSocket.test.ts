// Testes do mapeamento PURO fio→domínio do evento `analysis-tracks` (toHubAnalysis). O bug que
// motivou o arquivo é de classe "consumidor descartando campo calado": o handler remontava o
// objeto à mão e comia `coasting` e `zonesProibidas` — o hub emitia, o cliente nunca via, e a
// zona proibida NUNCA acendia VIOLADA por este caminho. O 1º teste ("payload completo") é o
// que impede a reincidência: se o hub ganhar campo e o mapeamento não passar adiante, quebra.
import { describe, it, expect } from "vitest";
import { toHubAnalysis, type AnalysisTracksPayload } from "./useDashboardSocket";

const RECV = 1_700_000_000_000;

// Payload como o server/analysis/pipeline.js emite HOJE (contrato pinado da Onda B).
const FULL: AnalysisTracksPayload = {
  cameraId: "cam-1",
  ts: 42, // o ts do HUB — de propósito absurdo: o mapeamento tem de ignorá-lo
  latencyMs: 380,
  tracks: [{ id: 7, bbox: [0.1, 0.2, 0.3, 0.4], cx: 0.25, cy: 0.4, zone: "z1", score: 0.8, vx: 0.01, vy: -0.02 }],
  zones: [{ id: "z1", label: "Doca", people: 2, occupied: true }],
  coasting: true,
  zonesProibidas: [{ id: "p1", label: "Área Restrita", people: 1, presenca: true }],
};

describe("toHubAnalysis — payload completo do hub não perde NENHUM campo", () => {
  it("mapeia campo a campo (e o único que muda é o ts, que vira o de RECEPÇÃO)", () => {
    expect(toHubAnalysis(FULL, RECV)).toEqual({
      ts: RECV,
      latencyMs: 380,
      tracks: FULL.tracks,
      zones: FULL.zones,
      coasting: true,
      zonesProibidas: [{ id: "p1", label: "Área Restrita", people: 1, presenca: true }],
    });
  });

  it("nenhuma chave do fio fica de fora (sentinela da classe do bug: campo novo do hub, silêncio no cliente)", () => {
    const out = toHubAnalysis(FULL, RECV) as Record<string, unknown>;
    for (const k of Object.keys(FULL)) {
      if (k === "cameraId" || k === "ts") continue; // roteamento / relógio local (ver abaixo)
      expect(Object.keys(out)).toContain(k);
    }
  });

  it("ts é o recvT LOCAL, não o do hub (gate de stale imune a skew hub×cliente)", () => {
    expect(toHubAnalysis({ cameraId: "c", ts: 42 }, RECV).ts).toBe(RECV);
  });
});

describe("toHubAnalysis — coasting (re-emissão de rodada pulada ≠ observação nova)", () => {
  it("passa adiante o true das re-emissões do gate de movimento", () => {
    expect(toHubAnalysis({ cameraId: "c", coasting: true }, RECV).coasting).toBe(true);
  });

  it("ausente (hub antigo/rodada normal) → false, nunca undefined", () => {
    expect(toHubAnalysis({ cameraId: "c" }, RECV).coasting).toBe(false);
  });

  it("valor torto no fio não vira coasting (só o booleano true conta)", () => {
    expect(toHubAnalysis({ cameraId: "c", coasting: "true" }, RECV).coasting).toBe(false);
    expect(toHubAnalysis({ cameraId: "c", coasting: 1 }, RECV).coasting).toBe(false);
  });
});

describe("toHubAnalysis — zonesProibidas (o fio que acende VIOLADA no canvas)", () => {
  it("preserva id/label/people/presenca de cada zona", () => {
    const out = toHubAnalysis(
      {
        cameraId: "c",
        zonesProibidas: [
          { id: "p1", label: "Restrita", people: 3, presenca: true },
          { id: "p2", label: "Elétrica", people: 0, presenca: false },
        ],
      },
      RECV,
    );
    expect(out.zonesProibidas).toEqual([
      { id: "p1", label: "Restrita", people: 3, presenca: true },
      { id: "p2", label: "Elétrica", people: 0, presenca: false },
    ]);
  });

  it("AUSENTE ≠ VAZIA: hub antigo (sem o campo) → undefined; câmera sem zona proibida → []", () => {
    expect(toHubAnalysis({ cameraId: "c" }, RECV).zonesProibidas).toBeUndefined();
    expect(toHubAnalysis({ cameraId: "c", zonesProibidas: [] }, RECV).zonesProibidas).toEqual([]);
  });

  it("descarta entrada sem id string (não casa com zona nenhuma no desenho) e mantém as boas", () => {
    const out = toHubAnalysis(
      {
        cameraId: "c",
        zonesProibidas: [
          { label: "sem id", people: 1, presenca: true },
          { id: 7, label: "id numérico", people: 1, presenca: true },
          null,
          "p1",
          { id: "ok", label: "Boa", people: 1, presenca: true },
        ],
      },
      RECV,
    );
    expect(out.zonesProibidas).toEqual([{ id: "ok", label: "Boa", people: 1, presenca: true }]);
  });

  it("campos tortos degradam para default seguro (label '', people 0) sem derrubar a zona", () => {
    const out = toHubAnalysis(
      { cameraId: "c", zonesProibidas: [{ id: "p1", label: 3, people: "muitos", presenca: false }] },
      RECV,
    );
    expect(out.zonesProibidas).toEqual([{ id: "p1", label: "", people: 0, presenca: false }]);
  });

  it("people negativo (impossível) vira 0", () => {
    const out = toHubAnalysis({ cameraId: "c", zonesProibidas: [{ id: "p1", people: -2 }] }, RECV);
    expect(out.zonesProibidas?.[0]?.people).toBe(0);
  });

  it("presenca só é true no booleano true ou na string legada 'VIOLADA' (alarme real não some calado)", () => {
    const zs = [
      { id: "a", presenca: true },
      { id: "b", presenca: "VIOLADA" },
      { id: "c", presenca: "ARMADA" },
      { id: "d" },
    ];
    const out = toHubAnalysis({ cameraId: "c", zonesProibidas: zs }, RECV);
    expect(out.zonesProibidas?.map((z) => z.presenca)).toEqual([true, true, false, false]);
  });

  it("não-lista (objeto/string) é ignorada — degrada para ausente, não quebra", () => {
    expect(toHubAnalysis({ cameraId: "c", zonesProibidas: { p1: true } }, RECV).zonesProibidas).toBeUndefined();
    expect(toHubAnalysis({ cameraId: "c", zonesProibidas: "p1" }, RECV).zonesProibidas).toBeUndefined();
  });
});

describe("toHubAnalysis — defensivo nos campos antigos (comportamento preservado)", () => {
  it("payload vazio: listas vazias, latência 0 e nenhum campo undefined nas obrigatórias", () => {
    expect(toHubAnalysis({ cameraId: "c" }, RECV)).toEqual({
      ts: RECV,
      tracks: [],
      zones: [],
      latencyMs: 0,
      coasting: false,
    });
  });

  it("tracks/zones de tipo errado viram lista vazia (tile sem caixas, nunca quebra)", () => {
    const out = toHubAnalysis({ cameraId: "c", tracks: "nope", zones: 12 }, RECV);
    expect(out.tracks).toEqual([]);
    expect(out.zones).toEqual([]);
  });

  it("latencyMs ausente/negativo/não-numérico vira 0 (o interpolador não aceita idade absurda)", () => {
    expect(toHubAnalysis({ cameraId: "c" }, RECV).latencyMs).toBe(0);
    expect(toHubAnalysis({ cameraId: "c", latencyMs: -5 }, RECV).latencyMs).toBe(0);
    expect(toHubAnalysis({ cameraId: "c", latencyMs: "380" }, RECV).latencyMs).toBe(0);
    expect(toHubAnalysis({ cameraId: "c", latencyMs: 380 }, RECV).latencyMs).toBe(380);
  });

  it("tracks passam INTACTOS (o mapeamento não reescreve o que o motor calculou)", () => {
    const tracks = FULL.tracks as unknown[];
    expect(toHubAnalysis({ cameraId: "c", tracks }, RECV).tracks).toEqual(tracks);
  });
});
