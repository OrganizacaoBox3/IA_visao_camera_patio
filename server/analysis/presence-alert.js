// ─────────────────────────────────────────────────────────────────────────────
// presence-alert.js — PRODUTOR server-side do alarme de PRESENÇA em zona
// proibida (spec-alerta-por-atividade §3 F2). Máquina de estados POR zona
// (modo "proibida" no camcfg — campos aditivos presencaAlertMs/arming):
//   ARMADA → (pessoa na zona por ≥ presencaAlertMs contínuos)  → VIOLADA
//   VIOLADA → (zona vazia contínua por ≥ off-delay, histerese) → ARMADA
// A violação chama o pipeline de alarme DIRETO no hub (deps.raiseAlarm →
// alarm/pipeline.handleAlert) — a câmera fica coberta 24/7 SEM dashboard aberto
// (CA-4 da spec; é o ponto da diretriz "lógica no back"). O caminho a jusante
// (dedup/flap/flood/shelve/canais/alarm-event) é agnóstico a tipo e intocado.
//
// SEMÂNTICA COM O GATE DE MOVIMENTO (decisão de design): observe() só roda em
// rodadas de INFERÊNCIA (processRound). Rodada PULADA pelo gate significa "a
// cena não mudou" → o estado usa o último valor OBSERVADO e o dwell NÃO reseta
// (pessoa PARADA dentro da zona: o piso de probe do gate — ≤6s — traz a próxima
// observação e o relógio do dwell segue contando de presentSince; observações
// esparsas somam permanência, não zeram). Flicker de detecção de 1 rodada é
// amortecido pela graça LOST do tracker; piscada mais longa não fecha/reabre a
// violação graças ao off-delay (max(5000, dwell/2)).
//
// UM EVENTO POR VIOLAÇÃO: raiseAlarm dispara UMA vez na transição
// ARMADA→VIOLADA; enquanto VIOLADA só a duração interna (durationMs) atualiza —
// re-notificação NÃO re-alerta. Mesmo que um produtor re-chamasse, o dedup da
// política (chave cam|zona|tipo, janela ALARM_DEDUP_MS=60s) seguraria a repetição.
//
// ARMING: nesta onda toda zona proibida é tratada como armada 24/7 (o contrato
// pina arming default "sempre"); o gate por turno (F3 da spec) mora em
// alarm/shift.js na POLÍTICA, não aqui — o produtor sempre produz, a política
// suprime. LGPD: só metadados (labels/timestamps) — nenhum frame passa por aqui.
//
// PROJEÇÃO (Onda B): stateOf(st) é o getter PURO do estado por zona — o
// pipeline o usa p/ montar o campo aditivo `zonesProibidas` do analysis-tracks
// (o fio que acende VIOLADA no canvas). Só leitura; a máquina não muda.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { attributeZone } = require("./zones");

// Dwell default quando a zona não traz presencaAlertMs (contrato pinado da spec E2).
const DWELL_DEFAULT_MS = 10_000;

// Off-delay da histerese de saída: nunca menor que 5s (flicker de detecção não
// fecha/reabre o evento), escalando com metade do dwell p/ zonas de dwell longo.
function offDelayMs(dwellMs) {
  return Math.max(5000, dwellMs / 2);
}

// Dwell efetivo da zona (leitura DEFENSIVA — config legada/ausente cai no default).
function dwellMsOf(zone) {
  const v = zone ? zone.presencaAlertMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DWELL_DEFAULT_MS;
}

/**
 * @param {object} deps
 * @param {(p: {text:string, ts:number, cameraId:string, cameraLabel:string, zona:string, tipo:string}) => void} deps.raiseAlarm
 *        entrada do pipeline de alarme server-side (o engine liga em alarm/pipeline.handleAlert)
 * @param {(cameraId:string) => string} deps.cameraLabelOf  label da câmera p/ o texto do alerta
 */
function createPresenceAlert({ raiseAlarm, cameraLabelOf }) {
  /**
   * Uma OBSERVAÇÃO (rodada de inferência) de uma câmera: conta pessoas por zona
   * proibida e avança a máquina de estados. MUTA st.presence (Map zoneId → estado
   * { state:"armada"|"violada", presentSince, absentSince, violatedAt, durationMs,
   *   people }).
   * @param {{id:string, zonesProib?:Array, presence?:Map}} st  estado por câmera (engine.createState)
   * @param {Array<{bbox:number[]}>} tracks  tracks EMITÍVEIS da rodada (pós-política LOST)
   * @param {number} now  timestamp da rodada
   */
  function observe(st, tracks, now) {
    const zones = st.zonesProib || [];
    if (!zones.length) {
      if (st.presence && st.presence.size) st.presence.clear(); // config removeu todas → esquece tudo
      return;
    }
    if (!st.presence) st.presence = new Map();
    const seen = new Set();
    for (const z of zones) {
      seen.add(z.id);
      // Contagem INDEPENDENTE por zona (mesmo critério do attributeZone: centro do
      // bbox + máscara) — zonas proibidas SOBREPOSTAS veem a mesma pessoa cada uma
      // (violação é por zona; o desempate do attributeZone serve à atribuição
      // exclusiva das zonas de atividade, não à vigilância).
      let people = 0;
      for (const t of tracks) if (attributeZone(t.bbox, [z]) !== null) people += 1;
      let m = st.presence.get(z.id);
      if (!m) {
        m = { state: "armada", presentSince: null, absentSince: null, violatedAt: 0, durationMs: 0, people: 0 };
        st.presence.set(z.id, m);
      }
      m.people = people; // contagem OBSERVADA da rodada — só projeção (stateOf), não decide transição
      const dwellMs = dwellMsOf(z);
      if (m.state === "armada") {
        if (people >= 1) {
          if (m.presentSince == null) m.presentSince = now; // 1ª observação com gente — âncora do dwell
          if (now - m.presentSince >= dwellMs) {
            // ARMADA → VIOLADA: UM alerta por violação (ver cabeçalho).
            m.state = "violada";
            m.violatedAt = m.presentSince; // a violação conta desde o INÍCIO da permanência
            m.durationMs = now - m.presentSince;
            m.absentSince = null;
            const cameraLabel = cameraLabelOf(st.id);
            raiseAlarm({
              text: `⚠ ${cameraLabel}: presença em área proibida (${z.label}) há ${Math.round(m.durationMs / 1000)}s`,
              ts: now,
              cameraId: st.id,
              cameraLabel,
              zona: z.label,
              tipo: "presenca",
            });
          }
        } else {
          m.presentSince = null; // saiu ANTES do dwell → contador reseta (spec E2: travessia não alerta)
        }
      } else if (people >= 1) {
        m.absentSince = null; // voltou dentro da histerese → o MESMO evento segue aberto
        m.durationMs = now - m.violatedAt; // só a duração interna atualiza (sem novo alerta)
      } else {
        if (m.absentSince == null) m.absentSince = now;
        if (now - m.absentSince >= offDelayMs(dwellMs)) {
          m.state = "armada"; // VIOLADA → ARMADA: vazia contínua pelo off-delay (re-arma)
          m.presentSince = null;
          m.absentSince = null;
        }
      }
    }
    // Recarga de camcfg (kind:"zones"): zona que SAIU da config leva o estado junto
    // (poda por id); a que PERMANECE preserva dwell/violação através da recarga.
    for (const id of st.presence.keys()) if (!seen.has(id)) st.presence.delete(id);
  }

  return { observe };
}

/**
 * Getter PURO do estado por zona proibida — a projeção que o pipeline monta no
 * campo aditivo `zonesProibidas` do analysis-tracks. Só LÊ st.zonesProib (config
 * atual) + st.presence (máquina); não muta nada (nem cria st.presence).
 * `violada` é o ESTADO da máquina, não people>0 cru: pessoa que saiu dentro da
 * histerese ainda projeta violada; permanência aquém do dwell ainda projeta
 * armada. Zona recém-adicionada (ainda não observada) nasce armada com 0.
 * @param {{zonesProib?:Array, presence?:Map}} st  estado por câmera (engine.createState)
 * @returns {Map<string, {violada:boolean, people:number, dwellMs:number}>}
 */
function stateOf(st) {
  const out = new Map();
  for (const z of st.zonesProib || []) {
    const m = st.presence && st.presence.get(z.id);
    out.set(z.id, {
      violada: !!m && m.state === "violada",
      people: (m && m.people) || 0,
      dwellMs: dwellMsOf(z),
    });
  }
  return out;
}

module.exports = { createPresenceAlert, stateOf, offDelayMs, dwellMsOf, DWELL_DEFAULT_MS };
