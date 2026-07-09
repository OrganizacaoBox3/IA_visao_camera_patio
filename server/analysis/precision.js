// ─────────────────────────────────────────────────────────────────────────────
// precision.js — PAINEL DE PRECISÃO do motor. Dono ÚNICO dos knobs de QUALIDADE
// de detecção/tracking/contagem de pessoa. Mexer num eixo de precisão = editar
// AQUI e medir pelo sensor apontado no knob. Sem dependências; objeto congelado.
//
// CONTRATO: entra process.env (lido 1× na carga), sai PRECISION (serializável).
// O worker de inferência é OUTRO processo (fork herda o env do hub): o env segue
// sendo o TRANSPORTE, este módulo é o único INTERPRETADOR — worker.js dá require
// no MESMO painel e resolve os MESMOS valores. Os scripts do eval/ sobrepõem via
// env do fork (ex.: ANALYSIS_SCORE_MIN) e continuam funcionando sem mudança.
//
// FORA do painel (fronteira): knobs de CUSTO/capacidade — cadência (ANALYSIS_FPS/
// _LINE/_FOCUS, engine.js), pool/threads (worker-host.js/autoscale.js), janela de
// ingest (ANALYSIS_AGG_MS). Cadência afeta a contagem (recall×cadência), mas é
// dimensionamento, não qualidade. O gate de aprendizado da auto-máscara mora em
// automask.js (feature própria, env próprio). Tier do modelo: model.js/autoscale.
//
// INVARIANTE (D.10): mudança de QUALQUER knob deste painel passa por `npm run
// eval` antes/depois; decisão de DEFAULT exige full-set (o fixture já enganou:
// 512 passou o gate e perdeu ~8pp de recall pequena — perf-input-size-dfine.md).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** Número de env com clamp [min,max] e default (mesma semântica do motion.js). */
function numEnv(raw, def, min, max) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

// Input do resize (ANALYSIS_INPUT): eixo dinâmico do ONNX → múltiplo de 32 (stride
// do backbone) sem re-exportar; clamp [160,1024] evita OOM/grafo degenerado.
function resolveInputSize() {
  const raw = Number(process.env.ANALYSIS_INPUT);
  if (!Number.isFinite(raw) || raw <= 0) return 640;
  const snapped = Math.round(raw / 32) * 32;
  return Math.max(160, Math.min(1024, snapped));
}

// Input da câmera FOCADA (ANALYSIS_FOCUS_INPUT). Câmera aberta em tela cheia troca RECALL por
// LATÊNCIA: input menor → inferência mais rápida → overlay mais fresco (o marcador acompanha a
// pessoa; medido no 07-*: S@1080p focada dá só ~1,4fps, o gargalo é a inferência). DEFAULT =
// resolveInputSize() (= input global → NENHUMA mudança de comportamento; é opt-in por deploy).
function resolveFocusInput() {
  const raw = Number(process.env.ANALYSIS_FOCUS_INPUT);
  if (!Number.isFinite(raw) || raw <= 0) return resolveInputSize();
  const snapped = Math.round(raw / 32) * 32;
  return Math.max(160, Math.min(1024, snapped));
}

const PRECISION = Object.freeze({
  // ── Detector (consumidor: worker.js — squash/tiles; engine.js — tiles no pedido) ──
  detector: Object.freeze({
    // 1. Piso do worker: dets ≥ scoreMin voltam ao engine. 0.25 sustenta tracks na
    //    2ª passada do ByteTrack (score baixo NÃO nasce track — ver highScore).
    //    SENSOR: `npm run eval` → recall_all@0.25.
    scoreMin: Number(process.env.ANALYSIS_SCORE_MIN ?? 0.25),
    // 2. Ponto de operação/nascimento: 1ª passada do tracker e nascimento exigem
    //    ≥ highScore (0.35 calibrado no fixture — F1 82,1% no S@640).
    //    SENSOR: gate f1_all@0.35; contagem fim-a-fim = acuracia-modelos.md §3 (harness na F2).
    highScore: Number(process.env.ANALYSIS_HIGH_SCORE ?? 0.35),
    // 3. NMS por classe no worker: o D-FINE emite queries duplicadas no mesmo alvo
    //    na faixa 0.25-0.5. Baixar mata pessoas lado a lado; subir deixa duplicata.
    //    SENSOR: gate precision_all@0.35.
    nmsIou: Number(process.env.ANALYSIS_NMS_IOU ?? 0.6),
    // 4. Dedupe do tiling por CONTENÇÃO (interseção/área da caixa MENOR): a caixa
    //    PARCIAL do tile vizinho tem IoU baixo com a inteira e passaria no NMS.
    //    0.7 conservador: duas pessoas realmente lado a lado não se contêm a 70%.
    //    SENSOR: `node eval/run-eval.mjs --mode tiled`.
    containment: 0.7,
    // 5. Alvo do resize squash (ANALYSIS_INPUT). 640 = input de treino (default).
    //    ESCAPE-HATCH MEDIDO (opt-in por deploy): 896 = +5 a +8pp de recall em CENA
    //    DENSA (multidão), precisão INTACTA, a ~1,87× CPU/frame (≈ metade das câmeras
    //    por core) — vale onde o HW afona; default fica 640 p/ não dobrar CPU em box
    //    apertado (homolog 4-core). 512 = -23% CPU mas -7-8pp recall pequena; 416 reprova.
    //    SENSOR: eval/persons-cftv.mjs (MOT20, GT) + gate. Evidência: reconhecimento-
    //    pessoas/04-resultado-fullset-capacidade.md + perf-input-size-dfine.md.
    input: resolveInputSize(),
    // 5b. Input da câmera FOCADA (ANALYSIS_FOCUS_INPUT) — CUSTO/latência, não qualidade de fundo.
    //    Consumidor: engine.js (manda `input` no pedido só quando a câmera está em FOCO). Default =
    //    input global (sem mudança). SENSOR: scripts/measure-focus.cjs (cadência) + 07-diagnostico-
    //    overlay-lag.md. Menor = overlay mais fresco (marcador acompanha) × menos recall NA focada.
    focusInput: resolveFocusInput(),
    // 6. Grid do perfil longRange (tiling estilo SAHI): 2×2/0.1 espelha o front
    //    (src/vision/detect.ts). Fixo (YAGNI): grid maior re-quadruplica o custo
    //    sem caso medido. SENSOR: run-eval --mode tiled (recall distante × ms/frame).
    tiles: Object.freeze({ cols: 2, rows: 2, overlap: 0.1 }),
  }),

  // ── Tracker ByteTrack (consumidor: engine.js → createByteTracker) ───────────
  // Espelho consciente de APP_CONFIG.people.track do front (src/config.ts) — mudou
  // aqui, confira lá (duplicação declarada; teste de paridade de VALORES pendente).
  tracker: Object.freeze({
    // 7. IoU mínimo p/ associar detecção×track (contra a bbox PREDITA). Baixar
    //    associa vizinhos errados; subir derruba id em rodada lenta.
    //    SENSOR: bytetrack.test.js (cenários de campo) + travessias contadas.
    iouThreshold: 0.25,
    // 8. Guarda de nascimento: det alta sem par que sobrepõe track ativo além disso
    //    NÃO nasce (evita 1 pessoa virar 2 por até ttlMs — bug de campo).
    //    0.55 conservador. SENSOR: bytetrack.test.js.
    birthIouThreshold: 0.55,
    // 9-11. Derivação do TTL — ver trackTtlMs() abaixo (nunca-cego: acoplado ao
    //    probe). É também o TTL INTERNO dos tracks LOST (janela máxima em que a
    //    re-associação ainda devolve o MESMO id — knob 22).
    ttlFloorMs: 1500,
    ttlRoundFactor: 3.5,
    ttlProbeMarginMs: 2000,
    // 20. RE-ASSOCIAÇÃO (2º estágio) — FOLGA do raio, normalizada. Det alta sem par
    //     por IoU re-casa com track sem par se dist(centro da det, centro PREVISTO)
    //     ≤ folga + |v|·gap. POR QUÊ: fonte flaky/gate/probe criam GAPS entre
    //     rodadas analisadas; a predição erra mais que o bbox, o IoU zera e a MESMA
    //     pessoa virava id novo a cada salto. Baixar perde re-identificação no
    //     salto; subir arrisca herdar id de vizinho (mitigado: par inequívoco +
    //     tamanho compatível + só score alto). 0 desliga o estágio.
    //     SENSOR: bytetrack.test.js (salto moderado/extremo/ambíguo) + eval:counting
    //     + status().perCamera[id].tracker.reassoc1m em campo.
    reassocDist: 0.12,
    // 21. Gap MÁXIMO (ms) desde o último match p/ tentar o 2º estágio. Além disso a
    //     extrapolação |v|·gap não é confiável → id novo (aceito — salto extremo/
    //     oclusão longa). ~2.5s cobre fonte flaky e rodada perdida; o PROBE de 6s
    //     em cena estática re-casa por IoU (pessoa parada → predição parada) e não
    //     depende deste gate. SENSOR: bytetrack.test.js + tracker.reassoc1m.
    reassocMaxGapMs: 2500,
    // 22. POLÍTICA LOST (anti-rastro): rodadas ANALISADAS sem match antes do track
    //     sair da EMISSÃO (analysis-tracks/ocupação/contagem). Segue vivo INTERNO
    //     até o TTL (9-11) p/ o 2º estágio devolver o MESMO id. 1 = uma rodada de
    //     graça SÓ p/ OCLUSÃO (miss de 1 rodada não pisca overlay/zona — recall a
    //     2fps é intermitente); em rodada de REALOCAÇÃO (nascimento/re-associação)
    //     a graça é suprimida — 1 pessoa que saltou nunca vira 2 tracks emitidos
    //     (bytetrack.js). 0 faria o overlay piscar a cada miss; subir recria o
    //     rastro. SENSOR: pipeline.test.js (payload sem lost) + eval:counting
    //     (salto extremo/oclusão longa) + status().tracker.lost.
    lostAfterMisses: 1,
  }),

  // ── Contador de linha (consumidor: engine.js → createCounter) ───────────────
  counter: Object.freeze({
    // 12. Deslocamento mínimo (norm.) p/ avaliar cruzamento — filtra micro-jitter
    //     do bbox. SENSOR: counting.test.js (replay determinístico).
    minMove: 0.01,
    // 13. Gate de TELEPORTE: salto > maxDist re-ancora sem contar (id reciclado
    //     do tracker não vira travessia falsa). SENSOR: counting.test.js.
    maxDist: 0.35,
    // 14. Janela pós-cruzamento em que o MESMO track na MESMA linha não reconta
    //     (pessoa oscilando sobre a linha). SENSOR: counting.test.js.
    debounceMs: 800,
    // 15. HISTERESE: o lado novo precisa se sustentar 2 rodadas antes de contar
    //     (o update do cruzamento é a 1ª). SENSOR: counting.test.js.
    minCrossingFrames: 2,
  }),

  // ── Gate de movimento (consumidor: motion.js defaults + engine.js probe) ────
  // Trade-off declarado: o gate economiza inferência (sensor de CUSTO existe) mas
  // NÃO tem sensor direto de recall do pulo — a defesa é o desenho nunca-cego
  // (baseline + piso de probe + fail-open + TTL ≥ probe). Lacuna honesta (02 §4.2).
  gate: Object.freeze({
    // 16. Fração do thumbnail que precisa mudar p/ "há movimento" (0.005 ≈ 15 px
    //     de 64×48). SENSOR: status().motionGate.skipped1m (economia) + dets1m.
    motionRatio: numEnv(process.env.ANALYSIS_MOTION_RATIO, 0.005, 0, 1),
    // 17. Piso de probe: cena estática AINDA roda a cada tanto (pega quem apareceu
    //     e congelou — nunca-cego). SENSOR: status().motionGate.probeMs + skipped1m.
    probeMs: numEnv(process.env.ANALYSIS_MOTION_PROBE_MS, 6000, 500, 60_000),
    // 18. Piso de probe da câmera FOCADA (tela cheia): operador olhando merece
    //     latência menor de descoberta. SENSOR: idem.
    probeFocusMs: numEnv(process.env.ANALYSIS_MOTION_PROBE_FOCUS_MS, 2000, 250, 60_000),
    // 19. |luma−prev| p/ "pixel mudou" — MESMO valor de atividade.motionPixelDelta
    //     (front); constante (knob que ninguém calibra é ruído de config).
    //     SENSOR: motion.test.js.
    pixelDelta: 22,
  }),
});

/**
 * TTL do track/counter DERIVADO (nunca vira número solto): a 1fps o TTL de 1500ms
 * do front mataria o track numa rodada perdida; e COM gate de movimento o track
 * precisa sobreviver ao maior intervalo entre inferências — o piso de PROBE —
 * senão a pessoa parada some entre dois probes e renasce com id novo (nunca-cego
 * quebrado). Margem de ttlProbeMarginMs cobre o jitter da cadência.
 * @param {{ roundMs:number, gateOn:boolean }} p  cadência base + gate ligado?
 * @returns {number} ttl em ms = max(piso, round×fator, gateOn ? probe+margem : 0)
 */
function trackTtlMs({ roundMs, gateOn }) {
  const t = PRECISION.tracker;
  return Math.max(
    t.ttlFloorMs,
    Math.round(roundMs * t.ttlRoundFactor),
    gateOn ? PRECISION.gate.probeMs + t.ttlProbeMarginMs : 0,
  );
}

module.exports = { PRECISION, trackTtlMs };
