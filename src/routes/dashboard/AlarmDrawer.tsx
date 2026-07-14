import { useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import { Button, Checkbox, Select, Dialog, Tooltip, ScrollArea, Badge, StatusDot, EmptyState, type Tone } from "../../ui";
import { type AlarmEvent, type AlarmPriority, type AlarmState } from "../../api";
// Rótulos/cores por prioridade/estado: fonte única em types/alarm.ts.
import {
  ALARM_PRIORITY_LABEL,
  ALARM_STATE_LABEL,
  alarmPriorityColor,
  alarmPriorityBorder,
} from "../../types/alarm";

// Tom do <Badge> por prioridade/estado — MESMO mapa do contrato (bate com o AlarmesPanel do
// Relatório e preserva as cores do CSS antigo: critical=crítico, high=warn, advisory/forwarded=info,
// acknowledged=ok, new=neutro/default). Going-gray: cor só onde há anormalidade.
const PRIORITY_TONE: Record<AlarmPriority, Tone> = {
  critical: "alert",
  high: "warn",
  advisory: "info",
};
const STATE_TONE: Record<AlarmState, Tone | undefined> = {
  new: undefined, // neutro (default) — estado normal de entrada na fila
  acknowledged: "ok",
  forwarded: "info",
};

type AlarmDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alarms: AlarmEvent[];
  newCount: number;
  onAct: (a: AlarmEvent, kind: "ack" | "forward") => void;
};

// Fila de alarmes acionável — drawer/sheet via Dialog (Radix):
// foco preso, ESC e portal "de graça"; o .ui-dialog é reposicionado como sheet
// lateral (e bottom-sheet no mobile) em alarms.css, escopado por :has(.alarm-drawer__list)
// para não afetar os demais diálogos. Filtros de exibição (prioridade/estado/ocultar
// reconhecidos) são locais deste drawer (não apagam nada no servidor).
export function AlarmDrawer({ open, onOpenChange, alarms, newCount, onAct }: AlarmDrawerProps) {
  const [fPriority, setFPriority] = useState<"all" | AlarmPriority>("all");
  const [fState, setFState] = useState<"all" | AlarmState>("all");
  const [hideAcked, setHideAcked] = useState(false); // só filtro de exibição (não apaga no servidor)

  // Lista visível = filtros de prioridade/estado + "ocultar reconhecidos" (só exibição). Mantém ts desc.
  const visibleAlarms = useMemo(
    () =>
      alarms.filter(
        (a) =>
          (fPriority === "all" || a.priority === fPriority) &&
          (fState === "all" || a.state === fState) &&
          (!hideAcked || a.state === "new"),
      ),
    [alarms, fPriority, fState, hideAcked],
  );

  function renderAlarmCard(a: AlarmEvent) {
    const done = a.state !== "new";
    const when = new Date(a.ts).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const local = a.cameraLabel || a.cameraId || a.zona;
    return (
      <div
        key={a.id}
        className="alarm-drawer__card"
        data-done={done ? 1 : 0}
        style={{ borderLeftColor: alarmPriorityBorder(a.priority) }}
      >
        <div className="alarm-drawer__card-top">
          <StatusDot
            color={alarmPriorityColor(a.priority)}
            label={ALARM_PRIORITY_LABEL[a.priority]}
          />
          <Badge tone={PRIORITY_TONE[a.priority]}>{ALARM_PRIORITY_LABEL[a.priority]}</Badge>
          <Tooltip content={new Date(a.ts).toLocaleString("pt-BR")}>
            <span className="alarm-drawer__card-time">{when}</span>
          </Tooltip>
        </div>
        <div className="alarm-drawer__card-text">{a.text}</div>
        <div className="alarm-drawer__card-meta">
          {local && (
            <span className="alarm-drawer__card-loc">
              <MapPin size={12} strokeWidth={1.75} aria-hidden />
              {local}
              {a.zona && a.zona !== local ? ` · ${a.zona}` : ""}
            </span>
          )}
          <span>{a.tipo}</span>
          <Badge tone={STATE_TONE[a.state]}>
            {ALARM_STATE_LABEL[a.state]}
            {a.ackBy ? ` · ${a.ackBy}` : ""}
          </Badge>
        </div>
        {!done && (
          <div className="alarm-drawer__card-actions">
            <Tooltip content="Reconhecer (assumir o alarme)">
              <Button size="sm" variant="primary" onClick={() => onAct(a, "ack")}>
                Reconhecer
              </Button>
            </Tooltip>
            <Tooltip content="Encaminhar a outro operador">
              <Button size="sm" onClick={() => onAct(a, "forward")}>
                Encaminhar
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          Fila de alarmes
          {/* Pluralização real; zero novos = sem contador (auditoria 3.3). */}
          {newCount > 0 && (
            <span className="alarm-drawer__count">
              {newCount === 1 ? "1 novo" : `${newCount} novos`}
            </span>
          )}
        </>
      }
    >
      <div className="alarm-drawer__filters">
        <Select
          value={fPriority}
          onChange={(v) => setFPriority(v as "all" | AlarmPriority)}
          ariaLabel="Filtrar por prioridade"
          options={[
            { value: "all", label: "Toda prioridade" },
            { value: "critical", label: "Crítico" },
            { value: "high", label: "Alta" },
            { value: "advisory", label: "Informativo" },
          ]}
        />
        <Select
          value={fState}
          onChange={(v) => setFState(v as "all" | AlarmState)}
          ariaLabel="Filtrar por estado"
          options={[
            { value: "all", label: "Todo estado" },
            { value: "new", label: "Novos" },
            { value: "acknowledged", label: "Reconhecidos" },
            { value: "forwarded", label: "Encaminhados" },
          ]}
        />
        <label>
          <Checkbox
            checked={hideAcked}
            onCheckedChange={setHideAcked}
            ariaLabel="Ocultar reconhecidos"
          />{" "}
          Limpar reconhecidos
        </label>
      </div>
      <ScrollArea className="alarm-drawer__scroll">
        <div className="alarm-drawer__list">
          {visibleAlarms.length === 0 ? (
            <EmptyState>
              {alarms.length === 0
                ? "Nenhum alarme registrado."
                : "Nenhum alarme para os filtros atuais."}
            </EmptyState>
          ) : (
            visibleAlarms.map(renderAlarmCard)
          )}
        </div>
      </ScrollArea>
    </Dialog>
  );
}
