import {
  kpis,
  deltaPct,
  heatmap,
  ranking,
  evolution,
  fmtMin,
  type EventRow,
  type ShiftRuler,
} from "../../report/calc";
import { Tabs, TabsContent } from "../../ui";
import {
  RepLens,
  HistoryFooter,
  Insight,
  SectionTitle,
  REP_TABPANEL_CLS,
  type RepTab,
} from "./chrome";
import { KpiRow, Kpi, Delta } from "./KpiRow";
import { Heatmap, heatColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendSection } from "./TrendChart";
import { FlowBiChart } from "./FlowChart";
import { EventsTable } from "./EventsTable";
import type { FlowLineRow } from "../../report/calc";

type Kpis = ReturnType<typeof kpis>;
type ByAtiv = { rows: { atividade: string; idleMin: number; alerts: number }[]; max: number };

// Fluxo de pessoas já agregado pelo view-model (calc/flow): recorte período/turno.
// `null` no prop = hub antigo sem o kind "flow" → a seção inteira some (graceful).
export type FlowView = {
  hasAny: boolean; // existe ALGUM cruzamento no histórico (independente do recorte)
  k: { in: number; out: number; lines: number };
  byHour: { hours: { in: number; out: number }[]; max: number };
  byLine: { rows: FlowLineRow[]; max: number };
};

export function AtividadePanel({
  lens,
  k,
  kPrev,
  ruler,
  tips,
  hm,
  rank,
  byAtiv,
  evo,
  evt,
  flow,
  tab,
  onTabChange,
}: {
  lens: string;
  k: Kpis;
  kPrev: Kpis;
  // Régua do turno: só existe se o hub CARIMBOU o turno no bucket (ruler.stamped). Sem carimbo,
  // a faixa some inteira — melhor nenhum número do que um número na régua errada (÷24h).
  ruler: ShiftRuler;
  tips: string[];
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ByAtiv;
  evo: ReturnType<typeof evolution>;
  evt: EventRow[];
  flow: FlowView | null; // null = hub sem o kind "flow" → seção oculta
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
}) {
  // "fluxo" só é uma aba válida quando o hub expõe o kind "flow"; se o estado herdou "fluxo"
  // e a seção sumiu (refresh/hub antigo), cai para "quando" sem efeito colateral.
  const activeTab = tab === "fluxo" && !flow ? "quando" : tab;
  return (
    <>
      <RepLens lens={lens} />
      {/* RÉGUA DO TURNO PROMOVIDA AO TOPO (spec §2.4 N4): é a melhor peça da tela — ocupação
          medida DENTRO da janela de trabalho (÷ turno−pausas, NUNCA ÷ 24h), com a atividade
          FORA do turno como LINHA PRÓPRIA (jamais somada ao denominador). Vem ANTES dos KPIs
          crus justamente porque é o número com RÉGUA; aparece só quando o hub carimba o turno. */}
      {ruler.stamped && (
        <section className="panel">
          <SectionTitle>Régua do turno — dentro da janela de trabalho</SectionTitle>
          <KpiRow fit>
            <Kpi
              value={ruler.occupancyPct === null ? "—" : `${ruler.occupancyPct}%`}
              label="ocupação no turno"
            />
            <Kpi value={fmtMin(ruler.idleMinInShift)} label="tempo parado no turno" />
            <Kpi value={ruler.alertsInShift} label="alertas no turno" />
            <Kpi value={`${ruler.offActiveHours}h`} label="atividade fora do turno" />
          </KpiRow>
        </section>
      )}
      {/* 5 KPIs (o "pico de pessoas" desceu p/ o CSV — número cru sem faixa-alvo não sustenta
          decisão; o dado continua no arquivo, só não ocupa a tela). */}
      <KpiRow fit>
        <Kpi
          value={fmtMin(k.idleMin)}
          label={
            <>
              tempo parado <Delta v={deltaPct(k.idleMin, kPrev.idleMin)} />
            </>
          }
        />
        <Kpi
          value={k.alerts}
          label={
            <>
              alertas <Delta v={deltaPct(k.alerts, kPrev.alerts)} />
            </>
          }
        />
        <Kpi value={k.topArea} label="área mais parada" />
        <Kpi value={`${String(k.peakHour).padStart(2, "0")}h`} label="horário crítico" />
        {/* going-gray: cor em valor numérico só condicional a estado — sem verde incondicional */}
        <Kpi value={`${k.activePct}%`} label="tempo ativo" />
      </KpiRow>
      <Insight label="Oportunidades" tips={tips} />
      <Tabs
        className="rep-tabs flex-1"
        ariaLabel="Seção"
        value={activeTab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando para" },
          { value: "onde", label: "Onde para" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Eventos (${evt.length})` },
          // Fluxo de pessoas DENTRO do fluxo rolável: aba própria em vez de bloco
          // fixo abaixo das tabs (que espremia o tabpanel a ~60px em 1920 e clipava em 1366).
          ...(flow ? [{ value: "fluxo", label: "Fluxo de pessoas" }] : []),
        ]}
      >
        <TabsContent value="quando" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Quando para — horários críticos</SectionTitle>
            <Heatmap
              rows={hm.rows.map((row) => ({
                key: row.area,
                label: row.area,
                title: row.area,
                hours: row.hours,
              }))}
              cellColor={(_, v) => heatColor(v, hm.max)}
              cellTitle={(row, v, h) =>
                `${row.title} · ${String(h).padStart(2, "0")}h · ${fmtMin(v)} parado`
              }
              legendLeft="menos"
              legendRight="mais ocioso"
            />
          </section>
        </TabsContent>
        <TabsContent value="onde" className={REP_TABPANEL_CLS}>
          <div className="rep-2col flex-1" style={{ alignItems: "stretch" }}>
            <section className="panel">
              <SectionTitle>Por área</SectionTitle>
              <RankingBars
                rows={rank.rows.map((r) => ({
                  key: r.area,
                  label: r.area,
                  value: r.idleMin,
                  valueText: `${fmtMin(r.idleMin)} · ${r.alerts} alertas`,
                }))}
                max={rank.max}
                emptyNote="Sem ociosidade no período."
              />
            </section>
            <section className="panel">
              <SectionTitle>Por atividade</SectionTitle>
              <RankingBars
                rows={byAtiv.rows.map((r) => ({
                  key: r.atividade,
                  label: r.atividade,
                  value: r.idleMin,
                  valueText: `${fmtMin(r.idleMin)} · ${r.alerts} alertas`,
                }))}
                max={byAtiv.max}
                emptyNote="Sem dados."
              />
            </section>
          </div>
        </TabsContent>
        {/* "Por turno" MORREU aqui: turno já é filtro GLOBAL — com um turno escolhido o gráfico
            virava UMA barra. A quebra por turno segue no CSV (seção POR TURNO). */}
        <TabsContent value="tendencia" className={REP_TABPANEL_CLS}>
          <TrendSection
            bars={evo.bars.map((b) => ({
              key: b.dayIndex,
              label: b.label,
              value: b.idleMin,
              title: `${b.label} · ${fmtMin(b.idleMin)} parado`,
            }))}
            max={evo.max}
          />
        </TabsContent>
        <TabsContent value="eventos" className={REP_TABPANEL_CLS}>
          <EventsTable
            title={`Eventos — alertas no período (${evt.length})`}
            headers={["Data / hora", "Área", "Câmera", "Duração", "Turno"]}
            rows={evt}
            emptyNote="Nenhum alerta no período."
            renderCells={(r) => (
              <>
                <td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td>
                <td>{r.area}</td>
                <td className="muted">{r.camera}</td>
                <td className="mono">{fmtMin(r.durationMin)}</td>
                <td>{r.shift}</td>
              </>
            )}
          />
        </TabsContent>
        {/* Fluxo de pessoas — parte da história de atividade, não um modo novo.
            Vive como ABA (dentro do painel rolável) p/ nunca espremer as demais seções. */}
        {flow && (
          <TabsContent value="fluxo" className={REP_TABPANEL_CLS}>
            <FlowSection flow={flow} />
          </TabsContent>
        )}
      </Tabs>
      <HistoryFooter />
    </>
  );
}

// ── Fluxo (linhas de contagem) — in/out agregados dos buckets persistidos no hub ──
// Respeita período/turno (recorte feito no view-model via calc/flow). O filtro de
// ÁREA não se aplica: cruzamentos são registrados por câmera×linha, sem área.
function FlowSection({ flow }: { flow: FlowView }) {
  const { hasAny, k, byHour, byLine } = flow;
  if (!hasAny || k.in + k.out === 0) {
    // Estados vazios curtos (padrão das notas existentes): sem linha/cruzamento × recorte vazio.
    return (
      <section className="panel flex-1">
        <SectionTitle>Fluxo de pessoas — linhas de contagem</SectionTitle>
        <p className="empty-note">
          {hasAny
            ? "Sem cruzamentos no período/turno selecionado."
            : "Nenhum cruzamento registrado ainda. Desenhe uma linha de contagem na câmera (Central) — cada passagem vira entrada/saída aqui."}
        </p>
      </section>
    );
  }
  // Rótulo humano por linha: nome da câmera; com 2+ linhas na mesma câmera, sufixo "linha N"
  // (ordem estável pelo id — o tripwireId cru só vai ao CSV/tooltip).
  const linesOfCam = new Map<string, string[]>();
  for (const r of byLine.rows) {
    const arr = linesOfCam.get(r.cameraId) ?? [];
    arr.push(r.tripwireId);
    linesOfCam.set(r.cameraId, arr);
  }
  for (const arr of linesOfCam.values()) arr.sort();
  const lineLabel = (r: FlowLineRow) => {
    const cam = r.cameraLabel || r.cameraId;
    const ids = linesOfCam.get(r.cameraId) ?? [];
    return ids.length > 1 ? `${cam} · linha ${ids.indexOf(r.tripwireId) + 1}` : cam;
  };
  return (
    <>
      <section className="panel">
        <SectionTitle>Fluxo de pessoas — linhas de contagem</SectionTitle>
        {/* going-gray: fluxo é informação neutra — sem cor saturada.
            O "saldo (entradas − saídas)" desceu p/ o CSV: número cru sem faixa-alvo. O saldo
            AGORA se lê no gráfico bidirecional abaixo (a assimetria entre as duas metades). */}
        <KpiRow fit>
          <Kpi value={k.in} label="entradas no período" />
          <Kpi value={k.out} label="saídas no período" />
          <Kpi
            value={k.lines}
            label={k.lines === 1 ? "linha com cruzamento" : "linhas com cruzamento"}
          />
        </KpiRow>
        <p className="muted text-label">
          Respeita período e turno. O filtro de área não se aplica ao fluxo (cruzamentos são por
          câmera × linha, sem área).
        </p>
      </section>
      {/* UM gráfico bidirecional no lugar de "Entradas por hora" + "Saídas por hora" (dois
          gráficos com o mesmo eixo e a mesma escala, lidos em par p/ responder uma pergunta). */}
      <section className="panel">
        <SectionTitle>Entradas e saídas por hora</SectionTitle>
        <FlowBiChart hours={byHour.hours} max={byHour.max} />
      </section>
      <section className="panel flex-1">
        <SectionTitle>Por linha / câmera</SectionTitle>
        <RankingBars
          rows={byLine.rows.map((r) => ({
            key: `${r.cameraId}|${r.tripwireId}`,
            label: <span title={r.tripwireId}>{lineLabel(r)}</span>,
            value: r.in + r.out,
            valueText: `${r.in} entradas · ${r.out} saídas`,
          }))}
          max={byLine.max}
          emptyNote="Sem cruzamentos no período."
        />
      </section>
    </>
  );
}
