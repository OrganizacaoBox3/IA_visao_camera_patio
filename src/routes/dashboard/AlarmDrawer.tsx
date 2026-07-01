import { useMemo, useState } from "react";
import { Button, Checkbox, Select, Dialog, Tooltip, ScrollArea } from "../../ui";
import { type AlarmEvent, type AlarmPriority, type AlarmState } from "../../api";

// Prioridade → token de cor (going-gray): advisory=info(azul), high=warn(amarelo), critical=critical(vermelho).
function prioColor(p: AlarmPriority): string {
  return p === "critical"
    ? "var(--state-critical)"
    : p === "high"
      ? "var(--state-warn)"
      : "var(--state-info)";
}
function prioBorder(p: AlarmPriority): string {
  return p === "critical"
    ? "var(--state-critical-border)"
    : p === "high"
      ? "var(--state-warn-border)"
      : "var(--state-info-border)";
}
const PRIO_LABEL: Record<AlarmPriority, string> = {
  advisory: "informativo",
  high: "alta",
  critical: "crítico",
};
const STATE_LABEL: Record<AlarmState, string> = {
  new: "novo",
  acknowledged: "reconhecido",
  forwarded: "encaminhado",
};

type AlarmDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alarms: AlarmEvent[];
  newCount: number;
  onAct: (a: AlarmEvent, kind: "ack" | "forward") => void;
};

// Fila de alarmes acionável (Onda B · item 7) — drawer/sheet via Dialog (Radix):
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
        className="alarm-card"
        data-done={done ? 1 : 0}
        style={{ borderLeftColor: prioBorder(a.priority) }}
      >
        <div className="alarm-card__top">
          <span className="alarm-card__dot" style={{ background: prioColor(a.priority) }} />
          <span className="alarm-card__prio" style={{ color: prioColor(a.priority) }}>
            {PRIO_LABEL[a.priority]}
          </span>
          <Tooltip content={new Date(a.ts).toLocaleString("pt-BR")}>
            <span className="alarm-card__time">{when}</span>
          </Tooltip>
        </div>
        <div className="alarm-card__text">{a.text}</div>
        <div className="alarm-card__meta">
          {local && (
            <span>
              📍 {local}
              {a.zona && a.zona !== local ? ` · ${a.zona}` : ""}
            </span>
          )}
          <span>{a.tipo}</span>
          <span className="alarm-card__state">
            {STATE_LABEL[a.state]}
            {a.ackBy ? ` · ${a.ackBy}` : ""}
          </span>
        </div>
        {!done && (
          <div className="alarm-card__actions">
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
          Fila de alarmes{" "}
          <span className="alarm-drawer__count" data-zero={newCount === 0 ? 1 : 0}>
            {newCount} novo(s)
          </span>
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
            <p className="alarm-drawer__empty">
              {alarms.length === 0
                ? "Nenhum alarme registrado."
                : "Nenhum alarme para os filtros atuais."}
            </p>
          ) : (
            visibleAlarms.map(renderAlarmCard)
          )}
        </div>
      </ScrollArea>
    </Dialog>
  );
}
