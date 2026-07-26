import { type RefObject } from "react";
import { Bell } from "lucide-react";
import { alarmKpis, alarmTrend, alarmHeatmap, type AlarmWindow } from "../../report/calc";
import {
  ALARM_PRIORITY_LABEL,
  ALARM_STATE_LABEL,
  alarmPriorityColor,
  type AlarmEvent,
  type AlarmPriority,
  type AlarmState,
} from "../../types/alarm";
import { Alert, Badge, EmptyState, ScrollArea, type Tone } from "../../ui";
import { RepLens, HistoryFooter, Insight, SectionTitle } from "./chrome";
import { useAlarmsLoadMeta, type AlarmsLoadMeta } from "./useReportData";
import { KpiRow, Kpi } from "./KpiRow";
import { Heatmap } from "./Heatmap";
import { TrendSection } from "./TrendChart";

// Rampa do heatmap sobre o TOKEN da prioridade (sem RGB cru): intensidade 18%..100%
// via color-mix — célula vazia fica transparente (mesma leitura do heatColor comum).
function alarmHeatColor(priority: AlarmPriority, v: number, max: number): string {
  if (v <= 0) return "transparent";
  const t = 0.18 + Math.min(1, v / max) * 0.82;
  return `color-mix(in srgb, ${alarmPriorityColor(priority)} ${Math.round(t * 100)}%, transparent)`;
}

// Badge do padrão da casa em vez dos spans .alarm-badge (contrato compartilhado do laudo).
// Mapa preserva a leitura de cor atual do CSS: crítico→critical, alta→warn, informativo→info;
// estado novo→neutro (default), reconhecido→ok, encaminhado→info.
const PRIO_TONE: Record<AlarmPriority, Tone> = {
  critical: "alert",
  high: "warn",
  advisory: "info",
};
const STATE_TONE: Record<AlarmState, Tone | undefined> = {
  new: undefined, // neutro → tom default do Badge
  acknowledged: "ok",
  forwarded: "info",
};

// ── Aviso de COBERTURA da carga (bug B3) ──────────────────────────────────────────────────────
// KPI, tendência e mapa de horas são calculados sobre a lista QUE CHEGOU. Se ela veio cortada
// (limit) ou se a retenção do servidor já descartou o começo do período, os números abaixo
// SUBCONTAM — e subcontar calado é pior que não mostrar. Aqui o teto vira texto.
// Exportado p/ teste (renderToStaticMarkup, molde da casa).
export function alarmsLoadWarnings(meta: AlarmsLoadMeta): string[] {
  const w: string[] = [];
  if (meta.truncated === true && meta.total != null)
    w.push(
      `Mostrando os ${meta.limit} alarmes mais recentes de ${meta.total} no período consultado — os números abaixo (KPIs, tendência e mapa de horas) cobrem só esses ${meta.limit}.`,
    );
  else if (meta.truncated === null)
    w.push(
      `O servidor não informou o total de alarmes: a lista pode estar cortada em ${meta.limit} — os números abaixo podem subcontar.`,
    );
  if (meta.retentionClipped)
    w.push(
      `A fila do servidor guarda no máximo ${meta.retention ?? "N"} alarmes e o período consultado começa antes do mais antigo guardado: eventos mais antigos já foram descartados.`,
    );
  return w;
}

export function AlarmsLoadNote({ meta }: { meta: AlarmsLoadMeta }) {
  const warnings = alarmsLoadWarnings(meta);
  if (warnings.length === 0) return null;
  return (
    <Alert tone="warn">
      <span className="flex flex-col gap-1">
        {warnings.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </span>
    </Alert>
  );
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
}) {
  const lens =
    `Alarmes · ${periodLabel}` +
    (alarmPriority !== "Todas" ? ` · ${ALARM_PRIORITY_LABEL[alarmPriority]}` : "") +
    (alarmState !== "Todos" ? ` · ${ALARM_STATE_LABEL[alarmState]}` : "");
  // Cobertura da carga (não é estado do modo — vem da carga única do relatório).
  const loadMeta = useAlarmsLoadMeta();
  return (
    <>
      <RepLens lens={lens} />
      <AlarmsLoadNote meta={loadMeta} />
      {alarms.length === 0 ? (
        <EmptyState>
          <b>Sem alarmes registrados.</b>
          <p>A fila de alarmes aparece aqui conforme a política dispara eventos na Central.</p>
          <p className="muted">
            Apenas metadados (hora, câmera/zona, tipo, prioridade, estado) — sem imagens (LGPD).
          </p>
        </EmptyState>
      ) : (
        <>
          <KpiRow fit>
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
          <Insight label="Alarmes" tips={aTips} icon={Bell} />
          <div className="rep-2col" ref={trendRef}>
            {/* A MESMA peça dos outros modos (era a 5ª reimplementação à mão) — aqui com as
                barras clicáveis (filtro do dia). O título "Tendência (14 dias)" é contrato. */}
            <TrendSection
              fill={false}
              hint="clique p/ filtrar o dia"
              bars={aTrend.bars.map((b) => ({
                key: b.dayStart,
                label: b.label,
                value: b.count,
                title: `${b.label} · ${b.count} alarme(s)`,
                critical: b.critical > 0,
              }))}
              max={aTrend.max}
              onPick={(b) => pickDay(Number(b.key), b.label)}
              isSelected={(b) => alarmWindow?.from === b.key || selDay === b.key}
            />
            <section className="panel">
              <SectionTitle>
                Quando — prioridade × hora{" "}
                <span className="muted text-label font-normal">— clique p/ filtrar a hora</span>
              </SectionTitle>
              <Heatmap
                rows={aHeat.rows.map((row) => ({
                  key: row.priority,
                  label: ALARM_PRIORITY_LABEL[row.priority],
                  title: ALARM_PRIORITY_LABEL[row.priority],
                  hours: row.hours,
                }))}
                cellColor={(row, v) => alarmHeatColor(row.key as AlarmPriority, v, aHeat.max)}
                cellTitle={(row, v, h) =>
                  `${ALARM_PRIORITY_LABEL[row.key as AlarmPriority]} · ${String(h).padStart(2, "0")}h · ${v} alarme(s)`
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
                      <Badge tone={PRIO_TONE[e.priority]}>
                        {ALARM_PRIORITY_LABEL[e.priority]}
                      </Badge>
                      <Badge tone={STATE_TONE[e.state]}>{ALARM_STATE_LABEL[e.state]}</Badge>
                    </span>
                  </button>
                ))}
                {alarmsView.length === 0 && (
                  <EmptyState>Nenhum alarme com os filtros atuais.</EmptyState>
                )}
              </div>
            </ScrollArea>
          </section>
          <HistoryFooter />
        </>
      )}
    </>
  );
}
