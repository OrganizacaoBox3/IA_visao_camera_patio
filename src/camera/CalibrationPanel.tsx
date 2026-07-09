// Painel de CALIBRAÇÃO de homografia por câmera (MVP, self-contained). Método de MERCADO (10-calibracao-
// melhoria.md): em vez de digitar X,Y avulso de cada ponto (frágil/impraticável), o operador marca os 4
// CANTOS de um RETÂNGULO real no chão, em ordem, e informa só Largura×Comprimento (metros). A homografia
// (src/vision/homography.ts) sai dos 4 cantos ↔ (0,0),(L,0),(L,C),(0,C). A matemática é a mesma; muda a UX.
//   • Calibrar: 4 cantos + L×C → H salva no hub (api.saveCalibration). Uma GRADE métrica projetada de volta
//     mostra se a calibração "assenta" no chão (conferência visual, como o mercado faz).
//   • Medir: com a câmera calibrada, clica 2 pontos → distância REAL no chão em metros.
//
// DESACOPLADO da casca de câmera (ADR-007): recebe uma imagem estática (`snapshotUrl`) e captura cliques
// sobre um <img>/placeholder próprio. Coords NORMALIZADAS 0..1 (mesmo sistema de zonas/tracks/pé). Só
// geometria/números trafegam; a imagem é local/efêmera (LGPD). Localizamos o PÉ da pessoa (no chão, Z=0) —
// pontos fora do chão exigiriam homografia de altura (evolução futura, se o campo pedir).
import { useEffect, useMemo, useRef, useState } from "react";
import { Grid3x3, Ruler, Save, Undo2, X } from "lucide-react";
import { Button, Badge, Field, Input, SegmentedControl, Alert } from "../ui";
import {
  computeHomography,
  measureDistance,
  worldToPixel,
  type Correspondence,
  type Matrix3,
  type Vec2,
} from "../vision/homography";
import { getCalibration, saveCalibration, ApiError, type CameraCalibration } from "../api";

type Mode = "calibrar" | "medir";

/** Cantos do retângulo em coords de mundo (metros), na ordem de clique: 1→(0,0) 2→(L,0) 3→(L,C) 4→(0,C). */
function worldCorners(L: number, C: number): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: L, y: 0 },
    { x: L, y: C },
    { x: 0, y: C },
  ];
}

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
  const [corners, setCorners] = useState<Vec2[]>([]); // cantos clicados (px 0..1), até 4, em ordem
  const [width, setWidth] = useState<string>("1"); // Largura (lado 1→2), metros — string p/ digitar livre
  const [length, setLength] = useState<string>("1"); // Comprimento (lado 2→3), metros
  const [savedH, setSavedH] = useState<Matrix3 | null>(null);
  const [measurePts, setMeasurePts] = useState<Vec2[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: "corner" | "measure"; idx: number } | null>(null); // ponto sendo arrastado
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // ponto sob o cursor (feedback de "pegar")

  // Carrega a calibração existente. Reconstrói os cantos + L×C quando são 4 pontos (método retângulo);
  // se for de um formato antigo, ainda usa a H p/ MEDIR. Degrada gracioso.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCorners([]);
    setSavedH(null);
    setMeasurePts([]);
    getCalibration(cameraId)
      .then((cal) => {
        if (cancelled || !cal) return;
        setSavedH(cal.H);
        if (cal.points.length === 4) {
          setCorners(cal.points.map((p) => ({ x: p.px.x, y: p.px.y })));
          setWidth(String(cal.points[1].world.x)); // (L,0)
          setLength(String(cal.points[2].world.y)); // (L,C)
        }
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

  const L = parseFloat(width);
  const C = parseFloat(length);
  const dimsOk = Number.isFinite(L) && L > 0 && Number.isFinite(C) && C > 0;

  // H recomputada quando há 4 cantos + dimensões válidas (memo).
  const liveH = useMemo(() => {
    if (corners.length !== 4 || !dimsOk) return null;
    const w = worldCorners(L, C);
    const corr: Correspondence[] = corners.map((px, i) => ({ px, world: w[i] }));
    return computeHomography(corr);
  }, [corners, L, C, dimsOk]);

  // H ativa p/ medição + grade: a recém-editada (se válida) ou a última salva.
  const activeH: Matrix3 | null = liveH && liveH.ok ? liveH.H : savedH;

  const distance =
    activeH && measurePts.length === 2 ? measureDistance(activeH, measurePts[0], measurePts[1]) : null;

  // Grade métrica de conferência: linhas do mundo (0..L × 0..C) a cada `step` m projetadas de volta na
  // imagem (worldToPixel). Se "assenta" no chão, a calibração está boa. Só quando há H válida.
  const grid = useMemo(() => {
    if (!activeH || !dimsOk) return null;
    const step = Math.max(1, Math.ceil(Math.max(L, C) / 12)); // ≤ ~13 linhas por eixo
    const seg: Array<[Vec2, Vec2]> = [];
    const proj = (wx: number, wy: number) => worldToPixel(activeH, { x: wx, y: wy });
    for (let x = 0; x <= L + 1e-6; x += step) {
      const a = proj(x, 0);
      const b = proj(x, C);
      if (a && b) seg.push([a, b]);
    }
    for (let y = 0; y <= C + 1e-6; y += step) {
      const a = proj(0, y);
      const b = proj(L, y);
      if (a && b) seg.push([a, b]);
    }
    return { seg, step };
  }, [activeH, L, C, dimsOk]);

  // ── Interação por PONTEIRO: pegar/arrastar um ponto existente OU adicionar um novo. Coords do palco
  // → normalizadas 0..1 (contra o retângulo da imagem). Mouse e toque (pointer events). ──
  const HIT = 0.04; // raio de acerto (fração da imagem) p/ "pegar" um ponto já marcado
  const activePts = mode === "medir" ? measurePts : corners;

  function pxFrom(e: React.PointerEvent<HTMLDivElement>): Vec2 | null {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }
  function nearest(pts: Vec2[], px: Vec2): number | null {
    let best: number | null = null;
    let bestD = HIT;
    pts.forEach((c, i) => {
      const d = Math.hypot(c.x - px.x, c.y - px.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const px = pxFrom(e);
    if (!px) return;
    if (mode === "medir") {
      const hit = nearest(measurePts, px);
      if (hit != null) dragRef.current = { kind: "measure", idx: hit };
      else setMeasurePts((p) => (p.length >= 2 ? [px] : [...p, px]));
    } else {
      if (!canConfigure) return;
      const hit = nearest(corners, px);
      if (hit != null) dragRef.current = { kind: "corner", idx: hit };
      else {
        setNote(null);
        setCorners((p) => (p.length >= 4 ? p : [...p, px])); // até 4; arraste p/ ajustar, "Refazer" limpa
      }
    }
    if (dragRef.current) e.currentTarget.setPointerCapture(e.pointerId); // captura → arrasto suave fora do palco
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const px = pxFrom(e);
    if (!px) return;
    const d = dragRef.current;
    if (d) {
      if (d.kind === "corner") setCorners((p) => p.map((c, i) => (i === d.idx ? px : c)));
      else setMeasurePts((p) => p.map((c, i) => (i === d.idx ? px : c)));
      return;
    }
    setHoverIdx(nearest(activePts, px)); // feedback: cursor "pega" ao passar sobre um ponto
  }
  function onPointerEnd() {
    dragRef.current = null;
  }

  const undoCorner = () => setCorners((p) => p.slice(0, -1));
  const resetCorners = () => setCorners([]);

  async function save() {
    if (!liveH || !liveH.ok) return;
    setSaving(true);
    setErr(null);
    setNote(null);
    const w = worldCorners(L, C);
    const payload: CameraCalibration = {
      points: corners.map((px, i) => ({ px, world: w[i] })),
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

  const CORNER_HINT = ["1 · próximo-esquerdo", "2 · próximo-direito", "3 · longe-direito", "4 · longe-esquerdo"];

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

      {mode === "calibrar" ? (
        <>
          <p className="text-[12px] text-text-muted">
            {canConfigure
              ? "Escolha um RETÂNGULO no chão (área demarcada, pallet, ladrilhos) e clique os 4 cantos EM ORDEM — arraste um canto para ajustar. Depois informe a Largura (lado 1→2) e o Comprimento (lado 2→3) em metros."
              : "A calibração requer perfil de engenharia. Você pode usar o modo Medir."}
          </p>
          {canConfigure && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Largura 1→2 (m)" className="w-32">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min="0"
                  value={width}
                  onChange={(ev) => setWidth(ev.target.value)}
                />
              </Field>
              <Field label="Comprimento 2→3 (m)" className="w-36">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min="0"
                  value={length}
                  onChange={(ev) => setLength(ev.target.value)}
                />
              </Field>
              <span className="mb-2 text-[12px] text-text-muted">
                {corners.length < 4
                  ? `Clique o canto ${CORNER_HINT[corners.length]}`
                  : "4 cantos marcados"}
              </span>
              {corners.length > 0 && (
                <>
                  <Button size="sm" variant="ghost" className="mb-1" onClick={undoCorner}>
                    <Undo2 size={14} strokeWidth={1.75} aria-hidden /> Desfazer
                  </Button>
                  <Button size="sm" variant="ghost" className="mb-1" onClick={resetCorners}>
                    Refazer
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-[12px] text-text-muted">
          {activeH
            ? "Clique em 2 pontos do chão para medir a distância real entre eles — arraste para ajustar."
            : "Calibre a câmera primeiro (retângulo do chão) para poder medir em metros."}
        </p>
      )}

      {/* Palco: wrapper ENCOLHE até a imagem (cliques mapeiam direto a 0..1, sem letterbox). Imagem capada
          à viewport (max-h) e à largura da página (max-w) p/ não cortar a tela. */}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerLeave={() => {
          onPointerEnd();
          setHoverIdx(null);
        }}
        className="relative mx-auto touch-none select-none overflow-hidden rounded-sm border border-border bg-panel-2"
        style={{
          cursor: hoverIdx != null ? "grab" : "crosshair",
          ...(snapshotUrl
            ? { width: "fit-content", maxWidth: "100%" }
            : { width: "min(100%, 640px)", aspectRatio: "16 / 9" }),
        }}
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
          {/* GRADE de conferência (métrica projetada de volta) — some quando ainda não há H válida. */}
          {mode === "calibrar" &&
            grid?.seg.map(([a, b], i) => (
              <line
                key={`g${i}`}
                x1={`${a.x * 100}%`}
                y1={`${a.y * 100}%`}
                x2={`${b.x * 100}%`}
                y2={`${b.y * 100}%`}
                stroke="var(--state-ok)"
                strokeWidth={1}
                opacity={0.5}
              />
            ))}
          {/* Contorno do retângulo (cantos na ordem) + marcadores numerados. */}
          {mode === "calibrar" && corners.length >= 2 && (
            <polygon
              points={corners.map((p) => `${p.x * 100}%,${p.y * 100}%`).join(" ")}
              fill="none"
              stroke="var(--state-info)"
              strokeWidth={2}
              strokeDasharray={corners.length < 4 ? "4 3" : undefined}
            />
          )}
          {mode === "calibrar" &&
            corners.map((p, i) => (
              <g key={`c${i}`}>
                <circle
                  cx={`${p.x * 100}%`}
                  cy={`${p.y * 100}%`}
                  r={hoverIdx === i ? 8 : 6}
                  fill="var(--state-info)"
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
                <text x={`${p.x * 100}%`} y={`${p.y * 100}%`} dx={9} dy={4} fontSize={12} fill="var(--state-info)">
                  {i + 1}
                </text>
              </g>
            ))}
          {/* Modo medir: linha + pontos. */}
          {mode === "medir" && measurePts.length === 2 && (
            <line
              x1={`${measurePts[0].x * 100}%`}
              y1={`${measurePts[0].y * 100}%`}
              x2={`${measurePts[1].x * 100}%`}
              y2={`${measurePts[1].y * 100}%`}
              stroke="var(--state-warn)"
              strokeWidth={2}
            />
          )}
          {mode === "medir" &&
            measurePts.map((p, i) => (
              <circle
                key={`m${i}`}
                cx={`${p.x * 100}%`}
                cy={`${p.y * 100}%`}
                r={hoverIdx === i ? 8 : 6}
                fill="var(--state-warn)"
                stroke="var(--bg)"
                strokeWidth={2}
              />
            ))}
        </svg>
      </div>

      {/* Grade: legenda do passo (quando visível). */}
      {mode === "calibrar" && grid && (
        <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
          <Grid3x3 size={12} strokeWidth={1.75} aria-hidden /> Grade de conferência: {grid.step} m por linha —
          deve assentar no chão.
        </span>
      )}

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

      {/* Calibração: estado da homografia + salvar. */}
      {mode === "calibrar" && (
        <div className="flex flex-col gap-2">
          {loading && <span className="text-[12px] text-text-muted">Carregando…</span>}
          {liveH && !liveH.ok && <Alert tone="warn">{liveH.error}</Alert>}
          {err && <Alert tone="alert">{err}</Alert>}
          {note && <Alert tone="ok">{note}</Alert>}
          {canConfigure && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" disabled={!liveH || !liveH.ok || saving} onClick={save}>
                <Save size={14} strokeWidth={1.75} aria-hidden /> {saving ? "Salvando…" : "Salvar calibração"}
              </Button>
              {corners.length < 4 && (
                <span className="text-[12px] text-text-muted">
                  Faltam {4 - corners.length} canto(s).
                </span>
              )}
              {corners.length === 4 && !dimsOk && (
                <span className="text-[12px] text-text-muted">Informe Largura e Comprimento (&gt; 0).</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
