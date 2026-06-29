import { useEffect, useRef, useState } from "react";
import { APP_CONFIG } from "./config";
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
import { Button, IconButton, Slider, Toggle, ToggleGroup, ScrollArea, Tooltip } from "./ui";

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
const DETECTORS = [
  ["face", "Face"],
  ["hands", "Mãos"],
  ["phone", "Celular"],
  ["risk", "Risco"],
] as const;

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
  const mutedRef = useRef(false); // refs lidos no loop sem re-subscrever
  const flagsRef = useRef<FadigaFlags>({ ...FADIGA_FLAGS_ALL });
  const ackRef = useRef(false); // alerta reconhecido por gesto (silencia o episódio)

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
    const e = engineRef.current;
    return () => e.dispose();
  }, []);

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
    const loop = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current,
        viewport = viewportRef.current;
      if (!canvas || !viewport) return;
      const f = getFrame();
      if (!f || !f.w || !f.h) return;
      const now = performance.now();
      meterRef.current.tick(now);

      const r = engineRef.current.process({ frame: f, now, flags: flagsRef.current }); // domínio
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
        <div className={`tile fadiga-tile ${RISK_CLS[risk]}`} onClick={onOpen}>
          <div className="viewport tile-vp" ref={viewportRef}>
            <canvas ref={canvasRef} />
            <div className="tile-badges">
              <span className={`tb ${status.cls}`}>● {status.txt}</span>
              {phone && <span className="tb ALERTA">📱</span>}
            </div>
          </div>
          <div className="tile-foot">
            <span className="tile-name">{label}</span>
            <span className="tile-meta">
              EAR {ear == null ? "--" : ear.toFixed(2)} ·{" "}
              {signal !== "SEM_SINAL" ? signal : `${handCount} mão(s)`}
            </span>
          </div>
        </div>
      </Tooltip>
    );
  }

  // ── FULL (console do operador) ──
  return (
    <div className="cam fadiga-cam">
      <header className="cam-head">
        <div className="cam-title">
          <b>{label}</b>
          <span className="muted">operador · fadiga</span>
        </div>
        <div className="spacer" />
        <span className={`badge ${status.cls}`}>{status.txt}</span>
        <IconButton label="Fechar" onClick={onClose}>
          ✕
        </IconButton>
      </header>

      <div className="cam-stage" ref={viewportRef}>
        <canvas className="overlay" ref={canvasRef} />
        <aside className="cam-drawer">
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <div className="read-now">
              <div className="obj-total">
                Risco:{" "}
                <b
                  style={{
                    color:
                      risk === "OK"
                        ? "var(--ok)"
                        : risk === "ALERTA_DUPLO"
                          ? "var(--alert)"
                          : "var(--idle)",
                  }}
                >
                  {RISK_LABEL[risk]}
                </b>
                {ack && (
                  <span className="flow-chip Baixo" style={{ marginLeft: 8 }}>
                    ✋ reconhecido
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
            <div className="read-flow-h">Sinais</div>
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
            <div className="read-flow-h">Ocorrências</div>
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

            <div className="read-flow-h">Controles</div>
            <div className="fadiga-controls">
              <Tooltip content="Liga/desliga o alarme sonoro">
                <Toggle
                  pressed={muted}
                  onPressedChange={setMuted}
                  aria-label="Liga/desliga o alarme sonoro"
                >
                  {muted ? "🔇 Som off" : "🔊 Som on"}
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
                👍 durante um alerta silencia o episódio até voltar a OK.
              </p>
            </div>

            <div className="read-flow-h">Calibração</div>
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
                ↺ Restaurar padrão
              </Button>
            </div>
          </ScrollArea>
        </aside>
      </div>

      <div className="cam-kpibar">
        <span className="kb">
          ⦿ risco <b>{RISK_LABEL[risk]}</b>
        </span>
        <span className="kb">
          EAR <b>{ear == null ? "--" : ear.toFixed(2)}</b>
        </span>
        <span className="kb">
          MAR <b>{mar == null ? "--" : mar.toFixed(2)}</b>
        </span>
        <span className="kb">
          📱 <b>{phone ? "sim" : "não"}</b>
        </span>
        <span className="kb">
          {muted ? "🔇" : "🔊"}
          {ack ? " ✋" : ""}
        </span>
        <span className="kb muted">
          FPS {fps} · face {faceLat}ms · mãos {handLat}ms · cel {objLat}ms
        </span>
      </div>
    </div>
  );
}
