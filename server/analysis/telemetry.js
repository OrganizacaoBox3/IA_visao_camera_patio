// ─────────────────────────────────────────────────────────────────────────────
// telemetry.js — Montagem do payload de GET /api/analysis/status (CONTRATO
// ADITIVO — campos novos sim, quebrar existentes nunca). PURO dado o snapshot
// injetado: o engine junta o wiring vivo (states/config/stats) e este módulo
// agrega por câmera e dá forma — testável sem subir o motor (telemetry.test.js).
//
// Efeito colateral DELIBERADO: poda o gateLog (janela rolante 60s) de cada
// câmera ao medir — a mesma poda que o pipeline faz; medir aqui mantém o log
// enxuto em câmeras paradas (sem rodada não haveria poda).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const automask = require("./automask");
const health = require("./health"); // veredito de saúde por câmera + resumo da frota

// ── Sensor do GATE de movimento (engine.recordGateRound alimenta st.gateLog) ──
// Chaves SEMPRE presentes em reasons1m (zero-fill) — um "0" declarado vale mais que
// um campo ausente que o consumidor tem de adivinhar. Motivos raros observados
// (decode-error, gate-off) entram ADITIVAMENTE só quando ocorrem: a soma de
// reasons1m é sempre o total de rodadas gateadas na janela (sanity check de graça).
const GATE_REASONS = ["baseline", "motion", "probe", "skip"];

/** Percentil por NEAREST-RANK (sem interpolação) — determinístico e testável. */
function percentileOf(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Agrega a janela de 60s de rodadas GATEADAS de uma câmera.
 * @returns {{skipped1m:number, skipMoving1m:number, ratioP50:number, ratioP95:number, reasons1m:object}}
 *
 * `skipMoving1m` É O NÚMERO QUE FALTAVA: rodadas PULADAS em que havia ≥1 track vivo
 * NÃO estacionário. Pulo com a cena de fato parada é ECONOMIA; pulo com gente andando
 * em quadro é CEGUEIRA — e até aqui os dois iam somados no mesmo `skipped1m`.
 *
 * Os percentis usam SÓ os ratios MEDIDOS (rodada com decode ok e gate ligado — o
 * engine grava ratio=0 com reason "decode-error"/"gate-off" quando não mediu). Contar
 * esses zeros puxaria os percentis PARA BAIXO justamente onde eles serão lidos p/
 * decidir o limiar: seria medir o instrumento, não a cena (regra 9 do CLAUDE.md).
 * Janela sem NENHUMA medição devolve 0 — leia junto com reasons1m antes de concluir
 * "cena parada" (0 aqui pode ser "não medi nada", e a diferença está lá).
 */
function gateStatsOf(log) {
  const ratios = [];
  const reasons1m = {};
  for (const k of GATE_REASONS) reasons1m[k] = 0;
  let skipped1m = 0;
  let skipMoving1m = 0;
  for (const g of log) {
    reasons1m[g.reason] = (reasons1m[g.reason] || 0) + 1;
    if (g.reason !== "decode-error" && g.reason !== "gate-off") ratios.push(g.ratio || 0);
    if (g.infer) continue;
    skipped1m += 1;
    if (g.moving > 0) skipMoving1m += 1; // ← pulou COM gente se movendo: cegueira MEDIDA
  }
  ratios.sort((a, b) => a - b);
  return {
    skipped1m,
    skipMoving1m,
    ratioP50: r4(percentileOf(ratios, 0.5)),
    ratioP95: r4(percentileOf(ratios, 0.95)),
    reasons1m,
  };
}

/**
 * Agrega a janela de 60s de IDADE DO QUADRO no despacho (engine.recordFrameAge → st.ageLog).
 * @returns {{p50:number, p90:number, n:number, trend:number}|null}  null = nada medido na janela.
 *
 * `trend` = média da 2ª metade menos a da 1ª metade, em ms. É o campo que decide, e ele existe
 * porque FILA É FENÔMENO CUMULATIVO: ela não aparece na mediana (a 1ª metade a segura), aparece
 * na TENDÊNCIA. Idade alta e ESTÁVEL é latência constante (câmera/encoder/rede) — outro
 * problema, outra ação. Idade que SOBE é fila, e fila não se conserta lendo mais rápido, se
 * conserta descartando o quadro velho. Mesmo critério de `scripts/diagnose-source.mjs`.
 */
function frameAgeStatsOf(log) {
  if (!Array.isArray(log) || !log.length) return null;
  const ages = log.map((e) => e.a);
  const sorted = [...ages].sort((a, b) => a - b);
  let trend = 0;
  if (ages.length >= 8) {
    const meio = Math.floor(ages.length / 2);
    const media = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
    trend = Math.round(media(ages.slice(meio)) - media(ages.slice(0, meio)));
  }
  return {
    p50: Math.round(percentileOf(sorted, 0.5)),
    p90: Math.round(percentileOf(sorted, 0.9)),
    n: ages.length,
    trend,
  };
}

/**
 * @param {object} snap  snapshot vivo do engine:
 *   { now, states:Map, focusedCams:Set, targetFpsOf(st), enabled, modelFile,
 *     fps:{normal,line,focus}, motionGate:{enabled,ratio,probeMs,probeFocusMs,thumb},
 *     autoscale:{mode,tier,pin,choked,idle,lastSwitchAt}, worker, go2rtcPull }
 * @returns {object} payload do /api/analysis/status (shape estável)
 */
// CPU/memória do PROCESSO do hub. `process.cpuUsage()` é acumulado desde o boot: guardamos a
// amostra anterior e derivamos a % da janela (mesma técnica do sampleCpu do pool). Janela mínima
// de 5s para o número não oscilar por ruído de amostragem; até a 1ª janela fechar devolve null —
// "ainda não medi" não é "0%".
let cpuAnterior = null;
function hubUso(now) {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  let cpuPct = null;
  if (!cpuAnterior) {
    cpuAnterior = { user: cpu.user, system: cpu.system, t: now };
  } else if (now - cpuAnterior.t >= 5000) {
    const dms = (cpu.user + cpu.system - cpuAnterior.user - cpuAnterior.system) / 1000;
    cpuPct = Math.round((dms / (now - cpuAnterior.t)) * 1000) / 10; // % de UM core
    cpuAnterior = { user: cpu.user, system: cpu.system, t: now };
  }
  return {
    cpuPct,
    rssMb: Math.round(mem.rss / 1e5) / 10,
    heapMb: Math.round(mem.heapUsed / 1e5) / 10,
    uptimeS: Math.round(process.uptime()),
  };
}

function buildStatus(snap) {
  const { now, states, focusedCams, targetFpsOf } = snap;
  const perCamera = {};
  let skipped1mAll = 0; // prova do ganho do gate — inferências puladas (60s, todas as câmeras)
  let skippedAll = 0; // idem, acumulado desde o boot
  for (const [id, st] of states) {
    let dets1m = 0;
    let excluded1m = 0;
    let automasked1m = 0;
    let reassoc1m = 0;
    for (const d of st.detsLog) {
      dets1m += d.n;
      excluded1m += d.x || 0;
      automasked1m += d.a || 0;
      reassoc1m += d.r || 0;
    }
    const cutoff = now - 60_000;
    // Poda deliberada (ver cabeçalho) + agregação da janela. Leitura DEFENSIVA do
    // gateLog: estado antigo/parcial não pode derrubar o /status inteiro.
    const gateLog = Array.isArray(st.gateLog) ? st.gateLog : [];
    while (gateLog.length && gateLog[0].t < cutoff) gateLog.shift();
    const gate = gateStatsOf(gateLog);
    // Idade do quadro: mesma poda deliberada do gateLog (câmera parada não deixa log velho).
    const ageLog = Array.isArray(st.ageLog) ? st.ageLog : [];
    while (ageLog.length && ageLog[0].t < cutoff) ageLog.shift();
    const frameAge = frameAgeStatsOf(ageLog);
    skipped1mAll += gate.skipped1m;
    skippedAll += st.skipped;
    perCamera[id] = {
      fps: Math.round((st.rounds.length / 60) * 100) / 100,
      targetFps: targetFpsOf(st), // cadência efetiva (foco > linha > normal); 0 se fadiga
      focused: focusedCams.has(id), // aberta em tela cheia por ≥1 dashboard
      queue: st.slots.count() + (st.latest ? 1 : 0), // inferências em voo (foco pode ter >1) + frame pendente
      skipped1m: gate.skipped1m, // rodadas puladas pelo gate nos últimos 60s
      skippedTotal: st.skipped, // total pulado desde o boot
      motion: r4(st.motionRatio), // último ratio de movimento (0..1)
      // SENSOR do gate (ADITIVO — nada acima mudou de shape). `skipMoving1m` responde
      // "o gate está me cegando?" com DADO: pulos com gente NÃO estacionária viva em
      // quadro. Os percentis do ratio existem p/ calibrar o limiar medindo, não
      // chutando (o limiar em si NÃO muda aqui — precision.js é dono, e mexer nele
      // passa pelo eval/). `reasons1m` = por que cada rodada rodou (ou não).
      gate: {
        skipMoving1m: gate.skipMoving1m,
        ratioP50: gate.ratioP50,
        ratioP95: gate.ratioP95,
        reasons1m: gate.reasons1m,
      },
      lastMs: st.lastMs,
      // IDADE DO QUADRO no despacho (ADITIVO). Leia JUNTO com `lastMs`: este é o transporte
      // (câmera→hub), aquele é a inferência — a soma é o que o operador sente. `null` = nenhuma
      // rodada despachada na janela (câmera parada/gateada), que NÃO é o mesmo que "idade 0".
      frameAge,
      dets1m,
      excluded1m, // dets de pessoa suprimidas por zona de exclusão em 60s
      longRange: st.longRange, // true = rodada com tiling no worker
      fadiga: st.fadiga, // true = câmera modo=fadiga (NÃO analisada no hub)
      source: st.source, // origem do último frame ("relay" | "go2rtc")
      // ESTABILIDADE DO VÍDEO (ADITIVO — health.observeFrame, O(1) por frame): maior lacuna e
      // nº de retomadas na janela de 60s. Cru aqui p/ transparência; o veredito é o `health`.
      maxGapMs: st.frameGapMax ?? null,
      retomadas1m: st.frameRetomadas ?? null,
      // SAÚDE (ADITIVO): separa "cena vazia" de "não estou medindo" — o falso-OK que fazia
      // câmera parada, IA parada e IA atrasada mostrarem a MESMA tela (contagem 0, sem aviso).
      // O veredito carrega o número que o sustenta (health.js `medido`).
      health: health.classifyCamera({
        now,
        lastFrameAt: st.lastFrameAt,
        lastInferAt: st.lastInferAt,
        fps: Math.round((st.rounds.length / 60) * 100) / 100,
        targetFps: targetFpsOf(st),
        frameAgeP50: frameAge ? frameAge.p50 : null,
        maxGapMs: st.frameGapMax,
        retomadas1m: st.frameRetomadas,
        hasTripwire: !!(snap.hasTripwireOf && snap.hasTripwireOf(id)),
        // fadiga roda no CLIENTE (ADR-009) → o motor não a cobre; acusar "IA parada" nela
        // seria acusar o desenho, não uma falha.
        analiseLigada: snap.enabled !== false && !st.fadiga,
      }),
    };
    // Auto-máscara: transparência — o operador vê onde a máscara agiu (rects
    // normalizados prontos p/ virar zona de exclusão manual). Formato: automask.statusOf.
    if (st.autoMask) {
      perCamera[id].automasked1m = automasked1m; // dets suprimidas pela auto-máscara em 60s
      perCamera[id].autoMask = automask.statusOf(st.autoMask);
    }
    // Tracker anti-rastro (precision.js 20-22): sensores da política de emissão.
    // Condicional (aditivo): só quando o estado carrega um tracker com stats().
    if (st.tracker && typeof st.tracker.stats === "function") {
      const tk = st.tracker.stats();
      perCamera[id].tracker = {
        reassoc1m, // saltos recuperados SEM id novo nos últimos 60s (2º estágio)
        reassocTotal: tk.reassociations, // idem, desde o boot
        lost: tk.lost, // tracks vivos INTERNOS mas ocultos do payload agora
      };
    }
  }
  return {
    enabled: snap.enabled,
    model: snap.modelFile,
    targetFps: snap.fps.normal,
    lineFps: snap.fps.line, // cadência das câmeras com linha/tripwire
    focusFps: snap.fps.focus, // cadência da câmera em foco (tela cheia)
    // Cadência da classe OCIOSA (sem linha/foco/zona proibida), DERIVADA da capacidade medida.
    // Igual a targetFps = pool sobrando (ninguém degradado); menor = frota cedeu p/ quem precisa.
    idleFps: snap.fps.idle,
    // INCIDENTES DE SAÚDE abertos (aditivo): o que já foi notificado e segue de pé — por câmera
    // e o SISTÊMICO (mesma condição em N câmeras = 1 causa). O colapso é da MENSAGEM; aqui o
    // registro aparece inteiro, senão a tela esconderia o que o WhatsApp resumiu.
    incidentesSaude: snap.incidentesSaude || [],
    // CUSTO por rodada (cost.js): decode (JPEG→tensor, sharp) × inferência (ONNX), p50/p95 na
    // janela de 60s. É a decomposição que separa "o modelo está caro" de "o transporte está
    // caro" — os dois têm remédios OPOSTOS, e sem separar se mexe no lugar errado. O worker já
    // media os dois; o host descartava o decode e guardava só o último inferMs de uma câmera.
    custo: (snap.worker && snap.worker.custo) || null,
    // CONSUMO DO PRÓPRIO HUB (aditivo). `worker.cpuPct` mede só o pool de inferência; o hub paga
    // por fora o relé/socket, o decode de thumbnail do gate (sharp) e o pull do go2rtc. Sem este
    // número, "o servidor está no limite?" não tem resposta honesta — sobrava só a fatia dos
    // workers, que é a MENOR parte quando há stream sendo decodificado. Os ffmpeg do go2rtc são
    // processos FILHOS (fora deste process.cpuUsage): quem fecha a conta é a métrica da MÁQUINA
    // (flyctl) — o relatório precisa dizer isso, não fingir cobertura que não tem.
    hub: hubUso(now),
    focused: [...focusedCams], // ids das câmeras focadas (união entre dashboards)
    autoMask: { mode: automask.AUTOMASK_MODE }, // modo global ("off"|"suggest"|"hide")
    // Gate de movimento — config + PROVA DO GANHO (inferências puladas).
    motionGate: {
      enabled: snap.motionGate.enabled,
      ratio: snap.motionGate.ratio, // limiar de movimento p/ rodar
      probeMs: snap.motionGate.probeMs, // piso: cena estática ainda roda a cada tanto (nunca-cego)
      probeFocusMs: snap.motionGate.probeFocusMs, // idem, câmera focada
      thumb: snap.motionGate.thumb, // resolução do thumbnail de luma
      skipped1m: skipped1mAll,
      skippedTotal: skippedAll,
    },
    // Auto-dimensionamento do modelo — tier ativo, modo e histerese (diagnóstico).
    autoscale: snap.autoscale,
    worker: snap.worker,
    go2rtcPull: snap.go2rtcPull,
    // RESUMO DA FROTA (ADITIVO): quantas câmeras em cada estado + a lista das problemáticas com
    // motivo. É o que uma tela de monitoramento consome sem varrer perCamera inteiro.
    health: health.summarize(
      Object.fromEntries(Object.entries(perCamera).map(([id, c]) => [id, c.health])),
    ),
    perCamera,
  };
}

module.exports = { buildStatus };
