import {
  readingKpis,
  deltaPct,
  readingHeatmap,
  readingRanking,
  readingByCamera,
  readingEvolution,
  type ReadingEventRow,
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
import { Heatmap, readColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendSection } from "./TrendChart";
import { EventsTable } from "./EventsTable";

type RKpis = ReturnType<typeof readingKpis>;

export function LeituraPanel({
  lens,
  rk,
  rkPrev,
  rtips,
  rhm,
  rrank,
  byCam,
  revo,
  revt,
  tab,
  onTabChange,
}: {
  lens: string;
  rk: RKpis;
  rkPrev: RKpis;
  rtips: string[];
  rhm: ReturnType<typeof readingHeatmap>;
  rrank: ReturnType<typeof readingRanking>;
  byCam: ReturnType<typeof readingByCamera>;
  revo: ReturnType<typeof readingEvolution>;
  revt: ReadingEventRow[];
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
}) {
  return (
    <>
      <RepLens lens={lens} />
      <KpiRow>
        <Kpi
          value={rk.boxes.toLocaleString("pt-BR")}
          label={
            <>
              caixas lidas <Delta v={deltaPct(rk.boxes, rkPrev.boxes)} goodWhenDown={false} />
            </>
          }
        />
        <Kpi
          value={`${rk.ratePct}%`}
          label="taxa de leitura"
          valueStyle={{
            // going-gray: taxa boa (≥95%) é o estado normal → sem cor; saturada só p/ o degradado.
            color:
              rk.ratePct >= 95
                ? undefined
                : rk.ratePct >= 80
                  ? "var(--state-warn)"
                  : "var(--state-critical)",
          }}
        />
        <Kpi
          value={rk.noReads.toLocaleString("pt-BR")}
          label="no-reads"
          valueStyle={{ color: rk.noReads > 0 ? "var(--state-critical)" : undefined }}
        />
        <Kpi value={rk.topPonto} label="ponto de maior volume" />
        <Kpi value={`${String(rk.peakHour).padStart(2, "0")}h`} label="horário de pico" />
      </KpiRow>
      <Insight label="Leitura" tips={rtips} />
      <Tabs
        className="rep-tabs flex-1"
        ariaLabel="Seção"
        value={tab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando lê" },
          { value: "onde", label: "Onde lê" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Leituras (${revt.length})` },
        ]}
      >
        <TabsContent value="quando" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Quando lê — volume por hora</SectionTitle>
            <Heatmap
              rows={rhm.rows.map((row) => ({
                key: row.ponto,
                label: row.ponto,
                title: row.ponto,
                hours: row.hours,
              }))}
              cellColor={(_, v) => readColor(v, rhm.max)}
              cellTitle={(row, v, h) =>
                `${row.title} · ${String(h).padStart(2, "0")}h · ${v} caixas`
              }
              legendLeft="menos"
              legendRight="mais volume"
              scaleRead
            />
          </section>
        </TabsContent>
        <TabsContent value="onde" className={REP_TABPANEL_CLS}>
          <div className="rep-2col flex-1" style={{ alignItems: "stretch" }}>
            <section className="panel">
              <SectionTitle>Por ponto</SectionTitle>
              <RankingBars
                rows={rrank.rows.map((r) => ({
                  key: r.ponto,
                  label: r.ponto,
                  value: r.boxes,
                  valueText: (
                    <>
                      {r.boxes.toLocaleString("pt-BR")} caixas · taxa {r.ratePct}%
                      {r.noReads > 0 ? ` · ${r.noReads} no-read` : ""}
                    </>
                  ),
                }))}
                max={rrank.max}
                read
                emptyNote="Sem leituras no período."
              />
            </section>
            <section className="panel">
              <SectionTitle>Contribuição por câmera</SectionTitle>
              <RankingBars
                rows={byCam.rows.map((r) => ({
                  key: r.camera,
                  label: r.camera,
                  value: r.reads,
                  valueText: `${r.reads.toLocaleString("pt-BR")} leituras`,
                }))}
                max={byCam.max}
                read
                emptyNote="Sem dados."
              />
            </section>
          </div>
        </TabsContent>
        {/* "Por turno" MORREU aqui: turno já é filtro GLOBAL — com um turno escolhido o gráfico
            virava UMA barra. A quebra por turno segue no CSV (seção POR TURNO). */}
        <TabsContent value="tendencia" className={REP_TABPANEL_CLS}>
          <TrendSection
            bars={revo.bars.map((b) => ({
              key: b.dayIndex,
              label: b.label,
              value: b.boxes,
              title: `${b.label} · ${b.boxes} caixas`,
            }))}
            max={revo.max}
            read
          />
        </TabsContent>
        <TabsContent value="eventos" className={REP_TABPANEL_CLS}>
          <EventsTable
            title={`Leituras — códigos no período (${revt.length})`}
            headers={["Data / hora", "Ponto", "Código", "Câmeras", "Turno"]}
            rows={revt}
            emptyNote="Nenhuma leitura no período."
            renderCells={(r) => (
              <>
                <td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td>
                <td>{r.ponto}</td>
                <td className="mono">{r.code}</td>
                <td className="mono">{r.cameras > 1 ? `${r.cameras}×` : "1"}</td>
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
