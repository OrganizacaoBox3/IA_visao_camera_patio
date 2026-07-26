import { fadigaKpis, fadigaHeatmap, fadigaEvolution, type FadigaEventRow } from "../../report/calc";
import { Tabs, TabsContent } from "../../ui";
import {
  RepLens,
  HistoryFooter,
  Insight,
  SectionTitle,
  REP_TABPANEL_CLS,
  type RepTab,
} from "./chrome";
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
      {/* SEM AMOSTRA NÃO EXISTE PERCENTUAL (auditoria A2): `alertPct === null` ⇒ "—". O 0% que
          ficava aqui era pintado como "operação saudável ≤2%" — falso-OK no KPI de SEGURANÇA. */}
      <KpiRow fit>
        <Kpi
          value={fk.alertPct === null ? "—" : `${fk.alertPct}%`}
          label={
            fk.alertPct === null ? (
              <>
                tempo em alerta <span className="muted">· sem amostra no recorte</span>
              </>
            ) : (
              "tempo em alerta"
            )
          }
          valueStyle={{
            // going-gray: operação saudável (≤2%) é o normal → sem cor; saturada só no risco.
            color:
              fk.alertPct === null || fk.alertPct <= 2
                ? undefined
                : fk.alertPct <= 10
                  ? "var(--state-warn)"
                  : "var(--state-critical)",
          }}
        />
        {/* "0 ocorrências" sem NENHUMA amostra é ausência de medição, não ausência de risco. */}
        <Kpi
          value={fk.samples > 0 ? fOccFadiga : "—"}
          label="ocorrências de fadiga"
          valueStyle={{ color: fOccFadiga ? "var(--state-warn)" : undefined }}
        />
        <Kpi
          value={fk.samples > 0 ? fOccCelular : "—"}
          label="ocorrências de celular"
          valueStyle={{ color: fOccCelular ? "var(--state-warn)" : undefined }}
        />
        {/* pico de um vetor zerado é sempre 00h — só sai com amostra de risco de verdade. */}
        <Kpi
          value={fk.alertSamples > 0 ? `${String(fk.peakHour).padStart(2, "0")}h` : "—"}
          label="horário crítico"
        />
      </KpiRow>
      {/* Insight sem amostra não existe (fadigaInsights devolve []) — a faixa some inteira. */}
      {ftips.length > 0 && <Insight label="Operador" tips={ftips} />}
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
              // dia sem amostra tem barra zero — que é visualmente idêntica a "dia perfeito".
              // O título diz qual dos dois é (o número só existe onde houve medição).
              title: b.samples > 0 ? `${b.label} · ${b.pct}% em alerta` : `${b.label} · sem dado`,
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
