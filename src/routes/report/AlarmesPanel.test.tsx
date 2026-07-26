// GATE do bug B3 — TETO INVISÍVEL: o relatório pede 500 alarmes de uma fila com retenção maior e
// calcula KPI/tendência de "últimos 30 dias" em cima do que chegou. Sem declarar o corte, isso é
// subcontagem SILENCIOSA. Aqui trava a cadeia inteira: resposta do hub → meta → aviso na tela.
// Molde da casa: renderToStaticMarkup (sem jsdom) — ver ui/Card.test.tsx.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AlarmsLoadNote } from "./AlarmesPanel";
import { fetchAlarmsPage, type AlarmsLoadMeta } from "./useReportData";

const meta = (p: Partial<AlarmsLoadMeta> = {}): AlarmsLoadMeta => ({
  limit: 500,
  total: 120,
  truncated: false,
  retention: 1000,
  retentionClipped: false,
  ...p,
});
const html = (m: AlarmsLoadMeta) => renderToStaticMarkup(<AlarmsLoadNote meta={m} />);

describe("fetchAlarmsPage — o que o hub devolve vira meta SEM inventar certeza", () => {
  it("envelope truncado (1200 eventos, limit 500) ⇒ truncated true e total 1200", async () => {
    const r = await fetchAlarmsPage(1_700_000_000_000, async () => ({
      events: Array.from({ length: 500 }, (_, i) => ({ id: `a${i}` })),
      total: 1200,
      truncated: true,
      limit: 500,
      retention: 1000,
      retentionClipped: false,
    }));
    expect(r.events.length).toBe(500);
    expect(r.meta.truncated).toBe(true);
    expect(r.meta.total).toBe(1200);
  });

  // 30d = maior `Period` HOJE. Se alguém criar um período mais largo, o código acompanha
  // (deriva de periodDays) e este teste QUEBRA — é o aviso de que o teto mudou.
  it("pede a JANELA do relatório (since = 30d) — o corte do servidor incide sobre ela", async () => {
    let url = "";
    await fetchAlarmsPage(1_700_000_000_000, async (p: string) => {
      url = p;
      return [];
    });
    expect(url).toContain("limit=500");
    expect(url).toContain("meta=1");
    expect(url).toContain(`since=${1_700_000_000_000 - 30 * 86_400_000}`);
  });

  it("hub antigo (array) com página CHEIA ⇒ truncated null ('não sei'), nunca false", async () => {
    const r = await fetchAlarmsPage(1, async () => Array.from({ length: 500 }, (_, i) => ({ id: `a${i}` })));
    expect(r.meta.truncated).toBeNull();
    expect(r.meta.total).toBeNull();
  });

  it("hub antigo (array) com página INCOMPLETA ⇒ não houve corte, e isso se pode afirmar", async () => {
    const r = await fetchAlarmsPage(1, async () => Array.from({ length: 12 }, (_, i) => ({ id: `a${i}` })));
    expect(r.meta.truncated).toBe(false);
    expect(r.meta.total).toBe(12);
  });
});

describe("AlarmsLoadNote — o teto vira texto na tela", () => {
  it("truncado: diz 'os 500 ... de 1200' e que os números cobrem só a página", () => {
    const out = html(meta({ truncated: true, total: 1200 }));
    expect(out).toContain("500");
    expect(out).toContain("1200");
    expect(out).toMatch(/cobrem só/);
  });

  it("cadeia completa: envelope truncado do hub ⇒ aviso renderizado", async () => {
    const r = await fetchAlarmsPage(1, async () => ({
      events: [],
      total: 1200,
      truncated: true,
      limit: 500,
      retention: 1000,
      retentionClipped: false,
    }));
    expect(html(r.meta)).toContain("1200");
  });

  it("sem corte: NADA na tela (aviso permanente é ruído, não informação)", () => {
    expect(html(meta())).toBe("");
  });

  it("truncated desconhecido (hub antigo) ⇒ avisa que pode subcontar, sem afirmar total", () => {
    const out = html(meta({ truncated: null, total: null }));
    expect(out).toMatch(/pode estar cortada/);
    expect(out).toMatch(/subcontar/);
  });

  it("retenção mordendo a janela ⇒ segundo aviso, com o teto da fila", () => {
    const out = html(meta({ retentionClipped: true, retention: 1000 }));
    expect(out).toContain("1000");
    expect(out).toMatch(/descartados/);
  });
});
