import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Hand, RotateCcw, Smartphone, ThumbsUp, Volume2, VolumeX, X } from "lucide-react";
import { APP_CONFIG } from "./config";
import { useFocusTrap } from "./camera/useFocusTrap";
import { type FrameSource } from "./frame";
import { drawFadigaScene } from "./fadiga/draw";
import { type ManualSignal, type RiskState, type PhoneDetection } from "./fadiga/landmarks";
import {
  FadigaProcessor,
  type FadigaModelState,
  type FadigaCounters,
  type FadigaFlags,
  type FadigaThresholds,
  FADIGA_FLAGS_ALL,
} from "./processors/fadiga";
import {
  loadFadigaThresholds,
  saveFadigaThresholds,
  FADIGA_DEFAULT_THRESHOLDS,
  FADIGA_THRESHOLD_FIELDS,
} from "./fadiga/calibration";
import { type FadigaSamplePayload, type FadigaEvent } from "./report/store";
import { FrameMeter } from "./telemetry";
import {
  Badge,
  Button,
  IconButton,
  Slider,
  Toggle,
  ToggleGroup,
  ScrollArea,
  SectionTitle,
  Tooltip,
} from "./ui";

// Modo FADIGA (casca fina): pipeline (Face/Hand/coco) + motor de risco vivem em FadigaProcessor;
// aqui ficam só feed/overlay, painel, beep e telemetria.

const RISK_LABEL: Record<RiskState, string> = {
  OK: "OK",
  ALERTA_FADIGA: "Fadiga",
  ALERTA_CELULAR: "Celular",
  ALERTA_DUPLO: "Duplo",
};
const RISK_CLS: Record<RiskState, string> = {
  OK: "ATIVA",
  ALERTA_FADIGA: "OCIOSA",
  ALERTA_CELULAR: "OCIOSA",
  ALERTA_DUPLO: "ALERTA",
};
// Estado→tom do átomo Badge (going-gray, mapa da doutrina): ATIVA/VAZIA ficam na base
// neutra (sem tom); cor saturada só para anormalidade — OCIOSA→warn, ALERTA→critical.
const CLS_TONE: Record<string, "warn" | "alert" | undefined> = {
  ATIVA: undefined,
  VAZIA: undefined,
  OCIOSA: "warn",
  ALERTA: "alert",
};
const DETECTORS = [
  ["face", "Face"],
  ["hands", "Mãos"],
  ["phone", "Celular"],
  ["risk", "Risco"],
] as const;

// a11y (WCAG 2.1.1): o tile da grade é um <button> (não <div onClick>) → foco + Enter/Espaço
// nativos. Reset só dos defaults de botão que a classe .tile NÃO define (padding/font/cor/
// alinhamento + chrome nativo); background/border/cursor/flex e a cor de estado (.fadiga-tile.*)
// continuam vindo do CSS, então a aparência do tile não muda.
const TILE_BTN_RESET: CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  padding: 0,
  font: "inherit",
  color: "inherit",
  textAlign: "inherit",
};

type Props = {
  cameraId: string;
  label: string;
  getFrame: () => FrameSource | null;
  mode: "tile" | "full";
  onOpen?: () => void;
  onClose?: () => void;
  onAlert?: (msg: string) => void;
  onSample?: (p: FadigaSamplePayload) => void;
  onEvent?: (e: FadigaEvent) => void;
};

export function FadigaView({
  label,
  getFrame,
  mode,
  onOpen,
  onClose,
  onAlert,
  onSample,
  onEvent,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const engineRef = useRef(new FadigaProcessor()); // domínio (modelos + motor de risco)
  const audioRef = useRef<AudioContext | null>(null);
  const lastBeepRef = useRef(0);
  const onAlertRef = useRef(onAlert);
  const onSampleRef = useRef(onSample);
  const onEventRef = useRef(onEvent);
  const meterRef = useRef(new FrameMeter()); // FPS + latência facial
  const handMeterRef = useRef(new FrameMeter()); // latência de mãos
  const objMeterRef = useRef(new FrameMeter()); // latência de celular
  const lastUiRef = useRef(0);
  const lastFrameElRef = useRef<unknown>(null); // gate de "frame novo" (padrão CameraWorkspace)
  const lastFrameTsRef = useRef(0);
  const lastVpWRef = useRef(0); // tamanho do viewport no último draw — resize força redraw
  const lastVpHRef = useRef(0);
  const mutedRef = useRef(false); // refs lidos no loop sem re-subscrever
  const flagsRef = useRef<FadigaFlags>({ ...FADIGA_FLAGS_ALL });
  const ackRef = useRef(false); // alerta reconhecido por gesto (silencia o episódio)
  const fullRef = useRef<HTMLDivElement | null>(null); // raiz da casca fullscreen (foco preso)
  const cfgOpenRef = useRef(false); // esta casca não tem Dialog Radix → o trap nunca defere
  const onCloseRef = useRef(onClose); // estável p/ o ESC do trap (não re-arma o listener)

  const [ear, setEar] = useState<number | null>(null);
  const [mar, setMar] = useState<number | null>(null);
  const [yawn, setYawn] = useState(false);
  const [signal, setSignal] = useState<ManualSignal>("SEM_SINAL");
  const [handCount, setHandCount] = useState(0);
  const [phone, setPhone] = useState<PhoneDetection>(null);
  const [risk, setRisk] = useState<RiskState>("OK");
  const [faceState, setFaceState] = useState<FadigaModelState>("loading");
  const [counters, setCounters] = useState<FadigaCounters>({
    fadiga: 0,
    bocejo: 0,
    celular: 0,
    duplo: 0,
  });
  const [fps, setFps] = useState(0);
  const [faceLat, setFaceLat] = useState(0);
  const [handLat, setHandLat] = useState(0);
  const [objLat, setObjLat] = useState(0);
  const [muted, setMuted] = useState(false);
  const [flags, setFlags] = useState<FadigaFlags>({ ...FADIGA_FLAGS_ALL });
  const [ack, setAck] = useState(false);
  const [thresholds, setThresholds] = useState<FadigaThresholds>(() => loadFadigaThresholds());

  useEffect(() => {
    engineRef.current.setThresholds(thresholds);
    saveFadigaThresholds(thresholds);
  }, [thresholds]);
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);
  useEffect(() => {
    onSampleRef.current = onSample;
  }, [onSample]);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    flagsRef.current = flags;
  }, [flags]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const e = engineRef.current;
    return () => e.dispose();
  }, []);

  // Casca fullscreen NÃO vira Radix Dialog (ADR-007: Portal/scroll-lock remontaria o canvas)
  // → ESC fecha + trap de foco MANUAIS, via o MESMO hook do CameraWorkspace (a outra casca
  // fullscreen deste fluxo). Inativo no modo tile (fullRef só é anexado no full).
  useFocusTrap(mode === "full", fullRef, cfgOpenRef, onCloseRef);

  function beep() {
    if (mode !== "full") return; // só a câmera aberta emite som
    const now = performance.now();
    if (now - lastBeepRef.current < APP_CONFIG.audio.alertBeepCooldownMs) return;
    lastBeepRef.current = now;
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      const a = audioRef.current;
      if (a.state === "suspended") void a.resume();
      const osc = a.createOscillator(),
        gain = a.createGain();
      osc.frequency.value = APP_CONFIG.audio.alertFrequencyHz;
      osc.connect(gain);
      gain.connect(a.destination);
      gain.gain.setValueAtTime(0.0001, a.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, a.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        a.currentTime + APP_CONFIG.audio.alertDurationMs / 1000,
      );
      osc.start();
      osc.stop(a.currentTime + APP_CONFIG.audio.alertDurationMs / 1000);
    } catch {
      /* política de áudio */
    }
  }

  useEffect(() => {
    let stopped = false;
    lastFrameElRef.current = null; // remonte de canvas (tile↔full) exige redraw no 1º frame
    const loop = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current,
        viewport = viewportRef.current;
      if (!canvas || !viewport) return;
      const f = getFrame();
      if (!f || !f.w || !f.h) return;
      // ── GATE de "frame novo": o rAF roda a ~60Hz, mas o vídeo chega a ~12fps. Se o frame
      //    (identidade do `el` / `ts`) não mudou desde o último tick processado, pula
      //    process()+draw — mesmo padrão do CameraWorkspace. Exceção: resize do viewport sem
      //    frame novo ainda redesenha (o draw depende do tamanho de exibição). ──
      const vpW = viewport.clientWidth,
        vpH = viewport.clientHeight;
      if (
        f.el === lastFrameElRef.current &&
        (f.ts == null || f.ts === lastFrameTsRef.current) &&
        vpW === lastVpWRef.current &&
        vpH === lastVpHRef.current
      )
        return;
      lastFrameElRef.current = f.el;
      lastFrameTsRef.current = f.ts ?? 0;
      lastVpWRef.current = vpW;
      lastVpHRef.current = vpH;
      const now = performance.now();
      meterRef.current.tick(now);

      // Na GRADE (tile) a cadência de inferência é rebaixada (slow) — ver FadigaProcessor.
      const r = engineRef.current.process({
        frame: f,
        now,
        flags: flagsRef.current,
        slow: mode === "tile",
      }); // domínio
      if (r.faceMs != null) meterRef.current.pushProc(r.faceMs);
      if (r.handMs != null) handMeterRef.current.pushProc(r.handMs);
      if (r.objMs != null) objMeterRef.current.pushProc(r.objMs);
      drawFadigaScene(canvas, viewport, f.el, f.w, f.h, r.scene);

      r.events.forEach((e) => onEventRef.current?.({ posto: label, type: e.type, ts: e.ts }));
      if (r.sample && onSampleRef.current) onSampleRef.current({ posto: label, ...r.sample });

      // Alarme + gesto-como-ação. O beep repete enquanto em alerta (cooldown interno);
      // 👍 (JOINHA) reconhece o episódio e silencia até voltar a OK; mute silencia sempre.
      const s = r.snapshot;
      if (r.alertRisk) {
        ackRef.current = false;
        setAck(false);
        onAlertRef.current?.(`⚠ ${label}: ${RISK_LABEL[r.alertRisk]}`);
      }
      if (s.risk === "OK") {
        if (ackRef.current) {
          ackRef.current = false;
          setAck(false);
        }
      } else {
        if (s.signal === "JOINHA" && !ackRef.current) {
          ackRef.current = true;
          setAck(true);
          onAlertRef.current?.(`✋ ${label}: alerta reconhecido (gesto 👍)`);
        }
        if (!mutedRef.current && !ackRef.current) beep();
      }

      const uiEvery = mode === "full" ? 140 : 350;
      if (now - lastUiRef.current > uiEvery) {
        lastUiRef.current = now;
        const s = r.snapshot;
        setEar(s.ear);
        setMar(s.mar);
        setYawn(s.yawn);
        setSignal(s.signal);
        setHandCount(s.handCount);
        setPhone(s.phone);
        setRisk(s.risk);
        setFaceState(s.faceState);
        setCounters(s.counters);
        const mt = meterRef.current;
        setFps(Math.round(mt.fps));
        setFaceLat(Math.round(mt.avgProcMs));
        setHandLat(Math.round(handMeterRef.current.avgProcMs));
        setObjLat(Math.round(objMeterRef.current.avgProcMs));
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFrame, mode, label]);

  const loading = faceState === "loading";
  const status =
    faceState === "error"
      ? { txt: "modelo falhou", cls: "ALERTA" }
      : loading
        ? { txt: "carregando", cls: "VAZIA" }
        : { txt: RISK_LABEL[risk], cls: RISK_CLS[risk] };

  // ── TILE ──
  if (mode === "tile") {
    return (
      <Tooltip content="Abrir monitor do operador">
        <button
          type="button"
          className={`tile fadiga-tile ${RISK_CLS[risk]}`}
          onClick={onOpen}
          style={TILE_BTN_RESET}
        >
          <div className="viewport tile-vp" ref={viewportRef}>
            <canvas ref={canvasRef} />
            <div className="tile-badges">
              <span className={`tb ${status.cls}`}>● {status.txt}</span>
              {phone && (
                <span className="tb ALERTA inline-flex items-center">
                  <Smartphone
                    size={16}
                    strokeWidth={1.75}
                    role="img"
                    aria-label="Celular detectado"
                  />
                </span>
              )}
            </div>
          </div>
          <div className="tile-foot">
            <span className="tile-name">{label}</span>
            <span className="tile-meta">
              EAR {ear == null ? "--" : ear.toFixed(2)} ·{" "}
              {signal !== "SEM_SINAL" ? signal : `${handCount} mão(s)`}
            </span>
          </div>
        </button>
      </Tooltip>
    );
  }

  // ── FULL (console do operador) ──
  // Semântica de diálogo modal (paridade com o CameraWorkspace): role/aria-modal/aria-label
  // + tabIndex=-1 (o trap foca a raiz quando não há focável).
  return (
    <div
      className="cam fadiga-cam"
      ref={fullRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Operador ${label} em tela cheia`}
    >
      {/* a11y (A5): heading da casca fullscreen — só p/ leitores de tela. */}
      <h1 className="sr-only">Operador {label} — monitor de fadiga</h1>
      <header className="cam-head">
        <div className="cam-title">
          <b>{label}</b>
          <span className="muted">operador · fadiga</span>
        </div>
        <div className="spacer" />
        <Badge tone={CLS_TONE[status.cls]}>{status.txt}</Badge>
        <IconButton label="Fechar" onClick={onClose}>
          <X size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </header>

      {/* Palco + drawer lado a lado (.cam-body, cine.css): o palco encolhe e o draw
          re-letterboxa (fit) — o vídeo não fica coberto pelo painel. */}
      <div className="cam-body">
        <div className="cam-stage" ref={viewportRef}>
          <canvas className="overlay" ref={canvasRef} />
        </div>
        <aside className="cam-drawer">
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <div className="read-now">
              {/* Badge --state-* no lugar do <b style> com aliases --ok/--idle/--alert
                  (aposentados no G7 — a cor inline já não resolvia). Ack = confirmação
                  pontual → tom ok, com ícone + texto (nunca só-por-ícone). */}
              <div className="obj-total">
                Risco: <Badge tone={CLS_TONE[RISK_CLS[risk]]}>{RISK_LABEL[risk]}</Badge>
                {ack && (
                  <span className="ml-2 inline-flex align-middle">
                    <Badge tone="ok">
                      <Hand size={12} strokeWidth={1.75} aria-hidden /> reconhecido
                    </Badge>
                  </span>
                )}
              </div>
              <div className="read-now-meta">
                <span>
                  EAR <b>{ear == null ? "--" : ear.toFixed(3)}</b>
                </span>
                <span>
                  MAR <b>{mar == null ? "--" : mar.toFixed(3)}</b>
                  {yawn ? " (bocejo)" : ""}
                </span>
              </div>
            </div>
            {/* Seções internas = <h2> semântico (SectionTitle); .read-flow-h preserva o
                padding/layout do drawer (a tipografia label 11 uppercase é a mesma). */}
            <SectionTitle flush className="read-flow-h">
              Sinais
            </SectionTitle>
            <div className="fadiga-signals">
              <div className="fs-row">
                <span>Celular</span>
                <span className={phone ? "on" : ""}>
                  {phone ? `sim ${Math.round(phone.score * 100)}%` : "não"}
                </span>
              </div>
              <div className="fs-row">
                <span>Gesto de mão</span>
                <span>
                  {signal} ({handCount})
                </span>
              </div>
              <div className="fs-row">
                <span>Modelo facial</span>
                <span>
                  {faceState === "ready"
                    ? "ativo"
                    : faceState === "loading"
                      ? "carregando…"
                      : "falhou"}
                </span>
              </div>
            </div>
            <SectionTitle flush className="read-flow-h">
              Ocorrências
            </SectionTitle>
            <div className="fadiga-signals">
              <div className="fs-row">
                <span>Fadiga</span>
                <span>{counters.fadiga}</span>
              </div>
              <div className="fs-row">
                <span>Bocejo</span>
                <span>{counters.bocejo}</span>
              </div>
              <div className="fs-row">
                <span>Celular</span>
                <span>{counters.celular}</span>
              </div>
              <div className="fs-row">
                <span>Duplo</span>
                <span>{counters.duplo}</span>
              </div>
            </div>

            <SectionTitle flush className="read-flow-h">
              Controles
            </SectionTitle>
            <div className="fadiga-controls">
              <Tooltip content="Liga/desliga o alarme sonoro">
                <Toggle
                  pressed={muted}
                  onPressedChange={setMuted}
                  aria-label="Liga/desliga o alarme sonoro"
                >
                  {muted ? (
                    <VolumeX size={16} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Volume2 size={16} strokeWidth={1.75} aria-hidden />
                  )}
                  {muted ? "Som off" : "Som on"}
                </Toggle>
              </Tooltip>
              <div className="cfg-classes">
                <span className="cfg-classes-lbl">Detecções</span>
                <ToggleGroup
                  type="multiple"
                  ariaLabel="Detecções"
                  value={DETECTORS.filter(([k]) => flags[k]).map(([k]) => k)}
                  onValueChange={(vals) =>
                    setFlags((prev) => {
                      const next = { ...prev };
                      for (const [k] of DETECTORS) next[k] = vals.includes(k);
                      return next;
                    })
                  }
                  items={DETECTORS.map(([k, lbl]) => ({
                    value: k,
                    label: lbl,
                    ariaLabel: `Liga/desliga ${lbl}`,
                  }))}
                />
              </div>
              <p className="fadiga-hint">
                <ThumbsUp
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className="inline-block align-text-bottom"
                />{" "}
                Um joinha durante um alerta silencia o episódio até voltar a OK.
              </p>
            </div>

            <SectionTitle flush className="read-flow-h">
              Calibração
            </SectionTitle>
            <div className="fadiga-calib">
              {FADIGA_THRESHOLD_FIELDS.map((fld) => (
                <Tooltip key={fld.key} content={fld.hint}>
                  <div className="calib-row">
                    <span className="calib-lbl">{fld.label}</span>
                    <span className="calib-val">{fld.fmt(thresholds[fld.key])}</span>
                    <Slider
                      value={thresholds[fld.key]}
                      min={fld.min}
                      max={fld.max}
                      step={fld.step}
                      onChange={(v) => setThresholds((t) => ({ ...t, [fld.key]: v }))}
                      ariaLabel={fld.label}
                    />
                  </div>
                </Tooltip>
              ))}
              <Button onClick={() => setThresholds({ ...FADIGA_DEFAULT_THRESHOLDS })}>
                <RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Restaurar padrão
              </Button>
            </div>
          </ScrollArea>
        </aside>
      </div>

      <div className="cam-kpibar">
        <span className="kb">
          risco <b>{RISK_LABEL[risk]}</b>
        </span>
        <span className="kb">
          EAR <b>{ear == null ? "--" : ear.toFixed(2)}</b>
        </span>
        <span className="kb">
          MAR <b>{mar == null ? "--" : mar.toFixed(2)}</b>
        </span>
        <span className="kb">
          <Smartphone size={16} strokeWidth={1.75} role="img" aria-label="Celular" />{" "}
          <b>{phone ? "sim" : "não"}</b>
        </span>
        {/* going-gray/a11y: estado NUNCA só-por-ícone — ícone Lucide + texto (antes 🔇/🔊/✋). */}
        <span className="kb">
          {muted ? (
            <VolumeX size={16} strokeWidth={1.75} aria-hidden />
          ) : (
            <Volume2 size={16} strokeWidth={1.75} aria-hidden />
          )}{" "}
          <b>{muted ? "som off" : "som on"}</b>
        </span>
        {ack && (
          <span className="kb">
            <Hand size={16} strokeWidth={1.75} aria-hidden /> <b>reconhecido</b>
          </span>
        )}
        <span className="kb muted">
          FPS {fps} · face {faceLat}ms · mãos {handLat}ms · cel {objLat}ms
        </span>
      </div>
    </div>
  );
}
