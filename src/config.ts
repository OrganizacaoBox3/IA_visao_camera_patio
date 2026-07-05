// Parâmetros e thresholds da POC. Ajuste aqui e recarregue para calibrar a demo.

// Acesso TIPADO às envs de build-time (Vite). Centraliza o cast largo
// `import.meta.env as Record<string, string | undefined>` que antes se repetia em cada
// leitura de VITE_* — um único ponto para ler variável de ambiente. undefined = ausente.
function env(key: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[key];
}

export const APP_CONFIG = {
  detection: {
    // Detecção de MOVIMENTO (diferença de frames, independente de classe)
    procWidth: 240, // largura do canvas de processamento (downscale)
    motionPixelDelta: 22, // delta de luminância (0-255) p/ considerar pixel "mudou"
    motionActiveRatio: 0.012, // fração da zona alterada p/ contar como movimento NORMAL (ATIVA)
    motionSlowRatio: 0.004, // movimento entre slow e active = BAIXA MOVIMENTAÇÃO / gargalo (LENTA)
    signalSmoothingAlpha: 0.4, // suavização EMA do score de movimento

    // Detecção de OCUPAÇÃO (objetos) — coco-ssd (roda em WORKER, fora da main thread)
    base: "mobilenet_v2" as "mobilenet_v1" | "mobilenet_v2" | "lite_mobilenet_v2", // melhor recall que lite_*
    objectIntervalMs: 350, // cadência da inferência na câmera ABERTA (full)
    objectScoreThreshold: 0.5,
    maxBoxes: 40, // teto de detecções por inferência (coco default é só 20 → perdia gente)
    minScore: 0.25, // limiar BRUTO do coco (baixo de propósito; filtramos por classe depois)
    occupancyClasses: ["person", "truck", "car", "bus", "motorcycle", "bicycle"] as const,
    // TILING: recorta o frame em blocos e detecta cada um — objetos pequenos/distantes ficam
    // relativamente maiores no input 300×300 do SSD, melhorando o recall em cenas amplas/densas.
    detectTileWidth: 512, // largura (px) de cada bloco enviado ao modelo
    tiles: { cols: 2, rows: 2, overlap: 0.12 }, // cols*rows=1 desliga o tiling
    nmsIoU: 0.45, // IoU p/ fundir detecções duplicadas nas bordas dos blocos

    // PERFIL "LONGO ALCANCE" / PANORÂMICA (P0 do plano `analises/plano-deteccao-objetos.md`).
    // OPT-IN POR CÂMERA: são só os PARÂMETROS do perfil; nada aqui muda o comportamento default.
    // Quem consome (frentes B/C: cameraConfig/CameraWorkspace/processors) liga o perfil por câmera
    // e repassa estes valores a `detectFrame(..., opts)` (tiling na grade + tile maior + limiares baixos)
    // e ao pipeline de movimento (procWidth/ratios mais sensíveis a micro-movimento distante).
    // Grade mais fina (4×4) + tile maior (640) resgatam objetos pequenos vistos de cima (rooftop/rua).
    longRange: {
      tiles: { cols: 4, rows: 4, overlap: 0.12 }, // grade fina p/ objetos pequenos/distantes
      detectTileWidth: 640, // px por bloco enviado ao modelo (mais pixels no alvo distante)
      objectScoreThreshold: 0.3, // limiar de OCUPAÇÃO por classe (mais baixo: alvos distantes pontuam menos)
      minScore: 0.15, // limiar BRUTO do coco no perfil (filtragem por classe vem depois)
      peopleScoreThreshold: 0.3, // confiança mínima p/ contar "person" no perfil
      procWidth: 480, // largura do canvas de movimento (mais detalhe p/ micro-movimento distante)
      motionActiveRatio: 0.004, // fração da zona alterada p/ "ATIVA" no perfil (mais sensível)
      motionSlowRatio: 0.0015, // fração p/ "LENTA/baixa movimentação" no perfil
    },

    // Máquina de estados / anti-flicker
    activeHoldMs: 1200, // tempo após movimento em que a zona segue "ATIVA"
    stateConfirmationMs: 900, // confirma transição de estado
    recoveryGraceMs: 1500, // tolerância ao sair de ALERTA
  },

  // Presença: contagem de pessoas + permanência ANÔNIMA (IDs efêmeros, sem rosto/identidade)
  people: {
    scoreThreshold: 0.4, // confiança mínima p/ contar "person" (baixado: alvos distantes pontuam menos)
    // THRESHOLD POR FINALIDADE (CALIBRAÇÃO) — decisão registrada, SEM novo número: PRESENÇA e
    // CONTAGEM compartilham este `scoreThreshold`. Cogitou-se um limiar de PRESENÇA menor que o de
    // CONTAGEM (contar exige mais certeza que só "notar alguém"), mas o detector novo (D-FINE-S) já
    // dá recall alto ~0.35 → um segundo limiar não muda o recall observado e só adicionaria uma
    // config para manter (overengineering). A fonte medida de falso positivo é objeto ESTÁTICO
    // (grade/placa/TV), tratada pelo modo de zona "Exclusão" (máscara), não por baixar o limiar —
    // baixar o corte AUMENTARIA os FPs estáticos. Reavaliar só se a medição mudar (acuracia-modelos.md).
    dwellMinMs: 800, // ignora aparições muito curtas (flicker)
    // ByteTrack-lite (Onda 2 do plano-contagem-pessoas): associação em 2 PASSADAS por IoU —
    // score alto associa/nasce; score BAIXO (minScore..scoreThreshold, antes descartado) só
    // SUSTENTA tracks existentes. Substitui o greedy por distância do caminho antigo (o antigo
    // trackMaxDist/trackTimeoutMs foi removido). Consumido por vision/bytetrack.ts + counter.
    track: {
      iouThreshold: 0.25, // IoU mínimo p/ associar detecção×track (contra a bbox PREDITA)
      ttlMs: 1500, // morte do track sem associação (ms)
      // Gate de TELEPORTE do counter (counting.ts maxDist). Era 0.25; com o ByteTracker o id só
      // avança por IoU com a predição (deslocamentos de id são estruturalmente plausíveis) e uma
      // rodada LENTA (LR full ~0,5-1,3s) desloca até ~0.3 do frame — 0.35 deixa o cruzamento real
      // contar sem abrir mão da defesa contra troca de alvo grosseira.
      counterMaxDist: 0.35,
      minCrossingFrames: 2, // histerese: lado novo sustentado N updates consecutivos antes de contar
      debounceMs: 800, // janela anti-oscilação por (track, linha) pós-cruzamento (counting.ts)
    },
  },

  zones: {
    // Limite de inatividade p/ disparar alerta. Tempo SEMPRE exibido em valor REAL (sem escala).
    // Agora é definido POR ÁREA na interface; este é só o default de zonas novas/semente.
    defaultIdleAlertMs: 15 * 60_000, // limite operacional (15 min)
    demoIdleAlertMs: 10_000, // limite curto p/ demonstrar ao vivo (10 s) — sobrepõe por-área quando "Limite curto" está ligado
    limitPresetsMs: [30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000], // 30s..30min
  },

  // Modo DEMONSTRAÇÃO. O "Limite curto (10s)" encurta o tempo de inatividade p/ disparar alertas
  // ao vivo (zones.demoIdleAlertMs), gerando alertas/andon/WhatsApp em massa. Em PRODUÇÃO deve ficar
  // DESLIGADO (alertas seguem o limite real por área). Liga-se explicitamente por:
  //   • env build-time VITE_DEMO_MODE=1  → default ligado (ambiente de demo); ou
  //   • o toggle "Limite curto (10s)" na central (override manual por sessão).
  demo: {
    shortLimitDefault: env("VITE_DEMO_MODE") === "1",
  },

  // OVERLAY da câmera ao vivo (Onda A — fundação consumida pela Onda 2/CameraWorkspace).
  //   confidenceThreshold: slider GLOBAL de confiança (0..1) p/ filtrar o que é desenhado.
  //   layers: toggles das camadas sobre o vídeo (caixas, máscara, zonas, heatmap).
  // Os casts `as number`/`as boolean` mantêm os tipos largos (não literais) p/ que o
  // CameraWorkspace possa atualizar os valores em estado/UI sem conflito de tipos.
  overlay: {
    confidenceThreshold: 0.5 as number,
    layers: {
      boxes: true as boolean,
      mask: true as boolean,
      zones: true as boolean,
      heatmap: false as boolean,
    },
  },

  // Central (dashboard): paginação dos feeds — só os feeds da página atual são PROCESSADOS
  // (inferência + decode + draw). Limita CPU/GPU com N câmeras (não roda inferência de todos).
  dashboard: {
    feedsPerPage: 6, // máx. de feeds processados simultaneamente por página
  },

  audio: {
    alertBeepCooldownMs: 4000,
    alertFrequencyHz: 880,
    alertDurationMs: 220,
  },

  timeline: {
    maxItems: 12,
    dedupeWindowMs: 1500,
  },

  metrics: {
    rollingSamples: 24,
  },

  // Modo LEITURA de código de barras (câmera lê códigos na esteira; N câmeras = 1 Ponto de Leitura)
  reading: {
    decodeIntervalMs: 120, // cadência de decodificação (~8/s) — throttle p/ performance
    dedupWindowMs: 1500, // mesmo código no ponto dentro disso = mesma caixa
    recentWindowMs: 60_000, // janela p/ throughput/contagem "recente"
    // Formatos (nomes do BarcodeDetector). ZXing tenta todos no fallback.
    formats: [
      "ean_13",
      "ean_8",
      "code_128",
      "code_39",
      "itf",
      "qr_code",
      "data_matrix",
      "upc_a",
      "upc_e",
    ] as string[],
    defaultPonto: "Ponto 1",
    // Captura de ALTA RESOLUÇÃO p/ câmeras de leitura (barras precisam de pixels).
    // A central pede esse perfil ao nó quando a câmera vira "leitura" (câmeras de atividade seguem em net.*).
    captureWidth: 1280, // default ("alta") — usado se a câmera não tiver preset
    captureQuality: 0.9, // qualidade JPEG (menos artefato = leitura melhor)
    captureFps: 8,
    // Presets de captura escolhíveis por câmera no modal ⚙ Câmeras.
    capturePresets: {
      media: { width: 960, quality: 0.8, fps: 8, label: "Média (960)" },
      alta: { width: 1280, quality: 0.9, fps: 8, label: "Alta (1280)" },
      maxima: { width: 1920, quality: 0.92, fps: 6, label: "Máxima (1920)" },
    } as Record<string, { width: number; quality: number; fps: number; label: string }>,
    // F3 — detecção de PASSAGEM de caixa (motion no ROI) p/ taxa de leitura e no-read.
    motionProcWidth: 160, // downscale p/ o diff de movimento (leve)
    motionPixelDelta: 22, // delta de luminância p/ "pixel mudou"
    passEnterRatio: 0.06, // fração do ROI alterada p/ considerar que ENTROU caixa
    passClearRatio: 0.02, // abaixo disso = ROI livre (fim da passagem)
    passDebounceMs: 600, // tempo mínimo entre passagens (anti-flicker)
    // Reconciliação passagens × leituras → taxa; alerta de queda de taxa.
    rateAlertPct: 80, // taxa de leitura abaixo disso (com volume) dispara alerta
    rateAlertMinPassages: 5, // só alerta com nº mínimo de passagens na janela (evita ruído)
    rateAlertCooldownMs: 30_000,
  },

  // Modo OBJETOS — detecção zero-shot (OWL-ViT via transformers.js, em worker).
  objects: {
    model: "Xenova/owlvit-base-patch32", // modelo zero-shot (baixado do HF na 1ª vez, depois cacheado)
    procWidth: 640, // largura p/ rasterizar o frame antes de detectar (custo×precisão)
    threshold: 0.1, // confiança mínima do OWL-ViT (scores são baixos)
    detectIntervalMs: 700, // cadência de detecção (zero-shot é pesado; o worker se auto-regula)
  },

  // Modo FADIGA (operador) — MediaPipe FaceLandmarker + HandLandmarker + coco-ssd (celular).
  // Câmera dedicada ao rosto do operador (≠ câmeras de área). Portado do sensor_fadiga_mvp.
  fadiga: {
    mediapipeWasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
    faceModelAssetUrl:
      "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    handModelAssetUrl:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    faceIntervalMs: 66,
    handIntervalMs: 90,
    objectIntervalMs: 220,
    phoneClassName: "cell phone",
    phoneScoreThreshold: 0.55,
    phoneMinRawScore: 0.28,
    phoneAdaptiveBoostEar: 0.22,
    phoneAdaptiveBoostHand: 0.18,
    phoneAdjustedScoreThreshold: 0.52,
    phoneRetainMs: 420,
    eyesClosedEarThreshold: 0.21,
    yawnMarThreshold: 0.075,
    fatigueConfirmationMs: 1500,
    phoneConfirmationMs: 1000,
    yawnConfirmationMs: 900,
    recoveryGraceMs: 600,
    signalSmoothingAlpha: 0.35,
    minAlertStateHoldMs: 900,
    handGestureConfirmationMs: 700,
    eyeIndices: { left: [33, 160, 158, 133, 153, 144], right: [362, 385, 387, 263, 373, 380] },
    mouthIndices: { width: [78, 308], open: [13, 14], draw: [78, 308, 13, 14] },
    rollingSamples: 24,
  },

  // Rede / hub de câmeras (socket.io). O dashboard processa; a câmera só envia frames.
  net: {
    // Servidor do hub (socket.io). Resolução em 3 níveis:
    //  1) VITE_HUB_URL (build-time) — força um endpoint explícito (ex.: hub dedicado).
    //  2) produção (HTTPS): mesma origem — o socket.io sobe via wss:// no mesmo domínio,
    //     com o web server (Caddy/nginx) fazendo reverse_proxy de /socket.io → 127.0.0.1:4000.
    //     Isso evita mixed-content (página https + ws:// é bloqueado pelo navegador).
    //  3) dev: mesma máquina na porta 4000 (permite celular apontar p/ o IP do laptop).
    serverUrl:
      env("VITE_HUB_URL") ??
      (typeof location !== "undefined"
        ? import.meta.env.DEV
          ? `http://${location.hostname}:4000`
          : location.origin
        : "http://localhost:4000"),
    // Resolução/fps de EXIBIÇÃO p/ câmeras de ATIVIDADE. A detecção reamostra p/ detection.procWidth
    // (240/512/640) de qualquer forma, então estes pixels só servem à tela e à detecção de atividade.
    // P1 (plano-performance-imagem.md): o gargalo é CPU/main-thread, NÃO banda (rede é LAN). A
    // super-compressão só piorava a qualidade sem ganho real → revertida p/ valores mais nítidos.
    // Trade-off: +decode/+banda por frame, aceitável em LAN. O modo LEITURA continua sobrepondo com
    // alta resolução própria (reading.capturePresets) via evento `capture` — não é afetado por aqui.
    // MJPEG é o FALLBACK (o caminho fluido é o WebRTC): não precisa do máximo absoluto, mas NÍTIDO.
    // Equilíbrio nitidez×custo declarado: 1280px mantido de propósito — o gargalo real é CPU/decode na
    // main-thread (não a banda; rede é LAN), e subir a largura encareceria o decode sem ganho visível
    // no tile. Quem precisa do máximo absoluto usa o WebRTC (nativo) ou o preset "maxima" da leitura.
    frameWidth: 1280, // largura do frame enviado (era 960) — mais nitidez p/ tile/full; leitura usa preset próprio
    frameFps: 12, // frames/s — mantido (não é o gargalo; 12 dá fluidez sem saturar a main-thread)
    jpegQuality: 0.9, // qualidade do JPEG (0.75→0.85→0.9): sem super-compressão; menos artefato de re-encode
  },

  // Gateway de vídeo go2rtc (Fase 1 do retrofit-performance / plano-fase1-go2rtc.md). OPT-IN por
  // câmera via camcfg `transport:"webrtc"` (default "mjpeg" = tile atual, inalterado). Servido
  // SAME-ORIGIN sob `/go2rtc/` (reverse-proxy → :1984), como já fazemos com `/socket.io/` e `/api/`;
  // o nome do stream = id da câmera. O <video-stream> assina o WS de sinalização em
  // `${baseUrl}/api/ws?src=<cameraId>` (o setter http→ws do componente cuida do protocolo).
  // Override por VITE_GO2RTC_BASE (ex.: dev apontando direto p/ `http://<host>:1984`).
  go2rtc: {
    baseUrl: env("VITE_GO2RTC_BASE") ?? "/go2rtc",
  },

  // Nó de webcam (/camera) — publicação de vídeo por WebRTC/WHIP ao go2rtc (Fase 5 do retrofit).
  //
  // DEFAULT = TENTA WebRTC/WHIP (Onda 1 da simplificação de config: "o melhor como base, sem flag").
  // A decisão é em RUNTIME por PROBE: o nó tenta publicar por RTCPeerConnection → go2rtc
  // (`POST ${go2rtc.baseUrl}/api/webrtc?dst=<id>`) — que o navegador NÃO estrangula em 2º plano,
  // eliminando a "câmera lenta ao minimizar". Se a negociação ESTABELECER, segue WebRTC. Se FALHAR
  // (go2rtc ausente/timeout/erro de conexão), o nó CAI SOZINHO (fallback automático, sem flag) para
  // o caminho JPEG-por-socket legado, byte-a-byte — retrocompat total (sem go2rtc = igual a hoje).
  //
  // Escape hatch (raro): VITE_WEBCAM_WHIP=0 FORÇA o JPEG sem sequer tentar o WHIP (build-time; p/ o
  // caso extremo de um browser/ambiente que precise ser fixado no legado). Qualquer outro valor
  // (ausente/"1"/…) = tenta WHIP. Antes esta flag era opt-in build-time do MELHOR (exigia rebuild
  // p/ ter o bom); agora o melhor é o default e a flag só serve p/ DESLIGAR.
  webcam: {
    whip: {
      // "attempt": tenta WHIP por default; só "0" desliga (escape hatch). Consumido em CameraPage.
      enabled: env("VITE_WEBCAM_WHIP") !== "0",
      probeTimeoutMs: 6000, // janela do probe: sem WHIP estabelecido até aqui → cai p/ JPEG (auto)
      // MELHOR QUALIDADE COMO BASE (norte "zero escolha"): o WebRTC/WHIP NÃO é estrangulado como o
      // MJPEG (é o caminho fluido), então dá p/ pedir o IDEAL do device — 1080p30 (whip.ts pede
      // 1920×1080@30 por constraint `ideal`; o device entrega o melhor que suporta, com fallback
      // automático se recusar). Tradeoff honesto: ~5 Mbps por webcam publicada (vs 1.5) e mais CPU
      // de encode no nó — aceitável em LAN, que é o alvo. Bitrate coerente com 1080p30 (H.264/VP8
      // a ~4–6 Mbps é nítido sem estourar). Escape hatch p/ link fraco: reduzir estes tetos.
      maxBitrateKbps: 5000, // teto de banda coerente com 1080p30 (era 1500 p/ 720p15)
      maxFramerate: 30, // fps do encoder — captura fluida (era 15); device com menos cai sozinho
    },
  },

  // (Zonas-semente automáticas removidas em jul/2026 — câmera nova abre LIMPA;
  // o usuário desenha as próprias zonas. Ver src/zones.ts.)
} as const;

// Perfil "Longo alcance"/Panorâmica (P0) — tipo exportado p/ as frentes B/C que ligam o perfil
// por câmera consumirem os parâmetros com tipos corretos. É OPT-IN: default segue `detection.*`.
export type LongRangeProfile = typeof APP_CONFIG.detection.longRange;

// Overlay (Onda A) — tipos exportados p/ a Onda 2 (CameraWorkspace) consumir.
export type OverlayLayers = typeof APP_CONFIG.overlay.layers;
export type OverlayConfig = typeof APP_CONFIG.overlay;

// ── MODO-COMO-PRESET (Onda B item 9) ───────────────────────────────────────────
// Cada MODO é um PRESET COMPLETO: ao trocar o modo de uma zona, a sessão recarrega
// de uma vez (1) quais CAMADAS de overlay ligar, (2) a CONFIANÇA default e (3) quais
// MÉTRICAS/KPIs o painel deve destacar — espelhando os "presets por exame" do
// ultrassom (03-ultrassom-imagem-medica.md §2.3/§3.5; síntese "Modo = preset completo").
// ADITIVO e RETROCOMPATÍVEL: o bloco `overlay` acima segue sendo o estado-base/fallback
// da sessão; o preset apenas SOBRESCREVE camadas/confiança quando o modo é trocado, e o
// operador pode reajustar manualmente depois (os toggles/slider continuam valendo).
//
// `ModeKey` repete o literal de `ZoneMode` (zones.ts) de propósito: config.ts é importado
// POR zones.ts, então não pode importá-lo de volta (evita dependência circular). Se um novo
// modo for adicionado em ZoneMode, o TS acusará a chave faltante aqui em MODE_PRESETS.
export type ModeKey = "atividade" | "leitura" | "objetos" | "fadiga";

// Uma métrica/KPI em destaque no painel para o modo (chave estável + rótulo curto p/ UI).
export type ModeMetric = { key: string; label: string };

export type ModePreset = {
  label: string; // nome curto do modo (UI)
  description: string; // o que o modo monitora (UI, 1 linha)
  layers: OverlayLayers; // camadas a LIGAR ao entrar no modo
  confidenceThreshold: number; // confiança default do modo (0..1)
  metrics: ModeMetric[]; // KPIs/indicadores que o painel destaca neste modo
};

export type ModePresets = Record<ModeKey, ModePreset>;

export const MODE_PRESETS: ModePresets = {
  atividade: {
    label: "Atividade",
    description: "Movimento e ocupação por zona; alerta de parada/gargalo.",
    layers: { boxes: true, mask: true, zones: true, heatmap: false },
    confidenceThreshold: 0.5, // tracks de pessoa têm score razoável
    metrics: [
      { key: "state", label: "Estado" },
      { key: "people", label: "Pessoas" },
      { key: "idle", label: "Parada" },
      { key: "flow", label: "Fluxo" },
    ],
  },
  leitura: {
    label: "Leitura",
    description: "Leitura de códigos na esteira; taxa, ritmo e no-reads.",
    layers: { boxes: false, mask: false, zones: true, heatmap: false }, // só a faixa de leitura importa
    confidenceThreshold: 0.5,
    metrics: [
      { key: "ratePct", label: "Taxa" },
      { key: "perMin", label: "Lidas/min" },
      { key: "noReads", label: "No-reads" },
      { key: "lastCode", label: "Último código" },
    ],
  },
  objetos: {
    label: "Objetos",
    description: "Contagem de objetos/classes na cena (zero-shot).",
    layers: { boxes: true, mask: false, zones: true, heatmap: false },
    confidenceThreshold: 0.15, // scores do OWL-ViT são baixos (objects.threshold=0.1) → não esconder caixas
    metrics: [
      { key: "total", label: "Total em cena" },
      { key: "counts", label: "Por classe" },
    ],
  },
  fadiga: {
    label: "Fadiga",
    description: "Sinais de fadiga do operador (olhos/boca) e uso de celular.",
    layers: { boxes: true, mask: false, zones: true, heatmap: false }, // boxes liga os marcadores de rosto/celular
    confidenceThreshold: 0.5,
    metrics: [
      { key: "risk", label: "Risco" },
      { key: "ear", label: "EAR" },
      { key: "phone", label: "Celular" },
    ],
  },
};
