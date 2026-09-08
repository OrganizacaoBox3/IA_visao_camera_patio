// ─────────────────────────────────────────────────────────────────────────────
// health.js — SAÚDE por câmera: separa "não tem nada acontecendo" de "não estou
// vendo nada". Função PURA (sinais medidos → estado + motivo + os números que
// sustentam o veredito); zero I/O, zero relógio próprio (o `now` entra por
// parâmetro). Consumidor: engine.status() → /api/analysis/status → painel.
//
// POR QUE ISTO EXISTE (o problema que ele resolve, medido nesta operação):
// "câmera parada", "câmera mandando vídeo mas a IA não analisou", "IA analisando
// mas atrasada" e "tudo bem, cena vazia" produziam a MESMA tela: contagem 0 e
// nenhum aviso. Isso é FALSO-OK — o operador conclui "não tem ninguém" quando o
// certo era "não estou medindo". Cada estado abaixo nasceu de um desses casos
// reais, e todo estado carrega o NÚMERO que o justifica (medição, não opinião).
//
// OS ESTADOS (ordem de precedência = do mais grave ao mais leve; o 1º que casa
// vence, porque um sintoma mais grave EXPLICA os de baixo — câmera sem frame
// obviamente também não tem inferência, e reportar os dois só dilui o sinal):
//   1. "sem-video"      — nenhum frame há > semVideoMs. A IA não tem o que ver.
//   2. "video-instavel" — frame chegando, mas com reconexão/lacuna frequente
//                         (reconnects1m ≥ instavelReconnects OU maior lacuna
//                         medida > instavelGapMs). O dado existe mas é picado.
//   3. "ia-parada"      — TEM frame fresco e a inferência parou (nenhuma rodada
//                         há > iaParadaFactor × cadência esperada). É o caso que
//                         mais engana: vídeo bonito na tela, número congelado.
//   4. "ia-atrasada"    — inferência rodando, mas (a) o frame analisado está
//                         velho (frameAgeP50 > atrasoFrameMs) ou (b) a cadência
//                         real está muito abaixo da meta (fps < atrasoFpsRatio ×
//                         targetFps). Número existe, mas não acompanha o vídeo.
//   5. "linha-sem-cadencia" — a câmera TEM tripwire e a cadência real não fecha
//                         travessia. MEDIDO: cruzamento exige ver a MESMA pessoa
//                         antes e depois da linha; a <linhaFpsMin fps a pessoa
//                         atravessa entre duas rodadas e o cruzamento é
//                         DESCARTADO por continuidade perdida (counting.js). Sem
//                         este aviso, o in/out fica 0 e parece "ninguém passou".
//   6. "ok"             — os sinais batem com a meta. Silêncio é informação.
//
// NÃO INVENTA DADO: sinal ausente (`null`/`undefined`) nunca vira veredito — se
// não há como saber, o estado degrada para "ok" com `motivo: "sem sinal"` em vez
// de acusar falha (acusar sem medir treina o operador a ignorar o aviso).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Limiares — DEFAULTS declarados aqui (dono único), sobrescrevíveis por parâmetro
// (o teste passa os seus; ops pode pinar no futuro sem tocar na lógica).
const DEFAULTS = Object.freeze({
  // Sem frame por mais que isto = "sem-video". 15s = 3× o pior caso saudável do
  // relé/go2rtc observado nesta operação (~5s entre frames em câmera ociosa com
  // gate de movimento ativo), então não acusa câmera lenta como câmera morta.
  semVideoMs: 15_000,
  // RETOMADAS (vídeo parou e voltou) na última janela de 1min que caracterizam
  // instabilidade. 3 é o piso onde deixa de ser evento isolado e vira padrão.
  // NOME HONESTO: é lacuna-e-retomada MEDIDA no fluxo de frames, não "reconexão
  // TCP" — o hub não tem esse sinal do ffmpeg/go2rtc hoje (rtsp.statuses() não
  // expõe contador de restart). Chamar de reconexão seria afirmar o que não medi.
  instavelRetomadas: 3,
  // Maior lacuna entre frames que ainda é "normal" — acima disso, picado.
  instavelGapMs: 8_000,
  // Multiplicador da cadência esperada que caracteriza "IA parada". 6× dá folga
  // pro gate de movimento (que legitimamente pula rodadas em cena estática) e
  // pro jitter do pool sob carga, sem deixar de pegar a parada real.
  iaParadaFactor: 6,
  // Piso absoluto do "ia-parada": mesmo com cadência esperada altíssima, só
  // acusa depois disto (evita alarme por um soluço de 1-2s).
  iaParadaMinMs: 12_000,
  // Idade do frame analisado (p50) acima da qual a análise não acompanha o vídeo.
  atrasoFrameMs: 3_000,
  // Fração da meta de fps abaixo da qual a cadência é "atrasada" (0.25 = a
  // câmera está entregando menos de 1/4 do que foi pedido pra ela).
  atrasoFpsRatio: 0.25,
  // Cadência mínima pra contagem de LINHA fechar travessia (ver counting.js:
  // o cruzamento precisa da MESMA pessoa em duas observações consecutivas).
  linhaFpsMin: 1.5,
});

/** Arredonda pra 2 casas — número de RELATÓRIO (o operador lê), não de cálculo. */
function r2(v) {
  return Math.round(v * 100) / 100;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Classifica a saúde de UMA câmera. PURA.
 *
 * @param {object} s  sinais MEDIDOS (todos opcionais — ausente = "não sei", nunca "falhou")
 * @param {number} [s.now]              relógio do chamador (ms epoch)
 * @param {number} [s.lastFrameAt]      ms epoch do último frame recebido
 * @param {number} [s.lastInferAt]      ms epoch da última rodada de inferência despachada
 * @param {number} [s.fps]              cadência REAL medida (rodadas/s na última janela)
 * @param {number} [s.targetFps]        cadência pedida pra esta câmera
 * @param {number} [s.frameAgeP50]      idade captura→despacho do frame analisado (ms, p50)
 * @param {number} [s.maxGapMs]         maior lacuna entre frames na janela
 * @param {number} [s.retomadas1m]      lacunas-e-retomadas do vídeo na última janela de 1min
 * @param {boolean} [s.hasTripwire]     a câmera tem linha de contagem configurada?
 * @param {boolean} [s.analiseLigada]   o motor cobre esta câmera? (false = fadiga/desligado)
 * @param {object} [limites]            override dos DEFAULTS (o teste usa; ops pode pinar)
 * @returns {{estado:string, motivo:string, desde:number|null, medido:object}}
 */
function classifyCamera(s = {}, limites = {}) {
  const L = { ...DEFAULTS, ...limites };
  const now = isNum(s.now) ? s.now : Date.now();

  // Cadência ESPERADA em ms entre rodadas (da meta da própria câmera; sem meta,
  // assume 1fps — o default do motor).
  const targetFps = isNum(s.targetFps) && s.targetFps > 0 ? s.targetFps : 1;
  const cadenciaMs = 1000 / targetFps;

  const semFrameMs = isNum(s.lastFrameAt) ? Math.max(0, now - s.lastFrameAt) : null;
  const semInferMs = isNum(s.lastInferAt) ? Math.max(0, now - s.lastInferAt) : null;

  // `medido` viaja em TODO veredito: é o que separa medição de inferência — o
  // operador (e o suporte) vê o número que sustentou o estado, não só o rótulo.
  const medido = {
    semFrameMs,
    semInferMs,
    fps: isNum(s.fps) ? r2(s.fps) : null,
    targetFps: r2(targetFps),
    frameAgeP50: isNum(s.frameAgeP50) ? Math.round(s.frameAgeP50) : null,
    maxGapMs: isNum(s.maxGapMs) ? Math.round(s.maxGapMs) : null,
    retomadas1m: isNum(s.retomadas1m) ? s.retomadas1m : null,
  };

  // 1. SEM VÍDEO — a IA não tem o que ver. Precede tudo: explica os de baixo.
  if (semFrameMs != null && semFrameMs > L.semVideoMs)
    return {
      estado: "sem-video",
      motivo: `nenhum frame há ${Math.round(semFrameMs / 1000)}s`,
      desde: isNum(s.lastFrameAt) ? s.lastFrameAt : null,
      medido,
    };

  // 2. VÍDEO INSTÁVEL — chega, mas picado (reconexão em série ou lacuna grande).
  const retomadasDemais =
    isNum(s.retomadas1m) && s.retomadas1m >= L.instavelRetomadas
      ? `${s.retomadas1m} retomadas de vídeo no último minuto`
      : null;
  const lacunaGrande =
    isNum(s.maxGapMs) && s.maxGapMs > L.instavelGapMs
      ? `lacuna de ${Math.round(s.maxGapMs / 1000)}s entre frames`
      : null;
  if (retomadasDemais || lacunaGrande)
    return {
      estado: "video-instavel",
      motivo: [retomadasDemais, lacunaGrande].filter(Boolean).join(" · "),
      desde: null,
      medido,
    };

  // Sem análise cobrindo a câmera (fadiga roda no cliente, ou motor desligado):
  // os estados de IA abaixo não se aplicam — acusá-los seria acusar o desenho.
  if (s.analiseLigada === false)
    return { estado: "ok", motivo: "análise não cobre esta câmera", desde: null, medido };

  // 3. IA PARADA — TEM frame fresco (passou pelo gate 1) e a inferência sumiu.
  const limiteParada = Math.max(L.iaParadaMinMs, cadenciaMs * L.iaParadaFactor);
  if (semInferMs != null && semInferMs > limiteParada)
    return {
      estado: "ia-parada",
      motivo: `vídeo chegando, mas nenhuma análise há ${Math.round(semInferMs / 1000)}s`,
      desde: isNum(s.lastInferAt) ? s.lastInferAt : null,
      medido,
    };

  // 4. IA ATRASADA — analisa, mas não acompanha: frame velho OU cadência muito
  // abaixo da meta. Os dois motivos coexistem no texto quando ambos batem.
  const frameVelho =
    isNum(s.frameAgeP50) && s.frameAgeP50 > L.atrasoFrameMs
      ? `frame analisado com ${(s.frameAgeP50 / 1000).toFixed(1)}s de atraso`
      : null;
  const cadenciaBaixa =
    isNum(s.fps) && s.fps < targetFps * L.atrasoFpsRatio
      ? `${r2(s.fps)} de ${r2(targetFps)} análises/s`
      : null;
  if (frameVelho || cadenciaBaixa)
    return {
      estado: "ia-atrasada",
      motivo: [frameVelho, cadenciaBaixa].filter(Boolean).join(" · "),
      desde: null,
      medido,
    };

  // 5. LINHA SEM CADÊNCIA — contagem de travessia exige continuidade; abaixo do
  // piso ela não fecha e o in/out fica 0 parecendo "ninguém passou".
  if (s.hasTripwire === true && isNum(s.fps) && s.fps < L.linhaFpsMin)
    return {
      estado: "linha-sem-cadencia",
      motivo: `linha exige ~${L.linhaFpsMin} análises/s p/ fechar travessia; medido ${r2(s.fps)}`,
      desde: null,
      medido,
    };

  // 6. OK — e quando não havia sinal nenhum, diz isso em vez de fingir veredito.
  const semSinal = semFrameMs == null && semInferMs == null && !isNum(s.fps);
  return {
    estado: "ok",
    motivo: semSinal ? "sem sinal" : "dentro do esperado",
    desde: null,
    medido,
  };
}

// Janela do máximo/contagem de lacuna — MESMA semântica dos outros *1m do status.
const GAP_JANELA_MS = 60_000;
// Lacuna que caracteriza "o vídeo parou e voltou". 5s = acima do pior caso saudável
// medido no relé/go2rtc com gate de movimento ativo (~1-2s entre frames).
const RETOMADA_GAP_MS = 5_000;

/**
 * Observa a CHEGADA de um frame e mantém, por câmera, a maior lacuna e o número de
 * retomadas na janela de 1min. MUTA `st` (mesmo padrão de presence-alert/occupancy-alert).
 *
 * CUSTO É O REQUISITO AQUI: este é o caminho mais quente do hub (todo frame de toda
 * câmera, dois pontos de entrada — relé e pull do go2rtc). Por isso é O(1) por frame,
 * sem array e sem alocação: um máximo e um contador com reinício por janela. A poda
 * por array (padrão dos logs por RODADA) não se pagaria numa frequência de FRAME.
 *
 * Chamar ANTES de atualizar st.lastFrameAt (precisa do valor anterior p/ medir a lacuna).
 * @param {{lastFrameAt?:number, frameGapAt?:number, frameGapMax?:number, frameRetomadas?:number}} st
 * @param {number} now  ms epoch da chegada
 * @param {{gapJanelaMs?:number, retomadaGapMs?:number}} [limites]
 */
function observeFrame(st, now, limites = {}) {
  const janela = limites.gapJanelaMs ?? GAP_JANELA_MS;
  const retomadaGap = limites.retomadaGapMs ?? RETOMADA_GAP_MS;
  if (!st.frameGapAt || now - st.frameGapAt > janela) {
    st.frameGapAt = now; // vira a janela: o máximo/contagem valem pelo último minuto
    st.frameGapMax = 0;
    st.frameRetomadas = 0;
  }
  const anterior = st.lastFrameAt;
  if (!isNum(anterior) || anterior <= 0) return; // 1º frame da câmera: não há lacuna a medir
  const gap = now - anterior;
  if (gap <= 0) return; // frame fora de ordem/mesmo ms: nada a afirmar
  if (gap > st.frameGapMax) st.frameGapMax = gap;
  if (gap >= retomadaGap) st.frameRetomadas += 1;
}

/** Estados que o painel deve destacar (o resto é silêncio). */
const ESTADOS_RUINS = Object.freeze([
  "sem-video",
  "video-instavel",
  "ia-parada",
  "ia-atrasada",
  "linha-sem-cadencia",
]);

/**
 * Resumo da frota: quantas câmeras em cada estado + a lista das problemáticas.
 * PURA. @param {Record<string, {estado:string}>} porCamera  saída de classifyCamera por id
 */
function summarize(porCamera = {}) {
  const contagem = {};
  const problemas = [];
  for (const [id, h] of Object.entries(porCamera)) {
    const e = (h && h.estado) || "ok";
    contagem[e] = (contagem[e] || 0) + 1;
    if (ESTADOS_RUINS.includes(e)) problemas.push({ id, estado: e, motivo: h.motivo });
  }
  return { total: Object.keys(porCamera).length, contagem, problemas };
}

module.exports = {
  classifyCamera,
  summarize,
  observeFrame,
  DEFAULTS,
  ESTADOS_RUINS,
  GAP_JANELA_MS,
  RETOMADA_GAP_MS,
};
