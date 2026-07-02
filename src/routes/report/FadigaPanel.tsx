import {
  fadigaKpis,
  fadigaHeatmap,
  fadigaEvolution,
  type FadigaEventRow,
} from "../../report/mock";
import { Tabs, TabsContent } from "../../ui";
import { RepLens, HistoryFooter, Insight, type RepTab } from "./chrome";
import { KpiRow, Kpi } from "./KpiRow";
import { Heatmap, heatColor } from "./Heatmap";
import { TrendChart } from "./TrendChart";
import { EventsTable } from "./EventsTable";

type FKpis = ReturnType<typeof fadigaKpis>;

export function FadigaPanel({
  lens,
  fk,
  fOccFadiga,
  fOccCelular,
  fBocejos,
  ftips,
  fhm,
  fevo,
  fevt,
  tab,
  onTabChange,
  busy,
  onClear,
}: {
  lens: string;
  fk: FKpis;
  fOccFadiga: number;
  fOccCelular: number;
  fBocejos: number;
  ftips: string[];
  fhm: ReturnType<typeof fadigaHeatmap>;
  fevo: ReturnType<typeof fadigaEvolution>;
  fevt: FadigaEventRow[];
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
          value={`${fk.alertPct}%`}
          label="tempo em alerta"
          valueStyle={{
            color:
              fk.alertPct <= 2 ? "var(--ok)" : fk.alertPct <= 10 ? "var(--idle)" : "var(--alert)",
          }}
        />
        <Kpi
          value={fOccFadiga}
          label="ocorrências de fadiga"
          valueStyle={{ color: fOccFadiga ? "var(--idle)" : undefined }}
        />
        <Kpi
          value={fOccCelular}
          label="ocorrências de celular"
          valueStyle={{ color: fOccCelular ? "var(--idle)" : undefined }}
        />
        <Kpi value={fBocejos} label="bocejos" />
        <Kpi value={`${String(fk.peakHour).padStart(2, "0")}h`} label="horário crítico" />
      </KpiRow>
      <Insight label="💡 Operador" tips={ftips} />
      <Tabs
        className="rep-tabs"
        ariaLabel="Seção"
        value={tab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Ocorrências (${fevt.length})` },
        ]}
      >
        {/* "quando" e "onde" (fallback p/ estado herdado de outro modo) mostram o mesmo heatmap. */}
        {(["quando", "onde"] as const).map((v) => (
          <TabsContent key={v} value={v} className="rep-tabpanel">
            <section className="panel">
              <h3>Quando — tempo de risco por hora (min)</h3>
              <Heatmap
                rows={fhm.rows.map((row) => ({
                  key: row.label,
                  label: row.label,
                  title: row.label,
                  hours: row.hours,
                }))}
                cellColor={(_, v2) => heatColor(v2, fhm.max)}
                cellTitle={(row, v2, h) =>
                  `${row.title} · ${String(h).padStart(2, "0")}h · ${v2} min`
                }
                legendLeft="menos"
                legendRight="mais risco"
              />
            </section>
          </TabsContent>
        ))}
        <TabsContent value="tendencia" className="rep-tabpanel">
          <section className="panel">
            <h3>Tendência (14 dias) — % do tempo em alerta</h3>
            <TrendChart
              bars={fevo.bars.map((b) => ({
                key: b.dayIndex,
                label: b.label,
                value: b.pct,
                title: `${b.label} · ${b.pct}% em alerta`,
              }))}
              max={fevo.max}
            />
          </section>
        </TabsContent>
        <TabsContent value="eventos" className="rep-tabpanel">
          <EventsTable
            title={`Ocorrências de risco (${fevt.length})`}
            headers={["Data / hora", "Posto", "Tipo", "Turno"]}
            rows={fevt}
            emptyNote="Nenhuma ocorrência no período."
            renderCells={(r) => (
              <>
                <td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td>
                <td>{r.posto}</td>
                <td>{r.type}</td>
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
