// Export LOCAL de CLIPE do cine-loop (Onda B) — sem dependências novas.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ LGPD / PRIVACIDADE                                                        ║
// ║ Tudo aqui acontece 100% EM MEMÓRIA no navegador do operador. Os quadros   ║
// ║ vêm do CineBuffer (efêmero) e o resultado é um Blob montado localmente.   ║
// ║  • NADA é enviado, copiado ou persistido no servidor.                     ║
// ║  • A ÚNICA saída é um DOWNLOAD LOCAL disparado manualmente pelo operador   ║
// ║    (ver triggerDownload + CameraWorkspace.exportClip).                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// Quadro "achatado" p/ exportação: a imagem desenhável + suas dimensões e o relógio
// relativo. NÃO somos donos do `img` (ImageBitmap do buffer) — apenas o desenhamos;
// quem fecha os bitmaps é o CineBuffer (evict/clear). Não chame .close() aqui.
export type ClipFrame = {
  img: CanvasImageSource;
  dw: number; // largura desenhável da imagem (bmp.width)
  dh: number; // altura desenhável da imagem (bmp.height)
  ts: number; // performance.now() da captura (p/ tempo relativo)
};

export type ClipKind = "webm" | "montage";

// Tipos de container/codec testados, em ordem de preferência (qualidade → compatibilidade).
const WEBM_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

function pickWebmType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of WEBM_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* navegador sem isTypeSupported → ignora */
    }
  }
  return null;
}

/**
 * Detecta a melhor estratégia de export disponível no navegador.
 *  • "webm"     → MediaRecorder sobre canvas.captureStream (vídeo real).
 *  • "montage"  → fallback: um único PNG em grade com quadros-chave (sem deps).
 */
export function clipSupport(): ClipKind {
  const canCapture =
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function";
  if (canCapture && pickWebmType()) return "webm";
  return "montage";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Desenha `img` (dw×dh) dentro de cw×ch preservando o aspecto (letterbox), igual ao palco.
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  dw: number,
  dh: number,
  cw: number,
  ch: number,
): void {
  const s = Math.min(cw / dw, ch / dh);
  const w = dw * s,
    h = dh * s;
  ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
}

export type ClipProgress = (done: number, total: number) => void;

/**
 * Grava os quadros do buffer como WebM, desenhando-os num canvas offscreen na taxa
 * do cine-loop e capturando o stream com MediaRecorder. Resolve com um Blob webm.
 *
 * Robustez/memória: para o MediaRecorder e TODAS as tracks do stream no `finally`
 * (mesmo em erro). Não cria object URLs aqui (o chamador faz o download e revoga).
 */
export async function recordClipWebm(
  frames: readonly ClipFrame[],
  opts: { fps?: number; onProgress?: ClipProgress } = {},
): Promise<Blob> {
  const n = frames.length;
  if (!n) throw new Error("sem quadros no buffer");
  const mime = pickWebmType();
  if (mime == null) throw new Error("WebM não suportado neste navegador");

  const fps = Math.max(1, Math.min(30, opts.fps ?? 12));
  const cw = Math.max(2, Math.round(frames[0].dw));
  const ch = Math.max(2, Math.round(frames[0].dh));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D indisponível");

  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const finished = new Promise<Blob>((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
    rec.onerror = () => reject(new Error("falha ao gravar o clipe"));
  });

  const frameMs = 1000 / fps;
  try {
    // fundo neutro p/ o letterbox dos quadros
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    rec.start();
    for (let i = 0; i < n; i++) {
      const fr = frames[i];
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
      drawContain(ctx, fr.img, Math.round(fr.dw), Math.round(fr.dh), cw, ch);
      opts.onProgress?.(i + 1, n);
      await sleep(frameMs);
    }
    await sleep(frameMs); // garante a captura do último quadro antes do stop
  } finally {
    if (rec.state !== "inactive") rec.stop();
    for (const t of stream.getTracks()) t.stop(); // libera o stream (memória)
  }
  return finished;
}

/**
 * Fallback sem dependências: monta UM único PNG com uma grade de quadros-chave
 * (amostrados do buffer). Útil quando MediaRecorder/WebM não está disponível.
 */
export async function buildMontagePng(
  frames: readonly ClipFrame[],
  opts: { maxCells?: number; cellWidth?: number; onProgress?: ClipProgress } = {},
): Promise<Blob> {
  const n = frames.length;
  if (!n) throw new Error("sem quadros no buffer");
  const maxCells = Math.max(1, opts.maxCells ?? 16);
  // amostragem uniforme dos quadros (inclui o primeiro; teto de maxCells)
  const step = Math.max(1, Math.ceil(n / maxCells));
  const picked: ClipFrame[] = [];
  for (let i = 0; i < n && picked.length < maxCells; i += step) picked.push(frames[i]);
  if (picked[picked.length - 1] !== frames[n - 1] && picked.length < maxCells)
    picked.push(frames[n - 1]);

  const cols = Math.ceil(Math.sqrt(picked.length));
  const rows = Math.ceil(picked.length / cols);
  const ar = picked[0].dh / picked[0].dw || 0.5625;
  const cellW = Math.max(2, Math.round(opts.cellWidth ?? Math.min(320, picked[0].dw)));
  const cellH = Math.max(2, Math.round(cellW * ar));
  const gap = 4;

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW + (cols + 1) * gap;
  canvas.height = rows * cellH + (rows + 1) * gap;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D indisponível");
  ctx.fillStyle = "#05080c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const t0 = picked.length ? frames[n - 1].ts : 0;
  for (let i = 0; i < picked.length; i++) {
    const fr = picked[i];
    const c = i % cols,
      r = Math.floor(i / cols);
    const x = gap + c * (cellW + gap),
      y = gap + r * (cellH + gap);
    ctx.save();
    ctx.translate(x, y); // drawContain centra na origem; o translate posiciona a célula
    ctx.fillStyle = "#05080c";
    ctx.fillRect(0, 0, cellW, cellH);
    drawContain(ctx, fr.img, Math.round(fr.dw), Math.round(fr.dh), cellW, cellH);
    // rótulo de tempo relativo (segundos) no canto
    const rel = ((fr.ts - t0) / 1000).toFixed(1) + "s";
    ctx.font = "10px ui-monospace, monospace";
    const tw = ctx.measureText(rel).width + 6;
    ctx.fillStyle = "rgba(5,8,12,0.75)";
    ctx.fillRect(0, cellH - 13, tw, 13);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(rel, 3, cellH - 3);
    ctx.restore();
    opts.onProgress?.(i + 1, picked.length);
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("falha ao gerar PNG"))), "image/png");
  });
}

/**
 * Dispara um DOWNLOAD LOCAL do Blob (ação manual do operador — LGPD).
 * Cria um object URL, clica num <a download> e devolve a URL p/ o chamador revogar.
 * O chamador É RESPONSÁVEL por revogar a URL (URL.revokeObjectURL) quando seguro.
 */
export function triggerDownload(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}

// Nome do arquivo: câmera + timestamp local (mesma convenção do snapshot).
export function clipFileName(cameraId: string, wallTs: number, ext: string): string {
  const d = new Date(wallTs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${cameraId}_clip_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
