// Lógica PURA do transporte de vídeo no painel por câmera (extraída do god-component DashboardPage
// para virar testável — auditoria §S2). Decide o render do CameraTile: "mjpeg" (frames Socket.IO no
// canvas) vs "webrtc" (WHEP/WHIP via go2rtc, <video-stream>). Sem estado nem efeitos — recebe tudo
// por parâmetro (preferência do camcfg, streams do go2rtc, cooldowns de falha, relógio).
//
// Onda 2: "auto" = MELHOR DISPONÍVEL, resolvido aqui —
//   • "mjpeg"  → "mjpeg" (override manual: força o relé JPEG; ÚNICO força de verdade, nunca WebRTC);
//   • "webrtc" → "webrtc" (override manual: prefere go2rtc);
//   • "auto"/ausente → "webrtc" SE o go2rtc serve a câmera (id ∈ streams), senão "mjpeg".
// Auto-fallback: se o WebRTC FALHOU há pouco p/ esta câmera (tile/full reportou), cai pro relé MJPEG
// durante o cooldown — MESMO que go2rtc liste o stream (registrado ≠ com frames: fonte caída deixa o
// stream órfão e o <video-stream> quebra). Vale p/ "auto" E p/ "webrtc" manual; ao expirar o cooldown
// torna a tentar WebRTC (retry periódico, sem flicker).

export type CamTransport = "auto" | "mjpeg" | "webrtc";

export function transportOf(
  transport: CamTransport,
  id: string,
  go2rtcStreams: Set<string>,
  failMap: Map<string, number>,
  now: number,
): "mjpeg" | "webrtc" {
  if (transport === "mjpeg") return "mjpeg"; // único FORÇA de verdade (nunca WebRTC)
  const failUntil = failMap.get(id);
  if (failUntil != null && failUntil > now) return "mjpeg"; // cooldown de falha de WebRTC
  // "webrtc" e "auto" PREFEREM WebRTC, mas só quando o go2rtc de fato serve a câmera (id ∈ streams).
  // go2rtc fora / stream ausente → caem pra MJPEG (evita o tile preso em "loading").
  return go2rtcStreams.has(id) ? "webrtc" : "mjpeg";
}
