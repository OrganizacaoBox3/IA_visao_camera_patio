// ─────────────────────────────────────────────────────────────────────────────
// engine.js — MOTOR DE ANÁLISE NO HUB (F1 do plano-analise-server-side, ADR-009).
//
// ORQUESTRAÇÃO. As responsabilidades próprias foram extraídas (R5/retrofit) para 4 módulos
// vizinhos — este arquivo só as fia (wire) e mantém o pipeline por rodada + a API pública:
//   • model.js        — catálogo N/S/M + verificação sha256 + download/fallback.
//   • worker-host.js  — ciclo de vida do worker de inferência (spawn/respawn + CPU).
//   • automask.js     — auto-máscara aprendida (Welford). PURO/determinístico (testado).
//   • go2rtc-source.js— fonte alternativa de frames (pull frame.jpeg) + estado de pull.
//
// Consome os frames que o hub JÁ possui (relé webcam + RTSP), amostra
// @ANALYSIS_FPS (default 1fps, último-vence) e envia ao worker de inferência
// (worker.js, D-FINE-N / onnxruntime-node em PROCESSO SEPARADO — spike §6).
// Com as detecções: ByteTrack por câmera → tripwires/zonas do camcfg →
// pgstore.ingest DIRETO (mesmos formatos do front — src/report/store.ts):
//   • "flow"/"cross"  { cameraId, cameraLabel, tripwireId, dir, ts, shift }
//   • "ativ"/"samples" { cameraId, samples:[{ zoneId, label, atividade,
//       idleMs:0, frames, activeFrames, people }] } a cada ~ANALYSIS_AGG_MS.
//     (people = PICO de pessoas na janela → people_peak; activeFrames = rodadas
//      com ≥1 pessoa na zona → activePct. idleMs fica 0: ociosidade por MOTION
//      continua no front — alarmes de ociosidade estão FORA da F1.)
//
// LIGA/DESLIGA (documentado — contrato):
//   • ausente (DEFAULT) → motor LIGADO: se o modelo não existe, BAIXA no boot
//     (HuggingFace, verificação de tamanho+sha256, escrita atômica, fallback S→N).
//     Download falhou → motor desliga com aviso; o hub segue normal. O CORAÇÃO do
//     produto liga e se auto-provisiona sozinho — o cliente não precisa de flag.
//   • ANALYSIS_ENABLED=0 → motor DESLIGADO (ÚNICO escape hatch — nó sem CPU / só-vídeo).
//   • ANALYSIS_ENABLED=1 → idêntico ao default (LIGADO + baixa); mantido por
//     compatibilidade e para tornar a intenção explícita em scripts de deploy.
//   • DETECÇÃO ATIVA POR DEFAULT: o motor sobe sozinho no boot e cobre TODA câmera do
//     relé (exceto as em modo=fadiga, que rodam no cliente). "Sem modelo → motor off,
//     hub segue" continua valendo quando o download não é possível (ex.: air-gap).
//
// OVERLAYS SERVIDOS (F2 — ADITIVO): a cada rodada de análise o hub emite
// `analysis-tracks { cameraId, ts, tracks, zones }` (volatile, room "dashboards")
// com os tracks de pessoa (bbox normalizado + zona atribuída) e o estado por zona
// (people/occupied) — o dashboard desenha overlays sem inferir localmente.
// Sem socket na room, a emissão nem monta o payload (ver emitTracks).
//
// ANTI-DUPLICAÇÃO (contrato com F1-C — ADITIVO): para cada câmera analisada o
// hub emite `analysis-status { cameraId, engine: "hub" }` aos dashboards (no
// connect, via snapshotTo(); e a cada mudança). Câmera que sai da análise →
// { cameraId, engine: null }. O front usa isso p/ desligar o ingest local.
//
// LONGO ALCANCE (F3 — perfil por câmera): câmera com CameraCfg.longRange=true no
// camcfg é analisada com TILING 2×2 (overlap 0.1, estilo SAHI) a 640/tile em vez
// do squash 640 único — recall de pedestre distante em panorâmicas. O engine só
// DECIDE (lê o camcfg no createState e no `camcfg-updated` kind:"camconfig") e
// passa `tiles` no pedido; recorte/reprojeção/fusão vivem no worker. CUSTO: 4×
// inferência por rodada, SÓ nas câmeras marcadas (ver README §Longo alcance).
//
// SHED: câmera analisada conta como espectador — index.js injeta
// rtsp.setAnalysisViewer(isAnalyzing), então o shed NÃO pausa o ffmpeg de
// câmera RTSP analisada. Webcam segue podendo ser rebaixada p/ SHED_WEBCAM_FPS
// (2fps ≥ cadência de análise — o motor não perde nada e o nó economiza CPU).
//
// FONTE go2rtc (Fase 3 — ADITIVO, OFF por default): além do relé, o motor pode PUXAR
// frames do go2rtc (ver go2rtc-source.js). Alimenta o MESMO pipeline (mesmo st.latest /
// tick / worker / ingest / emit). LGPD: JPEG puxado é EFÊMERO em memória (igual ao relé).
//
// LGPD/ADR-002: frames continuam EFÊMEROS em memória (hub→worker via IPC);
// persiste-se SÓ indicadores/metadados, como hoje.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const os = require("node:os");

const camcfg = require("../camcfg");
const pgstore = require("../pgstore");
const go2rtc = require("../go2rtc"); // Fase 3: fonte alternativa de frames (pull frame.jpeg)
const { createByteTracker } = require("./bytetrack");
const { createCounter } = require("./counting");
const { attributeZone, inExclusionZone } = require("./zones");
const model = require("./model"); // catálogo/verificação/download do .onnx (fallback S→N)
const autoscale = require("./autoscale"); // decisão PURA de tier (pick de startup + válvula de runtime)
const { createWorkerPool, resolveWorkerCount, dispatchReady } = require("./worker-host"); // POOL de workers de inferência
const { createGo2rtcSource } = require("./go2rtc-source"); // pull frame.jpeg (Fase 3)
const {
  createAutoMask,
  amCell,
  amObserve,
  evaluateAutoMask,
  AM_COLS,
  AM_ROWS,
  AM_WIN_MS,
  AM_MIN_ROUNDS,
  AUTOMASK_MODE,
  AUTOMASK_ON,
} = require("./automask"); // Fase 4: hotspots fixos aprendidos (Welford)

// ── Parâmetros de operação (defaults espelham APP_CONFIG.people.track do front) ──
const FPS = Math.min(4, Math.max(0.2, Number(process.env.ANALYSIS_FPS) || 1));
const ROUND_MS = Math.round(1000 / FPS);
// Cadência ELEVADA p/ câmera COM tripwire/linha (Fase 4): a contagem de linha quebra por
// recall×cadência (acuracia-modelos.md §3 e Medida D) — a 0,5-1fps um caminhante cruza em
// 2-3 rodadas, insuficiente p/ nascimento+histerese; a ≥2fps o ByteTrack tem rodadas de
// sobra na travessia. SÓ a câmera com linha paga o custo; a sem linha segue @ANALYSIS_FPS.
// ANALYSIS_FPS_LINE (default 2) nunca abaixo do ANALYSIS_FPS nem acima de 4fps.
const FPS_LINE = Math.min(4, Math.max(FPS, Number(process.env.ANALYSIS_FPS_LINE) || 2));
const ROUND_MS_LINE = Math.round(1000 / FPS_LINE);
// Ponto de operação do spike §8: nascimento/1ª passada em ~0.35; o worker devolve ≥0.25,
// que alimenta a 2ª passada do ByteTrack (score baixo SUSTENTA track, não nasce).
const HIGH_SCORE = Number(process.env.ANALYSIS_HIGH_SCORE ?? 0.35);
const AGG_MS = Math.max(1000, Number(process.env.ANALYSIS_AGG_MS ?? 3000));
// TTL escala com a cadência (a 1fps, o 1500ms do front mataria o track numa rodada perdida).
const TTL_MS = Math.max(1500, Math.round(ROUND_MS * 3.5));
const PRUNE_MS = 5 * 60_000; // câmera sem frame há tanto tempo sai do estado/status
// Resolução do tick baseada na cadência MAIS RÁPIDA (linha) p/ o dispatch honrar 2fps.
const TICK_MS = Math.min(250, Math.max(50, Math.round(Math.min(ROUND_MS, ROUND_MS_LINE) / 4)));
// Grid do perfil "Longo alcance/Panorâmica" (F3): 2×2 com overlap 0.1 — espelha o
// tiling do front (src/vision/detect.ts tileGrid). Fixo de propósito (YAGNI): um
// grid maior quadruplicaria de novo o custo sem caso de uso medido.
const LR_TILES = { cols: 2, rows: 2, overlap: 0.1 };

// ── Auto-dimensionamento do modelo (Onda 5 — autoscale.js) ───────────────────
// NORTE: melhor tier que o hardware SUSTENTA, ZERO decisão do usuário. `ANALYSIS_MODEL`
// (n|s|m) deixa de ser escolha e vira PIN opcional (escape hatch p/ ops): se setado, FIXA
// o tier e DESLIGA o autoscale. Ausente = AUTO (pick de startup + válvula de runtime). O
// override de path (ANALYSIS_MODEL_PATH — eval/) também desliga o autoscale (tier fora do
// catálogo). Sem pin, o motor começa no melhor sustentável e só DESCE sob pressão medida.
const MODEL_PIN = (process.env.ANALYSIS_MODEL || "").toLowerCase();
const PIN_TIER = autoscale.TIERS.includes(MODEL_PIN) ? MODEL_PIN : null;
const AUTOSCALE_OFF = !!PIN_TIER || !!process.env.ANALYSIS_MODEL_PATH;

let autoTier = null; // tier ATIVO real (o engine é a autoridade; model.getActiveTier() confirma)
let autoState = null; // estado de histerese do reducer puro (autoscale.decideRuntime)
let switchingTier = false; // trava reentrância enquanto uma troca (download+respawn) está em curso

let ctx = null; // { io, cameras } injetado pelo index.js
let enabled = false;
let stopping = false;
let poolSize = 1; // nº de workers do pool (resolvido no init — env ANALYSIS_WORKERS / cores / câmeras)

let seq = 0;
/** cameraId → estado por câmera (tracker/counter/zonas/fila/métricas) */
const states = new Map();
const timers = [];

const shiftOf = (hour) => (hour >= 6 && hour < 14 ? "Manhã" : hour >= 14 && hour < 22 ? "Tarde" : "Noite");

// ── Módulos extraídos, fiados com as dependências do engine ──────────────────
// worker-host (POOL): injeta o Map states (reset no exit + roteamento), o path ATUAL do
// modelo (pode mudar por fallback), o pipeline por rodada (processDets), o predicado de
// parada e getSize (nº de workers, resolvido no spawn). O pool roteia por MENOR-CARGA e
// respawna POR-WORKER (nunca-cego enquanto ≥1 vive).
const workerHost = createWorkerPool({
  states,
  getModelPath: model.getModelPath,
  onDets: processDets,
  isStopping: () => stopping,
  getSize: () => poolSize,
});
// go2rtc-source: injeta go2rtc, o Map states, o createState (materializa a câmera puxada),
// o predicado "motor rodando" e ROUND_MS (base do PULL_STALE_MS).
const go2rtcSource = createGo2rtcSource({
  go2rtc,
  states,
  createState,
  running: () => enabled && !stopping,
  roundMs: ROUND_MS,
});

// ── Estado por câmera ────────────────────────────────────────────────────────
function ativZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "atividade");
}

// Zonas de EXCLUSÃO (calibração — analises/acuracia-modelos.md Medida A): a pessoa cujo
// PÉ cai aqui é descartada antes de tracking/contagem/ingest (mata FP de objeto fixo).
// Contrato compartilhado com o front: modo "exclusao" no camcfg.
function exclZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "exclusao");
}

// Perfil "Longo alcance/Panorâmica" da câmera (CameraCfg.longRange — src/cameraConfig.ts).
// Leitura DEFENSIVA (=== true): config ausente/legada sem o campo → false (squash atual).
function longRangeOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return !!(cfg && cfg.longRange === true);
}

// Papel da câmera (CameraCfg.modo — src/cameraConfig.ts). "fadiga" é modo ESPECIALIZADO que
// roda no CLIENTE (MediaPipe/face mesh do operador) — o hub NÃO deve detectar/contar PESSOA
// nela: (a) economiza CPU do worker, (b) tira do relatório o ruído de "pessoa" contada sobre
// o rosto do operador em close. Leitura DEFENSIVA (mesma disciplina do longRange): sem config
// salva → cleanCamConfig default "atividade" → não é fadiga.
function modoOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return (cfg && cfg.modo) || "atividade";
}
function isFadiga(cameraId) {
  return modoOf(cameraId) === "fadiga";
}

function createState(id) {
  const st = {
    id,
    latest: null, // { buf, ts } — último frame recebido (último-vence)
    busy: false,
    inflight: 0,
    lastSentAt: 0,
    lastFrameAt: Date.now(),
    lastRelayAt: 0, // último frame vindo do RELÉ (só onFrame) — base da decisão de pull
    source: "relay", // origem do último frame: "relay" | "go2rtc" (aditivo no status)
    errors: 0,
    tracker: createByteTracker({ highScore: HIGH_SCORE, iouThreshold: 0.25, ttlMs: TTL_MS }),
    counter: createCounter(camcfg.getTripwires(id), {
      minMove: 0.01,
      ttl: TTL_MS,
      maxDist: 0.35, // gate de teleporte (APP_CONFIG.people.track.counterMaxDist)
      debounceMs: 800,
      minCrossingFrames: 2, // histerese: lado novo sustentado 2 rodadas
    }),
    zonesAtiv: ativZonesOf(id),
    zonesExcl: exclZonesOf(id), // pessoas com o pé aqui são descartadas antes do tracking
    longRange: longRangeOf(id), // F3: true → pedido ao worker leva tiles 2×2 (LR_TILES)
    fadiga: isFadiga(id), // F4: câmera modo=fadiga NÃO é analisada no hub (roda no cliente)
    roundMs: camcfg.getTripwires(id).length ? ROUND_MS_LINE : ROUND_MS, // F4: câmera com linha amostra mais rápido
    autoMask: AUTOMASK_ON ? createAutoMask() : null, // F4: aprendizado de hotspots fixos (opt-in)
    window: { frames: 0, zones: new Map() }, // acumulação p/ o ingest "ativ" (~AGG_MS)
    rounds: [], // timestamps das rodadas (p/ fps real no status)
    detsLog: [], // { t, n } pessoas por rodada (p/ dets1m)
    lastMs: 0,
  };
  states.set(id, st);
  // Fadiga: o hub não cobre PESSOA nessa câmera → anuncia engine:null (front mantém o modo
  // especializado local, não liga o ingest de pessoa). Demais câmeras: engine:"hub".
  emitAnalysisStatus(id, st.fadiga ? null : "hub");
  return st;
}

function emitAnalysisStatus(cameraId, engine) {
  if (ctx) ctx.io.to("dashboards").emit("analysis-status", { cameraId, engine });
}

// ── Pipeline por rodada: dets → tracker → counter/zonas → ingest ─────────────
function processDets(st, dets, now) {
  // Zona de EXCLUSÃO (calibração — analises/acuracia-modelos.md Medida A): a detecção de
  // pessoa cujo PÉ (bottom-center do bbox) cai numa zona modo "exclusao" (mask-aware) é
  // DESCARTADA AQUI — antes de ByteTrack/counter/zonas/ingest/emit. Não conta, não rastreia,
  // não vira overlay. Os FP de objeto fixo (grade/placa/janela) são espacialmente presos;
  // a pessoa real se move, então mascarar o hotspot mata o FP sem custar recall.
  const persons = [];
  let excluded = 0;
  let autoHidden = 0;
  const am = st.autoMask; // F4: auto-máscara aprendida (null quando a feature está OFF)
  const roundCells = am ? new Set() : null; // células com ≥1 pé NESTA rodada (presença por rodada)
  for (const d of dets) {
    if (!d || d.class !== "person" || !Array.isArray(d.bbox)) continue;
    if (st.zonesExcl.length && inExclusionZone(d.bbox, st.zonesExcl)) {
      excluded += 1;
      continue;
    }
    // Auto-máscara (F4): o PÉ (bottom-center) → célula do grid aprendido. APRENDE de TODAS as
    // detecções (mesmo as já suprimidas): assim um objeto fixo AINDA presente segue confirmado
    // (e suprimido); quando ele some, deixa de ser reaprendido e a supressão cai (adaptativo).
    if (am) {
      const fx = d.bbox[0] + d.bbox[2] / 2;
      const fy = d.bbox[1] + d.bbox[3];
      const cell = amCell(fx, fy);
      amObserve(am, cell, [fx, fy, d.bbox[2], d.bbox[3]], roundCells);
      if (AUTOMASK_MODE === "hide" && am.suppressed.has(cell)) {
        autoHidden += 1; // célula aprendida como objeto fixo → suprime (como zona de exclusão manual)
        continue;
      }
    }
    persons.push({ score: d.score, bbox: d.bbox });
  }
  if (am) {
    am.rounds += 1;
    for (const cell of roundCells) am.cells.get(cell).present += 1; // 1 presença/rodada/célula
    if (now - am.windowStart >= AM_WIN_MS && am.rounds >= AM_MIN_ROUNDS) evaluateAutoMask(st, now);
  }
  st.rounds.push(now);
  st.detsLog.push({ t: now, n: persons.length, x: excluded, a: autoHidden });
  const cutoff = now - 60_000;
  while (st.rounds.length && st.rounds[0] < cutoff) st.rounds.shift();
  while (st.detsLog.length && st.detsLog[0].t < cutoff) st.detsLog.shift();

  const tracks = st.tracker.update(persons, now, HIGH_SCORE);

  // Tripwires → eventos de cruzamento → ingest "flow"/"cross" (mesmo formato do front)
  const crossings = st.counter.update(
    tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
    now,
  );
  if (crossings.length) {
    const cam = ctx && ctx.cameras.get(st.id);
    const cameraLabel = cam ? cam.label : st.id;
    const ts = Date.now();
    for (const ev of crossings) {
      pgstore
        .ingest("flow", "cross", {
          cameraId: st.id,
          cameraLabel,
          tripwireId: ev.tripwireId,
          dir: ev.dir,
          ts,
          shift: shiftOf(new Date(ts).getHours()),
        })
        .catch((e) => console.error("[analysis] ingest flow falhou:", e.message));
    }
  }

  // Zonas de atividade → people/occupied por zona (janela agregada em flushAtiv).
  // A atribuição por track roda UMA vez e alimenta os dois consumidores: a janela
  // do ingest e o payload de overlay (analysis-tracks) — zero trabalho extra.
  const zoneByTrack = new Map(); // track.id → label | null
  const perLabel = new Map(); // label → pessoas nesta rodada
  if (st.zonesAtiv.length) {
    for (const t of tracks) {
      const label = attributeZone(t.bbox, st.zonesAtiv);
      zoneByTrack.set(t.id, label);
      if (label) perLabel.set(label, (perLabel.get(label) || 0) + 1);
    }
    st.window.frames += 1;
    for (const z of st.zonesAtiv) {
      const n = perLabel.get(z.label) || 0;
      let acc = st.window.zones.get(z.id);
      if (!acc)
        st.window.zones.set(z.id, (acc = { label: z.label, atividade: z.atividade || "", active: 0, peak: 0 }));
      if (n > 0) acc.active += 1;
      if (n > acc.peak) acc.peak = n;
    }
  }

  // Overlays servidos (F2): tracks/estados desta rodada p/ os dashboards desenharem
  // sem inferir localmente. Roda TODA rodada (inclusive com 0 tracks — o dashboard
  // precisa da rodada vazia p/ apagar caixas), mesmo sem zona/tripwire configurada.
  emitTracks(st, tracks, zoneByTrack, perLabel, now);
}

// ── Overlays servidos (F2 do plano — evento `analysis-tracks`, ADITIVO) ──────
// io.to("dashboards").volatile.emit: mesmo padrão último-vence dos frames do relé —
// overlay atrasado não acumula backlog em socket lento. Payload EXPLÍCITO: só o que
// o contrato pede (não vazam campos internos do tracker: vx/vy/score/firstSeen…).
// ECONOMIA: sem socket na room "dashboards" não monta nem serializa nada
// (io.sockets.adapter.rooms.get("dashboards")?.size — custo de um lookup por rodada).
function emitTracks(st, tracks, zoneByTrack, perLabel, ts) {
  if (!ctx) return;
  if (!ctx.io.sockets.adapter.rooms.get("dashboards")?.size) return;
  ctx.io.to("dashboards").volatile.emit("analysis-tracks", {
    cameraId: st.id,
    ts,
    tracks: tracks.map((t) => ({
      id: t.id,
      bbox: [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], // normalizado 0..1
      cx: t.cx,
      cy: t.cy,
      // F4 (ADITIVO ao contrato analysis-tracks): score REAL (0..1) da detecção que sustenta o
      // track nesta rodada — antes era descartado no emit. O front usa p/ o slider de confiança
      // no modo hub (hoje forçado a 1). Sustentado por det de score baixo → reflete o piso 0.25.
      score: t.score,
      zone: zoneByTrack.get(t.id) ?? null,
    })),
    zones: st.zonesAtiv.map((z) => {
      const people = perLabel.get(z.label) || 0;
      return { id: z.id, label: z.label, people, occupied: people > 0 };
    }),
  });
}

// Flush do "ativ"/"samples" (~AGG_MS): MESMO shape do front (SamplePayload/ZoneSample).
function flushAtiv() {
  for (const st of states.values()) {
    if (!st.window.frames || !st.window.zones.size) continue;
    const samples = [];
    for (const [zoneId, acc] of st.window.zones) {
      samples.push({
        zoneId,
        label: acc.label,
        atividade: acc.atividade,
        idleMs: 0, // ociosidade por motion segue no front (fora da F1)
        frames: st.window.frames,
        activeFrames: acc.active,
        people: acc.peak,
      });
    }
    st.window = { frames: 0, zones: new Map() };
    pgstore
      .ingest("ativ", "samples", { cameraId: st.id, samples })
      .catch((e) => console.error("[analysis] ingest ativ falhou:", e.message));
  }
}

// ── Amostragem: tick escolhe o último frame por câmera e manda ao worker ─────
function tick() {
  if (!workerHost.ready()) return;
  const now = Date.now();
  for (const st of states.values()) {
    // Guarda de despacho PURA (worker-host.dispatchReady): fadiga (roda no cliente),
    // coalescência (≤1 job em voo por câmera via busy), último-vence (latest) e cadência
    // (F4: câmera com linha @ROUND_MS_LINE ≥2fps; sem linha @ROUND_MS 1fps). Único choke
    // point — pega relé E pull go2rtc. O roteamento ao worker de menor carga é do pool.send.
    if (!dispatchReady(st, now, ROUND_MS)) continue;
    const frame = st.latest;
    st.latest = null;
    st.busy = true;
    st.lastSentAt = now;
    st.inflight = ++seq;
    try {
      // cópia no envio: o buf do relé pode ser view de um buffer maior (RTSP) — a cópia
      // acontece só 1×/rodada (não por frame do relé) e serializa enxuto no IPC.
      // F3: câmera longRange leva `tiles` — o worker recorta/reprojeta/funde (4× inferência).
      workerHost.send({
        type: "detect",
        id: st.inflight,
        cameraId: st.id,
        jpeg: Buffer.from(frame.buf),
        ...(st.longRange ? { tiles: LR_TILES } : {}),
      });
    } catch {
      st.busy = false;
      st.inflight = 0;
    }
  }
}

function prune() {
  const now = Date.now();
  for (const [id, st] of states) {
    if (now - st.lastFrameAt > PRUNE_MS) {
      states.delete(id);
      go2rtcSource.dropPull(id);
      emitAnalysisStatus(id, null);
    }
  }
  go2rtcSource.prunePulls(now); // R5: poda entradas de pull órfãs (stream que só falha / sumiu)
}

function logMinute() {
  if (!states.size) return;
  const parts = [];
  for (const [id, st] of states) {
    const fps = Math.round((st.rounds.length / 60) * 100) / 100;
    const src = st.source === "go2rtc" ? "[g2r]" : "";
    parts.push(`${id}${st.longRange ? "[LR]" : ""}${src}: ${fps}fps ${st.lastMs}ms`);
  }
  const w = workerHost.stats();
  const perW = w.workers.map((x) => `#${x.id}${x.ready ? "" : "!"}:${x.cpuPct}%`).join(" ");
  console.log(
    `[analysis] pool ${w.readyCount}/${w.size} cpu~${w.cpuPct}% (${perW}) · ${parts.join(" · ")}`,
  );
}

// ── Auto-dimensionamento: válvula de runtime (downgrade sob pressão medida) ──
// Roda 1×/janela (autoscale.DEFAULTS.evalMs). Agrega a cadência ALCANÇADA × ALVO das
// câmeras analisadas (não-fadiga) + o cpuPct do worker → decisão PURA (autoscale). Se a
// decisão for trocar, recarrega o modelo via model.setActiveTier (ATÔMICO: reverte se o
// download falhar) + workerHost.reload(). SEGURANÇA: em falha de troca, mantém o tier vivo
// (nunca cego). switchingTier trava reentrância enquanto o download/respawn não termina.
async function evaluateAutoscale() {
  if (!enabled || stopping || AUTOSCALE_OFF || switchingTier) return;
  let sumAch = 0;
  let sumTgt = 0;
  let cams = 0;
  for (const st of states.values()) {
    if (st.fadiga) continue; // fadiga roda no cliente — não pesa no worker do hub
    sumAch += st.rounds.length / 60; // fps REAL da janela (rounds guarda 60s)
    sumTgt += st.roundMs === ROUND_MS_LINE ? FPS_LINE : FPS; // alvo efetivo da câmera
    cams += 1;
  }
  const w = workerHost.stats();
  const sample = {
    now: Date.now(),
    tier: autoTier,
    cpuPct: w.cpuPct, // agregado do pool (soma dos N) — decideRuntime escala o teto por workers
    achievedFps: sumAch,
    targetFps: sumTgt,
    cameras: cams,
    cores: os.cpus().length,
    workers: w.size, // capacidade REAL do pool: throughput/orçamento ≈ N × por-worker
  };
  const d = autoscale.decideRuntime(autoState, sample);
  autoState = d.state;
  if (d.action === "hold") return;

  switchingTier = true;
  try {
    const ok = await model.setActiveTier(d.to, true);
    if (ok) {
      autoTier = model.getActiveTier() || d.to;
      autoState.tier = autoTier;
      workerHost.reload(); // respawn imediato com o novo modelo
      console.log(`[analysis] autoscale ${d.action.toUpperCase()} ${d.from}→${autoTier}: ${d.reason}`);
    } else {
      // Troca falhou (download indisponível) → mantém o tier vivo. O lastSwitchAt já entrou
      // em cooldown (evita martelar um download que falha). NUNCA fica sem modelo.
      autoState.tier = autoTier;
      console.warn(`[analysis] autoscale ${d.action} ${d.from}→${d.to} ABORTADO (modelo indisponível) — mantém ${autoTier}`);
    }
  } catch (e) {
    autoState.tier = autoTier;
    console.error(`[analysis] autoscale ${d.action} ${d.from}→${d.to} ERRO: ${e.message} — mantém ${autoTier}`);
  } finally {
    switchingTier = false;
  }
}

// ── API pública (consumida pelo index.js / routes/analysis.js) ───────────────

/** Frame do relé (webcam OU RTSP). Guarda só o MAIS NOVO por câmera (último-vence). */
function onFrame(cameraId, buf, ts) {
  if (!enabled || stopping || !cameraId || !buf) return;
  const id = String(cameraId);
  const st = states.get(id) || createState(id);
  const now = Date.now();
  st.lastFrameAt = now;
  st.lastRelayAt = now; // relé ativo → em modo "relay-less" esta câmera não é puxada do go2rtc
  st.source = "relay";
  st.latest = { buf, ts: ts || now };
}

/** Mudança de camcfg (teed pelo index.js a partir do evento "camcfg-updated"). */
function onCamcfgUpdated(p) {
  if (!enabled || !p || !p.cameraId) return;
  const st = states.get(String(p.cameraId));
  if (!st) return;
  if (p.kind === "tripwires") {
    st.counter.setTripwires(camcfg.getTripwires(st.id)); // preserva contadores por id
    // F4: ganhou/perdeu linha → recalcula a cadência (câmera com linha amostra a ≥2fps).
    st.roundMs = camcfg.getTripwires(st.id).length ? ROUND_MS_LINE : ROUND_MS;
  } else if (p.kind === "zones") {
    st.zonesAtiv = ativZonesOf(st.id);
    st.zonesExcl = exclZonesOf(st.id); // recarrega a máscara de exclusão na próxima rodada
    st.window = { frames: 0, zones: new Map() }; // janela reinicia com a nova geometria
  } else if (p.kind === "camconfig") {
    st.longRange = longRangeOf(st.id); // F3: liga/desliga o tiling na PRÓXIMA rodada
    // F4: entrou/saiu do modo fadiga → atualiza o contrato anti-duplicação (hub ⇄ cliente).
    const wasFadiga = st.fadiga;
    st.fadiga = isFadiga(st.id);
    if (st.fadiga !== wasFadiga) {
      if (st.fadiga) st.window = { frames: 0, zones: new Map() }; // descarta janela pendente
      emitAnalysisStatus(st.id, st.fadiga ? null : "hub");
    }
  }
}

/** Câmera analisada conta como espectador (shed). Com o motor ON, TODA câmera do relé é analisada. */
function isAnalyzing() {
  return enabled && !stopping;
}

/** Snapshot do contrato anti-duplicação p/ um dashboard que acabou de conectar. */
function snapshotTo(socket) {
  if (!enabled) return;
  // Fadiga: engine:null (o hub não cobre pessoa nela — front mantém o modo especializado local).
  for (const [id, st] of states) socket.emit("analysis-status", { cameraId: id, engine: st.fadiga ? null : "hub" });
}

/** GET /api/analysis/status — métricas por câmera (aditivo). */
function status() {
  const perCamera = {};
  for (const [id, st] of states) {
    let dets1m = 0;
    let excluded1m = 0;
    let automasked1m = 0;
    for (const d of st.detsLog) {
      dets1m += d.n;
      excluded1m += d.x || 0;
      automasked1m += d.a || 0;
    }
    perCamera[id] = {
      fps: Math.round((st.rounds.length / 60) * 100) / 100,
      targetFps: st.fadiga ? 0 : st.roundMs === ROUND_MS_LINE ? FPS_LINE : FPS, // F4 (aditivo): cadência efetiva
      queue: (st.busy ? 1 : 0) + (st.latest ? 1 : 0),
      lastMs: st.lastMs,
      dets1m,
      excluded1m, // aditivo: dets de pessoa suprimidas por zona de exclusão em 60s
      longRange: st.longRange, // F3 (aditivo): true = rodada com tiling 2×2 no worker
      fadiga: st.fadiga, // F4 (aditivo): true = câmera modo=fadiga (NÃO analisada no hub)
      source: st.source, // aditivo: origem do último frame ("relay" | "go2rtc")
    };
    // F4 (aditivo): sugestões/supressões da auto-máscara aprendida — TRANSPARÊNCIA. Cada célula
    // vem como rect NORMALIZADO, pronto p/ o operador pintar uma zona de exclusão manual ali.
    if (st.autoMask) {
      perCamera[id].automasked1m = automasked1m; // dets suprimidas pela auto-máscara em 60s
      perCamera[id].autoMask = {
        mode: AUTOMASK_MODE, // "suggest" (só expõe) | "hide" (suprime)
        // células ENFORCED (suprimindo dets) — só no modo "hide"; em "suggest" nada é suprimido.
        suppressed: AUTOMASK_MODE === "hide" ? st.autoMask.suppressed.size : 0,
        suggestions: (st.autoMask.suggestions || []).map((s) => {
          const col = s.cell % AM_COLS;
          const row = Math.floor(s.cell / AM_COLS);
          return {
            x: col / AM_COLS,
            y: row / AM_ROWS,
            w: 1 / AM_COLS,
            h: 1 / AM_ROWS,
            presentPct: Math.round(s.presentPct * 100) / 100,
            jitter: Math.round(s.jitter * 1000) / 1000,
          };
        }),
      };
    }
  }
  return {
    enabled,
    model: path.basename(model.getModelPath()),
    targetFps: FPS,
    lineFps: FPS_LINE, // F4 (aditivo): cadência das câmeras com linha/tripwire
    autoMask: { mode: AUTOMASK_MODE }, // F4 (aditivo): modo global da auto-máscara ("off"|"suggest"|"hide")
    // Onda 5 (aditivo): auto-dimensionamento do modelo — tier ativo, modo e histerese (diagnóstico).
    autoscale: {
      mode: AUTOSCALE_OFF ? "pin" : "auto", // "pin"=fixo (ANALYSIS_MODEL/PATH) · "auto"=dimensiona sozinho
      tier: autoTier || model.getActiveTier(), // n|s|m ativo (null sob override de path)
      pin: PIN_TIER || (process.env.ANALYSIS_MODEL_PATH ? "path" : null), // por que está fixo, se estiver
      choked: autoState ? autoState.choked : 0, // janelas afogadas acumuladas (rumo a downgrade)
      idle: autoState ? autoState.idle : 0, // janelas folgadas acumuladas (rumo a upgrade)
      lastSwitchAt: autoState ? autoState.lastSwitchAt : 0, // ts da última troca (cooldown)
    },
    worker: workerHost.stats(),
    // Fonte go2rtc (Fase 3, aditivo): estado do pull p/ diagnóstico.
    go2rtcPull: go2rtcSource.stats(),
    perCamera,
  };
}

/**
 * Boot do motor. `{ io, cameras }` vêm do index.js. Ver regras de liga/desliga no cabeçalho.
 */
async function init({ io, cameras }) {
  ctx = { io, cameras };
  const want = process.env.ANALYSIS_ENABLED;
  if (want === "0") {
    console.log("[analysis] motor DESLIGADO (ANALYSIS_ENABLED=0)");
    return;
  }
  // POOL: nº de workers (env ANALYSIS_WORKERS fixa; ausente = min(floor(cores/2), câmeras),
  // piso 1). Resolvido AQUI e lido pelo pool no spawn (getSize). O pick de startup e a válvula
  // de runtime do autoscale usam esse N como capacidade REAL (throughput ≈ N × por-worker).
  const cores = os.cpus().length;
  const camCount = ctx.cameras ? ctx.cameras.size : 0;
  poolSize = resolveWorkerCount({ cores, cameras: camCount, pin: process.env.ANALYSIS_WORKERS });
  // PICK DE STARTUP (autoscale): ANTES de baixar, escolhe o melhor tier que o hardware
  // sustenta. PIN (ANALYSIS_MODEL=n|s|m) fixa o tier; AUTO escolhe pelo orçamento (workers ×
  // cap/worker × câmeras esperadas). Override de path (eval/) não mexe no catálogo. ensureModel
  // baixa o tier corrente com o fallback S/M→N do catálogo (nunca fica sem modelo).
  if (PIN_TIER) {
    model.setTier(PIN_TIER);
    console.log(`[analysis] autoscale PIN — tier fixo em ${PIN_TIER.toUpperCase()} (ANALYSIS_MODEL), auto-dimensionamento DESLIGADO`);
  } else if (!process.env.ANALYSIS_MODEL_PATH) {
    const pick = autoscale.pickStartupTier({ cores, cameras: camCount, workers: poolSize });
    model.setTier(pick);
    console.log(`[analysis] autoscale AUTO — pick de startup ${pick.toUpperCase()} (${cores} cores, ${poolSize} workers, ${camCount} câmeras esperadas)`);
  }
  // DEFAULT LIGADO: ausente (ou qualquer valor ≠ "0") → o motor BAIXA o modelo no boot e sobe.
  // O download é seguro (sha256 + escrita atômica + fallback S→N). Só ANALYSIS_ENABLED=0 desliga.
  const ok = await model.ensureModel(want !== "0");
  if (!ok) {
    console.log(
      `[analysis] motor desligado — modelo indisponível em ${model.getModelPath()} (download falhou; sem rede no 1º boot?). ANALYSIS_ENABLED=0 desliga o motor de propósito.`,
    );
    return;
  }
  enabled = true;
  // Tier ATIVO real após o ensure (pode ter caído por fallback S/M→N no download) — é daqui
  // que a válvula de runtime parte. O reducer nasce sem histerese acumulada.
  autoTier = model.getActiveTier() || "s";
  autoState = autoscale.initState(autoTier);
  workerHost.spawnWorker();
  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(flushAtiv, AGG_MS));
  timers.push(setInterval(prune, 60_000));
  timers.push(setInterval(logMinute, 60_000));
  // Fonte go2rtc (Fase 3): ronda de pull na cadência MAIS RÁPIDA (linha) p/ alimentar 2fps
  // quando a câmera de linha é puxada. Inerte (no-op) enquanto go2rtc estiver desligado
  // (pullActive()=false) — logo, OFF por default sem custo além de um guard por tick.
  timers.push(setInterval(go2rtcSource.pullTick, Math.min(ROUND_MS, ROUND_MS_LINE)));
  // Válvula de runtime do autoscale: 1×/janela. Inerte (o guard AUTOSCALE_OFF retorna cedo)
  // quando há PIN/override — mas nem agendamos nesse caso (menos ruído/CPU).
  if (!AUTOSCALE_OFF) timers.push(setInterval(evaluateAutoscale, autoscale.DEFAULTS.evalMs));
  for (const t of timers) if (t.unref) t.unref();
  console.log(
    `[analysis] motor ATIVO — ${model.getModelSpec().label} no hub @${FPS}fps/câmera (linha @${FPS_LINE}fps)` +
      ` · tier=${autoTier}(${AUTOSCALE_OFF ? "pin" : "auto"})` +
      `${AUTOMASK_ON ? ` · auto-máscara=${AUTOMASK_MODE}` : ""} (pool de ${poolSize} worker(s), CPU EP)`,
  );
}

/** Desliga o motor (usado em testes/encerramento). */
function stop() {
  stopping = true;
  enabled = false;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  workerHost.stop();
}

module.exports = { init, onFrame, onCamcfgUpdated, isAnalyzing, snapshotTo, status, stop };
