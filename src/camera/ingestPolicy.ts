// Tabela ÚNICA da política de ingest do cliente (ADR-009) — dono do invariante "o que grava
// quando o MOTOR DO HUB analisa a câmera". Antes esta decisão vivia repetida em 6 call-sites do
// rAF do CameraWorkspace; agora os call-sites só consultam `shouldIngest(kind, engine)`.
//
// Racional (escrito UMA vez):
// • engine "hub": o motor server-side (D-FINE+ByteTrack, 24/7) grava FLOW (cruzamento de linha)
//   e ATIV (people/occupied/flow por zona) direto no pgstore — gravar no cliente também
//   DUPLICARIA o indicador. Todo o resto permanece 100% no cliente: o ALARME de ociosidade
//   nasce do motion local (o motor não grava alarmes); LEITURA (ZXing), OBJETOS (OWL-ViT) e
//   FADIGA (MediaPipe — exceção declarada da ADR-009) não são cobertos pelo motor.
// • engine "local": pipeline local é a única fonte → grava tudo.

export type IngestKind = "flow" | "ativ" | "alert" | "reads" | "pass" | "object" | "fadiga";
export type AnalysisEngine = "hub" | "local";

/** true = o MOTOR DO HUB já grava este indicador (cliente suprime p/ não duplicar). */
const HUB_COVERS: Record<IngestKind, boolean> = {
  flow: true,
  ativ: true,
  alert: false,
  reads: false,
  pass: false,
  object: false,
  fadiga: false,
};

/** O cliente deve persistir este indicador com a engine atual? */
export function shouldIngest(kind: IngestKind, engine: AnalysisEngine): boolean {
  return engine !== "hub" || !HUB_COVERS[kind];
}
