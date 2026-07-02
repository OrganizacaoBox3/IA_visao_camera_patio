import {
  kpis,
  deltaPct,
  heatmap,
  ranking,
  evolution,
  fmtMin,
  type EventRow,
} from "../../report/mock";
import { Tabs, TabsContent } from "../../ui";
import { RepLens, HistoryFooter, Insight, SHIFTS, type RepTab, type ByShift } from "./chrome";
import { KpiRow, Kpi, Delta } from "./KpiRow";
import { Heatmap, heatColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendChart } from "./TrendChart";
import { EventsTable } from "./EventsTable";
import type { FlowLineRow } from "../../report/store";

type Kpis = ReturnType<typeof kpis>;
type ByAtiv = { rows: { atividade: string; idleMin: number; alerts: number }[]; max: number };

// Fluxo de pessoas (plano 1.3) já agregado pelo ReportPage (store.flow*): recorte período/turno.
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
  peoplePeak,
  tips,
  hm,
  rank,
  byAtiv,
  evo,
  byShiftA,
  evt,
  flow,
  tab,
  onTabChange,
  busy,
  onClear,
}: {
  lens: string;
  k: Kpis;
  kPrev: Kpis;
  peoplePeak: number; // pico de pessoas no recorte (plano 2.6) — 0 = sem detecção no período
  tips: string[];
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ByAtiv;
  evo: ReturnType<typeof evolution>;
  byShiftA: ByShift;
  evt: EventRow[];
  flow: FlowView | null; // null = hub sem o kind "flow" → seção oculta
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
  busy: boolean;
  onClear: () => void;
}) {
  return (
    <>
      <RepLens lens={lens} />
      <KpiRow>
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
        <Kpi value={k.topArea} label="área mais parada" valueStyle={{ fontSize: 17 }} />
        <Kpi value={`${String(k.peakHour).padStart(2, "0")}h`} label="horário crítico" />
        <Kpi value={`${k.activePct}%`} label="tempo ativo" valueStyle={{ color: "var(--ok)" }} />
        {/* going-gray: contagem é informação neutra — sem cor saturada */}
        <Kpi value={peoplePeak} label="pico de pessoas" />
      </KpiRow>
      <Insight label="💡 Oportunidades" tips={tips} />
      <Tabs
        className="rep-tabs"
        ariaLabel="Seção"
        value={tab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando para" },
          { value: "onde", label: "Onde para" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Eventos (${evt.length})` },
        ]}
      >
        <TabsContent value="quando" className="rep-tabpanel">
          <section className="panel">
            <h3>Quando para — horários críticos</h3>
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
        <TabsContent value="onde" className="rep-tabpanel">
          <div className="rep-2col">
            <section className="panel">
              <h3>Por área</h3>
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
              <h3>Por atividade</h3>
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
        <TabsContent value="tendencia" className="rep-tabpanel">
          <div className="rep-2col">
            <section className="panel">
              <h3>Tendência (14 dias)</h3>
              <TrendChart
                bars={evo.bars.map((b) => ({
                  key: b.dayIndex,
                  label: b.label,
                  value: b.idleMin,
                  title: `${b.label} · ${fmtMin(b.idleMin)} parado`,
                }))}
                max={evo.max}
              />
            </section>
            <section className="panel">
              <h3>Por turno</h3>
              <RankingBars
                rows={SHIFTS.map((s) => ({
                  key: s,
                  label: s,
                  value: byShiftA.m[s],
                  valueText: fmtMin(byShiftA.m[s]),
                }))}
                max={byShiftA.max}
              />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="eventos" className="rep-tabpanel">
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
      </Tabs>
      {/* Fluxo de pessoas (plano 1.3) — parte da história de atividade, não um modo novo. */}
      {flow && <FlowSection flow={flow} />}
      <HistoryFooter onClear={onClear} busy={busy} />
    </>
  );
}

// ── Fluxo (linhas de contagem) — in/out agregados dos buckets persistidos no hub ──
// Respeita período/turno (recorte feito no ReportPage via store.flowWindow). O filtro de
// ÁREA não se aplica: cruzamentos são registrados por câmera×linha, sem área.
const pad2 = (h: number) => String(h).padStart(2, "0");

function FlowSection({ flow }: { flow: FlowView }) {
  const { hasAny, k, byHour, byLine } = flow;
  if (!hasAny || k.in + k.out === 0) {
    // Estados vazios curtos (padrão das notas existentes): sem linha/cruzamento × recorte vazio.
    return (
      <section className="panel">
        <h3>Fluxo de pessoas — linhas de contagem</h3>
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
        <h3>Fluxo de pessoas — linhas de contagem</h3>
        {/* going-gray: fluxo é informação neutra — sem cor saturada */}
        <KpiRow>
          <Kpi value={k.in} label="entradas no período" />
          <Kpi value={k.out} label="saídas no período" />
          <Kpi value={k.in - k.out} label="saldo (entradas − saídas)" />
          <Kpi value={k.lines} label={k.lines === 1 ? "linha com cruzamento" : "linhas com cruzamento"} />
        </KpiRow>
        <p className="muted text-[11px]">
          Respeita período e turno. O filtro de área não se aplica ao fluxo (cruzamentos são por
          câmera × linha, sem área).
        </p>
      </section>
      <div className="rep-2col">
        <section className="panel">
          <h3>Entradas por hora</h3>
          <TrendChart
            bars={byHour.hours.map((v, h) => ({
              key: h,
              label: h % 3 === 0 ? `${pad2(h)}h` : "",
              value: v.in,
              title: `${pad2(h)}h · ${v.in} entradas`,
            }))}
            max={byHour.max}
          />
        </section>
        <section className="panel">
          <h3>Saídas por hora</h3>
          <TrendChart
            read
            bars={byHour.hours.map((v, h) => ({
              key: h,
              label: h % 3 === 0 ? `${pad2(h)}h` : "",
              value: v.out,
              title: `${pad2(h)}h · ${v.out} saídas`,
            }))}
            max={byHour.max}
          />
        </section>
      </div>
      <section className="panel">
        <h3>Por linha / câmera</h3>
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
