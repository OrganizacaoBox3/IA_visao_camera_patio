// Tipagem local do web component vendorizado `<video-stream>` (go2rtc / VideoRTC v1.6.0).
//
// As "props" do componente (src/mode/media/background) são SETTERS/CAMPOS JS — NÃO atributos
// HTML observados. Por isso o wrapper React as aplica IMPERATIVAMENTE via ref (ver CameraTile),
// e este arquivo só expõe (1) o tipo do elemento p/ o ref e (2) o intrinsic JSX p/ o TS strict.

import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Subconjunto da API pública do VideoRTC/VideoStream que o wrapper manipula.
export interface VideoStreamElement extends HTMLElement {
  /** WebSocket de sinalização; aceita `/rel`, `http(s)://` ou `ws(s)://`. Ao setar, conecta. */
  src: string;
  /** Ordem de fallback do transporte. Default do componente: "webrtc,mse,hls,mjpeg". */
  mode: string;
  /** Mídias pedidas ("video", "video,audio", …). */
  media: string;
  /** false = pausa o stream quando o elemento sai da tela/aba (default). */
  background: boolean;
  visibilityCheck: boolean;
  visibilityThreshold: number;
  /** <video> interno criado em oninit(). */
  video?: HTMLVideoElement;
  /** Encerra ws/pc e solta o <video> — release imediato ao desmontar o tile. */
  ondisconnect?: () => void;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "video-stream": DetailedHTMLProps<HTMLAttributes<VideoStreamElement>, VideoStreamElement>;
    }
  }
}
