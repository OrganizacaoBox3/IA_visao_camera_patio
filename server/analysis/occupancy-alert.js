// ─────────────────────────────────────────────────────────────────────────────
// occupancy-alert.js — PRODUTOR server-side do alarme de LOTAÇÃO em zona de
// ATIVIDADE (targetOccupancy/occupancyToleranceMs, campos aditivos do camcfg —
// mesmo par usado pelo modo Objetos no cliente, src/processors/objetos.ts).
// Espelha presence-alert.js byte-a-byte na forma (máquina de estados por zona,
// dwell + histerese de saída, raiseAlarm direto no hub) — só troca o CRITÉRIO
// de entrada: "presença ≥1" vira "contagem ≠ meta".
//
// POR QUE AQUI E NÃO SÓ NO CLIENTE (objetos.ts): a 1ª versão desta feature
// rodava 100% no navegador sobre OWL-ViT (zero-shot). Medido em câmera real
// (loja, pessoas sentadas/parcialmente atrás de balcão, vista de cima): o
// zero-shot não as detectou — confiança abaixo do limiar para essa pose/
// ângulo. A contagem por zona de ATIVIDADE já vem do D-FINE (server-side, o
// MESMO motor avaliado em `npm run eval`), calculada 24/7 mesmo sem painel
// aberto (pipeline.js `perZone`, computado ANTES desta chamada). Mover a
// meta/alerta pra cá troca "depende do navegador + zero-shot" por "depende do
// mesmo motor que já é a fonte de verdade do resto do produto". A versão
// client-side (objetos.ts) continua existindo p/ metas de CLASSES não-pessoa
// (caixa/palete/empilhadeira) — este produtor cobre especificamente pessoa
// em zona de atividade, o caso que realmente precisa de robustez.
//
// UM EVENTO POR VIOLAÇÃO: raiseAlarm dispara UMA vez na transição OK→VIOLADA;
// enquanto VIOLADA só a duração interna atualiza. Fecha (VIOLADA→OK) só após
// a contagem voltar à meta por ≥ off-delay contínuo (histerese — evita
// abrir/fechar em cada rodada quando a contagem oscila ±1 na borda da meta).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Default espelha DEFAULT_OCCUPANCY_TOLERANCE_MS de src/zones.ts — os dois lados
// (cliente e servidor) caem no mesmo valor quando a zona não traz o campo.
const TOLERANCE_DEFAULT_MS = 30_000;

// Off-delay da histerese de saída: mesmo piso/proporção do presence-alert.js
// (nunca menor que 5s; escala com metade da tolerância p/ tolerância longa).
function offDelayMs(toleranceMs) {
  return Math.max(5000, toleranceMs / 2);
}

// Tolerância efetiva da zona (leitura DEFENSIVA — config legada/ausente cai no default).
function toleranceMsOf(zone) {
  const v = zone ? zone.occupancyToleranceMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : TOLERANCE_DEFAULT_MS;
}

/**
 * @param {object} deps
 * @param {(p: {text:string, ts:number, cameraId:string, cameraLabel:string, zona:string, tipo:string}) => void} deps.raiseAlarm
 * @param {(cameraId:string) => string} deps.cameraLabelOf
 */
function createOccupancyAlert({ raiseAlarm, cameraLabelOf }) {
  /**
   * Uma OBSERVAÇÃO (rodada de inferência) de uma câmera: compara a contagem já
   * calculada por zona de atividade (perZone, de pipeline.js) contra a meta de
   * cada zona que a definiu, e avança a máquina de estados. MUTA st.occupancy
   * (Map zoneId → { state:"ok"|"violada", deviatingSince, okSince, violatedAt,
   * durationMs, people, target }).
   * @param {{id:string, occupancy?:Map}} st  estado por câmera (engine.createState)
   * @param {Array} zonesAtiv  zonas de atividade da câmera (só as com targetOccupancy interessam)
   * @param {Map<string,number>} perZone  zone.id → pessoas nesta rodada (já calculado no pipeline)
   * @param {number} now  timestamp da rodada
   */
  function observe(st, zonesAtiv, perZone, now) {
    const zones = (zonesAtiv || []).filter((z) => typeof z.targetOccupancy === "number");
    if (!zones.length) {
      if (st.occupancy && st.occupancy.size) st.occupancy.clear(); // config removeu a meta → esquece
      return;
    }
    if (!st.occupancy) st.occupancy = new Map();
    const seen = new Set();
    for (const z of zones) {
      seen.add(z.id);
      const people = perZone.get(z.id) || 0;
      let m = st.occupancy.get(z.id);
      if (!m) {
        m = { state: "ok", deviatingSince: null, okSince: null, violatedAt: 0, durationMs: 0, people: 0, target: z.targetOccupancy };
        st.occupancy.set(z.id, m);
      }
      m.people = people;
      m.target = z.targetOccupancy;
      const tolMs = toleranceMsOf(z);
      const deviating = people !== z.targetOccupancy;
      if (m.state === "ok") {
        if (deviating) {
          if (m.deviatingSince == null) m.deviatingSince = now; // 1ª observação fora da meta — âncora
          if (now - m.deviatingSince >= tolMs) {
            // OK → VIOLADA: UM alerta por violação (ver cabeçalho).
            m.state = "violada";
            m.violatedAt = m.deviatingSince;
            m.durationMs = now - m.deviatingSince;
            m.okSince = null;
            const cameraLabel = cameraLabelOf(st.id);
            const dir = people > z.targetOccupancy ? "acima" : "abaixo";
            raiseAlarm({
              text: `⚠ ${cameraLabel} · ${z.label}: lotação ${dir} do esperado — ${people} pessoa(s) (esperado ${z.targetOccupancy})`,
              ts: now,
              cameraId: st.id,
              cameraLabel,
              zona: z.label,
              tipo: "objetos",
            });
          }
        } else {
          m.deviatingSince = null; // voltou à meta antes do prazo → contador reseta
        }
      } else if (deviating) {
        m.okSince = null; // ainda fora da meta → o MESMO evento segue aberto
        m.durationMs = now - m.violatedAt; // só a duração interna atualiza (sem novo alerta)
      } else {
        if (m.okSince == null) m.okSince = now;
        if (now - m.okSince >= offDelayMs(tolMs)) {
          m.state = "ok"; // VIOLADA → OK: na meta contínua pelo off-delay (fecha o evento)
          m.deviatingSince = null;
          m.okSince = null;
        }
      }
    }
    // Recarga de camcfg (kind:"zones"): zona que perdeu a meta ou saiu da config
    // leva o estado junto (poda por id); a que permanece preserva o estado.
    for (const id of st.occupancy.keys()) if (!seen.has(id)) st.occupancy.delete(id);
  }

  return { observe };
}

/**
 * Getter PURO do estado por zona de lotação — projeção pro payload do painel
 * (mesmo papel do presence-alert.stateOf). Só LÊ st.occupancy; não muta nada.
 * @param {{zonesAtiv?:Array, occupancy?:Map}} st
 * @returns {Map<string, {violada:boolean, people:number, target:number, toleranceMs:number}>}
 */
function stateOf(st) {
  const out = new Map();
  for (const z of (st.zonesAtiv || []).filter((z) => typeof z.targetOccupancy === "number")) {
    const m = st.occupancy && st.occupancy.get(z.id);
    out.set(z.id, {
      violada: !!m && m.state === "violada",
      people: (m && m.people) || 0,
      target: z.targetOccupancy,
      toleranceMs: toleranceMsOf(z),
    });
  }
  return out;
}

module.exports = { createOccupancyAlert, stateOf, offDelayMs, toleranceMsOf, TOLERANCE_DEFAULT_MS };
