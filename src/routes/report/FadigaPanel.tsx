import {
  fadigaKpis,
  fadigaHeatmap,
  fadigaEvolution,
  type FadigaEventRow,
} from "../../report/calc";
import { Tabs, TabsContent } from "../../ui";
import { RepLens, HistoryFooter, Insight, SectionTitle, REP_TABPANEL_CLS, type RepTab } from "./chrome";
import { KpiRow, Kpi } from "./KpiRow";
import { Heatmap, heatColor } from "./Heatmap";
import { TrendSection } from "./TrendChart";
import { EventsTable } from "./EventsTable";

type FKpis = ReturnType<typeof fadigaKpis>;

export function FadigaPanel({
  lens,
  fk,
  fOccFadiga,
  fOccCelular,
  ftips,
  fhm,
  fevo,
  fevt,
  tab,
  onTabChange,
}: {
  lens: string;
  fk: FKpis;
  fOccFadiga: number;
  fOccCelular: number;
  ftips: string[];
  fhm: ReturnType<typeof fadigaHeatmap>;
  fevo: ReturnType<typeof fadigaEvolution>;
  fevt: FadigaEventRow[];
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
}) {
  // A aba "onde" MORREU (renderizava o MESMO heatmap da aba "quando" — duplicação declarada no
  // próprio código). O estado da aba é COMPARTILHADO entre os modos: se o gestor chega aqui com
  // "onde"/"fluxo" herdados de Atividade, cai em "quando" — sem aba fantasma, sem painel vazio.
  const activeTab = tab === "onde" || tab === "fluxo" ? "quando" : tab;
  return (
    <>
      <RepLens lens={lens} />
      {/* "bocejos" desceu p/ o CSV: contagem crua sem faixa-alvo (doutrina 12). */}
      <KpiRow fit>
        <Kpi
          value={`${fk.alertPct}%`}
          label="tempo em alerta"
          valueStyle={{
            // going-gray: operação saudável (≤2%) é o normal → sem cor; saturada só no risco.
            color:
              fk.alertPct <= 2
                ? undefined
                : fk.alertPct <= 10
                  ? "var(--state-warn)"
                  : "var(--state-critical)",
          }}
        />
        <Kpi
          value={fOccFadiga}
          label="ocorrências de fadiga"
          valueStyle={{ color: fOccFadiga ? "var(--state-warn)" : undefined }}
        />
        <Kpi
          value={fOccCelular}
          label="ocorrências de celular"
          valueStyle={{ color: fOccCelular ? "var(--state-warn)" : undefined }}
        />
        <Kpi value={`${String(fk.peakHour).padStart(2, "0")}h`} label="horário crítico" />
      </KpiRow>
      <Insight label="Operador" tips={ftips} />
      <Tabs
        className="rep-tabs flex-1"
        ariaLabel="Seção"
        value={activeTab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Ocorrências (${fevt.length})` },
        ]}
      >
        <TabsContent value="quando" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Quando — tempo de risco por hora (min)</SectionTitle>
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
        <TabsContent value="tendencia" className={REP_TABPANEL_CLS}>
          <TrendSection
            bars={fevo.bars.map((b) => ({
              key: b.dayIndex,
              label: b.label,
              value: b.pct,
              title: `${b.label} · ${b.pct}% em alerta`,
            }))}
            max={fevo.max}
            note="% do tempo em alerta"
          />
        </TabsContent>
        <TabsContent value="eventos" className={REP_TABPANEL_CLS}>
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
      <HistoryFooter />
    </>
  );
}
