// Fila de alarmes acionável (extraída do god-component DashboardPage — auditoria §S1). Onda B ·
// item 7. Consome o backend B1 (só metadados, LGPD): carga inicial + derivados glanceable (novos,
// prioridade máxima) + ack/forward otimista. Os alarmes AO VIVO entram por socket (setAlarms é
// exposto ao useDashboardSocket). Comportamento byte-a-byte do original.
import { useEffect, useMemo, useState } from "react";
import {
  listAlarms,
  ackAlarm,
  forwardAlarm,
  ApiError,
  type AlarmEvent,
  type AlarmPriority,
  type AlarmState,
} from "../../api";
import { type ToastTone } from "../../ui";

export type Alarms = {
  alarms: AlarmEvent[];
  setAlarms: React.Dispatch<React.SetStateAction<AlarmEvent[]>>;
  alarmsOpen: boolean;
  setAlarmsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  newCount: number;
  topNewPriority: AlarmPriority;
  actOnAlarm: (a: AlarmEvent, kind: "ack" | "forward") => Promise<void>;
};

export function useAlarms(
  usuario: string,
  toast: (msg: string, tone?: ToastTone) => void,
): Alarms {
  // ── Fila de alarmes acionável (Onda B · item 7) — consome o backend B1 (só metadados, LGPD) ──
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const [alarmsOpen, setAlarmsOpen] = useState(false);

  // Carga inicial da fila de alarmes (ts desc); ao vivo entra pelos sockets. Falha não quebra a central.
  useEffect(() => {
    let alive = true;
    listAlarms({ limit: 200 })
      .then((list) => {
        if (alive) setAlarms(list);
      })
      .catch((e) => {
        console.error("[alarms] carga inicial falhou", e);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Contador de "novos" (estado new) — realce glanceable no cabeçalho. Prioridade máx. entre os novos.
  const newAlarms = useMemo(() => alarms.filter((a) => a.state === "new"), [alarms]);
  const newCount = newAlarms.length;
  const topNewPriority: AlarmPriority = useMemo(
    () =>
      newAlarms.some((a) => a.priority === "critical")
        ? "critical"
        : newAlarms.some((a) => a.priority === "high")
          ? "high"
          : "advisory",
    [newAlarms],
  );

  // Ack/forward otimista: reflete o estado já; confirma com a resposta (e o socket `alarm-update` reforça).
  async function actOnAlarm(a: AlarmEvent, kind: "ack" | "forward") {
    if (a.state !== "new") return; // já tratado
    const prevState = a.state;
    const optimistic: AlarmState = kind === "ack" ? "acknowledged" : "forwarded";
    setAlarms((prev) =>
      prev.map((x) =>
        x.id === a.id ? { ...x, state: optimistic, ackBy: usuario, ackAt: Date.now() } : x,
      ),
    );
    try {
      const updated = await (kind === "ack"
        ? ackAlarm(a.id, usuario)
        : forwardAlarm(a.id, usuario));
      setAlarms((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
      toast(kind === "ack" ? "Alarme reconhecido." : "Alarme encaminhado.", "ok");
    } catch (e) {
      setAlarms((prev) =>
        prev.map((x) =>
          x.id === a.id ? { ...x, state: prevState, ackBy: undefined, ackAt: undefined } : x,
        ),
      ); // rollback
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar o alarme.", "alert");
    }
  }

  return { alarms, setAlarms, alarmsOpen, setAlarmsOpen, newCount, topNewPriority, actOnAlarm };
}
