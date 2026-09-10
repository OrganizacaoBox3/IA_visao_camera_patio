import {
  kpis,
  deltaPct,
  heatmap,
  ranking,
  evolution,
  fmtMin,
  idleUnavailable,
  IDLE_UNAVAILABLE_NOTE,
  type EventRow,
  type ShiftRuler,
  type IdleMeasurement,
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
import { EventsTable } from "./EventsTable";

type Kpis = ReturnType<typeof kpis>;
type ByAtiv = { rows: { atividade: string; idleMin: number; alerts: number }[]; max: number };

// O FLUXO SAIU DAQUI (2026-09-10): virou MODO próprio — `FluxoPanel`/`useFluxoVM`. Era a 4ª aba
// deste painel, dentro de um modo cujo filtro é ÁREA — que não se aplica a cruzamento nenhum (a
// linha de contagem é por CÂMERA). O painel precisava de uma nota explicando por que o filtro ao
// lado não valia para ele; relatório que precisa se desculpar pelo filtro está no lugar errado.

// Selo de ociosidade NÃO MEDIDA (auditoria A6). Aparece no lugar do número/gráfico — a tela
// declara a ausência de medição em vez de exibir "0m", que se lê como "nada parou".
// Isto NÃO mede ociosidade (é trabalho de outra onda): só para de afirmar zero.
function IdleUnavailableNote({ compact = false }: { compact?: boolean }) {
  return (
    <p className="empty-note">
      {compact ? "Ociosidade não medida no período (motor do hub)." : IDLE_UNAVAILABLE_NOTE}
    </p>
  );
}

export function AtividadePanel({
  lens,
  k,
  kPrev,
  ruler,
  idle,
  tips,
  hm,
  rank,
  byAtiv,
  evo,
  evt,
  tab,
  onTabChange,
}: {
  lens: string;
  k: Kpis;
  kPrev: Kpis;
  // Régua do turno: só existe se o hub CARIMBOU o turno no bucket (ruler.stamped). Sem carimbo,
  // a faixa some inteira — melhor nenhum número do que um número na régua errada (÷24h).
  ruler: ShiftRuler;
  // Ociosidade medida no recorte? Com o motor no hub o bucket vem com idleMs=0 por construção
  // (A6): a tela troca TODO número de tempo parado pelo selo de indisponibilidade.
  idle: IdleMeasurement;
  tips: string[];
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ByAtiv;
  evo: ReturnType<typeof evolution>;
  evt: EventRow[];
  tab: RepTab;
  onTabChange: (v: RepTab) => void;
}) {
  const noIdle = idleUnavailable(idle); // observou e veio zerado ⇒ não medido, não "sem parada"
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
            <Kpi
              value={noIdle ? "—" : fmtMin(ruler.idleMinInShift)}
              label={
                noIdle ? (
                  <>
                    tempo parado no turno <span className="muted">· não medido</span>
                  </>
                ) : (
                  "tempo parado no turno"
                )
              }
            />
            <Kpi value={ruler.alertsInShift} label="alertas no turno" />
            <Kpi value={`${ruler.offActiveHours}h`} label="atividade fora do turno" />
          </KpiRow>
          {noIdle && <IdleUnavailableNote compact />}
        </section>
      )}
      {/* 5 KPIs (o "pico de pessoas" desceu p/ o CSV — número cru sem faixa-alvo não sustenta
          decisão; o dado continua no arquivo, só não ocupa a tela). */}
      <KpiRow fit>
        {/* "0m parado" é a leitura de "nada parou" — e com o motor no hub o zero é AUSÊNCIA DE
            MEDIÇÃO (A6). Os três KPIs derivados de ociosidade viram "—" juntos: exibir só um
            deles como "—" e os outros como zero seria trocar uma mentira por duas. */}
        <Kpi
          value={noIdle ? "—" : fmtMin(k.idleMin)}
          label={
            noIdle ? (
              <>
                tempo parado <span className="muted">· não medido</span>
              </>
            ) : (
              <>
                tempo parado <Delta v={deltaPct(k.idleMin, kPrev.idleMin)} />
              </>
            )
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
        <Kpi value={noIdle ? "—" : k.topArea} label="área mais parada" />
        <Kpi
          value={noIdle ? "—" : `${String(k.peakHour).padStart(2, "0")}h`}
          label="horário crítico"
        />
        {/* going-gray: cor em valor numérico só condicional a estado — sem verde incondicional */}
        <Kpi value={k.activePct === null ? "—" : `${k.activePct}%`} label="tempo ativo" />
      </KpiRow>
      {tips.length > 0 && <Insight label="Oportunidades" tips={tips} />}
      <Tabs
        className="rep-tabs flex-1"
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
        <TabsContent value="quando" className={REP_TABPANEL_CLS}>
          <section className="panel flex-1">
            <SectionTitle>Quando para — horários críticos</SectionTitle>
            {/* grade inteira de zeros com cara de mapa de calor "tudo tranquilo" — não desenha. */}
            {noIdle ? (
              <IdleUnavailableNote />
            ) : (
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
            )}
          </section>
        </TabsContent>
        <TabsContent value="onde" className={REP_TABPANEL_CLS}>
          <div className="rep-2col flex-1" style={{ alignItems: "stretch" }}>
            <section className="panel">
              <SectionTitle>Por área</SectionTitle>
              {/* "Sem ociosidade no período." é uma AFIRMAÇÃO — falsa quando ninguém mediu. */}
              <RankingBars
                rows={
                  noIdle
                    ? []
                    : rank.rows.map((r) => ({
                        key: r.area,
                        label: r.area,
                        value: r.idleMin,
                        valueText: `${fmtMin(r.idleMin)} · ${r.alerts} alertas`,
                      }))
                }
                max={rank.max}
                emptyNote={
                  noIdle
                    ? "Ociosidade não medida no período (motor do hub) — sem ranking a exibir."
                    : "Sem ociosidade no período."
                }
              />
            </section>
            <section className="panel">
              <SectionTitle>Por atividade</SectionTitle>
              <RankingBars
                rows={
                  noIdle
                    ? []
                    : byAtiv.rows.map((r) => ({
                        key: r.atividade,
                        label: r.atividade,
                        value: r.idleMin,
                        valueText: `${fmtMin(r.idleMin)} · ${r.alerts} alertas`,
                      }))
                }
                max={byAtiv.max}
                emptyNote={
                  noIdle
                    ? "Ociosidade não medida no período (motor do hub) — sem ranking a exibir."
                    : "Sem dados."
                }
              />
            </section>
          </div>
        </TabsContent>
        {/* "Por turno" MORREU aqui: turno já é filtro GLOBAL — com um turno escolhido o gráfico
            virava UMA barra. A quebra por turno segue no CSV (seção POR TURNO). */}
        <TabsContent value="tendencia" className={REP_TABPANEL_CLS}>
          {/* 14 barras zeradas leem-se como "14 dias sem parada" — o mesmo zero não medido. */}
          {noIdle ? (
            <section className="panel flex-1">
              <SectionTitle>Tendência (14 dias)</SectionTitle>
              <IdleUnavailableNote />
            </section>
          ) : (
            <TrendSection
              bars={evo.bars.map((b) => ({
                key: b.dayIndex,
                label: b.label,
                value: b.idleMin,
                title: `${b.label} · ${fmtMin(b.idleMin)} parado`,
              }))}
              max={evo.max}
            />
          )}
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
      </Tabs>
      <HistoryFooter />
    </>
  );
}
