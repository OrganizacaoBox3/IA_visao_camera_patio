import {
  objectKpis,
  objectHeatmap,
  objectPresence,
  objectRanking,
  objectByClass,
  objectEvolution,
  type ObjectEventRow,
} from "../../report/calc";
import { Package } from "lucide-react";
import { objClass } from "../../objects/catalog";
import { Tabs, TabsContent, ScrollArea } from "../../ui";
import { RepLens, HistoryFooter, Insight, SectionTitle, REP_TABPANEL_CLS, type RepTab } from "./chrome";
import { KpiRow, Kpi } from "./KpiRow";
import { Heatmap, readColor } from "./Heatmap";
import { RankingBars } from "./RankingBars";
import { TrendChart } from "./TrendChart";
import { EventsTable } from "./EventsTable";

// Rótulo humano da classe SEM emoji (#9/#12 — emoji era glifo funcional; a cor/ícone do
// overlay vive no catálogo, mas em relatório/CSV a classe é texto).
export function classLabel(k: string): string {
  return objClass(k)?.label ?? k;
}

type OKpis = ReturnType<typeof objectKpis>;

export function ObjetosPanel({
  lens,
  ok,
  oLoads,
  otips,
  ohm,
  opres,
  orank,
  obyClass,
  oevo,
  oevt,
  classes,
  presSetores,
  tab,
  onTabChange,
}: {
  lens: string;
  ok: OKpis;
  oLoads: number;
  otips: string[];
  ohm: ReturnType<typeof objectHeatmap>;
  opres: ReturnType<typeof objectPresence>;
  orank: ReturnType<typeof objectRanking>;
  obyClass: ReturnType<typeof objectByClass>;
  oevo: ReturnType<typeof objectEvolution>;
  oevt: ObjectEventRow[];
  classes: string[];
  presSetores: string[];
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
}) {
  return (
    <>
      <RepLens lens={lens} />
      <KpiRow>
        <Kpi value={ok.avgCount} label="objetos médios em cena" />
        <Kpi value={ok.peak} label="pico simultâneo" />
        {/* #9: ícone Lucide neutro no lugar do emoji 📦 do catálogo (.kpi-vico, report.css) */}
        <Kpi
          value={
            <span className="kpi-vico">
              <Package size={20} strokeWidth={1.75} aria-hidden /> {classLabel(ok.topClasse)}
            </span>
          }
          label="objeto predominante"
        />
        {/* going-gray: cor em valor numérico só condicional a estado — sem accent incondicional */}
        <Kpi value={`${ok.presenceTopPct}%`} label="presença (predominante)" />
        <Kpi
          value={oLoads}
          label="carregamentos"
          valueStyle={{ color: oLoads ? "var(--state-warn)" : undefined }}
        />
      </KpiRow>
      <Insight label="Objetos" tips={otips} />
      <Tabs
        className="rep-tabs flex-1"
        ariaLabel="Seção"
        value={tab}
        onValueChange={(v) => onTabChange(v as RepTab)}
        items={[
          { value: "quando", label: "Quando" },
          { value: "onde", label: "Setor × Classe" },
          { value: "tendencia", label: "Tendência" },
          { value: "eventos", label: `Eventos (${oevt.length})` },
        ]}
      >
        <TabsContent value="quando" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Quando — contagem média por hora</SectionTitle>
            <Heatmap
              rows={ohm.rows.map((row) => ({
                key: row.classe,
                label: classLabel(row.classe),
                title: row.classe,
                hours: row.hours,
              }))}
              cellColor={(_, v) => readColor(v, ohm.max)}
              cellTitle={(row, v, h) =>
                `${classLabel(row.key)} · ${String(h).padStart(2, "0")}h · ${v} em média`
              }
              legendLeft="menos"
              legendRight="mais objetos"
              scaleRead
            />
          </section>
        </TabsContent>
        <TabsContent value="onde" className={REP_TABPANEL_CLS}>
          <div className="rep-2col flex-1" style={{ alignItems: "stretch" }}>
            <section className="panel">
              <SectionTitle>Presença por Setor × Classe (% do tempo)</SectionTitle>
              {/* Hint de rolagem: some no desktop; no estreito a matriz rola
                  DENTRO da caixa (overflow-x), sem empurrar a página. */}
              <div className="rep-scrollhint" aria-hidden="true">
                deslize para ver todas as classes →
              </div>
              <ScrollArea className="rep-matrixscroll" orientation="both">
                <table className="obj-matrix">
                  <thead>
                    <tr>
                      <th scope="col">Setor</th>
                      {classes.map((cl) => (
                        <th key={cl} scope="col" title={cl}>
                          {classLabel(cl)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {presSetores.map((s) => (
                      <tr key={s}>
                        <td className="obj-setor">{s}</td>
                        {classes.map((cl) => {
                          const v = opres[s]?.[cl] ?? 0;
                          return (
                            <td key={cl} className={v >= 50 ? "on" : v > 0 ? "" : "off"}>
                              {v ? `${v}%` : "·"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {presSetores.length === 0 && (
                      <tr>
                        <td colSpan={classes.length + 1} className="empty-note">
                          Sem dados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>
            </section>
            <section className="panel">
              <SectionTitle>Por setor (média em cena)</SectionTitle>
              <RankingBars
                rows={orank.rows.map((r) => ({
                  key: r.setor,
                  label: r.setor,
                  value: r.avg,
                  valueText: `média ${r.avg} · pico ${r.peak}`,
                }))}
                max={orank.max}
                read
                emptyNote="Sem objetos no período."
              />
              <SectionTitle className="mt-3">Por classe</SectionTitle>
              <RankingBars
                rows={obyClass.rows.map((r) => ({
                  key: r.classe,
                  label: classLabel(r.classe),
                  value: r.avg,
                  valueText: `média ${r.avg}`,
                }))}
                max={obyClass.max}
                read
              />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="tendencia" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Tendência (14 dias) — objetos médios/dia</SectionTitle>
            <TrendChart
              bars={oevo.bars.map((b) => ({
                key: b.dayIndex,
                label: b.label,
                value: b.avg,
                title: `${b.label} · ${b.avg} em média`,
              }))}
              max={oevo.max}
              read
            />
          </section>
        </TabsContent>
        <TabsContent value="eventos" className={REP_TABPANEL_CLS}>
          <EventsTable
            title={`Eventos — presença e carregamentos (${oevt.length})`}
            headers={["Data / hora", "Tipo", "Setor", "Classe", "Turno"]}
            rows={oevt}
            emptyNote="Nenhum evento no período."
            renderCells={(r) => (
              <>
                <td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td>
                <td>{r.type}</td>
                <td>{r.setor}</td>
                <td>{classLabel(r.classe)}</td>
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
