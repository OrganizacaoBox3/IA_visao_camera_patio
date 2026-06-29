// ── CONGELAR + CINE-LOOP (Onda B) ────────────────────────────────────────────
// Extraído do CameraWorkspace.tsx (R2.1) SEM mudança de comportamento. Buffer de quadros
// EM MEMÓRIA / EFÊMERO (LGPD: nunca vai ao servidor; ver cineBuffer.ts). Encapsula: modo
// revisão, scrubber, play do cine-loop, render do quadro de revisão, snapshot PNG local e
// export de clipe (WebM + fallback montagem PNG) — tudo download LOCAL manual.
//
// O componente continua DONO do JSX (consome o estado/handlers daqui) e do rAF principal
// (que lê `cineRef`/`reviewRef` p/ alimentar o buffer e congelar o palco).
import { useEffect, useRef, useState, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { CineBuffer, type CineFrame } from "./cineBuffer";
import {
  clipSupport,
  recordClipWebm,
  buildMontagePng,
  triggerDownload,
  clipFileName,
  type ClipFrame,
} from "./clipExport";
import { drawReviewFrame } from "./draw";

type Args = {
  mode: "tile" | "full";
  cameraId: string;
  getFrame: () => FrameSource | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
};

export function useCineLoop({ mode, cameraId, getFrame, canvasRef, viewportRef }: Args) {
  const cineRef = useRef<CineBuffer | null>(null);
  if (cineRef.current === null)
    cineRef.current = new CineBuffer({ maxSeconds: 10, captureWidth: 480 });
  const reviewRef = useRef(false); // lido no rAF: em revisão o palco PARA de avançar (mas a inferência de fundo segue)
  const scrubRef = useRef(0); // índice do quadro em revisão (lido pelo render de revisão)
  const clipBusyRef = useRef(false); // trava reentrância (1 export por vez)
  const clipUrlRef = useRef<string | null>(null); // object URL do último download (revogado no cleanup)

  // CONGELAR + CINE: modo revisão, índice do scrubber e play do cine-loop.
  const [review, setReview] = useState(false);
  const [scrubIndex, setScrubIndex] = useState(0);
  const [cinePlaying, setCinePlaying] = useState(false);
  const [cineSize, setCineSize] = useState(0); // nº de quadros no buffer (atualiza o range do slider)
  const [reviewTip, setReviewTip] = useState<string | null>(null); // aviso quando o buffer está vazio
  // EXPORT DE CLIPE (local): estado da geração + progresso (0..100) p/ desabilitar/rotular o botão.
  const [clipState, setClipState] = useState<"idle" | "working" | "error">("idle");
  const [clipPct, setClipPct] = useState(0);

  useEffect(() => {
    reviewRef.current = review;
  }, [review]);
  useEffect(() => {
    scrubRef.current = scrubIndex;
  }, [scrubIndex]);
  // LGPD: ao desmontar a câmera, descarta TODO o buffer em memória (fecha os bitmaps)
  // e revoga qualquer object URL de export pendente (sem vazar memória).
  useEffect(() => {
    const cb = cineRef.current;
    return () => {
      cb?.dispose();
      if (clipUrlRef.current) {
        URL.revokeObjectURL(clipUrlRef.current);
        clipUrlRef.current = null;
      }
    };
  }, []);

  // Renderiza o quadro selecionado sempre que o índice/modo mudar (e ao redimensionar via tick do loop).
  useEffect(() => {
    if (!review) return;
    const canvas = canvasRef.current,
      viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const fr = cineRef.current?.get(scrubIndex);
    if (fr) drawReviewFrame(canvas, viewport, fr);
  }, [review, scrubIndex, cineSize, canvasRef, viewportRef]);

  // Cine-loop (play): avança o scrubber ~12 quadros/s, em loop, sem tocar no buffer.
  useEffect(() => {
    if (!review || !cinePlaying) return;
    let raf = 0;
    let last = 0;
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      if (t - last < 80) return;
      last = t; // ~12 fps de reprodução
      const n = cineRef.current?.size() ?? 0;
      if (n <= 1) return;
      setScrubIndex((i) => (i + 1 >= n ? 0 : i + 1));
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [review, cinePlaying]);

  // Entra em revisão (CONGELAR): trava o palco no último quadro do buffer.
  function enterReview() {
    const n = cineRef.current?.size() ?? 0;
    if (n === 0) {
      setReviewTip("Sem quadros no buffer ainda — aguarde o vídeo ao vivo.");
      setTimeout(() => setReviewTip(null), 2500);
      return;
    }
    setReviewTip(null);
    setCineSize(n);
    setScrubIndex(n - 1);
    setCinePlaying(false);
    setReview(true);
  }
  // Volta ao vivo: sai da revisão e limpa o estado de scrub (o buffer segue, efêmero).
  // Libera também o object URL do último export (memória).
  function exitReview() {
    setReview(false);
    setCinePlaying(false);
    setScrubIndex(0);
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
  }
  function scrubBy(delta: number) {
    setCinePlaying(false);
    const n = cineRef.current?.size() ?? 0;
    if (n === 0) return;
    setScrubIndex((i) => Math.max(0, Math.min(n - 1, i + delta)));
  }

  // SNAPSHOT LOCAL — download manual iniciado pelo operador. NUNCA vai ao servidor.
  // Renderiza o quadro (revisão: do buffer; ao vivo: o frame corrente) numa resolução própria
  // e dispara um download via canvas.toBlob → <a download>. Ação 100% local (LGPD).
  function downloadSnapshot() {
    const fr = review ? (cineRef.current?.get(scrubIndex) ?? null) : null;
    const tmp = document.createElement("canvas");
    let src: CanvasImageSource;
    let w: number;
    let h: number;
    let stampTs: number;
    if (fr) {
      src = fr.bmp;
      w = fr.bmp.width;
      h = fr.bmp.height;
      stampTs = fr.wallTs;
    } else {
      const f = getFrame();
      if (!f) return;
      src = f.el;
      w = f.w;
      h = f.h;
      stampTs = Date.now();
    }
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, 0, 0, w, h);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date(stampTs);
      const pad = (n: number) => String(n).padStart(2, "0");
      a.href = url;
      a.download = `${cameraId}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  }
  // EXPORT DE CLIPE LOCAL — a partir dos quadros do buffer (janela atual de revisão).
  // Abordagem: MediaRecorder sobre canvas.captureStream desenhando os quadros do buffer na
  // taxa do cine-loop → Blob WebM. Fallback gracioso (sem deps): um único PNG em grade
  // (montagem de quadros-chave) quando MediaRecorder/WebM não está disponível.
  // LGPD: tudo montado EM MEMÓRIA; o resultado é SEMPRE um DOWNLOAD LOCAL manual
  // (<a download>) nomeado por câmera + timestamp. NADA é enviado/persistido no servidor.
  async function exportClip() {
    if (clipBusyRef.current) return; // 1 export por vez (botão também desabilita)
    const snap = cineRef.current?.framesSnapshot() ?? [];
    if (snap.length === 0) {
      setReviewTip("Sem quadros no buffer ainda — aguarde o vídeo ao vivo.");
      setTimeout(() => setReviewTip(null), 2500);
      return;
    }
    // Achata os quadros p/ o exportador (apenas desenha os bitmaps; NÃO os fecha — o buffer é dono).
    const frames: ClipFrame[] = snap.map((fr) => ({
      img: fr.bmp,
      dw: fr.bmp.width,
      dh: fr.bmp.height,
      ts: fr.ts,
    }));
    const stampTs = snap[snap.length - 1].wallTs;
    const onProgress = (done: number, total: number) =>
      setClipPct(total ? Math.round((done / total) * 100) : 0);

    clipBusyRef.current = true;
    setClipState("working");
    setClipPct(0);
    try {
      let blob: Blob;
      let ext: string;
      if (clipSupport() === "webm") {
        blob = await recordClipWebm(frames, { fps: 12, onProgress });
        ext = "webm";
      } else {
        blob = await buildMontagePng(frames, { onProgress });
        ext = "png";
        setReviewTip(
          "Clipe (vídeo) não suportado neste navegador — exportada uma montagem PNG dos quadros-chave.",
        );
        setTimeout(() => setReviewTip(null), 4000);
      }
      // download LOCAL manual (LGPD); revoga a URL anterior e agenda a desta.
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      const url = triggerDownload(blob, clipFileName(cameraId, stampTs, ext));
      clipUrlRef.current = url;
      setTimeout(() => {
        if (clipUrlRef.current === url) {
          URL.revokeObjectURL(url);
          clipUrlRef.current = null;
        }
      }, 60000);
      setClipState("idle");
    } catch {
      setClipState("error");
      setReviewTip("Falha ao exportar o clipe neste navegador.");
      setTimeout(() => {
        setReviewTip(null);
        setClipState("idle");
      }, 4000);
    } finally {
      clipBusyRef.current = false;
      setClipPct(0);
    }
  }

  // Alimenta o ring buffer com o frame que já passou pelo gate do rAF (sem decode extra).
  // Só na câmera aberta (full) e fora da revisão — em revisão o buffer fica congelado/estável.
  function captureFrame(el: CanvasImageSource, w: number, h: number, now: number, wallTs: number) {
    if (mode === "full" && !reviewRef.current) cineRef.current?.capture(el, w, h, now, wallTs);
  }

  return {
    // estado p/ o JSX
    review,
    scrubIndex,
    cinePlaying,
    cineSize,
    reviewTip,
    clipState,
    clipPct,
    setScrubIndex,
    setCinePlaying,
    // handlers
    enterReview,
    exitReview,
    scrubBy,
    downloadSnapshot,
    exportClip,
    // p/ o rAF principal do componente
    captureFrame,
    cineRef,
    reviewRef,
  };
}

export type { CineFrame };
