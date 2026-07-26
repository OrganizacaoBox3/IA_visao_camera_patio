// ── Atraso de REPRODUÇÃO do vídeo WebRTC (modo síncrono — config overlay.syncDelayMs) ──────────
// Pede ao receiver do RTCPeerConnection que SEGURE a reprodução N ms (jitterBufferTarget é o
// padrão, em ms; playoutDelayHint é o legado Chrome, em segundos — setamos os dois). Com o vídeo
// atrasado e o overlay renderizando o MESMO instante (TrackInterpolator.sample(now, syncDelayMs)
// com histórico), a caixa é interpolação EXATA entre observações — zero arrasto por construção.
//
// É um HINT: o navegador pode aplicar aproximado. O `pc` do <video-stream> nasce/renasce a cada
// (re)conexão interna do elemento — o chamador REAPLICA periodicamente (idempotente e barato).

type ReceiverWithDelay = RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number };

/** Aplica o atraso nos receivers do pc do elemento. true = havia pc e ao menos 1 receiver tocado. */
export function applyPlayoutDelay(el: { pc?: RTCPeerConnection | null } | null | undefined, ms: number): boolean {
  const pc = el?.pc;
  if (!pc || ms <= 0) return false;
  let applied = false;
  for (const r of pc.getReceivers()) {
    try {
      const rec = r as ReceiverWithDelay;
      rec.jitterBufferTarget = ms;
      rec.playoutDelayHint = ms / 1000;
      applied = true;
    } catch {
      /* receiver sem suporte ao hint — segue (o overlay ainda casa pelo knob) */
    }
  }
  return applied;
}
