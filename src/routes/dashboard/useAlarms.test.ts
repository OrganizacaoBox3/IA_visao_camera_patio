// Gate da notificação interruptiva de ALARME CRÍTICO (ADR-004 · ISA-18.2/EEMUA-191).
// Bug medido que originou o arquivo: `alarm-event` crítico só empilhava na fila — o único realce
// era o contador do botão, que pode estar fora do campo de visão. Uma zona restrita violada (o
// alarme mais grave do produto, gerado 24/7 pelo motor do hub) chegava como um NÚMERO MUDO.
//
// O que estes testes travam:
//   1. crítico  ⇒ 1 toast (e o drawer abre);
//   2. advisory ⇒ NENHUM toast (EEMUA-191: alarme que sempre toca deixa de ser alarme);
//   3. rajada de N críticos ⇒ TETO de 2 toasts (o 1º na hora + 1 resumo), nunca N.
//
// Sem DOM: o projeto não tem jsdom/@testing-library (vitest roda lógica pura). O caminho testado é
// EXATAMENTE o do hook — `notifyCriticalArrivals(prev, next, burst)` é o corpo do setter que o
// useDashboardSocket chama ao receber `alarm-event`. O que NÃO é coberto aqui é só a fiação React
// (o setter embrulhado e o `setAlarmsOpen`), que é declaração de 3 linhas no useAlarms.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCriticalBurst,
  criticalArrivals,
  criticalToastText,
  notifyCriticalArrivals,
  CRITICAL_BURST_MS,
} from "./useAlarms";
import type { AlarmEvent } from "../../api";

function ev(over: Partial<AlarmEvent> = {}): AlarmEvent {
  return {
    id: "a1",
    ts: 1_700_000_000_000,
    cameraId: "cam-1",
    cameraLabel: "Doca 3",
    zona: "Área Restrita",
    tipo: "presenca",
    priority: "critical",
    text: "⚠ Doca 3: presença em área proibida (Área Restrita) há 12s",
    state: "new",
    ...over,
  };
}

// Banco de ensaio: o toast + o "abrir o drawer" como spies, e o agrupador real.
function bench(windowMs = CRITICAL_BURST_MS) {
  const toast = vi.fn();
  const onCritical = vi.fn();
  const burst = createCriticalBurst({ toast, onCritical, windowMs });
  return { toast, onCritical, burst };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("alarm-event CRÍTICO interrompe (a metade que estava faltando)", () => {
  it("um crítico novo ⇒ toast chamado 1× com tom de alarme e o drawer abre", () => {
    const { toast, onCritical, burst } = bench();
    const a = ev();
    notifyCriticalArrivals([], [a], burst); // = o que o socket faz: [a, ...prev]

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Alarme crítico"), "alert");
    expect(toast.mock.calls[0][0]).toContain("presença em área proibida");
    expect(onCritical).toHaveBeenCalledTimes(1); // leva o operador à fila acionável
  });

  it("o tom é `alert` — o token crítico que o design system já tem (going-gray, sem cor nova)", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev()], burst);
    expect(toast.mock.calls[0][1]).toBe("alert");
  });

  it("nada mais dispara depois da janela: o mesmo alarme reentrando não re-toasta (idempotente por id)", () => {
    const { toast, burst } = bench();
    const a = ev();
    notifyCriticalArrivals([], [a], burst);
    vi.advanceTimersByTime(CRITICAL_BURST_MS * 3);
    // re-render/reemissão do MESMO id (o StrictMode do React 19 invoca o updater 2×)
    notifyCriticalArrivals([], [a], burst);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("o que NÃO interrompe (EEMUA-191: alarme que sempre toca deixa de ser alarme)", () => {
  it("advisory ⇒ toast NÃO é chamado", () => {
    const { toast, onCritical, burst } = bench();
    notifyCriticalArrivals([], [ev({ priority: "advisory" })], burst);
    expect(toast).not.toHaveBeenCalled();
    expect(onCritical).not.toHaveBeenCalled();
  });

  it("high ⇒ toast NÃO é chamado (crítico é reservado; o realce de `high` é o contador)", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev({ priority: "high" })], burst);
    expect(toast).not.toHaveBeenCalled();
  });

  it("crítico JÁ reconhecido em outro posto (`alarm-update`) não interrompe ninguém", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev({ state: "acknowledged" })], burst);
    notifyCriticalArrivals([], [ev({ id: "a2", state: "forwarded" })], burst);
    expect(toast).not.toHaveBeenCalled();
  });

  it("crítico que JÁ estava na lista (mudou de estado, não chegou) não interrompe", () => {
    const { toast, burst } = bench();
    const a = ev();
    notifyCriticalArrivals([a], [{ ...a, ackBy: "op" }], burst);
    expect(toast).not.toHaveBeenCalled();
  });

  it("mistura: só o crítico da leva interrompe, e uma vez só", () => {
    const { toast, burst } = bench();
    const next = [ev({ id: "c1" }), ev({ id: "a1", priority: "advisory" }), ev({ id: "h1", priority: "high" })];
    notifyCriticalArrivals([], next, burst);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("Alarme crítico");
  });
});

describe("rajada entre câmeras — agrupada, nunca N toasts empilhados", () => {
  // Por que o cliente agrupa: a supressão de inundação do servidor (server/alarm/flood.js) conta a
  // janela POR cameraId, então 5 câmeras violando juntas produzem 5 eventos legítimos. Agrupar é
  // decisão de APRESENTAÇÃO — nenhum alarme some (todos seguem na fila/drawer).
  it("5 críticos ao mesmo tempo ⇒ 2 toasts: o 1º na hora + 1 resumo no fim da janela", () => {
    const { toast, burst } = bench();
    const lote = [1, 2, 3, 4, 5].map((i) => ev({ id: `c${i}`, cameraId: `cam-${i}` }));
    notifyCriticalArrivals([], lote, burst);

    // latência ZERO no primeiro: o alarme mais grave não espera janela nenhuma
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("Alarme crítico");

    vi.advanceTimersByTime(CRITICAL_BURST_MS);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith("Mais 4 alarmes críticos na fila.", "alert");
  });

  it("5 críticos em 5 eventos separados dentro da janela ⇒ mesmos 2 toasts", () => {
    const { toast, burst } = bench();
    let prev: AlarmEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      const a = ev({ id: `c${i}`, cameraId: `cam-${i}` });
      const next = [a, ...prev];
      notifyCriticalArrivals(prev, next, burst);
      prev = next;
      vi.advanceTimersByTime(100); // rajada real: ~100 ms entre eventos
    }
    expect(toast).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CRITICAL_BURST_MS);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith("Mais 4 alarmes críticos na fila.", "alert");
  });

  it("o resumo pluraliza (2 alarmes na rajada ⇒ 'Mais 1 alarme crítico')", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev({ id: "c1" }), ev({ id: "c2" })], burst);
    vi.advanceTimersByTime(CRITICAL_BURST_MS);
    expect(toast).toHaveBeenLastCalledWith("Mais 1 alarme crítico na fila.", "alert");
  });

  it("TETO provado: 20 críticos numa janela ⇒ ainda 2 toasts (o resumo conta os 19)", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], Array.from({ length: 20 }, (_, i) => ev({ id: `c${i}` })), burst);
    vi.advanceTimersByTime(CRITICAL_BURST_MS * 2);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith("Mais 19 alarmes críticos na fila.", "alert");
  });

  it("janela FECHADA: crítico depois dela volta a falar na hora (não vira silêncio permanente)", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev({ id: "c1" })], burst);
    vi.advanceTimersByTime(CRITICAL_BURST_MS + 1); // janela expira sem represados → sem resumo
    expect(toast).toHaveBeenCalledTimes(1);
    notifyCriticalArrivals([], [ev({ id: "c2" })], burst);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][0]).toContain("Alarme crítico");
  });

  it("dispose (unmount) cancela o resumo pendente e não deixa timer solto", () => {
    const { toast, burst } = bench();
    notifyCriticalArrivals([], [ev({ id: "c1" }), ev({ id: "c2" })], burst);
    burst.dispose();
    vi.advanceTimersByTime(CRITICAL_BURST_MS * 3);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("criticalArrivals — o diff que separa CHEGADA de histórico", () => {
  it("carga inicial não é chegada: nada que já estava em prev volta como novo", () => {
    const hist = [ev({ id: "h1" }), ev({ id: "h2" })];
    expect(criticalArrivals(hist, hist)).toEqual([]);
  });

  it("devolve só os ids inéditos, na ordem em que vieram", () => {
    const prev = [ev({ id: "h1" })];
    const next = [ev({ id: "n2" }), ev({ id: "n1" }), ...prev];
    expect(criticalArrivals(prev, next).map((a) => a.id)).toEqual(["n2", "n1"]);
  });

  it("lista vazia entra e sai vazia (sem alarme, sem trabalho)", () => {
    expect(criticalArrivals([], [])).toEqual([]);
  });
});

describe("criticalToastText — o que o operador lê", () => {
  it("prefixa a prioridade e remove o marcador do servidor (cor sozinha não é informação)", () => {
    expect(criticalToastText(ev())).toBe(
      "Alarme crítico · Doca 3: presença em área proibida (Área Restrita) há 12s",
    );
  });

  it("texto vazio degrada para local · tipo (nunca um toast em branco)", () => {
    expect(criticalToastText(ev({ text: "" }))).toBe("Alarme crítico · Doca 3 · presenca");
  });

  it("sem texto e sem local ainda diz alguma coisa", () => {
    expect(
      criticalToastText(ev({ text: "", cameraLabel: undefined, cameraId: undefined, zona: undefined, tipo: "" })),
    ).toBe("Alarme crítico · sem descrição");
  });

  it("resumo de causa-raiz longo é cortado (o cartão do toast não vira parede; detalhe fica no drawer)", () => {
    const out = criticalToastText(ev({ text: "x".repeat(400) }));
    expect(out.length).toBeLessThanOrEqual("Alarme crítico · ".length + 140);
    expect(out.endsWith("…")).toBe(true);
  });
});
