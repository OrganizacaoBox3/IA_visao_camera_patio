// Fonte de frame compartilhada entre as views e os processadores (DRY).
// `el` é o que o canvas/modelos consomem; `w`/`h` são as dimensões nativas do frame.
// `ts` (opcional): timestamp do frame na origem. Quando o produtor (A2/Dashboard) o
// expõe, o gate de "frame novo" o usa p/ detectar frames repetidos de forma barata;
// na ausência dele, o gate cai para a identidade do `el` (o ImageBitmap troca por frame).
export type FrameSource = { el: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap; w: number; h: number; ts?: number };

// Retângulo normalizado (0..1) no espaço do frame.
export type NormRect = { x: number; y: number; w: number; h: number };
