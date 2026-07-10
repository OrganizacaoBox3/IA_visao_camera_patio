import { memo, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { type FrameSource } from "../../frame";
import { CameraWorkspace, type HubAnalysis } from "../../CameraWorkspace";
import { type BtReading } from "../../api";
import { useCameraTagLabels } from "../../fusion/useCameraTagLabels";
import { useFloorTags } from "../../fusion/useFloorTags";
import { FadigaView } from "../../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../../report/store";
import { APP_CONFIG } from "../../config";
import type { VideoStreamElement } from "../../vendor/go2rtc/go2rtc";
import { Tooltip } from "../../ui";
import { TrackOverlay } from "./TrackOverlay";
import { type Camera, type CameraStatus } from "./types";
import "./go2rtc-tile.css";

// a11y (WCAG 2.1.1): o tile clicável é um <button> (não <div onClick>) → foco + Enter/Espaço
// nativos. Reset só dos defaults de botão que a classe .tile NÃO define (padding/font/cor/
// alinhamento + chrome nativo); background/border/cursor/flex continuam vindo da .tile, então a
// aparência do tile não muda. (Cópia local — o tile de fadiga em FadigaView usa a mesma intenção.)
const TILE_BTN_RESET: CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  padding: 0,
  font: "inherit",
  color: "inherit",
  textAlign: "inherit",
};

// ── Tile da grade: vídeo via WebRTC do go2rtc OU canvas MJPEG do relé ───────────────────────────
// Transporte por câmera (camcfg `transport`): "webrtc" exibe por `<video-stream>` (WebRTC/MSE/HLS/
// MJPEG auto-negociado, decode por HW fora da main-thread); "mjpeg" usa o canvas alimentado pelo
// relé socket.io. As caixas do hub entram por cima no TrackOverlay.
//
// Registro do custom element: `video-stream.js` é vendorizado (self-host, sem CDN) e importado
// DINAMICAMENTE 1× — só quando o 1º tile WebRTC monta (câmeras em "mjpeg" nunca carregam o JS).
let videoStreamModule: Promise<unknown> | null = null;
function ensureVideoStreamRegistered(): Promise<unknown> {
  if (!videoStreamModule) videoStreamModule = import("../../vendor/go2rtc/video-stream.js");
  return videoStreamModule;
}

// Wrapper React do <video-stream>. As props do componente são SETTERS JS (não atributos HTML), então
// aplicamos src/mode/media/background IMPERATIVAMENTE via ref, APÓS o elemento estar definido (evita
// o bug de "upgrade" em que uma prop setada antes do define vira data-property que sombreia o setter).
// Janela p/ o WebRTC estabelecer vídeo antes de declarar a fonte caída. Generosa o bastante p/
// cobrir a negociação ICE/handshake em rede lenta (webrtc→mse→hls fallback interno do componente),
// curta o bastante p/ o operador não encarar um tile preto: ~7s.
const WEBRTC_ESTABLISH_MS = 7000;

function Go2rtcVideoTile({
  camId,
  getHubAnalysis,
  getReadings,
  calibrationRev,
  onWebrtcFail,
}: {
  camId: string;
  // Getter estável do último `analysis-tracks` do hub → alimenta o overlay interpolado.
  // Ausente (câmera sem análise) → o overlay simplesmente não desenha (sem erro).
  getHubAnalysis?: () => HubAnalysis | null;
  // Leituras BLE da estação (fusão tag↔pessoa, caminho C). Ausente → sem rótulo de tag (só "Pessoa <id>").
  getReadings?: () => BtReading[];
  // Sync ao vivo da CALIBRAÇÃO (idioma tripwiresRev/ADR-006): incremento → re-busca H/station.
  calibrationRev?: number;
  // Detecção de fonte caída (go2rtc sem frames p/ esta câmera): chamado UMA vez com o id quando o
  // WebRTC não estabelece vídeo dentro da janela. O pai (DashboardPage) cai o tile pra MJPEG.
  // Ausente → sem fallback; o tile segue tentando WebRTC (comportamento atual).
  onWebrtcFail?: (cameraId: string) => void;
}) {
  const ref = useRef<VideoStreamElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Guard de 1×: o pai remonta esta câmera em MJPEG ao receber o fail, mas até o unmount chegar
    // não podemos disparar de novo (timer + evento de erro podem correr juntos).
    let fired = false;
    // Timer da janela de estabelecimento; declarado aqui p/ o cleanup (que roda síncrono, antes do
    // .then) enxergá-lo por closure e limpá-lo no unmount.
    let failTimer: ReturnType<typeof setTimeout> | undefined;
    // Captura o nó já no corpo do efeito (React já atribuiu o ref no commit) p/ usar no cleanup
    // sem reler `ref.current` lá — o elemento é estável por toda a vida do componente.
    const node = ref.current;
    const src = `${APP_CONFIG.go2rtc.baseUrl}/api/ws?src=${encodeURIComponent(camId)}`;
    // Sucesso: o <video> interno recebeu quadro (dimensões conhecidas) → NÃO é fonte caída. Cancela
    // o timer p/ nunca reportar falha. `loadeddata`/`resize` cobrem MSE, HLS e WebRTC.
    let onVideoReady: (() => void) | undefined;
    let videoEl: HTMLVideoElement | undefined;
    const clearFailTimer = () => {
      if (failTimer !== undefined) {
        clearTimeout(failTimer);
        failTimer = undefined;
      }
    };
    const reportFail = () => {
      if (cancelled || fired) return;
      fired = true;
      clearFailTimer();
      onWebrtcFail?.(camId);
    };
    ensureVideoStreamRegistered()
      .then(() => customElements.whenDefined("video-stream"))
      .then(() => {
        if (cancelled || !node) return;
        const el = node;
        // Ordem importa: config ANTES de `src` (o setter de src dispara a conexão).
        el.mode = "webrtc,mse,hls,mjpeg";
        el.media = "video"; // vigilância silenciosa: sem áudio
        el.background = false; // pausa/solta o stream quando fora de tela/aba
        if (el.video) el.video.controls = false; // tile limpo + clique abre a câmera
        // Detecção robusta de FALHA sem tocar no video-rtc.js: se, ao fim da janela, o <video>
        // interno não tem quadro (videoWidth === 0), a fonte não estabeleceu → reporta 1×. Se
        // estabelecer antes disso, `loadeddata` cancela o timer (nunca reporta).
        videoEl = el.video;
        if (videoEl) {
          onVideoReady = () => {
            if ((videoEl?.videoWidth ?? 0) > 0) clearFailTimer();
          };
          videoEl.addEventListener("loadeddata", onVideoReady);
          videoEl.addEventListener("resize", onVideoReady);
        }
        failTimer = setTimeout(() => {
          failTimer = undefined;
          if (cancelled || fired) return;
          // videoWidth > 0 ⇒ vídeo estabeleceu (WebRTC/MSE/HLS); só reporta se seguir zerado.
          if ((el.video?.videoWidth ?? 0) === 0) reportFail();
        }, WEBRTC_ESTABLISH_MS);
        el.src = src;
      })
      .catch(() => {
        // go2rtc indisponível (falha ao registrar/definir o componente) → também é fonte
        // inalcançável: reporta p/ cair pra MJPEG. Rollback global é a flag transport:"mjpeg".
        reportFail();
      });
    return () => {
      cancelled = true;
      clearFailTimer();
      if (videoEl && onVideoReady) {
        videoEl.removeEventListener("loadeddata", onVideoReady);
        videoEl.removeEventListener("resize", onVideoReady);
      }
      // PAUSA DE FUNDO / desmontagem: solta o stream JÁ (não espera o timeout de 5s do componente).
      try {
        node?.ondisconnect?.();
      } catch {
        /* no-op */
      }
    };
  }, [camId, onWebrtcFail]);

  // Fusão tag↔pessoa (caminho C): MESMO hook do fullscreen (useCameraTagLabels) — busca a calibração
  // 1× por câmera (H em metros + `station`, o ponto do chão da estação BLE) e roda a fusão. Antes o
  // tile duplicava a carga inline guardando SÓ o H (stationPx omitido → default 0.5,1.0 do frame.ts),
  // e o harness mediu o custo: precisão 81,4% → 49,2% (docs/cientifica/harness-associacao-indoor.md).
  // Sem getReadings (grade sem estação) fica desligada → labelFor sempre null (e nem busca calibração).
  const { labelForRef, calibration, assignedTags } = useCameraTagLabels({
    cameraId: camId,
    getHubAnalysis,
    getReadings,
    enabled: !!getReadings,
    calibrationRev,
  });
  // O TrackOverlay espera FUNÇÃO (dep de efeito), o hook devolve REF (p/ rAF do fullscreen): wrapper
  // de identidade estável (dep = o ref, que nunca muda) lendo o ref por chamada — o efeito do overlay
  // não re-arma e o React.memo dos tiles segue valendo.
  const labelFor = useCallback((trackId: number) => labelForRef.current(trackId), [labelForRef]);

  // TAGS NO CHÃO (default LIGADO na grade quando há calibração + leituras): reusa a MESMA
  // calibração já buscada acima (sem 2º fetch) + as leituras vivas do socket; tags já associadas
  // a pessoa não ganham anel (o rótulo AR da caixa já as mostra). Sem dados → viewRef null.
  const { viewRef: floorRef } = useFloorTags({
    calibration,
    getReadings,
    getAssignedTags: assignedTags,
    enabled: !!getReadings,
  });
  const getFloorTags = useCallback(() => floorRef.current, [floorRef]);

  return (
    <div className="tile-vp rtc-vp">
      <video-stream ref={ref} />
      {/* Caixas do hub interpoladas + tags no chão, num <canvas> transparente sobre o vídeo. */}
      <TrackOverlay
        videoRef={ref}
        getHubAnalysis={getHubAnalysis}
        labelFor={labelFor}
        getFloorTags={getFloorTags}
      />
    </div>
  );
}

// Estado de conexão por câmera (evento `camera-status`; ausente → assume "online").
// "Going gray": base neutra/cinza; cor saturada SÓ para anormalidade. Mapa de tokens
// (src/index.css · estado→token): online→neutral (operação normal, evita "árvore de natal");
// connecting→info (azul, advisory não-crítico); error→critical (vermelho); stopped→neutral-dim
// (cinza apagado). dot = realce; border = borda discreta por estado (glanceable à distância).
function statusInfo(s: CameraStatus | undefined): {
  text: string;
  dot: string;
  border: string;
  normal: boolean;
  fps?: number;
} {
  const state = s?.state ?? "online";
  const text =
    state === "online"
      ? "online"
      : state === "connecting"
        ? "conectando…"
        : state === "stopped"
          ? "parada"
          : "erro";
  const dot =
    state === "connecting"
      ? "var(--state-info)"
      : state === "error"
        ? "var(--state-critical)"
        : state === "stopped"
          ? "var(--state-neutral-dim)"
          : "var(--state-neutral)"; // online (normal) → neutro, sem cor de alarme
  // stopped e online (normal) compartilham a borda neutra → um só ramo default (going-gray).
  const border =
    state === "connecting"
      ? "var(--state-info-border)"
      : state === "error"
        ? "var(--state-critical-border)"
        : "var(--state-neutral-border)";
  // normal = operação sem anormalidade → o tile pode ficar mínimo (só o dot; texto no hover).
  return { text, dot, border, normal: state === "online", fps: s?.fps };
}

type CameraTileProps = {
  camera: Camera;
  isOpen: boolean; // câmera já aberta no painel (overlay full)
  // PAUSA DE FUNDO: outra câmera está aberta no painel, então este tile (de fundo) para o
  // trabalho pesado. Renderiza um placeholder leve e DESMONTA o CameraWorkspace/FadigaView →
  // encerra o rAF/motion/decode-draw daquele feed. Reversível: ao fechar a aberta, volta ao vivo.
  // Primitiva → amigável ao React.memo (só os tiles cujo `paused` muda re-renderizam).
  paused?: boolean;
  isFadiga: boolean;
  getFrame: () => FrameSource | null;
  tripwiresRev: number;
  status: CameraStatus | undefined;
  // Fonte da análise da câmera (ADR-009). "hub" = motor server-side grava os indicadores
  // (o CameraWorkspace suprime os ingests locais). OPCIONAL/retrocompatível (default "local");
  // primitiva → amigável ao React.memo abaixo (só o tile da câmera afetada re-renderiza).
  analysisEngine?: "hub" | "local";
  // Getter estável (cache por id na central — memo-friendly) do último `analysis-tracks` do
  // hub; o CameraWorkspace desenha esses tracks na grade em vez de rodar inferência local.
  // OPCIONAL/retrocompatível (ausente → pipeline local). (ADR-009)
  getHubAnalysis?: () => HubAnalysis | null;
  // Leituras BLE da estação (fusão tag↔pessoa, caminho C). Só o tile WebRTC usa; ausente → sem rótulo.
  getReadings?: () => BtReading[];
  // Sync ao vivo da CALIBRAÇÃO (mesmo idioma do tripwiresRev): a central incrementa a cada
  // `camcfg-updated {kind:"calibration"}` → a fusão do tile re-busca H/station em vez de ficar
  // stale até remontar. OPCIONAL/retrocompatível; primitiva → amigável ao React.memo abaixo.
  calibrationRev?: number;
  // Transporte de vídeo do tile: "webrtc" → exibe via <video-stream> (go2rtc); "mjpeg"/ausente →
  // canvas + relé socket.io. Por câmera (camcfg). Primitiva → amigável ao React.memo abaixo.
  transport?: "mjpeg" | "webrtc";
  // Fonte caída no caminho WebRTC: o tile chama UMA vez com o próprio id quando o <video-stream>
  // não estabelece vídeo (go2rtc sem frames p/ a câmera). O DashboardPage cai o tile pra MJPEG.
  // Estável/por id (memo-friendly, como onOpen); ausente → sem fallback (segue tentando WebRTC).
  onWebrtcFail?: (cameraId: string) => void;
  // Callback ÚNICO e estável do dashboard: o tile chama com o próprio id. Assinatura por id
  // (em vez de closure por câmera) para o React.memo abaixo valer — todos os tiles recebem a
  // MESMA função e só re-renderizam quando os próprios dados mudam.
  onOpen: (id: string) => void;
  onAlert: (msg: string) => void;
};

// Renderiza um tile da grade: frame (fadiga/atividade) + pílula de status/fps sobreposta.
// React.memo: o `camera-status` (a cada ~5s POR câmera) troca só `statuses[id]` da câmera
// afetada; com memo + callbacks estáveis, apenas o tile daquela câmera re-renderiza (sem o memo,
// a grade inteira ×N tiles). Demais props são primitivas ou estáveis (getFrame é cache por id).
export const CameraTile = memo(function CameraTile({
  camera,
  isOpen,
  paused,
  isFadiga,
  getFrame,
  tripwiresRev,
  status,
  analysisEngine,
  getHubAnalysis,
  getReadings,
  calibrationRev,
  transport,
  onWebrtcFail,
  onOpen,
  onAlert,
}: CameraTileProps) {
  // Adapta onOpen(id) → onOpen() esperado por FadigaView/CameraWorkspace (usado só como onClick;
  // memoizado p/ manter a identidade entre re-renders do próprio tile).
  const openSelf = useCallback(() => onOpen(camera.id), [onOpen, camera.id]);
  const st = statusInfo(status);
  const inner = isOpen ? (
    <div className="tile tile-open">aberta no painel</div>
  ) : paused ? (
    // Outra câmera aberta: placeholder leve; o feed processador fica DESMONTADO (sem rAF).
    // No caminho WebRTC isto também DESMONTA o <video-stream> → solta o stream (pausa de fundo).
    <div className="tile tile-open">em pausa</div>
  ) : transport === "webrtc" ? (
    // Vídeo fluido via go2rtc, sem inferência local aqui; as caixas do hub vêm interpoladas
    // por cima (TrackOverlay). Clique/Enter/Espaço abre a câmera, como nos demais. <button>
    // (teclado-acessível) sem título 'Abrir câmera': o seletor e2e mira só o tile do
    // CameraWorkspace — este não deve casá-lo. Conteúdo sem interativos → <button> é válido.
    <button type="button" className="tile" onClick={openSelf} style={TILE_BTN_RESET}>
      <Go2rtcVideoTile
        key={`rtc-${camera.id}`}
        camId={camera.id}
        getHubAnalysis={getHubAnalysis}
        getReadings={getReadings}
        calibrationRev={calibrationRev}
        onWebrtcFail={onWebrtcFail}
      />
    </button>
  ) : isFadiga ? (
    <FadigaView
      key={`fad-${camera.id}`}
      cameraId={camera.id}
      label={camera.label}
      getFrame={getFrame}
      mode="tile"
      onOpen={openSelf}
      onAlert={onAlert}
      onSample={recordFadigaSamples}
      onEvent={recordFadigaEvent}
    />
  ) : (
    <CameraWorkspace
      key={`ws-${camera.id}`}
      cameraId={camera.id}
      label={camera.label}
      getFrame={getFrame}
      mode="tile"
      tripwiresRev={tripwiresRev}
      analysisEngine={analysisEngine}
      getHubAnalysis={getHubAnalysis}
      // Fusão tag↔pessoa (caminho C) — mesma simetria que o tile WebRTC já tinha (Go2rtcVideoTile
      // acima): antes só a câmera aberta em tela cheia recebia isto; o tile MJPEG da grade ficava
      // preso em "Pessoa <id>" mesmo com a estação BLE configurada.
      getReadings={getReadings}
      calibrationRev={calibrationRev}
      onOpen={openSelf}
      onAlert={onAlert}
    />
  );
  return (
    <div className="cam-tile relative grid min-h-0">
      {inner}
      <Tooltip content={status?.lastError || st.text}>
        {/* Pílula de status (.cam-status-pill em go2rtc-tile.css): estático na classe; só a COR da
            borda é dinâmica (token por estado, going-gray) e fica no style.
            TILE MÍNIMO (U1): estado normal (data-quiet) mostra só o dot; o texto/fps (metadado
            secundário) aparece no hover do tile. Anormalidade (erro/conectando/parada) mantém
            o texto SEMPRE visível — going-gray: cor+texto só quando há o que agir. */}
        <span
          className="cam-status-pill"
          data-quiet={st.normal ? 1 : 0}
          style={{ borderColor: st.border }}
        >
          {/* .dot-status dá o formato; cor vem do token de estado (going-gray) via inline. */}
          <span className="dot-status" aria-hidden="true" style={{ background: st.dot }} />
          <span className="cam-status-pill__text">
            {st.text}
            {st.fps != null ? ` · ${st.fps}fps` : ""}
          </span>
        </span>
      </Tooltip>
    </div>
  );
});
