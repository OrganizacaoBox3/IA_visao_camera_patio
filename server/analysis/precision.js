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
    //    ⚠ NÃO aplicar no NMS do squash: MEDIDO (2026-07-25), recall_all@0.25 cai 4,4pp
    //    (pessoa parcialmente contida em cena densa é gente real). A duplicata parcial
    //    do D-FINE é tratada na guarda de NASCIMENTO do tracker (knob 8b abaixo).
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
    // 8b. Guarda de nascimento por CONTENÇÃO (2026-07-25 — bug de campo "2 caixas na
    //    MESMA pessoa" reincidiu): a query duplicada do D-FINE é caixa PARCIAL
    //    (cabeça/torso) CONTIDA na inteira — IoU ~0.1-0.3 passa pelo knob 8 e nascia
    //    2º track. Det alta sem par com contenção ≥ isto contra track observado/predito
    //    não nasce (track livre → recupera; ocupado → descarta) — SÓ contra track FRESCO
    //    (misses 0; track em miss + escala diferente é o caso do 2º estágio: id novo,
    //    contrato testado "tamanho INCOMPATÍVEL não re-associa"). POR QUE NO TRACKER e
    //    não no NMS do worker: MEDIDO no gate — contenção no NMS do squash derruba
    //    recall_all@0.25 em 4,4pp (83,2% < 87,6%: pessoa parcialmente contida em cena
    //    densa é gente REAL); no nascimento o custo é só adiar track novo de quem está
    //    ≥70% contido (oclusão profunda) até se separar. 0.7 espelha o containment do
    //    tiling (knob 4). 0 desliga. SENSOR: bytetrack.test.(ts|js) + eval:counting.
    birthContainment: 0.7,
    // 9-11. Derivação do TTL — ver trackTtlMs() abaixo (nunca-cego: acoplado ao
    //    probe). É também o TTL INTERNO dos tracks LOST (janela máxima em que a
    //    re-associação ainda devolve o MESMO id — knob 22). Vale como MORTE só p/ o
    //    track MÓVEL: p/ o ESTACIONÁRIO (knobs 23-26) ele vira PISO — não mata sozinho,
    //    mas a morte por evidência também não acontece antes dele.
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
    //     Vale p/ o track MÓVEL; o ESTACIONÁRIO tem graça própria (knob 25).
    lostAfterMisses: 1,

    // ── ESTADO ESTACIONÁRIO (F3 — spec-tracking-pessoa-parada §2 C2) ────────────
    // "Parado" é ESTADO, não morte: o track cuja posição fica estável ENTRA no estado
    // (caixa congelada, v=0), fica ISENTO do TTL de relógio (9-11) e passa a morrer
    // por EVIDÊNCIA (rodadas ANALISADAS sem match — rodada PULADA pelo gate não conta:
    // "não vi" ≠ "não estava"). É o conserto do bug de campo "o marcado some se a
    // pessoa estiver parada" e da métrica-que-mata (zona VAZIA com pessoa dentro).
    // SENSOR de todos: eval/stationary.mjs (roda no npm run eval:counting) — a régua
    // CA-8 mede ocupação/ghost/id-switch de dwell sob o gate de movimento REAL.
    // WIRING fechado (2026-07-25, spec-overlay-tempo-real Onda 1a): engine.byteTrackerOpts()
    // passa os 4 ao createByteTracker — este painel MANDA em produção; o teste de fiação
    // em engine.test.js quebra se um knob deixar de chegar.
    //
    // 23. Tolerância de JITTER do bbox (norm.): deslocamento do centro que ainda NÃO é
    //     movimento. Medido contra a ÂNCORA (onde a imobilidade começou) — quem TREME
    //     oscila em volta dela, quem DERIVA acumula e estoura. 0.01 = o MESMO minMove
    //     do counter (knob 12): a mesma noção de micro-jitter, um número só. Apertar é
    //     FAIL-SAFE (o track só não entra no estado); afrouxar demais faz caminhada
    //     lenta virar "parado" (perde-se a re-associação por distância — knob 20).
    stationaryTolerance: 0.01,
    // 24. Observações ESTÁVEIS consecutivas p/ ENTRAR no estado. 2 no hub: sob o gate,
    //     a cena estática só é inferida no PROBE (6s — knob 17), então 2 observações
    //     ≈ 12s de imobilidade (a ordem de grandeza do stationary.threshold do Frigate,
    //     ~10s). NUNCA 1: o track precisa de mais de uma evidência de imobilidade antes
    //     de sair do 2º estágio (anti-hijack). Espelho do front: 3 (rodada ~350ms).
    stationaryEnterRounds: 2,
    // 25. MORTE POR EVIDÊNCIA: rodadas ANALISADAS consecutivas sem match que o
    //     ESTACIONÁRIO tolera — é também a graça de EMISSÃO dele (enquanto vivo e não
    //     refutado, a caixa congelada É a evidência de presença: a zona fica OCIOSA,
    //     nunca VAZIA). A morte exige ISTO **E** o TTL (9-11) como piso: só a evidência
    //     mataria a pessoa parada em CENA MOVIMENTADA (aí o gate analisa a 2fps e 4
    //     oclusões seguidas = 2s, mais cedo que o TTL de hoje). 3 = tolera 3 probes
    //     cegos (~18s de detector piscando na pessoa sentada) e ainda fecha a saída em
    //     ≤ 4 probes. Subir = mais ghost quando a pessoa some sem ser vista saindo;
    //     baixar = a parada morre e o dwell zera. SENSOR: eval/stationary.mjs
    //     (occupancySurvivalPct × ghostTimeMs — os dois lados do mesmo knob).
    stationaryMaxMisses: 3,
    // 26. Teto de vida do estacionário (ms). 0 = SEM teto (escolhido): matar por
    //     RELÓGIO um track re-confirmado por evidência a cada probe é EXATAMENTE o bug
    //     que a F3 conserta (o dwell do operador zeraria no meio do turno). Fica como
    //     escape-hatch p/ o caso patológico (det fantasma eternamente re-confirmada —
    //     cujo tratamento certo é a auto-máscara/zona de exclusão, não o tracker).
    stationaryMaxMs: 0,
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
