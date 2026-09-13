// Supressão de inundação (flood suppression) por câmera. Quando uma câmera
// dispara muitos alertas em rajada (ex.: feed caiu → todas as zonas viram VAZIA),
// colapsa em UM alerta de resumo/causa-raiz em vez de N alertas individuais.
// Retorna a decisão (pass-through, resumo colapsado) ou null (suprimido por já
// estar colapsado na janela).
const { log, FLOOD_WINDOW_MS, FLOOD_THRESHOLD, FLOOD_SUMMARY_MS } = require("./config");
const { floodWin, floodState } = require("./state");
const { maxPriority, makeDecision } = require("./priority");

function applyFlood(cameraId, zona, text, ts, priority, now, meta) {
  // Sem câmera identificável não dá para agrupar com segurança → repassa.
  if (cameraId === "_")
    return makeDecision(text, ts, priority, {
      cameraId,
      zona,
      tipo: meta.tipo,
      critico: meta.critico,
    });

  let win = floodWin.get(cameraId);
  if (!win) {
    win = [];
    floodWin.set(cameraId, win);
  }
  while (win.length && now - win[0] > FLOOD_WINDOW_MS) win.shift(); // poda janela
  win.push(now);

  const flooding = win.length > FLOOD_THRESHOLD;

  if (!flooding) {
    if (floodState.has(cameraId)) floodState.delete(cameraId); // episódio encerrado
    return makeDecision(text, ts, priority, {
      cameraId,
      zona,
      tipo: meta.tipo,
      critico: meta.critico,
    });
  }

  // Em inundação: colapsa.
  let st = floodState.get(cameraId);
  if (!st) {
    st = { zonas: new Set(), lastSummaryTs: 0, n: 0 };
    floodState.set(cameraId, st);
  }
  if (zona) st.zonas.add(zona);
  st.n++;

  if (now - st.lastSummaryTs >= FLOOD_SUMMARY_MS) {
    st.lastSummaryTs = now;
    // breadth da rajada: distintas zonas vistas no colapso ∪ tamanho da janela
    // (a janela inclui os alertas que passaram antes do colapso disparar).
    const nZonas = Math.max(st.zonas.size, win.length);
    const resumo = `⚠ ${cameraId}: rajada de alertas — ${nZonas} zona(s) afetada(s) (possível queda de feed)`;
    log.warn(
      { cameraId, zonas: nZonas, suprimidos: st.n, janelaMs: FLOOD_WINDOW_MS },
      "[alarm] inundação colapsada em resumo",
    );
    // A RAJADA NÃO ESCALA MAIS PARA CRÍTICO (2026-09-13). O resumo é SINTOMA: os alertas que
    // ele colapsou já saíram (ou serão reemitidos) com a gravidade de cada um. Forçar
    // `critical` aqui contava o mesmo problema duas vezes e era uma das fontes dos 83% de
    // crítico medidos. O piso "high" preserva a intenção original — rajada merece atenção —
    // sem rebaixar um crítico legítimo que estivesse no meio dela (maxPriority).
    return makeDecision(resumo, ts, maxPriority(priority, "high"), {
      cameraId,
      zona: "*",
      tipo: meta.tipo,
      critico: true,
      summary: true,
      count: nZonas,
    });
  }

  log.debug({ cameraId, suprimidos: st.n }, "[alarm] alerta suprimido (inundação ativa)");
  return null;
}

module.exports = { applyFlood };
