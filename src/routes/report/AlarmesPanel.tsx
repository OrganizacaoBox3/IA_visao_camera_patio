import { type RefObject } from "react";
import { alarmKpis, alarmTrend, alarmHeatmap, type AlarmWindow } from "../../report/mock";
import type { AlarmEvent, AlarmPriority, AlarmState } from "../../types/alarm";
import { ScrollArea } from "../../ui";
import { Insight, SectionTitle } from "./chrome";
import { KpiRow, Kpi } from "./KpiRow";
import { Heatmap } from "./Heatmap";

export const PRIORITY_LABEL: Record<AlarmPriority, string> = {
  advisory: "Informativo",
  high: "Alta",
  critical: "Crítica",
};
export const STATE_LABEL: Record<AlarmState, string> = {
  new: "Novo",
  acknowledged: "Reconhecido",
  forwarded: "Encaminhado",
};

function alarmHeatColor(priority: AlarmPriority, v: number, max: number): string {
  if (v <= 0) return "transparent";
  const t = 0.18 + Math.min(1, v / max) * 0.82;
  const rgb =
    priority === "critical" ? "239, 68, 68" : priority === "high" ? "234, 179, 8" : "56, 189, 248";
  return `rgba(${rgb}, ${t})`;
}

export function AlarmesPanel({
  periodLabel,
  alarmPriority,
  alarmState,
  alarms,
  ak,
  aTips,
  aTrend,
  aHeat,
  alarmsView,
  alarmWindow,
  alarmHour,
  selAlarm,
  selDay,
  selHour,
  trendRef,
  pickDay,
  pickHour,
  pickAlarm,
  clearAlarmSel,
  onRefresh,
}: {
  periodLabel: string;
  alarmPriority: AlarmPriority | "Todas";
  alarmState: AlarmState | "Todos";
  alarms: AlarmEvent[];
  ak: ReturnType<typeof alarmKpis>;
  aTips: string[];
  aTrend: ReturnType<typeof alarmTrend>;
  aHeat: ReturnType<typeof alarmHeatmap>;
  alarmsView: AlarmEvent[];
  alarmWindow: AlarmWindow | null;
  alarmHour: number | null;
  selAlarm: string | null;
  selDay: number | null;
  selHour: number | null;
  trendRef: RefObject<HTMLDivElement | null>;
  pickDay: (dayStart: number, label: string) => void;
  pickHour: (h: number) => void;
  pickAlarm: (id: string) => void;
  clearAlarmSel: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="rep-lens">
        Alarmes · <b>{periodLabel}</b>
        {alarmPriority !== "Todas" ? <> · {PRIORITY_LABEL[alarmPriority]}</> : null}
        {alarmState !== "Todos" ? <> · {STATE_LABEL[alarmState]}</> : null}
      </div>
      {alarms.length === 0 ? (
        <div className="dash-empty">
          <p>
            <b>Sem alarmes registrados.</b>
          </p>
          <p>A fila de alarmes aparece aqui conforme a política dispara eventos na Central.</p>
          <p className="muted">
            Apenas metadados (hora, câmera/zona, tipo, prioridade, estado) — sem imagens (LGPD).
          </p>
        </div>
      ) : (
        <>
          <KpiRow>
            <Kpi value={ak.total} label="alarmes no período" />
            <Kpi
              value={ak.critical}
              label="críticos"
              valueStyle={{ color: ak.critical ? "var(--state-critical)" : undefined }}
            />
            <Kpi
              value={ak.high}
              label="alta"
              valueStyle={{ color: ak.high ? "var(--state-warn)" : undefined }}
            />
            <Kpi
              value={ak.advisory}
              label="informativos"
              valueStyle={{ color: ak.advisory ? "var(--state-info)" : undefined }}
            />
            <Kpi
              value={ak.news}
              label="em aberto"
              valueStyle={{ color: ak.news ? "var(--state-warn)" : undefined }}
            />
          </KpiRow>
          <Insight label="🔔 Alarmes" tips={aTips} />
          <div className="rep-2col" ref={trendRef}>
            <section className="panel">
              <SectionTitle>
                Tendência (14 dias){" "}
                <span className="muted text-[11px] font-normal">— clique p/ filtrar o dia</span>
              </SectionTitle>
              <div className="evo">
                {aTrend.bars.map((b) => {
                  const active = !!(
                    (alarmWindow && alarmWindow.from === b.dayStart) ||
                    selDay === b.dayStart
                  );
                  return (
                    <button
                      type="button"
                      className={`evo-col clk ${active ? "sel" : ""}`}
                      key={b.dayStart}
                      title={`${b.label} · ${b.count} alarme(s)`}
                      onClick={() => pickDay(b.dayStart, b.label)}
                      aria-pressed={active}
                    >
                      <div
                        className={`evo-bar ${b.critical > 0 ? "crit" : ""}`}
                        style={{
                          height: `${Math.max(2, Math.round((b.count / aTrend.max) * 100))}%`,
                        }}
                      />
                      <span className="evo-lbl">{b.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="panel">
              <SectionTitle>
                Quando — prioridade × hora{" "}
                <span className="muted text-[11px] font-normal">— clique p/ filtrar a hora</span>
              </SectionTitle>
              <Heatmap
                rows={aHeat.rows.map((row) => ({
                  key: row.priority,
                  label: PRIORITY_LABEL[row.priority],
                  title: PRIORITY_LABEL[row.priority],
                  hours: row.hours,
                }))}
                cellColor={(row, v) => alarmHeatColor(row.key as AlarmPriority, v, aHeat.max)}
                cellTitle={(row, v, h) =>
                  `${PRIORITY_LABEL[row.key as AlarmPriority]} · ${String(h).padStart(2, "0")}h · ${v} alarme(s)`
                }
                legendLeft="menos"
                legendRight="mais alarmes"
                onCellClick={(_, h) => pickHour(h)}
                isCellSelected={(_, h) => alarmHour === h || selHour === h}
              />
            </section>
          </div>
          <section className="panel panel-events">
            <div className="alarm-toolbar">
              <SectionTitle flush>Eventos ({alarmsView.length})</SectionTitle>
              {(alarmWindow || alarmHour != null) && (
                <span className="alarm-windownote">
                  {alarmWindow
                    ? `Dia ${alarmWindow.label}`
                    : `${String(alarmHour).padStart(2, "0")}h`}
                  <button className="linkbtn" onClick={clearAlarmSel}>
                    limpar
                  </button>
                </span>
              )}
            </div>
            <ScrollArea className="alarm-list-scroll">
              <div className="alarm-list">
                {alarmsView.map((e) => (
                  <button
                    type="button"
                    key={e.id}
                    className={`alarm-card prio-${e.priority} ${selAlarm === e.id ? "sel" : ""}`}
                    onClick={() => pickAlarm(e.id)}
                    aria-pressed={selAlarm === e.id}
                  >
                    <span className="alarm-time">{new Date(e.ts).toLocaleString("pt-BR")}</span>
                    <span className="alarm-body">
                      <span className="alarm-text">{e.text}</span>
                      <span className="alarm-loc">
                        <span>{e.cameraLabel ?? e.cameraId ?? "câmera —"}</span>
                        {e.zona ? (
                          <>
                            <span className="sep">·</span>
                            <span>{e.zona}</span>
                          </>
                        ) : null}
                        <span className="sep">·</span>
                        <span>{e.tipo}</span>
                        {e.ackBy ? (
                          <>
                            <span className="sep">·</span>
                            <span>por {e.ackBy}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="alarm-badges">
                      <span className={`alarm-badge b-${e.priority}`}>
                        {PRIORITY_LABEL[e.priority]}
                      </span>
                      <span className={`alarm-badge s-${e.state}`}>{STATE_LABEL[e.state]}</span>
                    </span>
                  </button>
                ))}
                {alarmsView.length === 0 && (
                  <p className="empty-note">Nenhum alarme com os filtros atuais.</p>
                )}
              </div>
            </ScrollArea>
          </section>
          <div className="rep-foot">
            Eventos de alarme (B1) · só metadados, sem imagens (LGPD) ·{" "}
            <button onClick={onRefresh} className="linkbtn">
              recarregar
            </button>
          </div>
        </>
      )}
    </>
  );
}
