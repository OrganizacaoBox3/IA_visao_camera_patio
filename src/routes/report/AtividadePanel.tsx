import {
  kpis,
  deltaPct,
  heatmap,
  ranking,
  evolution,
  fmtMin,
  type Shift,
  type EventRow,
} from "../../report/mock";
import { Tabs, TabsContent } from "../../ui";
import { RepLens, HistoryFooter, type RepTab } from "./chrome";
import { KpiRow, Kpi, Delta } from "./KpiRow";
import { Heatmap, heatColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendChart } from "./TrendChart";
import { EventsTable } from "./EventsTable";

const SHIFTS: Shift[] = ["Manhã", "Tarde", "Noite"];

type Kpis = ReturnType<typeof kpis>;
type ByAtiv = { rows: { atividade: string; idleMin: number; alerts: number }[]; max: number };
type ByShift = { m: Record<Shift, number>; max: number };

export function AtividadePanel({
  lens,
  k,
  kPrev,
  tips,
  hm,
  rank,
  byAtiv,
  evo,
  byShiftA,
  evt,
  tab,
  onTabChange,
  busy,
  onClear,
}: {
  lens: string;
  k: Kpis;
  kPrev: Kpis;
  tips: string[];
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ByAtiv;
  evo: ReturnType<typeof evolution>;
  byShiftA: ByShift;
  evt: EventRow[];
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
      </KpiRow>
      <section className="insight">
        <b>💡 Oportunidades</b> {tips.join(" · ")}
      </section>
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
      <HistoryFooter onClear={onClear} busy={busy} />
    </>
  );
}
