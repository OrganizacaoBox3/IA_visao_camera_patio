// Painel de CALIBRAÇÃO de homografia por câmera (MVP, self-contained). Duas funções sobre a MESMA
// imagem do chão:
//   • Calibrar: o operador clica ≥4 pontos no piso e digita a posição real (X,Y em metros) de cada
//     um → computa a homografia (src/vision/homography.ts) e salva no hub (api.saveCalibration).
//   • Medir: com a câmera calibrada, clica 2 pontos → distância REAL no chão em metros.
//
// DESACOPLADO da casca de câmera (ADR-007): NÃO monta dentro do <canvas>/fullscreen — recebe uma
// imagem estática (`snapshotUrl`, ex.: um frame baixado) e captura cliques sobre um <img>/placeholder
// próprio. Coordenadas são NORMALIZADAS 0..1 (mesmo sistema de zonas/tracks/pé da pessoa), medidas
// contra o retângulo do palco (o wrapper encolhe até a imagem → sem matemática de letterbox).
// LGPD: só geometria/números trafegam; a imagem é local e efêmera (nunca persistida).
import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Ruler, Save, Trash2, X } from "lucide-react";
import { Button, Badge, Field, Input, SegmentedControl, Alert } from "../ui";
import {
  computeHomography,
  measureDistance,
  type Correspondence,
  type Matrix3,
  type Vec2,
} from "../vision/homography";
import { getCalibration, saveCalibration, ApiError, type CameraCalibration } from "../api";

type Mode = "calibrar" | "medir";
// Ponto em EDIÇÃO: px fixado no clique; world como STRING (permite digitar "-", "1.", vazio sem o
// glitch do input numérico controlado). Vira Correspondence só quando ambos parseiam a número finito.
type EditPoint = { id: string; px: Vec2; wx: string; wy: string };

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

type Props = {
  cameraId: string;
  label?: string;
  canConfigure: boolean;
  /** Imagem estática do chão da câmera (frame baixado). Ausente → placeholder em grade. */
  snapshotUrl?: string;
  onClose?: () => void;
};

export function CalibrationPanel({ cameraId, label, canConfigure, snapshotUrl, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("calibrar");
  const [edits, setEdits] = useState<EditPoint[]>([]);
  const [savedH, setSavedH] = useState<Matrix3 | null>(null); // H persistida (base da medição)
  const [measurePts, setMeasurePts] = useState<Vec2[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Carrega a calibração existente (prefill dos pontos + H). Degrada gracioso se ausente/erro.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEdits([]);
    setSavedH(null);
    setMeasurePts([]);
    getCalibration(cameraId)
      .then((cal) => {
        if (cancelled || !cal) return;
        setSavedH(cal.H);
        setEdits(
          cal.points.map((p) => ({
            id: uid(),
            px: { x: p.px.x, y: p.px.y },
            wx: String(p.world.x),
            wy: String(p.world.y),
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) console.warn("[calibration] carga falhou — começando vazio", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  // Correspondências vivas + H recomputada ao editar (memo — só quando ≥4 pontos com metros válidos).
  const { corr, liveH } = useMemo(() => {
    const corr: Correspondence[] = edits.map((e) => ({
      px: e.px,
      world: { x: parseFloat(e.wx), y: parseFloat(e.wy) },
    }));
    const allNumbers = corr.every(
      (c) => Number.isFinite(c.world.x) && Number.isFinite(c.world.y),
    );
    const liveH =
      edits.length >= 4 && allNumbers ? computeHomography(corr) : null;
    return { corr, liveH };
  }, [edits]);

  // H ativa p/ medição: a recém-editada (se válida) ou a última salva.
  const activeH: Matrix3 | null = liveH && liveH.ok ? liveH.H : savedH;
  const distance =
    activeH && measurePts.length === 2
      ? measureDistance(activeH, measurePts[0], measurePts[1])
      : null;

  // Clique no palco → coordenada normalizada 0..1 (contra o retângulo da imagem).
  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const px: Vec2 = {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
    if (mode === "medir") {
      setMeasurePts((p) => (p.length >= 2 ? [px] : [...p, px]));
      return;
    }
    if (!canConfigure) return;
    setEdits((p) => [...p, { id: uid(), px, wx: "0", wy: "0" }]);
    setNote(null);
  }

  const setWorld = (id: string, axis: "wx" | "wy", v: string) =>
    setEdits((p) => p.map((e) => (e.id === id ? { ...e, [axis]: v } : e)));
  const removePoint = (id: string) => setEdits((p) => p.filter((e) => e.id !== id));

  async function save() {
    if (!liveH || !liveH.ok) return;
    setSaving(true);
    setErr(null);
    setNote(null);
    const payload: CameraCalibration = {
      points: corr.map((c) => ({ px: c.px, world: c.world })),
      H: liveH.H,
      updatedAt: Date.now(),
    };
    try {
      const saved = await saveCalibration(cameraId, payload);
      setSavedH(saved.H);
      setNote("Calibração salva.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Não foi possível salvar a calibração.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Ruler size={16} strokeWidth={1.75} aria-hidden />
          <b className="text-[14px]">Calibração de distância{label ? ` — ${label}` : ""}</b>
          {savedH && <Badge tone="ok">calibrada</Badge>}
        </div>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fechar">
            <X size={14} strokeWidth={1.75} aria-hidden />
          </Button>
        )}
      </div>

      <SegmentedControl<Mode>
        value={mode}
        onChange={(m) => {
          setMode(m);
          setMeasurePts([]);
        }}
        ariaLabel="Modo da calibração"
        options={[
          { value: "calibrar", label: "Calibrar" },
          { value: "medir", label: "Medir" },
        ]}
      />

      <p className="text-[12px] text-text-muted">
        {mode === "calibrar"
          ? canConfigure
            ? "Clique em ≥4 pontos do chão e informe a posição real (X,Y em metros) de cada um."
            : "A calibração requer perfil de engenharia. Você pode usar o modo Medir."
          : activeH
            ? "Clique em 2 pontos do chão para medir a distância real entre eles."
            : "Calibre a câmera primeiro (≥4 pontos) para poder medir em metros."}
      </p>

      {/* Palco: wrapper ENCOLHE até a imagem (cliques mapeiam direto a 0..1, sem letterbox). A imagem é
          capada à viewport (max-h) e à largura da página (max-w) p/ não estourar/cortar a tela; o palco
          centraliza e acompanha o tamanho real exibido. */}
      <div
        ref={stageRef}
        onClick={onStageClick}
        className="relative mx-auto cursor-crosshair select-none overflow-hidden rounded-sm border border-border bg-panel-2"
        style={
          snapshotUrl
            ? { width: "fit-content", maxWidth: "100%" }
            : { width: "min(100%, 640px)", aspectRatio: "16 / 9" }
        }
      >
        {snapshotUrl ? (
          <img
            src={snapshotUrl}
            alt="Chão da câmera para calibração"
            draggable={false}
            className="block max-h-[55vh] max-w-full select-none"
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
              backgroundSize: "10% 10%",
              opacity: 0.5,
            }}
          />
        )}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {mode === "calibrar" &&
            edits.map((e, i) => (
              <g key={e.id}>
                <circle
                  cx={`${e.px.x * 100}%`}
                  cy={`${e.px.y * 100}%`}
                  r={6}
                  fill="var(--state-info)"
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
                <text
                  x={`${e.px.x * 100}%`}
                  y={`${e.px.y * 100}%`}
                  dx={9}
                  dy={4}
                  fontSize={12}
                  fill="var(--state-info)"
                >
                  {i + 1}
                </text>
              </g>
            ))}
          {mode === "medir" && (
            <>
              {measurePts.length === 2 && (
                <line
                  x1={`${measurePts[0].x * 100}%`}
                  y1={`${measurePts[0].y * 100}%`}
                  x2={`${measurePts[1].x * 100}%`}
                  y2={`${measurePts[1].y * 100}%`}
                  stroke="var(--state-warn)"
                  strokeWidth={2}
                />
              )}
              {measurePts.map((p, i) => (
                <circle
                  key={i}
                  cx={`${p.x * 100}%`}
                  cy={`${p.y * 100}%`}
                  r={6}
                  fill="var(--state-warn)"
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
              ))}
            </>
          )}
        </svg>
      </div>

      {/* Medição: leitura da distância em metros. */}
      {mode === "medir" && (
        <div className="flex items-center gap-3">
          <div className="text-[13px]">
            {distance != null ? (
              <>
                Distância: <b>{distance.toFixed(2)} m</b>
              </>
            ) : (
              <span className="text-text-muted">Clique 2 pontos para medir.</span>
            )}
          </div>
          {measurePts.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setMeasurePts([])}>
              Limpar
            </Button>
          )}
        </div>
      )}

      {/* Calibração: lista de pontos com as coordenadas reais (metros). */}
      {mode === "calibrar" && (
        <div className="flex flex-col gap-2">
          {loading && <span className="text-[12px] text-text-muted">Carregando…</span>}
          {!loading && edits.length === 0 && (
            <span className="text-[12px] text-text-muted">
              Nenhum ponto. Clique no chão da imagem para adicionar.
            </span>
          )}
          {edits.map((e, i) => (
            <div key={e.id} className="flex items-end gap-2">
              <span className="mb-2 inline-flex items-center gap-1 text-[12px] text-text-dim">
                <MapPin size={13} strokeWidth={1.75} aria-hidden /> {i + 1}
              </span>
              <Field label="X (m)" className="w-24">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={e.wx}
                  disabled={!canConfigure}
                  onChange={(ev) => setWorld(e.id, "wx", ev.target.value)}
                />
              </Field>
              <Field label="Y (m)" className="w-24">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={e.wy}
                  disabled={!canConfigure}
                  onChange={(ev) => setWorld(e.id, "wy", ev.target.value)}
                />
              </Field>
              <span className="mb-2 text-[11px] text-text-muted">
                px {e.px.x.toFixed(2)},{e.px.y.toFixed(2)}
              </span>
              {canConfigure && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mb-1"
                  aria-label={`Remover ponto ${i + 1}`}
                  onClick={() => removePoint(e.id)}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                </Button>
              )}
            </div>
          ))}

          {/* Estado da homografia + ação de salvar. */}
          {liveH && !liveH.ok && <Alert tone="warn">{liveH.error}</Alert>}
          {err && <Alert tone="alert">{err}</Alert>}
          {note && <Alert tone="ok">{note}</Alert>}
          {canConfigure && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!liveH || !liveH.ok || saving}
                onClick={save}
              >
                <Save size={14} strokeWidth={1.75} aria-hidden /> {saving ? "Salvando…" : "Salvar calibração"}
              </Button>
              {edits.length < 4 && (
                <span className="text-[12px] text-text-muted">
                  Faltam {4 - edits.length} ponto(s) para o mínimo.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
