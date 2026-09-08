// ─────────────────────────────────────────────────────────────────────────────
// health-incidents.js — CICLO DE VIDA DE INCIDENTE sobre os vereditos de health.js.
// PURO/determinístico (relógio por parâmetro, zero I/O): o efeito (raiseAlarm → política de
// alarme → WhatsApp) fica no engine, guiado pelas AÇÕES que observe() devolve.
//
// POR QUE EXISTE: health.js já sabia dizer "esta câmera está sem vídeo / a IA parou / atrasou",
// mas o veredito só aparecia no /api/analysis/status e no painel — NINGUÉM era avisado.
// Detectar sem notificar não fecha o ciclo: o operador só descobre o problema quando vai olhar,
// que é justamente o que o monitor deveria evitar.
//
// O QUE ESTE MÓDULO RESOLVE (e por que não é só "mandar o veredito pro WhatsApp"):
//
//   1. UM INCIDENTE, NÃO UMA ENXURRADA. O veredito é recalculado a cada avaliação; uma câmera
//      offline por 3 horas produziria uma mensagem por avaliação. Aqui a condição vira UM
//      incidente com identidade, que ABRE uma vez, RENOTIFICA a cada `renotifyMs` (o operador
//      precisa ser lembrado de que o problema continua) e FECHA quando resolve.
//
//   2. INCIDENTE SISTÊMICO. MEDIDO em produção (2026-09-08): 16 de 17 câmeras em "ia-atrasada"
//      ao mesmo tempo — porque a causa é UMA (o pool de análise saturado), não 16. Notificar
//      por câmera nesse caso é ruído que ESCONDE o sinal: o operador recebe 16 mensagens e não
//      enxerga que o problema é do SISTEMA. Quando `sistemicoMin` câmeras compartilham o mesmo
//      estado, a notificação vira UMA, de escopo "frota" — os incidentes por câmera continuam
//      existindo e visíveis no status; o que colapsa é a MENSAGEM, não o registro.
//
//   3. PISCA NÃO É INCIDENTE (`confirmMs`). Uma lacuna de frame ou uma rodada perdida acontece
//      o tempo todo; virar alarme a cada pisca é a inundação que a ISA-18.2 manda evitar. A
//      condição precisa se SUSTENTAR antes de abrir (mesmo motivo do dwell no presence-alert).
//
//   4. FECHAR TAMBÉM PRECISA DE HISTERESE (`resolveMs`). Fechar na primeira avaliação saudável
//      reabriria na seguinte — o clássico flapping, que produz o par abre/fecha em loop. A
//      condição precisa estar OK de forma contínua para o incidente fechar.
//
//   5. AGRAVAMENTO NOTIFICA UMA VEZ. Se a câmera piora (ia-atrasada → sem-vídeo) é o MESMO
//      incidente, mas a mudança importa para quem vai agir; MELHORAR (sem-vídeo → ia-atrasada)
//      só atualiza, sem mensagem — senão a oscilação vira ruído.
//
// RESIDUAL DECLARADO: o estado é em MEMÓRIA. Reiniciar o hub esquece os incidentes abertos; as
// condições que persistirem re-confirmam em `confirmMs` e reabrem com id novo. Persistir exigiria
// esquema/migração e o ganho é pequeno perto do custo — declarado, não escondido.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// GRAVIDADE (mesma precedência de health.js: quanto maior, pior). Serve p/ decidir o que é
// AGRAVAMENTO — e só o agravamento notifica de novo dentro do mesmo incidente.
const GRAVIDADE = Object.freeze({
  "sem-video": 5,
  "video-instavel": 4,
  "ia-parada": 3,
  "ia-atrasada": 2,
  "linha-sem-cadencia": 1,
  ok: 0,
});

const DEFAULTS = Object.freeze({
  // A condição precisa se sustentar por isto antes de virar incidente (pisca não é incidente).
  confirmMs: 120_000,
  // Enquanto ABERTO, relembra o operador nesta cadência. NÃO cria incidente novo.
  renotifyMs: 30 * 60_000,
  // Precisa estar OK contínuo por isto p/ FECHAR (histerese anti-flapping).
  resolveMs: 180_000,
  // A partir de N câmeras no MESMO estado, a notificação vira UMA, de frota (a causa é uma só).
  sistemicoMin: 3,
});

const gravidadeDe = (estado) => GRAVIDADE[estado] ?? 0;
const ehProblema = (estado) => gravidadeDe(estado) > 0;

/**
 * Máquina de incidentes de saúde. Estado encapsulado; determinístico dado o histórico.
 * @param {{confirmMs?:number, renotifyMs?:number, resolveMs?:number, sistemicoMin?:number}} [opts]
 */
function createHealthIncidents(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  // cameraId → { estado, desde, aberto, incidenteId, notificadoEm, okDesde, pico }
  const porCamera = new Map();
  // estado → { incidenteId, desde, notificadoEm, ids[] } (incidente SISTÊMICO aberto)
  const sistemicos = new Map();
  let seq = 0;
  const novoId = (prefixo, now) => `${prefixo}-${now.toString(36)}-${++seq}`;

  function estadoDe(id) {
    let m = porCamera.get(id);
    if (!m)
      porCamera.set(
        id,
        (m = {
          estado: "ok",
          desde: 0, // início da condição ATUAL
          aberto: false,
          incidenteId: null,
          notificadoEm: 0,
          okDesde: 0,
          pico: "ok", // pior estado visto NESTE incidente (base do "agravou?")
        }),
      );
    return m;
  }

  /**
   * Uma AVALIAÇÃO da frota: recebe o veredito por câmera (o MESMO objeto que o
   * /api/analysis/status expõe em perCamera[].health) e avança a máquina.
   * @param {Record<string, {estado:string, motivo?:string}>} vereditos
   * @param {number} now
   * @param {(id:string)=>string} [rotuloDe] cameraId → label legível (p/ o texto do alarme)
   * @returns {{acoes:Array, abertos:Array}}
   */
  function observe(vereditos, now, rotuloDe = (id) => id) {
    const acoes = [];
    const vistos = new Set();

    // ── 1. MÁQUINA POR CÂMERA ────────────────────────────────────────────────
    for (const [id, v] of Object.entries(vereditos || {})) {
      vistos.add(id);
      const estado = (v && v.estado) || "ok";
      const motivo = (v && v.motivo) || "";
      const m = estadoDe(id);

      if (!ehProblema(estado)) {
        // Saudável: pendência não-confirmada morre; se está aberto, abre a janela de resolução.
        if (!m.aberto) {
          m.estado = "ok";
          m.desde = 0;
          continue;
        }
        if (!m.okDesde) m.okDesde = now;
        if (now - m.okDesde >= cfg.resolveMs) {
          acoes.push({
            tipo: "fechar",
            escopo: "camera",
            cameraId: id,
            rotulo: rotuloDe(id),
            incidenteId: m.incidenteId,
            estado: m.pico,
            duracaoMs: m.desde ? now - m.desde : 0,
          });
          porCamera.delete(id);
        }
        continue;
      }

      // Problema: a janela de resolução (se havia) morre — voltou a falhar.
      m.okDesde = 0;
      let agravou = false;
      if (m.estado !== estado) {
        agravou = m.aberto && gravidadeDe(estado) > gravidadeDe(m.pico);
        if (!m.desde) m.desde = now;
        m.estado = estado;
        if (gravidadeDe(estado) > gravidadeDe(m.pico)) m.pico = estado;
      } else if (!m.desde) m.desde = now;

      if (agravou) {
        m.notificadoEm = now;
        acoes.push({
          tipo: "agravar",
          escopo: "camera",
          cameraId: id,
          rotulo: rotuloDe(id),
          incidenteId: m.incidenteId,
          estado,
          motivo,
          desde: m.desde,
        });
        continue;
      }

      if (!m.aberto) {
        if (now - m.desde < cfg.confirmMs) continue; // ainda é pisca — não vira incidente
        m.aberto = true;
        m.incidenteId = novoId("inc", now);
        m.notificadoEm = now;
        m.pico = estado;
        acoes.push({
          tipo: "abrir",
          escopo: "camera",
          cameraId: id,
          rotulo: rotuloDe(id),
          incidenteId: m.incidenteId,
          estado,
          motivo,
          desde: m.desde,
        });
      } else if (now - m.notificadoEm >= cfg.renotifyMs) {
        m.notificadoEm = now;
        acoes.push({
          tipo: "renotificar",
          escopo: "camera",
          cameraId: id,
          rotulo: rotuloDe(id),
          incidenteId: m.incidenteId,
          estado,
          motivo,
          desde: m.desde,
          duracaoMs: now - m.desde,
        });
      }
    }

    // Câmera que sumiu do veredito (removida/podada): fecha — não há mais o que vigiar.
    for (const [id, m] of [...porCamera])
      if (!vistos.has(id)) {
        if (m.aberto)
          acoes.push({
            tipo: "fechar",
            escopo: "camera",
            cameraId: id,
            rotulo: rotuloDe(id),
            incidenteId: m.incidenteId,
            estado: m.pico,
            duracaoMs: m.desde ? now - m.desde : 0,
            motivo: "câmera saiu do monitoramento",
          });
        porCamera.delete(id);
      }

    // ── 2. COLAPSO SISTÊMICO ─────────────────────────────────────────────────
    // A MESMA condição em N câmeras é UMA causa, não N problemas (medido: 16 de 17 em
    // "ia-atrasada" por saturação do pool). A notificação vira uma só, de escopo "frota"; as
    // ações por câmera daquele estado são suprimidas (o registro por câmera permanece).
    const porEstado = new Map();
    for (const [id, m] of porCamera)
      if (m.aberto) {
        if (!porEstado.has(m.estado)) porEstado.set(m.estado, []);
        porEstado.get(m.estado).push(id);
      }
    const estadosSistemicos = new Set();
    for (const [estado, ids] of porEstado)
      if (ids.length >= cfg.sistemicoMin) estadosSistemicos.add(estado);

    const acoesFinais = [];
    for (const estado of estadosSistemicos) {
      const ids = [...porEstado.get(estado)].sort();
      let s = sistemicos.get(estado);
      if (!s) {
        s = { incidenteId: novoId("frota", now), desde: now, notificadoEm: now, ids };
        sistemicos.set(estado, s);
        acoesFinais.push({
          tipo: "abrir",
          escopo: "frota",
          estado,
          incidenteId: s.incidenteId,
          cameras: ids,
          desde: s.desde,
        });
      } else {
        s.ids = ids;
        if (now - s.notificadoEm >= cfg.renotifyMs) {
          s.notificadoEm = now;
          acoesFinais.push({
            tipo: "renotificar",
            escopo: "frota",
            estado,
            incidenteId: s.incidenteId,
            cameras: ids,
            desde: s.desde,
            duracaoMs: now - s.desde,
          });
        }
      }
    }
    // Fecha o sistêmico que desceu do limiar (a causa comum passou).
    for (const [estado, s] of [...sistemicos])
      if (!estadosSistemicos.has(estado)) {
        acoesFinais.push({
          tipo: "fechar",
          escopo: "frota",
          estado,
          incidenteId: s.incidenteId,
          cameras: s.ids,
          duracaoMs: now - s.desde,
        });
        sistemicos.delete(estado);
      }

    for (const a of acoes) if (!estadosSistemicos.has(a.estado)) acoesFinais.push(a);

    return { acoes: acoesFinais, abertos: listar(now) };
  }

  /** Incidentes ABERTOS (câmera + frota) — para o /api/analysis/status e a UI. */
  function listar(now) {
    const out = [];
    for (const [id, m] of porCamera)
      if (m.aberto)
        out.push({
          incidenteId: m.incidenteId,
          escopo: "camera",
          cameraId: id,
          estado: m.estado,
          pico: m.pico,
          desde: m.desde,
          duracaoMs: Math.max(0, now - m.desde),
        });
    for (const [estado, s] of sistemicos)
      out.push({
        incidenteId: s.incidenteId,
        escopo: "frota",
        estado,
        cameras: s.ids,
        desde: s.desde,
        duracaoMs: Math.max(0, now - s.desde),
      });
    return out;
  }

  return {
    observe,
    abertos: (now) => listar(now),
    reset: () => {
      porCamera.clear();
      sistemicos.clear();
    },
    config: () => ({ ...cfg }),
  };
}

module.exports = { createHealthIncidents, GRAVIDADE, DEFAULTS };
