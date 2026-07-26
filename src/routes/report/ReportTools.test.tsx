// GATES desta tela — dois bugs de HONESTIDADE (a interface afirmava o que não sabia):
//   B1 — falha ao consultar silenciamentos virava lista vazia ⇒ a tela escrevia "Os alertas
//        seguem o fluxo normal" exatamente quando não tinha ideia do estado do sistema.
//   B2 — o diálogo de "Limpar histórico" prometia apagar ALARMES; pgstore.clear() não os apaga.
// Molde da casa: renderToStaticMarkup (sem jsdom) — ver ui/Card.test.tsx.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CLEAR_DIALOG_DESCRIPTION,
  CLEAR_DOMAINS,
  SHELVES_EMPTY_COPY,
  SHELVES_ERROR_COPY,
  ShelvesList,
  loadShelvesState,
} from "./ReportTools";

const noop = () => {};
const render = (state: Parameters<typeof ShelvesList>[0]["state"]) =>
  renderToStaticMarkup(
    <ShelvesList
      state={state}
      onRetry={noop}
      shelveLabel={(k) => k}
      removing={null}
      onAskRemove={noop}
    />,
  );

describe("B1 — silenciamentos: FALHA não pode virar 'está tudo normal'", () => {
  it("listShelves rejeitando ⇒ estado de FALHA (nunca lista vazia)", async () => {
    const st = await loadShelvesState(() => Promise.reject(new Error("Falha de rede")));
    expect(st.status).toBe("error");
    expect(st).not.toEqual({ status: "ok", items: [] });
  });

  it("estado de falha renderiza o aviso — e NÃO a frase do vazio", async () => {
    const st = await loadShelvesState(() => Promise.reject(new Error("Falha de rede")));
    const html = render(st);
    expect(html).toContain(SHELVES_ERROR_COPY);
    expect(html).toContain("Falha de rede"); // o motivo técnico chega ao operador
    expect(html).toContain("Tentar de novo"); // e há como reconsultar
    // O ASSERT QUE IMPORTA: nada de normalidade afirmada sobre informação que não temos.
    expect(html).not.toContain("Os alertas seguem o fluxo normal");
    expect(html).not.toContain(SHELVES_EMPTY_COPY);
  });

  it("consulta OK e vazia ⇒ aí sim a frase do vazio (o outro lado do gate)", async () => {
    const st = await loadShelvesState(() => Promise.resolve([]));
    expect(st).toEqual({ status: "ok", items: [] });
    const html = render(st);
    expect(html).toContain(SHELVES_EMPTY_COPY);
    expect(html).not.toContain(SHELVES_ERROR_COPY);
  });

  it("carregando ⇒ nem vazio nem falha (o terceiro estado existe de verdade)", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(SHELVES_EMPTY_COPY);
    expect(html).not.toContain(SHELVES_ERROR_COPY);
  });
});

// O texto do diálogo é comparado com o SQL REAL de server/pgstore.js:clear(). Fonte lida do
// disco de propósito: se alguém acrescentar/remover tabela no TRUNCATE sem corrigir o texto,
// este teste quebra (é o mecanismo que impede o diálogo de voltar a mentir).
describe("B2 — 'Limpar histórico': o texto tem de bater com o que clear() faz", () => {
  const src = readFileSync(new URL("../../../server/pgstore.js", import.meta.url), "utf8");
  const truncated = new Set(
    (src.match(/`truncate\s+([^`]+)`/i)?.[1] ?? "").split(/[,\s]+/).filter(Boolean),
  );

  it("as tabelas citadas no texto == as tabelas truncadas", () => {
    expect(truncated.size).toBeGreaterThan(0); // o regex achou o SQL (senão o teste seria vácuo)
    expect([...truncated].sort()).toEqual([...CLEAR_DOMAINS.flatMap((d) => d.tables)].sort());
  });

  it("alarm_events NÃO é truncado — e o texto declara que os alarmes são preservados", () => {
    expect(truncated.has("alarm_events")).toBe(false);
    expect(CLEAR_DIALOG_DESCRIPTION).toMatch(/ALARMES não é apagado/);
    expect(CLEAR_DIALOG_DESCRIPTION).toMatch(/ALARM_EVENTS_RETENTION/); // onde se gerencia
    // a promessa antiga ("indicadores, eventos e alarmes") não pode voltar
    expect(CLEAR_DIALOG_DESCRIPTION).not.toMatch(/eventos e alarmes/i);
  });

  it("o texto nomeia todos os domínios apagados (e só eles)", () => {
    for (const d of CLEAR_DOMAINS) expect(CLEAR_DIALOG_DESCRIPTION).toContain(d.label);
  });

  it("o fallback JSON zera os MESMOS kinds (pgstore.KINDS)", () => {
    const kinds = (src.match(/const KINDS = \[([^\]]+)\]/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
    expect(kinds.sort()).toEqual(CLEAR_DOMAINS.map((d) => d.kind).sort());
  });
});
