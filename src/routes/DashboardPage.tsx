import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Video } from "lucide-react";
import { APP_CONFIG } from "../config";
import { setInferencePriority } from "../vision/scheduler";
import { CameraWorkspace } from "../CameraWorkspace";
import { FadigaView } from "../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../report/store";
import { getCameraCfg, type CameraCfg } from "../cameraConfig";
import { useAuth } from "../auth";
import { Button, Switch, Select, Tooltip, Badge, useToast } from "../ui";
import { type Camera } from "./dashboard/types";
import { CameraTile } from "./dashboard/CameraTile";
import { AlarmDrawer } from "./dashboard/AlarmDrawer";
import { ViewsManager } from "./dashboard/ViewsManager";
import { useFrameRelay } from "./dashboard/useFrameRelay";
import { useDashboardSocket } from "./dashboard/useDashboardSocket";
import { useVideoTransport } from "./dashboard/useVideoTransport";
import { useSavedViews } from "./dashboard/useSavedViews";
import { useAlarms } from "./dashboard/useAlarms";
import { colsFor, orderedCameras as computeOrdered } from "./dashboard/autoSurface";
import "./alarms.css";
import "./views.css";

// ── Central de câmeras: ORQUESTRAÇÃO ──────────────────────────────────────────────────────────
// O god-component foi quebrado em hooks por domínio (auditoria §S1 · R2): relé de frames
// (useFrameRelay), socket (useDashboardSocket), transporte de vídeo (useVideoTransport), views +
// auto-surface (useSavedViews) e alarmes (useAlarms); a lógica pura vive em transport.ts/autoSurface.ts
// (testadas). Aqui ficam só a cola entre as frentes, a paginação/feeds ativos e o JSX.
export function DashboardPage() {
  const { token, user, logout } = useAuth();
  const { toast } = useToast();

  // Estado próprio da orquestração (feeds/paginação/overlay/demo). O demais é dos hooks abaixo.
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // Modo demo ("Limite curto 10s") OFF por padrão (produção). Liga via env VITE_DEMO_MODE=1 ou toggle;
  // a escolha do toggle é lembrada na sessão para não voltar a disparar alertas falsos a cada reload.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    try {
      const v = sessionStorage.getItem("vp-demo-mode");
      if (v != null) return v === "1";
    } catch {
      /* no-op */
    }
    return APP_CONFIG.demo.shortLimitDefault;
  });

  // Relé de frames (decode fora da main-thread, getters estáveis, poda de câmeras removidas).
  // Desestruturado em membros ESTÁVEIS (refs + useCallbacks): usá-los direto (em vez do objeto
  // `relay`, recriado a cada render) mantém as deps dos efeitos estáveis (efeito de feeds ativos
  // só re-roda em pageCameras/openId, como no original).
  const relay = useFrameRelay(cameras);
  const { framesRef, activeIdsRef, openIdRef, drainDecode, getterFor, hubGetterFor } = relay;
  // Alarmes + views: criados ANTES do socket (que empurra os eventos ao vivo para os seus setters).
  const alarmsApi = useAlarms(user.usuario, toast);
  const savedViews = useSavedViews(user.id, toast);
  // Socket: roteia os eventos do hub para os refs do relé e para os setters das frentes acima.
  const socket = useDashboardSocket({
    token,
    logout,
    framesRef,
    activeIdsRef,
    hubAnalysisRef: relay.hubAnalysisRef,
    readingZoneRef: relay.readingZoneRef,
    drainDecode,
    loadReadingFlag: relay.loadReadingFlag,
    setCameras,
    setAlarms: alarmsApi.setAlarms,
    setViews: savedViews.setViews,
  });
  const { socketRef, connected, statuses, analysisEngines, revByCamera } = socket;
  const { alarms, alarmsOpen, setAlarmsOpen, newCount, topNewPriority, actOnAlarm } = alarmsApi;
  const {
    views,
    setViews,
    viewsLoading,
    activeViewId,
    setActiveViewId,
    activeView,
    autoSurface,
    setAutoSurface,
    viewsMgrOpen,
    setViewsMgrOpen,
    surfaceTick,
  } = savedViews;

  // Config por câmera (default = atividade → retrocompatível); leitor síncrono usado no transporte.
  const cfgOf = useCallback((id: string): CameraCfg => cfgs[id] ?? getCameraCfg(id), [cfgs]);
  // Transporte de vídeo no painel (go2rtc/WebRTC vs relé MJPEG) + auto-fallback WebRTC→MJPEG.
  const { transportOf, handleWebrtcFail } = useVideoTransport(cfgOf);

  // garante uma config carregada por câmera (default = atividade → retrocompatível)
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of cameras)
        if (!next[c.id]) {
          next[c.id] = getCameraCfg(c.id);
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [cameras]);

  // Conjunto base = câmeras da view ativa (na ordem salva), ou todas. Câmeras da view que não estão
  // mais conectadas são silenciosamente omitidas (o id permanece salvo para quando voltarem).
  const viewCameras = useMemo<Camera[]>(() => {
    if (!activeView) return cameras;
    const byId = new Map(cameras.map((c) => [c.id, c]));
    return activeView.cameraIds.map((id) => byId.get(id)).filter((c): c is Camera => !!c);
  }, [cameras, activeView]);

  // Ordem final: auto-surface reordena por atividade (lógica pura em autoSurface.ts); senão mantém a
  // ordem da view/lista. surfaceTick força o recálculo periódico (a recência decai com o tempo).
  const orderedCameras = useMemo<Camera[]>(
    () => computeOrdered(viewCameras, autoSurface, statuses, alarms, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewCameras, autoSurface, statuses, alarms, surfaceTick],
  );

  // Ao trocar de view ou ligar/desligar auto-surface, volta para a 1ª página (evita ficar "preso").
  useEffect(() => {
    setPage(0);
  }, [activeViewId, autoSurface]);

  // ── Paginação dos feeds: só os feeds da página atual são montados (CameraWorkspace) → só eles
  //    processam inferência. A view/auto-surface definem o CONJUNTO e a ORDEM; a paginação continua
  //    valendo sobre esse conjunto (no auto-surface, as mais ativas caem na 1ª página = processadas). ──
  const feedsPerPage = APP_CONFIG.dashboard.feedsPerPage;
  const pageCount = Math.max(1, Math.ceil(orderedCameras.length / feedsPerPage));
  const pageCameras = useMemo(
    () => orderedCameras.slice(page * feedsPerPage, page * feedsPerPage + feedsPerPage),
    [orderedCameras, page, feedsPerPage],
  );
  // mantém a página dentro do intervalo válido quando a lista de câmeras muda
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // Conjunto ativo = feeds visíveis (página) + câmera aberta. Decodifica os recém-ativos e libera
  // o ImageBitmap dos que saíram (memória); feeds inativos param de ser decodificados (ver `frame`).
  //
  // 0.2 — PAUSAR A GRADE QUANDO UMA CÂMERA ESTÁ ABERTA: com `openId` setado, o conjunto ativo
  // encolhe para SÓ a câmera aberta. Os tiles de fundo (até 5) deixam de ser decodificados aqui E
  // param rAF/motion/draw (CameraTile vira placeholder leve — prop `paused`). O `watch` reanuncia
  // só a aberta → o hub para de RELAYAR os frames de vídeo dos ocultos (banda/CPU do relé). O
  // plano de controle (`analysis-tracks`, broadcast à room, não filtrado por watch) segue chegando.
  // Reversível: ao fechar (openId=null), este efeito reroda, o conjunto volta à página inteira e o
  // watch/decoder retomam. O cine-loop e o decode NATIVO da aberta seguem intactos (ela é a ativa).
  useEffect(() => {
    const active = new Set<string>();
    if (openId) active.add(openId);
    else for (const c of pageCameras) active.add(c.id);
    openIdRef.current = openId; // ref lida pelo drainDecode (aberta = decode nativo, sem resize)
    const prev = activeIdsRef.current;
    activeIdsRef.current = active;
    // 2.1 — assinatura por câmera (contrato ADITIVO): anuncia ao hub o conjunto COMPLETO que este
    // dashboard quer receber; o hub passa a filtrar o evento `frame` por room (`cam:<id>`).
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

  // Eleva a prioridade da câmera ABERTA na fila do scheduler de inferência (A1). As tiles pedem
  // "low" e a câmera aberta (full) já pede "high"; aqui reforçamos a key na transição de abertura.
  useEffect(() => {
    if (openId) setInferencePriority(`${openId}:atividade`, "high");
  }, [openId]);

  // Lembra a escolha do toggle demo na sessão (evita reativar alertas falsos a cada reload).
  useEffect(() => {
    try {
      sessionStorage.setItem("vp-demo-mode", demoMode ? "1" : "0");
    } catch {
      /* no-op */
    }
  }, [demoMode]);

  function isFadiga(id: string): boolean {
    return cfgOf(id).modo === "fadiga";
  }

  // Seleção da view ativa (preferência local do operador). "__all__" = "Todas as câmeras".
  function pickView(v: string) {
    setActiveViewId(v === "__all__" ? null : v);
  }

  // ── 0.6 (ADR-009): PREFERIR O PIPELINE DO HUB por default ──
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
  // useCallback (1.6): identidade estável p/ não quebrar o memo do CameraTile (`toast` é estável).
  const handleAlert = useCallback(
    (msg: string) => {
      toast(msg, msg.includes("⚠") ? "alert" : "default");
      socketRef.current?.emit("alert", { text: msg, ts: Date.now() });
    },
    [toast, socketRef],
  );

  // Abertura de câmera (1.6): callback único e estável; o tile chama com o próprio id.
  const handleOpen = useCallback((id: string) => setOpenId(id), []);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Central de câmeras</h1>
        <div className="spacer" />
        {/* Views salvas por setor (Onda C · item 11): troca rápida do conjunto/ordem de câmeras. */}
        <span className="switch view-picker" aria-label="View por setor">
          <Select
            value={activeView ? activeView.id : "__all__"}
            onChange={pickView}
            ariaLabel="View por setor"
            options={[
              { value: "__all__", label: "Todas as câmeras" },
              ...views.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </span>
        <Tooltip content="Criar, renomear ou excluir views por setor">
          <Button onClick={() => setViewsMgrOpen(true)}>▤ Views</Button>
        </Tooltip>
        <Tooltip content="Prioriza as câmeras com mais atividade recente (alarmes + fps) na 1ª página.">
          <span className="switch">
            <Switch
              checked={autoSurface}
              onCheckedChange={setAutoSurface}
              ariaLabel="Auto-destaque das câmeras ativas"
            />{" "}
            Auto-destaque
          </span>
        </Tooltip>
        <Tooltip content="Encurta o limite p/ demonstrar ao vivo. Tempo exibido é real.">
          <span className="switch">
            <Switch
              checked={demoMode}
              onCheckedChange={setDemoMode}
              ariaLabel="Limite curto (10s)"
            />{" "}
            Limite curto (10s)
          </span>
        </Tooltip>
        {/* Ação ÚNICA de câmeras (substitui "+ Nó de câmera" e "+ Câmera IP"): leva à tela
            /cameras, que adiciona/gerencia tanto câmera IP (só superadmin lá dentro, como o
            botão antigo) quanto o nó local (webcam) — visível a todos, como o botão antigo. */}
        <Tooltip content="Adicionar/gerenciar câmeras (IP/RTSP ou webcam/nó local)">
          <Button asChild variant="primary">
            <Link to="/cameras">
              <Video size={16} strokeWidth={1.75} aria-hidden /> + Câmera
            </Link>
          </Button>
        </Tooltip>
        {/* Paginação: réplica do .switch em utilities (gap 4px, como o inline anterior): utility
            em layer não vence o gap:6px do .switch (index.css não-layered) — por isso sem a classe. */}
        {pageCount > 1 && (
          <span
            className="inline-flex items-center gap-1 text-[12px] text-text-dim"
            aria-label="Paginação de feeds"
          >
            <Tooltip content="Página anterior">
              <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page <= 0}>
                ‹
              </Button>
            </Tooltip>
            <span className="muted">
              {page + 1}/{pageCount}
            </span>
            <Tooltip content="Próxima página">
              <Button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
              >
                ›
              </Button>
            </Tooltip>
          </span>
        )}
        <Tooltip content="Fila de alarmes (eventos acionáveis)">
          <Button onClick={() => setAlarmsOpen((o) => !o)} active={alarmsOpen}>
            ▦ Alarmes
            {newCount > 0 && (
              <span
                className="alarm-badge"
                data-prio={topNewPriority}
                aria-label={`${newCount} novos`}
              >
                {newCount}
              </span>
            )}
          </Button>
        </Tooltip>
        {/* Going-gray: os chips informativos "hub ok · câmeras N · online N" foram removidos
            (ruído — a grade já mostra as câmeras e o estado de cada uma). Só o caso ANORMAL
            permanece: hub desconectado é informação crítica e ganha cor saturada. */}
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
        ) : orderedCameras.length === 0 ? (
          <div className="dash-empty">
            <p>
              <b>Esta view não tem câmeras conectadas.</b>
            </p>
            <p className="muted">
              Edite a view em <b>▤ Views</b> ou selecione <b>Todas as câmeras</b>.
            </p>
            <Button onClick={() => setActiveViewId(null)}>Ver todas as câmeras</Button>
          </div>
        ) : (
          <div className="dash-grid" data-cols={colsFor(pageCameras.length)}>
            {pageCameras.map((c) => (
              <CameraTile
                key={`wrap-${c.id}`}
                camera={c}
                isOpen={c.id === openId}
                // 0.2 — tile de FUNDO (outra câmera aberta) pausa: vira placeholder leve e desmonta
                // o CameraWorkspace (para rAF/motion/draw). Só a câmera aberta segue processando.
                paused={openId != null && c.id !== openId}
                isFadiga={isFadiga(c.id)}
                getFrame={getterFor(c.id)}
                demoMode={demoMode}
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
                // Transporte de VÍDEO na câmera ABERTA (tela cheia): MESMA resolução "auto/melhor
                // disponível" da grade (transportOf). go2rtc serve a câmera → WebRTC estável
                // (<video-stream>); go2rtc fora / stream ausente → MJPEG (relé JPEG, atual). Sem a
                // prop o full seguia sempre MJPEG. `open` é não-nulo neste ramo → open.id é seguro.
                transport={transportOf(open.id)}
                // Auto-fallback: a câmera aberta avisa se o WebRTC não estabelecer vídeo → MJPEG.
                onWebrtcFail={handleWebrtcFail}
                demoMode={demoMode}
                tripwiresRev={revByCamera.get(open.id) ?? 0}
                analysisEngine={analysisEngines[open.id] ?? defaultEngine}
                // F2: passado também no full por simetria/F3; a decisão da F2 (comentário no
                // rAF do CameraWorkspace) mantém o pipeline local na câmera aberta — o getter
                // só é consumido na grade (mode≠full).
                getHubAnalysis={hubGetterFor(open.id)}
                onClose={() => setOpenId(null)}
                onAlert={handleAlert}
              />
            )}
          </div>
        )}

        {/* O antigo modal "⚙ Câmeras" (papel + vídeo no painel por câmera) foi INCORPORADO à
            tela /cameras ("Ajustes desta câmera") — fim da fragmentação da config por-câmera. */}

        {/* Gerenciador de views por setor (Onda C · item 11) — criar/renomear/excluir + ordenar */}
        <ViewsManager
          open={viewsMgrOpen}
          onOpenChange={setViewsMgrOpen}
          views={views}
          setViews={setViews}
          setActiveViewId={setActiveViewId}
          cameras={cameras}
          viewsLoading={viewsLoading}
        />

        {/* Fila de alarmes acionável (Onda B · item 7) */}
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
