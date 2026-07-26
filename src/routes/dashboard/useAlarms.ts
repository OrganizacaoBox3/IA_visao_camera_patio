// Fila de alarmes acionável (extraída do god-component DashboardPage — auditoria §S1). Onda B ·
// item 7. Consome o backend B1 (só metadados, LGPD): carga inicial + derivados glanceable (novos,
// prioridade máxima) + ack/forward otimista. Os alarmes AO VIVO entram por socket (setAlarms é
// exposto ao useDashboardSocket). Comportamento byte-a-byte do original.
//
// ── NOTIFICAÇÃO INTERRUPTIVA DE CRÍTICO (ISA-18.2/EEMUA-191 · ADR-004) ─────────────────────────
// Antes desta onda, um `alarm-event` crítico (zona restrita violada — o alarme mais grave que o
// produto gera, 24/7 pelo motor do hub) só empilhava na fila: o único realce era o contador no
// botão, que pode estar fora do campo de visão. Agora um crítico TOASTA e ABRE o drawer.
//
// FRONTEIRA COM A POLÍTICA DO SERVIDOR — o que este arquivo NÃO faz (e por quê):
//   Quando um `alarm-event` chega no fio, a decisão JÁ passou pelo caminho único de
//   `server/alarm/pipeline.js` → `alarmPolicy.evaluate()`: shelving (silêncio de manutenção),
//   gate de turno (`alarm/shift.js`), dedup temporal por chave `câmera|zona|tipo`
//   (ALARM_DEDUP_MS = 60 s), anti-flapping (`alarm/flap.js`) e supressão de inundação
//   (`alarm/flood.js`). Evento no fio = política já deixou passar. O cliente NÃO redecide SE o
//   alarme existe — decide só COMO apresentá-lo.
//   O único agrupamento que o servidor não pode fazer é o da rajada ENTRE CÂMERAS: a janela de
//   `flood.js` é contada POR `cameraId`, então 5 câmeras violando ao mesmo tempo produzem 5
//   eventos legítimos, cada um abaixo do limiar da sua câmera. Empilhar 5 toasts é inútil — a
//   janela de rajada abaixo é APRESENTAÇÃO (quantos cartões flutuantes), nunca supressão: todos
//   os alarmes entram na fila/drawer intactos.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// ── Rajada de críticos: janela de agrupamento (ms) ────────────────────────────────────────────
// Leading-edge: o PRIMEIRO crítico toasta na hora (latência zero — é o requisito do alarme), e o
// que chegar nos CRITICAL_BURST_MS seguintes vira UM resumo no fim da janela. Teto provado por
// teste: no máximo 2 toasts por rajada, quaisquer que sejam N câmeras. Não é throttle "esperar
// para falar" (isso atrasaria justamente o alarme mais grave).
export const CRITICAL_BURST_MS = 2500;

// Teto de ids memorizados pelo guarda de idempotência (ver createCriticalBurst).
const SEEN_CAP = 400;

/** Corta o texto para caber no cartão do toast sem virar parede (o detalhe vive no drawer). */
function clampText(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Texto do toast de um alarme crítico. O `text` do servidor já vem com o rótulo da câmera
 * ("⚠ Doca 3: presença em área proibida (Zona X) há 12s") — o marcador inicial é removido porque
 * o prefixo "Alarme crítico" (+ a faixa vermelha do tom `alert`) já diz o que ele dizia, e cor
 * sozinha não é informação acessível. Puro/testável.
 */
export function criticalToastText(a: AlarmEvent): string {
  const raw = String(a.text || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const local = a.cameraLabel || a.cameraId || a.zona || "";
  const body = raw || [local, a.tipo].filter(Boolean).join(" · ") || "sem descrição";
  return `Alarme crítico · ${clampText(body)}`;
}

/**
 * Alarmes que CHEGARAM AGORA e exigem interrupção: prioridade `critical` E estado `new` E ausentes
 * da lista anterior. Puro/testável.
 *   • `state === "new"`: o socket `alarm-update` (ack/forward feito em outro posto) também passa
 *     por este caminho e pode PREPENDAR um alarme que este dashboard nunca viu — reconhecido por
 *     outro operador não é alarme novo, não interrompe.
 *   • diff contra `prev`: a CARGA INICIAL (histórico via listAlarms) não passa por aqui — ver o
 *     setter embrulhado —, mas o diff garante que re-render/reemissão do mesmo id não vira toast.
 */
export function criticalArrivals(
  prev: readonly AlarmEvent[],
  next: readonly AlarmEvent[],
): AlarmEvent[] {
  const before = new Set(prev.map((a) => a.id));
  return next.filter((a) => a.priority === "critical" && a.state === "new" && !before.has(a.id));
}

/** Agrupador de rajada (stateful, fora do React para ser testável sem DOM). */
export type CriticalBurst = {
  /** Entrega os críticos recém-chegados. Idempotente por id. */
  push: (items: readonly AlarmEvent[]) => void;
  /** Cancela o resumo pendente (cleanup do hook). NÃO invalida o objeto. */
  dispose: () => void;
};

/**
 * Cria o agrupador de rajada de críticos.
 *  - leading edge: 1º crítico da janela → toast imediato com o texto dele;
 *  - resto da janela → represado e resumido em UM toast ("Mais N alarmes críticos na fila.");
 *  - `onCritical` (abrir o drawer) só no leading edge de cada chegada nova.
 * `push` é IDEMPOTENTE por id (Set `seen`): é isso que torna seguro chamá-lo de dentro de um
 * updater de useState — o React 19 em StrictMode invoca o updater duas vezes, e a segunda não
 * pode virar um segundo toast.
 */
export function createCriticalBurst(opts: {
  toast: (msg: string, tone?: ToastTone) => void;
  onCritical?: () => void;
  windowMs?: number;
}): CriticalBurst {
  const windowMs = opts.windowMs ?? CRITICAL_BURST_MS;
  const seen = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = 0; // críticos represados na janela corrente

  function flush() {
    timer = null;
    const n = held;
    held = 0;
    if (n <= 0) return;
    opts.toast(
      n === 1 ? "Mais 1 alarme crítico na fila." : `Mais ${n} alarmes críticos na fila.`,
      "alert",
    );
  }

  return {
    push(items) {
      const fresh = items.filter((a) => !seen.has(a.id));
      if (!fresh.length) return;
      for (const a of fresh) seen.add(a.id);
      // Poda por ordem de inserção (Set preserva): memória limitada sem perder os recentes.
      if (seen.size > SEEN_CAP)
        for (const id of seen) {
          if (seen.size <= SEEN_CAP) break;
          seen.delete(id);
        }
      opts.onCritical?.(); // leva o operador ao lugar onde se reconhece/encaminha
      if (timer === null) {
        opts.toast(criticalToastText(fresh[0]), "alert");
        held = fresh.length - 1;
        timer = setTimeout(flush, windowMs);
      } else {
        held += fresh.length;
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      held = 0;
    },
  };
}

/** Cola entre o diff e o agrupador — é EXATAMENTE o corpo do setter embrulhado (ver useAlarms). */
export function notifyCriticalArrivals(
  prev: readonly AlarmEvent[],
  next: readonly AlarmEvent[],
  burst: CriticalBurst,
): void {
  const arrivals = criticalArrivals(prev, next);
  if (arrivals.length) burst.push(arrivals);
}

export function useAlarms(
  usuario: string,
  toast: (msg: string, tone?: ToastTone) => void,
): Alarms {
  // ── Fila de alarmes acionável (Onda B · item 7) — consome o backend B1 (só metadados, LGPD) ──
  const [alarms, setAlarmsState] = useState<AlarmEvent[]>([]);
  const [alarmsOpen, setAlarmsOpen] = useState(false);

  // O agrupador vive num ref (não é estado: não pinta nada) e lê o `toast` MAIS RECENTE por
  // indireção — assim ele é criado uma vez só e nunca fica com um closure velho.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  const burstRef = useRef<CriticalBurst | null>(null);
  if (burstRef.current === null)
    burstRef.current = createCriticalBurst({
      toast: (m, t) => toastRef.current(m, t),
      // Único destino barato: o drawer (a fila onde se reconhece/encaminha). Abrir a CÂMERA
      // exigiria o setOpenId do DashboardPage, que não é desta frente.
      onCritical: () => setAlarmsOpen(true),
    });
  useEffect(
    () => () => {
      burstRef.current?.dispose();
    },
    [],
  );

  // Setter EXPOSTO (é o que o useDashboardSocket recebe): mesma assinatura do useState, mais o
  // diff que dispara a notificação de crítico. Os setters INTERNOS (carga inicial, ack/forward)
  // usam `setAlarmsState` de propósito — carga inicial é HISTÓRICO, não chegada: 200 alarmes
  // antigos jamais podem virar 200 toasts no login.
  const setAlarms = useCallback<React.Dispatch<React.SetStateAction<AlarmEvent[]>>>((action) => {
    setAlarmsState((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      // Efeito dentro do updater: seguro porque `push` é idempotente por id (ver createCriticalBurst).
      notifyCriticalArrivals(prev, next, burstRef.current!);
      return next;
    });
  }, []);

  // Carga inicial da fila de alarmes (ts desc); ao vivo entra pelos sockets. Falha não quebra a central.
  useEffect(() => {
    let alive = true;
    listAlarms({ limit: 200 })
      .then((list) => {
        if (alive) setAlarmsState(list);
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
    setAlarmsState((prev) =>
      prev.map((x) =>
        x.id === a.id ? { ...x, state: optimistic, ackBy: usuario, ackAt: Date.now() } : x,
      ),
    );
    try {
      const updated = await (kind === "ack"
        ? ackAlarm(a.id, usuario)
        : forwardAlarm(a.id, usuario));
      setAlarmsState((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
      toast(kind === "ack" ? "Alarme reconhecido." : "Alarme encaminhado.", "ok");
    } catch (e) {
      setAlarmsState((prev) =>
        prev.map((x) =>
          x.id === a.id ? { ...x, state: prevState, ackBy: undefined, ackAt: undefined } : x,
        ),
      ); // rollback
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar o alarme.", "alert");
    }
  }

  return { alarms, setAlarms, alarmsOpen, setAlarmsOpen, newCount, topNewPriority, actOnAlarm };
}
