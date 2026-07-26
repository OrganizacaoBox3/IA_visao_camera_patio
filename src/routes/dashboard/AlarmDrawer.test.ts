// Gate do aviso de "crítico oculto pelos filtros" (AlarmDrawer). Existe por causa da notificação
// interruptiva do ADR-004: o drawer passou a ABRIR SOZINHO quando chega um `alarm-event` crítico —
// se o operador tinha deixado um filtro local ligado, ele abriria VAZIO, e um drawer vazio na cara
// de quem acabou de ser interrompido é falso-OK (o pior modo de falha da doutrina da casa).
// Só a função PURA é testada (o projeto não tem jsdom/@testing-library — sem render de componente).
import { describe, it, expect } from "vitest";
import { hiddenNewCriticalCount } from "./AlarmDrawer";
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
    text: "⚠ Doca 3: presença em área proibida",
    state: "new",
    ...over,
  };
}

describe("hiddenNewCriticalCount — crítico novo que o filtro está escondendo", () => {
  it("sem filtro (tudo visível) ⇒ 0, mesmo com críticos na lista", () => {
    const all = [ev({ id: "c1" }), ev({ id: "c2" })];
    expect(hiddenNewCriticalCount(all, all)).toBe(0);
  });

  it("filtro escondendo 2 críticos novos ⇒ 2", () => {
    const all = [ev({ id: "c1" }), ev({ id: "c2" }), ev({ id: "i1", priority: "advisory" })];
    const visible = all.filter((a) => a.priority === "advisory"); // filtro "Informativo"
    expect(hiddenNewCriticalCount(all, visible)).toBe(2);
  });

  it("só conta CRÍTICO NOVO: high/advisory ocultos e crítico já reconhecido não acendem o aviso", () => {
    const all = [
      ev({ id: "h1", priority: "high" }),
      ev({ id: "i1", priority: "advisory" }),
      ev({ id: "c1", state: "acknowledged" }),
      ev({ id: "c2", state: "forwarded" }),
    ];
    expect(hiddenNewCriticalCount(all, [])).toBe(0);
  });

  it('"limpar reconhecidos" escondendo um crítico RECONHECIDO não acende o aviso (nada a fazer ali)', () => {
    const all = [ev({ id: "c1" }), ev({ id: "c2", state: "acknowledged" })];
    const visible = all.filter((a) => a.state === "new");
    expect(hiddenNewCriticalCount(all, visible)).toBe(0);
  });

  it("lista vazia ⇒ 0 (curto-circuito, sem alocar Set)", () => {
    expect(hiddenNewCriticalCount([], [])).toBe(0);
  });
});
