// Pipeline de alarme — o caminho único decisão → canais → persistência → broadcast.
// Entra o payload do socket "alert" ({ text, ts?, cameraId?, zona?, tipo? }); a política
// decide UMA vez (evaluate → null = suprimido) e a MESMA decisão é roteada:
//   1) alerts.notify          — webhook Andon;
//   2) dispatch.dispatchAlert — WhatsApp (filtros por destinatário);
//   3) events.record          — fila acionável (SÓ METADADOS — LGPD/ADR-002);
//   4) io "alarm-event"       — painéis ao vivo (contrato ADITIVO).
// Nenhum canal decide sozinho (ADR-004): dedup/flood/prioridade/shelve moram na política.
const alarmPolicy = require("../alarmPolicy");
const alerts = require("../alerts");
const dispatch = require("../dispatch");
const events = require("../events");

/**
 * Avalia e roteia um alerta. Nunca rejeita: falha de persistência é logada e engolida
 * (o caminho de notificação não pode derrubar o handler de socket).
 * @param {{text:string, ts?:number, cameraId?:string, zona?:string, tipo?:string}} p
 * @param {{cameras: Map<string, {id:string, label?:string}>, io: {to:Function}}} ctx
 * @param {{evaluate?:Function, notify?:Function, dispatchAlert?:Function, record?:Function}} [deps]
 *        Injeção SÓ para teste (fakes sem socket); em produção use os defaults.
 * @returns {Promise<object|null>} o evento gravado, ou null quando suprimido/falhou.
 */
function handleAlert(p, { cameras, io }, deps = {}) {
  const evaluate = deps.evaluate || alarmPolicy.evaluate;
  const notify = deps.notify || alerts.notify;
  const dispatchAlert = deps.dispatchAlert || dispatch.dispatchAlert;
  const record = deps.record || events.record;

  const d = evaluate(p);
  if (!d) return Promise.resolve(null);
  notify(d);
  if (d.text) dispatchAlert(d.text, d.ts, d.priority);
  const cam = d.cameraId && d.cameraId !== "_" ? cameras.get(d.cameraId) : null;
  return record({
    ts: d.ts,
    cameraId: d.cameraId,
    cameraLabel: cam ? cam.label : undefined,
    zona: d.zona,
    tipo: d.tipo,
    priority: d.priority,
    text: d.text,
  })
    .then((ev) => {
      if (ev) io.to("dashboards").emit("alarm-event", ev);
      return ev || null;
    })
    .catch((e) => {
      console.error("[alarm-events] falha ao gravar:", e.message);
      return null;
    });
}

module.exports = { handleAlert };
