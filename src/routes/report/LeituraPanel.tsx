import {
  readingKpis,
  deltaPct,
  readingHeatmap,
  readingRanking,
  readingByCamera,
  readingEvolution,
  type Shift,
  type ReadingEventRow,
} from "../../report/mock";
import { Tabs, TabsContent } from "../../ui";
import { RepLens, HistoryFooter, type RepTab } from "./chrome";
import { KpiRow, Kpi, Delta } from "./KpiRow";
import { Heatmap, readColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendChart } from "./TrendChart";
import { EventsTable } from "./EventsTable";

const SHIFTS: Shift[] = ["Manhã", "Tarde", "Noite"];

type RKpis = ReturnType<typeof readingKpis>;
type ByShift = { m: Record<Shift, number>; max: number };

export function LeituraPanel({
  lens,
  rk,
  rkPrev,
  rtips,
  rhm,
  rrank,
  byCam,
  revo,
  byShiftR,
  revt,
  tab,
  onTabChange,
  busy,
  onClear,
}: {
  lens: string;
  rk: RKpis;
  rkPrev: RKpis;
  rtips: string[];
  rhm: ReturnType<typeof readingHeatmap>;
  rrank: ReturnType<typeof readingRanking>;
  byCam: ReturnType<typeof readingByCamera>;
  revo: ReturnType<typeof readingEvolution>;
  byShiftR: ByShift;
  revt: ReadingEventRow[];
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
            color:
              rk.ratePct >= 95 ? "var(--ok)" : rk.ratePct >= 80 ? "var(--idle)" : "var(--alert)",
          }}
        />
        <Kpi
          value={rk.noReads.toLocaleString("pt-BR")}
          label="no-reads"
          valueStyle={{ color: rk.noReads > 0 ? "var(--alert)" : undefined }}
        />
        <Kpi value={rk.topPonto} label="ponto de maior volume" valueStyle={{ fontSize: 15 }} />
        <Kpi value={`${String(rk.peakHour).padStart(2, "0")}h`} label="horário de pico" />
      </KpiRow>
      <section className="insight">
        <b>💡 Leitura</b> {rtips.join(" · ")}
      </section>
      <Tabs
        className="rep-tabs"
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
        <TabsContent value="quando" className="rep-tabpanel">
          <section className="panel">
            <h3>Quando lê — volume por hora</h3>
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
        <TabsContent value="onde" className="rep-tabpanel">
          <div className="rep-2col">
            <section className="panel">
              <h3>Por ponto</h3>
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
              <h3>Contribuição por câmera</h3>
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
        <TabsContent value="tendencia" className="rep-tabpanel">
          <div className="rep-2col">
            <section className="panel">
              <h3>Tendência (14 dias)</h3>
              <TrendChart
                bars={revo.bars.map((b) => ({
                  key: b.dayIndex,
                  label: b.label,
                  value: b.boxes,
                  title: `${b.label} · ${b.boxes} caixas`,
                }))}
                max={revo.max}
                read
              />
            </section>
            <section className="panel">
              <h3>Por turno</h3>
              <RankingBars
                rows={SHIFTS.map((s) => ({
                  key: s,
                  label: s,
                  value: byShiftR.m[s],
                  valueText: `${byShiftR.m[s].toLocaleString("pt-BR")} caixas`,
                }))}
                max={byShiftR.max}
                read
              />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="eventos" className="rep-tabpanel">
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
      <HistoryFooter onClear={onClear} busy={busy} />
    </>
  );
}
