// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — PIPELINE POR RODADA do motor: dets do worker → exclusão →
// auto-máscara → tracking → contagem de linha → zonas de atividade → ingest →
// emit. É a LÓGICA DE DOMÍNIO por detecção (o engine só orquestra: cadência,
// worker, timers, sockets). Determinístico dado (st, dets, now) — testável com
// dets sintéticos, sem worker/IPC (pipeline.test.js).
//
// CONTRATO com o relatório (INTOCÁVEL — mesmos shapes de src/report/store.ts):
//   ingest("flow","cross", { cameraId, cameraLabel, tripwireId, dir, ts })
//   ingest("ativ","samples", { cameraId, samples:[{ zoneId, label, atividade,
//     idleMs:0, frames, activeFrames, people }] })
//   people = PICO de pessoas na janela (→ people_peak); activeFrames = rodadas
//   com ≥1 pessoa (→ activePct); idleMs fica 0 (ociosidade por MOTION é do front).
//
// TURNO: o pipeline NÃO carimba turno (e não tem mais o `shiftOf` hardcoded 06/14/22 que era
// cópia manual do front — spec-turnos-por-zona F5). Quem carimba é o INGEST (server/pgstore.js),
// o choke point de TODOS os produtores, resolvendo pela fonte única (server/shift-clock.js) sobre
// o CADASTRO (server/shifts.js). O pipeline só entrega o `ts` — o motor mede, não interpreta.
//
// CONTRATO com o front (socket `analysis-tracks`, ADITIVO): o payload é montado
// AQUI (projeção explícita — campos internos do tracker NÃO vazam: firstSeen,
// velocidade crua…); o engine só transporta (deps.emitTracks). ECONOMIA: sem
// espectador (deps.hasViewers()=false) o payload nem é montado. Campo ADITIVO
// `coasting:true` só nas re-emissões de rodada pulada pelo gate (emitCoasting —
// C1 da spec-tracking-pessoa-parada); a rodada de inferência nunca o carrega.
// Campo ADITIVO `zonesProibidas` (Onda B): estado da máquina de presença por
// zona proibida (presence-alert.stateOf) — o canvas acende VIOLADA por ele.
//
// DEPS injetadas (createPipeline): highScore (nascimento de track — precision.js),
// ingest (pgstore), hasViewers/emitTracks (socket — o engine é o dono do io),
// cameraLabelOf (label p/ o evento de flow), raiseAlarm (alarme server-side de
// presença em zona proibida — engine liga em alarm/pipeline.handleAlert).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { resolveZone, resolveZoneByOverlap, inExclusionZone } = require("./zones");
const { roundObserver } = require("./automask");
const { createPresenceAlert, stateOf } = require("./presence-alert");
const { createOccupancyAlert } = require("./occupancy-alert");

/**
 * @param {object} deps
 * @param {number} deps.highScore            nascimento/1ª passada do tracker (PRECISION.detector.highScore)
 * @param {(kind, sub, payload) => Promise} deps.ingest       persistência de indicadores (pgstore.ingest)
 * @param {() => boolean} deps.hasViewers    há dashboard ouvindo? (false → não monta o payload)
 * @param {(payload) => void} deps.emitTracks  transporte do `analysis-tracks` (engine/io)
 * @param {(cameraId) => string} deps.cameraLabelOf  label da câmera p/ o evento de flow
 * @param {(p) => void} [deps.raiseAlarm]     entrada do pipeline de alarme server-side
 *        (alarm/pipeline.handleAlert com o ctx do engine); ausente → produtor inerte
 */
function createPipeline({ highScore, ingest, hasViewers, emitTracks, cameraLabelOf, raiseAlarm }) {
  // Presença em zona proibida (spec-alerta-por-atividade F2): a máquina de estados
  // mora em presence-alert.js; aqui só a OBSERVAÇÃO por rodada de inferência é
  // alimentada — o alarme nasce no HUB (24/7, sem dashboard aberto — CA-4).
  const presence = raiseAlarm ? createPresenceAlert({ raiseAlarm, cameraLabelOf }) : null;
  // Lotação em zona de ATIVIDADE (targetOccupancy/occupancyToleranceMs — campo
  // aditivo do camcfg): mesma dinâmica 24/7 sem dashboard aberto, sobre a
  // contagem por zona que o D-FINE já calcula (perZone, abaixo) — não depende
  // do OWL-ViT client-side (occupancy-alert.js, cabeçalho explica o porquê).
  const occupancy = raiseAlarm ? createOccupancyAlert({ raiseAlarm, cameraLabelOf }) : null;
  /**
   * Uma rodada de UMA câmera: consome as dets cruas do worker e MUTA st
   * (tracker/counter/janela/logs). Emite overlay ao final (inclusive com 0
   * tracks — o dashboard precisa da rodada vazia p/ apagar caixas).
   */
  function processRound(st, dets, now, latencyMs = 0) {
    // Zona de EXCLUSÃO (calibração — acuracia-modelos.md Medida A): pessoa cujo PÉ
    // (bottom-center) cai em zona modo "exclusao" é DESCARTADA AQUI — antes de
    // tracking/contagem/ingest/emit. FP de objeto fixo é espacialmente preso; a
    // pessoa real se move — mascarar o hotspot mata o FP sem custar recall.
    const persons = [];
    let excluded = 0;
    let autoHidden = 0;
    // Auto-máscara: 1 observer por rodada (contrato automask.js). APRENDE de todas
    // as dets, inclusive as que suprime — objeto ainda presente segue confirmado;
    // quando some, deixa de ser reaprendido e a supressão cai (adaptativo).
    const obs = st.autoMask ? roundObserver(st.autoMask) : null;
    for (const d of dets) {
      if (!d || d.class !== "person" || !Array.isArray(d.bbox)) continue;
      if (st.zonesExcl.length && inExclusionZone(d.bbox, st.zonesExcl)) {
        excluded += 1;
        continue;
      }
      if (obs) {
        const fx = d.bbox[0] + d.bbox[2] / 2; // PÉ da detecção (mesma âncora da exclusão)
        const fy = d.bbox[1] + d.bbox[3];
        if (obs.observe(fx, fy, d.bbox[2], d.bbox[3])) {
          autoHidden += 1; // célula aprendida como objeto fixo → suprime (como exclusão manual)
          continue;
        }
      }
      persons.push({ score: d.score, bbox: d.bbox });
    }
    if (obs) obs.close(now, st.id);

    // Logs rolantes (60s) que alimentam fps real/dets1m/excluded1m no status.
    st.rounds.push(now);
    st.detsLog.push({ t: now, n: persons.length, x: excluded, a: autoHidden });
    const cutoff = now - 60_000;
    while (st.rounds.length && st.rounds[0] < cutoff) st.rounds.shift();
    while (st.detsLog.length && st.detsLog[0].t < cutoff) st.detsLog.shift();

    // POLÍTICA LOST (bytetrack.js): update() devolve só os tracks EMITÍVEIS —
    // track sem match há >1 rodada fica INTERNO (sem rastro no overlay, sem
    // ocupação, sem contagem) até re-associar (mesmo id) ou morrer pelo TTL.
    const tracks = st.tracker.update(persons, now, highScore);
    // Métrica de RE-ASSOCIAÇÃO (2º estágio): delta do acumulado → detsLog.r →
    // tracker.reassoc1m no status (sensor do salto recuperado SEM id novo).
    if (typeof st.tracker.stats === "function") {
      const tot = st.tracker.stats().reassociations;
      st.detsLog[st.detsLog.length - 1].r = tot - (st.reassocSeen || 0);
      st.reassocSeen = tot;
    }

    // Tripwires → eventos de cruzamento → ingest "flow"/"cross". DECISÃO: LOST não
    // alimenta o counter (posição congelada não gera cruzamento e não refresca o
    // last-pos) — a travessia sobrevive pela RE-ASSOCIAÇÃO (mesmo id) + last-pos
    // que o counter guarda por TTL próprio (mesmo TTL do tracker — engine.js).
    const crossings = st.counter.update(
      tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
      now,
    );
    if (crossings.length) {
      const cameraLabel = cameraLabelOf(st.id);
      const ts = Date.now();
      for (const ev of crossings) {
        // Sem `shift`: o carimbo (turno resolvido + businessDate) é do ingest — ver cabeçalho.
        ingest("flow", "cross", {
          cameraId: st.id,
          cameraLabel,
          tripwireId: ev.tripwireId,
          dir: ev.dir,
          ts,
        }).catch((e) => console.error("[analysis] ingest flow falhou:", e.message));
      }
    }

    // Zonas de atividade → people/occupied por zona. A atribuição por track roda
    // UMA vez e alimenta os dois consumidores — a janela do ingest e o payload de
    // overlay — zero trabalho extra.
    //
    // A CONTAGEM É POR IDENTIDADE (zone.id), NUNCA POR RÓTULO. Chavear por label somava a
    // contagem de zonas HOMÔNIMAS (bug medido 2026-07-26: 2 zonas "Doca", 1 pessoa em cada →
    // people=2 nas duas e peak=2 no ingest ⇒ people_peak inflado 100% no relatório). E não é
    // canto raro: camcfg rotula toda zona sem nome como "Área". O rótulo segue viajando no
    // payload (é o que o operador lê), mas quem SOMA é o id. Ver zones.js/resolveZone.
    const zoneByTrack = new Map(); // track.id → LABEL | null (contrato do payload — id NÃO vaza)
    const perZone = new Map(); // zone.ID → pessoas nesta rodada
    if (st.zonesAtiv.length) {
      for (const t of tracks) {
        const z = resolveZone(t.bbox, st.zonesAtiv);
        zoneByTrack.set(t.id, z ? (z.label ?? null) : null);
        if (z) perZone.set(z.id, (perZone.get(z.id) || 0) + 1);
      }
      st.window.frames += 1;
      for (const z of st.zonesAtiv) {
        const n = perZone.get(z.id) || 0;
        let acc = st.window.zones.get(z.id);
        if (!acc)
          st.window.zones.set(z.id, (acc = { label: z.label, atividade: z.atividade || "", active: 0, peak: 0 }));
        if (n > 0) acc.active += 1;
        if (n > acc.peak) acc.peak = n;
      }
    }

    // Zonas OBJETOS com "pessoa" (st.zonesObjPessoa do engine): MESMO critério de entrada do
    // cliente Objetos (SOBREPOSIÇÃO — resolveZoneByOverlap, não o centro do resolveZone) — a
    // área é a que o operador desenhou na UI de Objetos (tamanho/local livres), a contagem só
    // troca de motor (D-FINE em vez de OWL-ViT). perZoneObj é um Map SEPARADO (id de zona
    // objetos não colide com id de zona atividade, mas o critério de entrada é diferente —
    // não dá pra reusar o mesmo perZone).
    // LEITURA DEFENSIVA (`|| []`, mesmo padrão que st.zonesProib já usa no payload): estado
    // sintético de teste/eval é montado à mão (eval/counting.mjs, eval/stationary.mjs,
    // pipeline.test.js) e um campo NOVO ausente lá derrubava o gate de CI com TypeError — foi
    // exatamente o que quebrou o `dev` na 1ª tentativa desta feature. O engine SEMPRE popula
    // este campo em produção; aqui a tolerância é de graça e evita o falso-vermelho.
    const zonesObjPessoa = st.zonesObjPessoa || [];
    const perZoneObj = new Map();
    if (zonesObjPessoa.length) {
      for (const t of tracks) {
        const z = resolveZoneByOverlap(t.bbox, zonesObjPessoa);
        if (z) perZoneObj.set(z.id, (perZoneObj.get(z.id) || 0) + 1);
      }
    }

    // Zonas PROIBIDAS (modo "proibida" — st.zonesProib do engine): a observação da
    // rodada alimenta a máquina de estados de presença (dwell → alarme server-side).
    // SÓ rodada de INFERÊNCIA passa aqui — rodada pulada pelo gate não observa e
    // NÃO reseta o dwell (skip = "nada mudou"; ver cabeçalho do presence-alert.js).
    if (presence) presence.observe(st, tracks, now);
    // Lotação: perZone/perZoneObj já refletem a rodada de INFERÊNCIA atual (calculados acima,
    // no mesmo bloco que alimenta o payload zones[].people) — mesma semântica de "só observa em
    // rodada não pulada" do presence, pelo mesmo motivo (skip = a cena não mudou; o dwell de
    // lotação não deve resetar por isso). UMA chamada só, com as DUAS listas de zona (atividade +
    // objetos+pessoa) e os DOIS Maps de contagem já combinados — observe() PODA por id quem não
    // está na lista desta chamada (zona que perdeu a meta); 2 chamadas separadas fariam a 2ª
    // podar o que a 1ª acabou de gravar. occupancy-alert.js é agnóstico de modo (só olha
    // targetOccupancy/occupancyToleranceMs da zona) — ids não colidem entre zonas (newZoneId).
    if (occupancy) {
      const zonesLotacao = zonesObjPessoa.length ? st.zonesAtiv.concat(zonesObjPessoa) : st.zonesAtiv;
      const perZoneLotacao = zonesObjPessoa.length ? new Map([...perZone, ...perZoneObj]) : perZone;
      occupancy.observe(st, zonesLotacao, perZoneLotacao, now);
    }

    // (O gravador de sessão de fusão — bt/session-recorder — migrou com o BLE; ADR-018.
    //  Era o ÚNICO gancho câmera→BLE dentro do motor de análise.)

    // Overlay servido: roda TODA rodada com espectador (inclusive 0 tracks — o
    // dashboard precisa da rodada vazia p/ apagar caixas), mesmo sem zona/linha.
    if (hasViewers()) {
      // Estado por zona proibida DESTA rodada (o observe acima já rodou) — o
      // getter é puro; a máquina não é tocada pela montagem do payload.
      const proibState = stateOf(st);
      const payload = {
        cameraId: st.id,
        ts: now,
        // Latência captura→emissão (ms): quanto o frame ENVELHECEU no pipeline (fila+decode+inferência)
        // antes de virar caixa. Medida no worker-host (Date.now − ts de captura) e passada por parâmetro.
        // O cliente ancora o keyframe em `recvT - latencyMs` e extrapola pro AGORA real → a caixa senta
        // na pessoa em vez de nascer ~meio segundo atrás (07-diagnostico-overlay-lag).
        latencyMs: Math.max(0, latencyMs),
        tracks: tracks.map((t) => ({
          id: t.id,
          bbox: [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], // normalizado 0..1
          cx: t.cx,
          cy: t.cy,
          // VELOCIDADE p/ o cliente EXTRAPOLAR entre rodadas (fluidez sem inferir).
          // Unidade: fração NORMALIZADA do frame por SEGUNDO (mesma base do bbox);
          // o ByteTrack estima em unid/ms → ×1000. Cliente: x(t+Δs) ≈ x + vx·Δs.
          vx: t.vx * 1000,
          vy: t.vy * 1000,
          // score REAL (0..1) da det que sustenta o track nesta rodada — o front usa
          // no slider de confiança do modo hub (det baixa sustenta → reflete o piso).
          score: t.score,
          zone: zoneByTrack.get(t.id) ?? null,
        })),
        // zonesObjPessoa entra na MESMA lista (id não colide entre zonas, newZoneId) — o
        // cliente casa por id independente do modo; é como a contagem de PESSOA de uma zona
        // Objetos passa a vir do D-FINE em vez do OWL-ViT sem precisar de um contrato novo.
        zones: st.zonesAtiv.concat(zonesObjPessoa).map((z) => {
          const people = (zonesObjPessoa.includes(z) ? perZoneObj : perZone).get(z.id) || 0;
          return { id: z.id, label: z.label, people, occupied: people > 0 };
        }),
        // Zonas PROIBIDAS (campo ADITIVO — contrato da Onda B): uma entrada POR
        // zona proibida da câmera; `presenca` é o estado VIOLADA da MÁQUINA do
        // presence-alert (não people>0 cru — quem saiu dentro da histerese ainda
        // acende; quem chegou aquém do dwell ainda não), `people` a contagem da
        // observação. Vai junto no snapshot lastTracks → o coasting re-emite o
        // estado da ÚLTIMA inferência, coerente com a semântica do skip (C1).
        zonesProibidas: (st.zonesProib || []).map((z) => {
          const s = proibState.get(z.id);
          return { id: z.id, label: z.label, presenca: s.violada, people: s.people };
        }),
      };
      emitTracks(payload);
      st.lastTracks = payload; // snapshot p/ re-emissão coasting nas rodadas puladas pelo gate (C1)
    } else {
      // Inferiu SEM espectador (payload nem foi montado — economia): o snapshot
      // anterior deixou de representar os tracks → invalida. coasting jamais
      // re-emite estado ANTERIOR à última inferência.
      st.lastTracks = null;
    }
  }

  /**
   * C1 — overlay nunca esfomeado (spec-tracking-pessoa-parada §2): em rodada
   * PULADA pelo gate de movimento o engine re-emite o ÚLTIMO payload com ts
   * fresco e a flag ADITIVA `coasting:true` (nenhum campo removido — contrato
   * `analysis-tracks` intacto).
   *
   * O QUE O COASTING AFIRMA: "o motor NÃO OBSERVOU nada de novo nesta rodada" —
   * e SÓ isso. NÃO afirma "nada aconteceu". (O comentário anterior dizia "é
   * verdadeiro por construção: o gate só pula com a cena ESTÁTICA": era FALSO. O
   * gate pula sempre que o ratio MEDIDO fica abaixo do limiar, o que inclui
   * pessoa pequena/distante em movimento — poucas células mudadas nas 3072 do
   * thumbnail 64×48 ficam abaixo de PRECISION.gate.motionRatio.) Ou seja: a
   * caixa congelada é a ÚLTIMA OBSERVAÇÃO, não uma afirmação sobre o presente;
   * quem garante que a defasagem é limitada é o piso de PROBE, não o coasting.
   * Quanto isso acontece deixou de ser opinião: `perCamera[].gate.skipMoving1m`
   * (telemetry.js) conta os pulos com gente NÃO estacionária viva em quadro.
   *
   * Só emite com espectador (mesmo hasViewers da emissão normal — sem banda à
   * toa) e só se há snapshot (dashboard que abriu no meio de um skip espera no
   * máximo o probe do gate, ≤6s, pela 1ª inferência).
   */
  function emitCoasting(st, now) {
    if (!st.lastTracks || !hasViewers()) return;
    emitTracks({ ...st.lastTracks, ts: now, coasting: true });
  }

  /** Flush das janelas "ativ" acumuladas (~ANALYSIS_AGG_MS) de todas as câmeras. */
  function flushWindows(states) {
    for (const st of states.values()) {
      if (!st.window.frames || !st.window.zones.size) continue;
      const samples = [];
      for (const [zoneId, acc] of st.window.zones) {
        samples.push({
          zoneId,
          label: acc.label,
          atividade: acc.atividade,
          idleMs: 0, // ociosidade por motion segue no front
          frames: st.window.frames,
          activeFrames: acc.active,
          people: acc.peak,
        });
      }
      st.window = { frames: 0, zones: new Map() };
      ingest("ativ", "samples", { cameraId: st.id, samples }).catch((e) =>
        console.error("[analysis] ingest ativ falhou:", e.message),
      );
    }
  }

  return { processRound, flushWindows, emitCoasting };
}

module.exports = { createPipeline };
