// Gates do auto-cadastro RTMP: a linha REAL do go2rtc dispara; nomes fora do contrato, canais já
// cadastrados, retries dentro do throttle e estouro do CAP não disparam. Knob desliga tudo.
import { describe, it, expect, beforeEach } from "vitest";
import { createAutoEnroll } from "./rtmp-auto-enroll";

// A linha exatamente como o hub re-loga o stderr do sidecar (journal de 2026-07-16).
const line = (name) =>
  `[go2rtc] 12:22:08.358 ERR github.com/AlexxIT/go2rtc/internal/rtmp/rtmp.go:61 > error="stream not found: ${name}"`;

function makeHarness(overrides = {}) {
  const registered = [];
  const existing = new Set(overrides.existing ?? []);
  const auto = createAutoEnroll({
    enabled: overrides.enabled ?? true,
    hasChannel: (n) => existing.has(n),
    register: (n) => registered.push(n),
    max: overrides.max ?? 32,
    throttleMs: overrides.throttleMs ?? 60_000,
    log: () => {},
  });
  return { auto, registered, existing };
}

describe("rtmp-auto-enroll", () => {
  let h;
  beforeEach(() => {
    h = makeHarness();
  });

  it("cadastra o canal da linha real do go2rtc", () => {
    h.auto.onLogLine(line("dydentro_cam01"), 1_000);
    expect(h.registered).toEqual(["dydentro_cam01"]);
  });

  it("linhas sem o padrão não disparam nada", () => {
    h.auto.onLogLine("[go2rtc] 12:00:00.000 INF [rtsp] listen addr=:8554", 1_000);
    h.auto.onLogLine("[analysis:cam-x] pull go2rtc falhou (1): timeout", 2_000);
    expect(h.registered).toEqual([]);
  });

  it("nome fora do contrato ([A-Za-z0-9_-]{1,32}) é ignorado", () => {
    h.auto.onLogLine(line("a/b"), 1_000); // path — o regex de captura nem casa com '/'
    h.auto.onLogLine(line("x".repeat(33)), 2_000); // longo demais
    h.auto.onLogLine(line("canal.com.ponto"), 3_000); // '.' capturado, mas reprovado na validação
    expect(h.registered).toEqual([]);
  });

  it("canal já cadastrado não re-registra (corrida de regeneração do yaml)", () => {
    h = makeHarness({ existing: ["live"] });
    h.auto.onLogLine(line("live"), 1_000);
    expect(h.registered).toEqual([]);
  });

  it("o retry de ~5s do publisher não martela: throttle por canal", () => {
    h.auto.onLogLine(line("cam_a"), 1_000);
    h.auto.onLogLine(line("cam_a"), 6_000); // dentro do throttle de 60s
    h.auto.onLogLine(line("cam_a"), 55_000);
    expect(h.registered).toEqual(["cam_a"]);
    h.auto.onLogLine(line("cam_a"), 62_000); // fora do throttle; hasChannel ainda false no harness
    expect(h.registered).toEqual(["cam_a", "cam_a"]); // re-tentativa legítima (cadastro falhou antes)
  });

  it("CAP global segura scanner na porta", () => {
    h = makeHarness({ max: 2 });
    h.auto.onLogLine(line("c1"), 1_000);
    h.auto.onLogLine(line("c2"), 2_000);
    h.auto.onLogLine(line("c3"), 3_000);
    expect(h.registered).toEqual(["c1", "c2"]);
  });

  it("RTMP_AUTO_ENROLL=0 (enabled:false) desliga tudo", () => {
    h = makeHarness({ enabled: false });
    h.auto.onLogLine(line("qualquer"), 1_000);
    expect(h.registered).toEqual([]);
  });
});
