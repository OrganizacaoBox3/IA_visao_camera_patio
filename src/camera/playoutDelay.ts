// ── Atraso de REPRODUÇÃO do vídeo WebRTC (modo síncrono — config overlay.syncDelayMs) ──────────
// Pede ao receiver do RTCPeerConnection que SEGURE a reprodução N ms (jitterBufferTarget é o
// padrão, em ms; playoutDelayHint é o legado Chrome, em segundos — setamos os dois). Com o vídeo
// atrasado e o overlay renderizando o MESMO instante (TrackInterpolator.sample(now, syncDelayMs)
// com histórico), a caixa é interpolação EXATA entre observações — zero arrasto por construção.
//
// É um HINT: o navegador pode aplicar aproximado. O `pc` do <video-stream> nasce/renasce a cada
// (re)conexão interna do elemento — o chamador REAPLICA periodicamente (idempotente e barato).
//
// ZERO É UM PEDIDO, NÃO A AUSÊNCIA DE UM (2026-08-16 — análise de latência
// `docs/analises/comparativo-mvp-maos-2026-08-16.md` §7.2, causa nº 4). Até aqui a guarda era
// `ms <= 0`, então quando o dono zerou o `syncDelayMs` esta função passou a retornar ANTES de
// tocar em qualquer receiver: paramos de pedir ATRASO e nunca chegamos a pedir PRESSA — o
// navegador ficava com o buffer de jitter ADAPTATIVO padrão, que é o que ele escolher. `0`
// agora significa "minimize" explícito (jitterBufferTarget=0 / playoutDelayHint=0), que é uma
// instrução diferente de não dizer nada. Só valor AUSENTE ou NEGATIVO é ignorado.
//
// Residual declarado: buffer mínimo troca latência por tolerância a jitter — sob rede ruim isso
// aparece como micro-travada na imagem. É o trade certo na LAN (go2rtc local, que é o caso do
// balcão e do CD); num link ruim, o caminho é subir o `syncDelayMs`, não voltar a calar o hint.

type ReceiverWithDelay = RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number };

/**
 * Aplica o alvo de reprodução nos receivers do pc do elemento.
 * @param ms  >0 = segure este tanto · **0 = minimize (pedido explícito)** · ausente/negativo = não mexer.
 * @returns true = havia pc e ao menos 1 receiver foi tocado.
 */
export function applyPlayoutDelay(el: { pc?: RTCPeerConnection | null } | null | undefined, ms: number): boolean {
  const pc = el?.pc;
  if (!pc || !Number.isFinite(ms) || ms < 0) return false;
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
