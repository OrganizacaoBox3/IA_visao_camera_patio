import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Clock, TriangleAlert, Video } from "lucide-react";
import { type FrameSource } from "../../frame";
import { CameraWorkspace, type HubAnalysis } from "../../CameraWorkspace";
import { FadigaView } from "../../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../../report/store";
import { APP_CONFIG } from "../../config";
import { getVideoTicket } from "../../video/ticket";
import type { VideoStreamElement } from "../../vendor/go2rtc/go2rtc";
import { HUB_TRACKS_STALE_MS } from "../../types/analysis";
import { Tooltip, StatusDot } from "../../ui";
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
  onWebrtcFail,
}: {
  camId: string;
  // Getter estável do último `analysis-tracks` do hub → alimenta o overlay interpolado.
  // Ausente (câmera sem análise) → o overlay simplesmente não desenha (sem erro).
  getHubAnalysis?: () => HubAnalysis | null;
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
      .then(async () => {
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
        // O proxy /go2rtc/* exige ticket: passe ESPECÍFICO desta câmera na URL do WS de sinalização.
        // Falha ao obter (deslogado/hub fora) → reporta e cai p/ MJPEG (mesmo caminho de fonte caída).
        const ticket = await getVideoTicket(camId).catch(() => null);
        if (cancelled || fired) return;
        if (!ticket) {
          reportFail();
          return;
        }
        el.src = `${APP_CONFIG.go2rtc.baseUrl}/api/ws?src=${encodeURIComponent(camId)}&ticket=${encodeURIComponent(ticket)}`;
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

  return (
    <div className="tile-vp rtc-vp">
      <video-stream ref={ref} />
      {/* Caixas do hub interpoladas num <canvas> transparente sobre o vídeo. Sem labelFor
          (a fusão BLE migrou — ADR-018): o rótulo é o genérico "Pessoa" (personLabel). */}
      <TrackOverlay videoRef={ref} getHubAnalysis={getHubAnalysis} />
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

// ── ZONA RESTRITA VIOLADA no TILE (o alarme mais grave que o produto gera) ────────────────────
// O motor do hub calcula 24/7 e manda no `analysis-tracks.zonesProibidas`; até aqui esse estado só
// existia DENTRO da câmera aberta em tela cheia (badge ARMADA/VIOLADA desenhado por camera/draw.ts)
// — na GRADE, que é a tela que o operador olha o dia inteiro, a violação era invisível. Pior no
// transporte "auto"/WebRTC (o default com go2rtc no ar): ali o CameraWorkspace nem monta, então nem
// o polígono desenhado existe; o tile mostrava só caixas de pessoa.
//
// ESCOPO (deliberado): o tile NÃO desenha o polígono da zona. A geometria não vem neste payload
// (viria de `camcfg` por câmera — carga nova no dashboard) e, no tamanho de um tile de mosaico,
// polígono é ruído. O que o mosaico precisa responder é "QUAL câmera tem violação AGORA e em QUAL
// área" — para o operador ABRIR a câmera e ver o resto. Isso é sinal de estado, não geometria.
//
// GOING-GRAY: ARMADA é operação NORMAL e não acende NADA (se toda câmera com zona restrita ficasse
// marcada o tempo todo, o sinal morre). Só VIOLADA satura (--state-critical).

/** Rótulo genérico quando a zona vem sem `label` — NUNCA o id (detalhe interno, como o id de track). */
const ZONA_SEM_NOME = "Área restrita";

/** Cadência da amostragem do payload (ms) — ver `useViolatedZones`. */
const RESTRICTED_POLL_MS = 1000;

/**
 * Zonas proibidas VIOLADAS no último payload do hub. TRI-ESTADO deliberado (o `undefined` do
 * contrato NÃO é `[]` — types/analysis.ts):
 *   • `null`  → NÃO SEI (sem payload · payload STALE · hub antigo sem o campo). O tile não acende
 *               e — invariante — também não afirma que está tudo bem.
 *   • `[]`    → sei, e a câmera está quieta (sem zona restrita, ou nenhuma violada) → silêncio legítimo.
 *   • [labels] → violadas AGORA, na ordem em que o motor mandou.
 * PURA (recebe `now`): o gate de STALE é o mesmo do overlay/CameraWorkspace (HUB_TRACKS_STALE_MS)
 * — motor reiniciando não pode virar "violação eterna". Indicador crítico travado aceso é PIOR que
 * indicador nenhum, porque ensina o operador a ignorá-lo.
 */
export function violatedZoneLabels(
  a: HubAnalysis | null | undefined,
  now: number,
): string[] | null {
  if (!a || !Array.isArray(a.zonesProibidas)) return null; // ausente ≠ vazio: "não sei"
  if (now - a.ts > HUB_TRACKS_STALE_MS) return null; // payload velho → apaga (não trava aceso)
  const out: string[] = [];
  for (const z of a.zonesProibidas) {
    // `presenca` é a MÁQUINA do motor (histerese/dwell), não `people > 0` cru — e a normalização
    // do fio (incl. a string "VIOLADA" do hub antigo) já aconteceu em toHubAnalysis.
    if (z?.presenca === true) out.push(z.label?.trim() || ZONA_SEM_NOME);
  }
  return out;
}

/** Igualdade rasa do tri-estado — preserva a referência p/ não re-renderizar o tile à toa. */
function sameLabels(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/**
 * Amostra o `zonesProibidas` do último payload do hub. AMOSTRAGEM (e não re-render por evento) é
 * imposta pelo desenho do ADR-009: `analysis-tracks` chega ~1fps e mora num REF (`hubAnalysisRef`)
 * justamente para não re-renderizar a grade inteira — o getter não notifica ninguém. 1 leitura/s
 * por tile é ruído perto do rAF do vídeo, e é o que faz a violação APAGAR sozinha quando o payload
 * envelhece (o gate de stale só vale se alguém reavaliar o relógio).
 */
function useViolatedZones(getHubAnalysis?: () => HubAnalysis | null): string[] | null {
  // Init LAZY (roda também no SSR dos testes): sem janela cega de 1 tick — se o hub já reportava
  // violação quando o tile montou, o 1º paint já acende.
  const [labels, setLabels] = useState<string[] | null>(() =>
    violatedZoneLabels(getHubAnalysis?.() ?? null, Date.now()),
  );
  useEffect(() => {
    if (!getHubAnalysis) {
      setLabels((prev) => (prev === null ? prev : null)); // câmera sem análise → volta a "não sei"
      return;
    }
    const read = () =>
      setLabels((prev) => {
        const next = violatedZoneLabels(getHubAnalysis() ?? null, Date.now());
        return sameLabels(prev, next) ? prev : next;
      });
    read(); // 1ª amostra no commit (o payload pode ter chegado entre o render e o efeito)
    const t = setInterval(read, RESTRICTED_POLL_MS);
    return () => clearInterval(t);
  }, [getHubAnalysis]);
  return labels;
}

// Contorno saturado no tile inteiro: é o que o olho pega VARRENDO o mosaico (mesmo idioma do
// `.tile.alerting`, que já usa --state-critical p/ alerta local). `outline` não empurra layout
// (border empurraria) e o raio acompanha o da .tile p/ não virar retângulo duro sobre o vídeo.
const TILE_VIOLADA_OUTLINE: CSSProperties = {
  outline: "2px solid var(--state-critical)",
  outlineOffset: "-1px",
  borderRadius: "10px",
};

// Pílula da violação: 2ª linha do canto superior esquerdo (logo abaixo da .cam-status-pill, que
// vive em top:6px) — o canto superior DIREITO é do .tile-badges do CameraWorkspace. Estilo inline
// (não .css) porque este arquivo é o dono do sinal; tudo por token (nada de hex — lint-tokens).
// Par bg/fg = o mesmo do padrão crítico da casa (bg escuro + fg claro): contraste AA de sobra,
// enquanto a SATURAÇÃO fica na borda/contorno. pointer-events:none → o clique atravessa e abre a
// câmera (a pílula não pode roubar o alvo do operador).
const VIOLADA_PILL: CSSProperties = {
  position: "absolute",
  top: "30px",
  left: "6px",
  zIndex: 3, // acima do canvas do TrackOverlay (1) e da pílula de status (2)
  maxWidth: "calc(100% - 12px)",
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontFamily: "var(--mono)",
  fontSize: "11px",
  background: "var(--state-critical-bg)",
  color: "var(--state-critical-fg)",
  border: "1px solid var(--state-critical)",
  borderRadius: "9999px",
  padding: "2px 8px",
  pointerEvents: "none",
};

// Pílula do GATE DE TURNO. Mesma geometria da VIOLADA (ficam em linhas diferentes: esta desce
// mais). Going-gray aplicado com critério: "sem turno" é ANORMAL (câmera cadastrada que não
// vigia nada → âmbar, cor saturada), "fora do turno" é NORMAL (pausa programada → neutro).
// Tratar os dois com a mesma cor seria voltar ao problema: economia e cegueira indistinguíveis.
const SHIFT_PILL = (anormal: boolean): CSSProperties => ({
  position: "absolute",
  top: "54px",
  left: "6px",
  zIndex: 3,
  maxWidth: "calc(100% - 12px)",
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontFamily: "var(--mono)",
  fontSize: "11px",
  background: anormal ? "var(--state-warn-bg)" : "var(--state-neutral-bg)",
  color: anormal ? "var(--state-warn-fg)" : "var(--state-neutral-fg)",
  border: `1px solid ${anormal ? "var(--state-warn)" : "var(--state-neutral)"}`,
  borderRadius: "9999px",
  padding: "2px 8px",
  pointerEvents: "none",
});

// Lista de zonas: uma linha só; se não couber, corta com reticências. O texto ÍNTEGRO continua na
// região viva (sr-only) — a AT nunca perde zona. NADA de "+N": número sobre a imagem é invariante
// da casa (a contagem vive no painel).
const VIOLADA_PILL_ZONES: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

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
  // Sync ao vivo da CALIBRAÇÃO (mesmo idioma do tripwiresRev): a central incrementa a cada
  // `camcfg-updated {kind:"calibration"}` → a câmera re-busca o H em vez de ficar
  // stale até remontar. OPCIONAL/retrocompatível; primitiva → amigável ao React.memo abaixo.
  calibrationRev?: number;
  // Sync ao vivo das ZONAS (mesmo idioma do tripwiresRev/calibrationRev): a central incrementa a
  // cada `camcfg-updated {kind:"zones"}` → o tile re-busca a lista em vez de ficar com geometria
  // obsoleta até remontar. OPCIONAL/retrocompatível; primitiva → amigável ao React.memo abaixo.
  zonesRev?: number;
  /**
   * GATE DE TURNO desta câmera. O tile PRECISA dizer isso: sem o aviso, uma câmera que o gate
   * desligou fica visualmente idêntica a uma câmera quebrada — as duas mostram nada. Era o que
   * acontecia com 11 das 15 câmeras em produção (15/09), e ninguém saberia pela tela.
   */
  shift?: "ativa" | "fora-janela" | "sem-turno" | null;
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
  shift,
  analysisEngine,
  getHubAnalysis,
  calibrationRev,
  zonesRev,
  transport,
  onWebrtcFail,
  onOpen,
  onAlert,
}: CameraTileProps) {
  // Adapta onOpen(id) → onOpen() esperado por FadigaView/CameraWorkspace (usado só como onClick;
  // memoizado p/ manter a identidade entre re-renders do próprio tile).
  const openSelf = useCallback(() => onOpen(camera.id), [onOpen, camera.id]);
  const st = statusInfo(status);
  // Zona restrita VIOLADA agora (null = "não sei"; [] = quieta) — ver useViolatedZones.
  const violadas = useViolatedZones(getHubAnalysis);
  const emViolacao = !!violadas && violadas.length > 0;
  const inner = isOpen ? (
    <div className="tile tile-open">aberta no painel</div>
  ) : paused ? (
    // VÍDEO SOB DEMANDA. Antes isto era só "pausa de fundo" (outra câmera aberta); agora é
    // também o estado de REPOUSO da grade, que deixou de streamar sozinha. O feed processador
    // fica DESMONTADO (sem rAF) e, no caminho WebRTC, o <video-stream> também → solta o stream.
    //
    // POR QUE a grade parou de streamar: medido em produção (14/09/2026) — painel aberto levou
    // o load da máquina de 8,04 para 15,63 (4 vCPU), e ficou aberto 17% das horas de uma semana.
    // A plataforma alerta por WhatsApp; a imagem serve ao SETUP (desenhar zona, conferir
    // enquadramento), não a um plantão de olhos. O vídeo do painel disputava CPU com a análise
    // que gera o alerta — painel esquecido atrasava a detecção que o sistema existe para fazer.
    //
    // O tile NÃO fica cego: a pílula de status e o sinal de VIOLADA são irmãos deste bloco (ver
    // o wrapper abaixo) e seguem vivos — o que sai é só o VÍDEO. Clique abre ao vivo.
    // `title="Abrir câmera"` é CONTRATO DE SELETOR do e2e (declarado em CameraWorkspace.tsx:1534,
    // usado 9× em app.spec.ts) e agora tem de morar aqui: em repouso este placeholder É o
    // affordance de abrir a câmera, porque a grade não monta mais o CameraWorkspace. Sem ele, todo
    // teste que abre uma câmera para exercitar zona/calibração/Select para de achar onde clicar.
    // O fluxo que o e2e descreve — clicar no tile abre a câmera — segue verdadeiro; só mudou o que
    // o tile mostra antes do clique. `aria-label` carrega o nome da câmera (o texto visível é
    // genérico e igual em todos os tiles; leitor de tela precisa distinguir qual é qual).
    <button
      type="button"
      className="tile tile-open"
      onClick={openSelf}
      style={TILE_BTN_RESET}
      aria-label={`Abrir câmera ${camera.label}`}
      title="Abrir câmera"
    >
      <span className="cam-tile__repouso">
        {/* O NOME é o conteúdo principal do tile em repouso, não enfeite: sem vídeo, é a única
            coisa que diz ao operador QUAL câmera é esta. A primeira versão deste placeholder
            mostrava só "ver ao vivo" em todos os tiles — grade ilegível, e o e2e pegou
            (`getByText('E2E-CAM')` não achava o nome em lugar nenhum do painel). */}
        <span className="cam-tile__nome">{camera.label}</span>
        <span className="cam-tile__acao">
          <Video size={14} strokeWidth={1.5} aria-hidden />
          ver ao vivo
        </span>
      </span>
    </button>
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
      calibrationRev={calibrationRev}
      zonesRev={zonesRev}
      onOpen={openSelf}
      onAlert={onAlert}
    />
  );
  return (
    <div
      className="cam-tile relative grid min-h-0"
      // Estado do SINAL (aceso/apagado), não do mundo: "0" cobre tanto "quieta" quanto "não sei"
      // — o tile nunca afirma normalidade. Gancho estável p/ teste/e2e.
      data-violada={emViolacao ? 1 : 0}
      style={emViolacao ? TILE_VIOLADA_OUTLINE : undefined}
    >
      {inner}
      {/* SINAL DE VIOLAÇÃO — só quando VIOLADA (ARMADA é normal e fica calada; going-gray).
          Duas peças, de propósito:
          (1) a pílula VISÍVEL é aria-hidden — é o duplicado gráfico da frase abaixo, e ler as
              duas seria repetição na AT. Ela carrega ÍCONE + a palavra "VIOLADA" em TEXTO: cor
              sozinha não comunica (daltonismo/monitor lavado do CD).
          (2) a região VIVA (role=status, sr-only) existe SEMPRE e fica VAZIA quando não há
              violação — região inserida junto com o conteúdo é anunciada de forma irregular pelas
              ATs. Vazia ela não afirma nada: "não sei" e "quieta" seguem indistinguíveis na
              saída, que é exatamente o contrato (o tile NUNCA declara normalidade). */}
      {emViolacao && (
        <span style={VIOLADA_PILL} aria-hidden="true">
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          VIOLADA
          <span style={VIOLADA_PILL_ZONES}>· {violadas.join(" · ")}</span>
        </span>
      )}
      {/* GATE DE TURNO — o aviso que separa "desligada de propósito" de "quebrada". Não anuncia
          "ativa": normalidade não pede pílula (going-gray). aria-hidden porque a frase completa
          vai na região viva abaixo, e ler as duas seria repetição na AT. */}
      {(shift === "sem-turno" || shift === "fora-janela") && (
        <span style={SHIFT_PILL(shift === "sem-turno")} aria-hidden="true">
          {shift === "sem-turno" ? (
            <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <Clock size={12} strokeWidth={1.75} aria-hidden />
          )}
          {shift === "sem-turno" ? "SEM TURNO" : "fora do turno"}
        </span>
      )}
      <span className="sr-only" role="status">
        {emViolacao ? `Área restrita violada em ${camera.label}: ${violadas.join(", ")}.` : ""}
      </span>
      {/* O gate de turno em texto, com a CONSEQUÊNCIA junto — a pílula é só a marca gráfica.
          Região própria (não a de violação) para que um aviso não sobrescreva o outro. */}
      <span className="sr-only" role="status">
        {shift === "sem-turno"
          ? `${camera.label}: sem turno atribuído. Esta câmera não está sendo analisada e não gera alerta.`
          : shift === "fora-janela"
            ? `${camera.label}: fora do turno. Análise pausada até o próximo turno.`
            : ""}
      </span>
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
          {/* StatusDot: bolinha + rótulo textual sr-only (going-gray); cor por status via override. */}
          <StatusDot color={st.dot} label={st.text} />
          <span className="cam-status-pill__text">
            {st.text}
            {st.fps != null ? ` · ${st.fps}fps` : ""}
          </span>
        </span>
      </Tooltip>
    </div>
  );
});
