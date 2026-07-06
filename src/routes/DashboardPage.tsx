import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, BellRing, ChevronLeft, ChevronRight, Video } from "lucide-react";
import { APP_CONFIG } from "../config";
import { setInferencePriority } from "../vision/scheduler";
import { CameraWorkspace } from "../CameraWorkspace";
import { FadigaView } from "../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../report/store";
import { useAuth } from "../auth";
import { Button, IconButton, Tooltip, Badge, useToast } from "../ui";
import { type Camera } from "./dashboard/types";
import { CameraTile } from "./dashboard/CameraTile";
import { AlarmDrawer } from "./dashboard/AlarmDrawer";
import { useFrameRelay } from "./dashboard/useFrameRelay";
import { useDashboardSocket } from "./dashboard/useDashboardSocket";
import { useVideoTransport } from "./dashboard/useVideoTransport";
import { useAlarms } from "./dashboard/useAlarms";
import { useCamCfgs } from "./useCamCfgs";
import "./alarms.css";
import "./dash-grid.css";

// Colunas da grade em função da quantidade de tiles visíveis (layout responsivo simples).
function colsFor(n: number): number {
  return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4;
}

// ── Central de câmeras: ORQUESTRAÇÃO ──────────────────────────────────────────────────────────
// Hooks por domínio: relé de frames (useFrameRelay), socket (useDashboardSocket), transporte de
// vídeo (useVideoTransport) e alarmes (useAlarms). Aqui ficam só a cola entre as frentes, a
// paginação/feeds ativos e o JSX. A grade mostra SEMPRE todas as câmeras conectadas, paginadas
// por feedsPerPage.
export function DashboardPage() {
  const { token, user, logout } = useAuth();
  const { toast } = useToast();

  // Estado próprio da orquestração (feeds/paginação/overlay). O demais é dos hooks abaixo.
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Relé de frames (decode fora da main-thread, getters estáveis, poda de câmeras removidas).
  // Desestruturado em membros ESTÁVEIS (refs + useCallbacks): usá-los direto (em vez do objeto
  // `relay`, recriado a cada render) mantém as deps dos efeitos estáveis (efeito de feeds ativos
  // só re-roda em pageCameras/openId).
  const relay = useFrameRelay(cameras);
  const { framesRef, activeIdsRef, openIdRef, drainDecode, getterFor, hubGetterFor } = relay;
  // Alarmes: criados ANTES do socket (que empurra os eventos ao vivo para os seus setters).
  const alarmsApi = useAlarms(user.usuario, toast);
  // Socket: roteia os eventos do hub para os refs do relé e para os setters das frentes acima.
  const socket = useDashboardSocket({
    token,
    logout,
    // Foco (ADR-009): a câmera aberta em tela cheia; o hook pede foco ao hub quando ela é "hub".
    openId,
    framesRef,
    activeIdsRef,
    hubAnalysisRef: relay.hubAnalysisRef,
    readingZoneRef: relay.readingZoneRef,
    drainDecode,
    loadReadingFlag: relay.loadReadingFlag,
    setCameras,
    setAlarms: alarmsApi.setAlarms,
  });
  const { socketRef, connected, statuses, analysisEngines, revByCamera } = socket;
  const { alarms, alarmsOpen, setAlarmsOpen, newCount, topNewPriority, actOnAlarm } = alarmsApi;

  // Config por câmera (default = atividade → retrocompatível); leitor síncrono usado no transporte.
  const { cfgOf } = useCamCfgs(cameras);
  // Transporte de vídeo no painel (go2rtc/WebRTC vs relé MJPEG) + auto-fallback WebRTC→MJPEG.
  const { transportOf, handleWebrtcFail } = useVideoTransport(cfgOf);

  // ── Paginação dos feeds: só os feeds da página atual são montados (CameraWorkspace) → só eles
  //    processam inferência. A grade mostra SEMPRE todas as câmeras conectadas; a paginação recorta
  //    esse conjunto (na ordem que o hub envia). ──
  const feedsPerPage = APP_CONFIG.dashboard.feedsPerPage;
  const pageCount = Math.max(1, Math.ceil(cameras.length / feedsPerPage));
  const pageCameras = useMemo(
    () => cameras.slice(page * feedsPerPage, page * feedsPerPage + feedsPerPage),
    [cameras, page, feedsPerPage],
  );
  // mantém a página dentro do intervalo válido quando a lista de câmeras muda
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Conjunto ativo = feeds visíveis (página) + câmera aberta. Decodifica os recém-ativos e libera
  // o ImageBitmap dos que saíram (memória); feeds inativos param de ser decodificados (ver `frame`).
  //
  // PAUSA DE FUNDO: com `openId` setado, o conjunto ativo encolhe para SÓ a câmera aberta. Os
  // tiles de fundo deixam de ser decodificados aqui E param rAF/motion/draw (CameraTile vira
  // placeholder leve — prop `paused`). O `watch` reanuncia só a aberta → o hub para de RELAYAR os
  // frames de vídeo dos ocultos (banda/CPU do relé). O plano de controle (`analysis-tracks`,
  // broadcast à room, não filtrado por watch) segue chegando. Reversível: ao fechar (openId=null),
  // este efeito reroda e o conjunto volta à página inteira. O cine-loop e o decode NATIVO da
  // aberta seguem intactos (ela é a ativa).
  useEffect(() => {
    const active = new Set<string>();
    if (openId) active.add(openId);
    else for (const c of pageCameras) active.add(c.id);
    openIdRef.current = openId; // ref lida pelo drainDecode (aberta = decode nativo, sem resize)
    const prev = activeIdsRef.current;
    activeIdsRef.current = active;
    // Assinatura por câmera (contrato ADITIVO): anuncia ao hub o conjunto COMPLETO que este
    // dashboard quer receber; o hub filtra o evento `frame` por room (`cam:<id>`).
    // O (re)connect reanuncia no handler "connect" (reconexão perde as rooms no servidor).
    socketRef.current?.emit("watch", { ids: [...active] });
    prev.forEach((id) => {
      if (!active.has(id)) {
        const f = framesRef.current.get(id);
        if (f?.bmp) {
          f.bmp.close();
          f.bmp = null;
          f.w = 0;
          f.h = 0;
        }
      }
    });
    active.forEach((id) => {
      const f = framesRef.current.get(id);
      if (f?.pending && !f.decoding) drainDecode(id);
    });
  }, [pageCameras, openId, framesRef, activeIdsRef, openIdRef, drainDecode, socketRef]);

  // Eleva a prioridade da câmera ABERTA na fila do scheduler de inferência. As tiles pedem
  // "low" e a câmera aberta (full) já pede "high"; aqui reforçamos a key na transição de abertura.
  useEffect(() => {
    if (openId) setInferencePriority(`${openId}:atividade`, "high");
  }, [openId]);

  function isFadiga(id: string): boolean {
    return cfgOf(id).modo === "fadiga";
  }

  // ── PREFERIR O PIPELINE DO HUB por default (ADR-009) ──
  // O hub emite `analysis-status {engine:"hub"}` por câmera analisada; com o MOTOR LIGADO ele
  // cria estado e analisa TODA câmera relayada, logo qualquer "hub" observado significa "motor
  // ativo". Nesse caso o default EFETIVO de uma câmera ainda sem status explícito passa a ser "hub"
  // (evita o flash do pipeline local até o snapshot/mudança daquela câmera chegar). FALLBACK
  // preservado: sem NENHUM "hub" (motor desligado / hub antigo) o default segue "local".
  const hubEngineActive = useMemo(
    () => Object.values(analysisEngines).some((e) => e === "hub"),
    [analysisEngines],
  );
  const defaultEngine: "hub" | "local" = hubEngineActive ? "hub" : "local";

  const open = openId ? (cameras.find((c) => c.id === openId) ?? null) : null;

  // Alerta do painel: mostra o toast E repassa ao hub (andon → webhook externo, se configurado).
  // useCallback: identidade estável p/ não quebrar o memo do CameraTile (`toast` é estável).
  const handleAlert = useCallback(
    (msg: string) => {
      toast(msg, msg.includes("⚠") ? "alert" : "default");
      socketRef.current?.emit("alert", { text: msg, ts: Date.now() });
    },
    [toast, socketRef],
  );

  // Abertura de câmera: callback único e estável; o tile chama com o próprio id.
  const handleOpen = useCallback((id: string) => setOpenId(id), []);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Central de câmeras</h1>
        <div className="spacer" />
        {/* Ação ÚNICA de câmeras: leva à tela /cameras, que adiciona/gerencia tanto câmera IP
            (superadmin) quanto o nó local (webcam) — visível a todos. */}
        <Tooltip content="Adicionar/gerenciar câmeras (IP/RTSP ou webcam/nó local)">
          <Button asChild variant="primary">
            <Link to="/cameras">
              <Video size={16} strokeWidth={1.75} aria-hidden /> + Câmera
            </Link>
          </Button>
        </Tooltip>
        {/* Paginação: réplica do .switch em utilities — utility em layer não vence o gap:6px
            do .switch (index.css não-layered), por isso sem a classe. */}
        {pageCount > 1 && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-text-dim"
            aria-label="Paginação de feeds"
          >
            <IconButton
              label="Página anterior"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page <= 0}
            >
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
            <span className="muted">
              {page + 1}/{pageCount}
            </span>
            <IconButton
              label="Próxima página"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
            >
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </span>
        )}
        <Tooltip content="Fila de alarmes (eventos acionáveis)">
          {/* Ícone Lucide + rótulo (NN/g: icon+label) — BellRing quando há novos, Bell em repouso. */}
          <Button onClick={() => setAlarmsOpen((o) => !o)} active={alarmsOpen}>
            {newCount > 0 ? (
              <BellRing size={16} strokeWidth={1.75} aria-hidden />
            ) : (
              <Bell size={16} strokeWidth={1.75} aria-hidden />
            )}
            Alarmes
            {newCount > 0 && (
              <span
                className="alarm-count-badge"
                data-prio={topNewPriority}
                aria-label={`${newCount} novos`}
              >
                {newCount}
              </span>
            )}
          </Button>
        </Tooltip>
        {/* Going-gray: só o caso ANORMAL ganha chip — hub desconectado é informação crítica
            e leva cor saturada; a operação normal fica sem badge (a grade já conta a história). */}
        {!connected && (
          <span aria-live="polite">
            <Badge tone="alert">hub desconectado</Badge>
          </span>
        )}
      </header>

      <div className="dash-body">
        {cameras.length === 0 ? (
          <div className="dash-empty">
            <p>
              <b>Nenhuma câmera conectada.</b>
            </p>
            <p>
              Adicione uma câmera IP/RTSP ou abra um nó de câmera (webcam) pela tela de câmeras.
            </p>
            <Button asChild variant="primary">
              <Link to="/cameras">Adicionar câmera</Link>
            </Button>
            <p className="muted mt-3">
              Hub: <code>{APP_CONFIG.net.serverUrl}</code> ·{" "}
              {connected ? "conectado" : "desconectado"}
            </p>
          </div>
        ) : (
          <div className="dash-grid" data-cols={colsFor(pageCameras.length)}>
            {pageCameras.map((c) => (
              <CameraTile
                key={`wrap-${c.id}`}
                camera={c}
                isOpen={c.id === openId}
                // Tile de FUNDO (outra câmera aberta) pausa: vira placeholder leve e desmonta
                // o CameraWorkspace (para rAF/motion/draw). Só a câmera aberta segue processando.
                paused={openId != null && c.id !== openId}
                isFadiga={isFadiga(c.id)}
                getFrame={getterFor(c.id)}
                tripwiresRev={revByCamera.get(c.id) ?? 0}
                status={statuses[c.id]}
                analysisEngine={analysisEngines[c.id] ?? defaultEngine}
                getHubAnalysis={hubGetterFor(c.id)}
                transport={transportOf(c.id)}
                // Auto-fallback: o tile avisa quando o <video-stream> WebRTC não estabelece vídeo.
                onWebrtcFail={handleWebrtcFail}
                onOpen={handleOpen}
                onAlert={handleAlert}
              />
            ))}
          </div>
        )}

        {/* Overlay: câmera aberta */}
        {open && (
          <div className="cam-overlay">
            {isFadiga(open.id) ? (
              <FadigaView
                key={`full-${open.id}`}
                cameraId={open.id}
                label={open.label}
                getFrame={getterFor(open.id)}
                mode="full"
                onClose={() => setOpenId(null)}
                onAlert={handleAlert}
                onSample={recordFadigaSamples}
                onEvent={recordFadigaEvent}
              />
            ) : (
              <CameraWorkspace
                key={`full-${open.id}`}
                cameraId={open.id}
                label={open.label}
                getFrame={getterFor(open.id)}
                mode="full"
                // Transporte de VÍDEO na câmera ABERTA (tela cheia): mesma decisão "auto/melhor
                // disponível" da grade (transportOf). go2rtc serve a câmera → WebRTC estável
                // (<video-stream>); go2rtc fora / stream ausente → MJPEG (relé JPEG).
                transport={transportOf(open.id)}
                // Auto-fallback: a câmera aberta avisa se o WebRTC não estabelecer vídeo → MJPEG.
                onWebrtcFail={handleWebrtcFail}
                tripwiresRev={revByCamera.get(open.id) ?? 0}
                analysisEngine={analysisEngines[open.id] ?? defaultEngine}
                // Simetria com o tile; a câmera aberta mantém o pipeline local (decisão no rAF
                // do CameraWorkspace) — o getter só é consumido na grade (mode≠full).
                getHubAnalysis={hubGetterFor(open.id)}
                onClose={() => setOpenId(null)}
                onAlert={handleAlert}
              />
            )}
          </div>
        )}

        {/* Fila de alarmes acionável */}
        <AlarmDrawer
          open={alarmsOpen}
          onOpenChange={setAlarmsOpen}
          alarms={alarms}
          newCount={newCount}
          onAct={actOnAlarm}
        />
      </div>
    </div>
  );
}
