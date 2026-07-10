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
  pixelToWorld,
  type Correspondence,
  type Matrix3,
  type Vec2,
} from "../vision/homography";
import { getCalibration, saveCalibration, ApiError, type CameraCalibration } from "../api";
import { useStationHealth } from "../fusion/useStationHealth";
import { StationHealthChip } from "../fusion/StationHealthChip";
import { useBleReadings } from "./useBleReadings";
import { TagPicker } from "./TagPicker";

type Mode = "calibrar" | "medir";
// dentro de "calibrar": marcar os 4 cantos, associar uma tag ÂNCORA a cada canto, o ponto da
// estação BLE OU a tag fixa de referência
type CalStep = "cantos" | "ancoras" | "estacao" | "referencia";

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
  const [calStep, setCalStep] = useState<CalStep>("cantos"); // o que se marca no palco ao calibrar
  const [corners, setCorners] = useState<Vec2[]>([]); // cantos clicados (px 0..1), até 4, em ordem
  // MAC de uma tag BLE ÂNCORA por canto (index-aligned a `corners`); "" = canto sem âncora. Posição
  // conhecida do vértice → base p/ calibrar distância/triangulação depois (a matemática fica adiada).
  const [cornerMacs, setCornerMacs] = useState<string[]>([]);
  const [anchorCorner, setAnchorCorner] = useState<number>(0); // canto em edição no passo "âncoras"
  const [station, setStation] = useState<Vec2 | null>(null); // ponto do chão da estação BLE (px 0..1), opcional
  // tag FIXA de referência (âncora de saúde): qual MAC + onde ela está no chão (px 0..1). mac/px marcados
  // em passos separados — `mac` pode estar vazio (só px) e vice-versa; só entra no save quando ambos.
  const [refTag, setRefTag] = useState<{ mac: string; px: Vec2 | null } | null>(null);
  const [width, setWidth] = useState<string>("1"); // Largura (lado 1→2), metros — string p/ digitar livre
  const [length, setLength] = useState<string>("1"); // Comprimento (lado 2→3), metros
  const [savedH, setSavedH] = useState<Matrix3 | null>(null);
  const [measurePts, setMeasurePts] = useState<Vec2[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: "corner" | "measure" | "station" | "reftag"; idx: number } | null>(null); // ponto sendo arrastado
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // ponto sob o cursor (feedback de "pegar")
  // Leituras BLE vivas: só nos passos que escolhem uma tag (referência OU âncoras). Efêmero (LGPD).
  const btReadings = useBleReadings(
    mode === "calibrar" && (calStep === "referencia" || calStep === "ancoras"),
  );

  // Carrega a calibração existente. Reconstrói os cantos + L×C quando são 4 pontos (método retângulo);
  // se for de um formato antigo, ainda usa a H p/ MEDIR. Degrada gracioso.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCorners([]);
    setCornerMacs([]);
    setStation(null);
    setRefTag(null);
    setSavedH(null);
    setMeasurePts([]);
    getCalibration(cameraId)
      .then((cal) => {
        if (cancelled || !cal) return;
        setSavedH(cal.H);
        if (cal.station) setStation({ x: cal.station.x, y: cal.station.y });
        if (cal.refTag) setRefTag({ mac: cal.refTag.mac, px: { x: cal.refTag.px.x, y: cal.refTag.px.y } });
        if (cal.points.length === 4) {
          setCorners(cal.points.map((p) => ({ x: p.px.x, y: p.px.y })));
          setCornerMacs(cal.points.map((p) => p.mac ?? "")); // âncora por canto (aditivo; "" = sem)
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

  // Distância real estação ↔ tag de referência (m), pelas projeções no mundo — só com H + ambos os pontos.
  const distMeters = useMemo(() => {
    if (!activeH || !station || !refTag?.px) return undefined;
    const a = pixelToWorld(activeH, station);
    const b = pixelToWorld(activeH, refTag.px);
    if (!a || !b) return undefined;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }, [activeH, station, refTag]);

  // Saúde da estação (heartbeat/drift/RSSI@1m) ancorada na tag fixa — hook de fusão (frente C).
  const stationHealth = useStationHealth({
    refMac: refTag?.mac || undefined,
    distMeters,
    enabled: mode === "calibrar" && calStep === "referencia" && !!refTag?.mac,
  });

  // ── Interação por PONTEIRO: pegar/arrastar um ponto existente OU adicionar um novo. Coords do palco
  // → normalizadas 0..1 (contra o retângulo da imagem). Mouse e toque (pointer events). ──
  const HIT = 0.04; // raio de acerto (fração da imagem) p/ "pegar" um ponto já marcado
  const activePts =
    mode === "medir"
      ? measurePts
      : calStep === "estacao"
        ? station
          ? [station]
          : []
        : calStep === "referencia"
          ? refTag?.px
            ? [refTag.px]
            : []
          : corners;

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
    } else if (calStep === "estacao") {
      if (!canConfigure) return;
      const hit = nearest(station ? [station] : [], px);
      if (hit != null) dragRef.current = { kind: "station", idx: 0 };
      else setStation(px); // clicar no chão fixa/reposiciona a estação; arraste p/ ajustar
    } else if (calStep === "referencia") {
      if (!canConfigure) return;
      const hit = nearest(refTag?.px ? [refTag.px] : [], px);
      if (hit != null) dragRef.current = { kind: "reftag", idx: 0 };
      else setRefTag((r) => ({ mac: r?.mac ?? "", px })); // fixa/reposiciona o ponto do chão; mantém o mac
    } else if (calStep === "ancoras") {
      // Passo âncoras: clicar SELECIONA o canto (não move nem cria) — a tag é escolhida na lista.
      const hit = nearest(corners, px);
      if (hit != null) setAnchorCorner(hit);
    } else {
      if (!canConfigure) return;
      const hit = nearest(corners, px);
      if (hit != null) dragRef.current = { kind: "corner", idx: hit };
      else if (corners.length < 4) {
        setNote(null);
        setCorners((p) => [...p, px]); // até 4; arraste p/ ajustar, "Refazer" limpa
        setCornerMacs((m) => [...m, ""]); // mantém a âncora index-aligned aos cantos
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
      else if (d.kind === "station") setStation(px);
      else if (d.kind === "reftag") setRefTag((r) => (r ? { ...r, px } : { mac: "", px }));
      else setMeasurePts((p) => p.map((c, i) => (i === d.idx ? px : c)));
      return;
    }
    setHoverIdx(nearest(activePts, px)); // feedback: cursor "pega" ao passar sobre um ponto
  }
  function onPointerEnd() {
    dragRef.current = null;
  }

  const undoCorner = () => {
    setCorners((p) => p.slice(0, -1));
    setCornerMacs((m) => m.slice(0, -1)); // âncora acompanha o canto removido
  };
  const resetCorners = () => {
    setCorners([]);
    setCornerMacs([]);
  };
  // Nome legível de um MAC-âncora (rótulo cadastrado, se a tag está visível agora; senão o MAC).
  const macName = (mac: string) => btReadings.find((r) => r.mac === mac)?.rotulo || mac;

  async function save() {
    if (!liveH || !liveH.ok) return;
    setSaving(true);
    setErr(null);
    setNote(null);
    const w = worldCorners(L, C);
    const payload: CameraCalibration = {
      points: corners.map((px, i) => ({
        px,
        world: w[i],
        ...(cornerMacs[i] ? { mac: cornerMacs[i] } : {}), // âncora só vai quando associada
      })),
      H: liveH.H,
      updatedAt: Date.now(),
      ...(station ? { station } : {}), // só vai quando marcado; ausente = fallback no back
      ...(refTag && refTag.mac && refTag.px ? { refTag: { mac: refTag.mac, px: refTag.px } } : {}), // idem
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
            <SegmentedControl<CalStep>
              value={calStep}
              onChange={setCalStep}
              ariaLabel="O que marcar no chão"
              options={[
                { value: "cantos", label: "Cantos" },
                { value: "ancoras", label: "Âncoras" },
                { value: "estacao", label: "Estação BLE" },
                { value: "referencia", label: "Tag de referência" },
              ]}
            />
          )}
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
                {calStep === "estacao"
                  ? station
                    ? "Estação marcada — arraste para ajustar"
                    : "Clique no chão onde fica a estação BLE"
                  : calStep === "referencia"
                    ? refTag?.px
                      ? "Tag de referência marcada — arraste para ajustar"
                      : "Escolha a tag na lista e clique no chão onde ela está fixada"
                    : corners.length < 4
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
          {canConfigure && calStep === "referencia" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-text-muted">Tags visíveis agora:</span>
                <StationHealthChip health={stationHealth} />
              </div>
              <TagPicker
                readings={btReadings}
                selectedMac={refTag?.mac ?? null}
                onPick={(mac) => setRefTag((prev) => ({ mac, px: prev?.px ?? null }))}
              />
            </div>
          )}
          {canConfigure && calStep === "ancoras" && (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-text-muted">
                Associe uma tag BLE ÂNCORA (posição conhecida) a cada canto: selecione o canto, depois
                escolha a tag na lista abaixo. Base para calibrar distância/triangulação depois.
              </p>
              {corners.length < 4 ? (
                <span className="text-[12px] text-text-muted">
                  Marque os 4 cantos primeiro (passo Cantos).
                </span>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] text-text-muted">Canto:</span>
                    {corners.map((_, i) => {
                      const selected = anchorCorner === i;
                      const mac = cornerMacs[i] || "";
                      return (
                        <Button
                          key={`ac${i}`}
                          size="sm"
                          variant={selected ? "primary" : "ghost"}
                          aria-pressed={selected}
                          onClick={() => setAnchorCorner(i)}
                        >
                          {i + 1}
                          {mac ? ` · ${macName(mac)}` : ""}
                        </Button>
                      );
                    })}
                  </div>
                  <span className="text-[12px] text-text-muted">
                    Tag-âncora para o canto {anchorCorner + 1}:
                  </span>
                  <TagPicker
                    readings={btReadings}
                    selectedMac={cornerMacs[anchorCorner] || null}
                    onPick={(mac) => setCornerMacs((m) => m.map((v, i) => (i === anchorCorner ? mac : v)))}
                    leading={
                      cornerMacs[anchorCorner] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setCornerMacs((m) => m.map((v, i) => (i === anchorCorner ? "" : v)))
                          }
                        >
                          Sem âncora
                        </Button>
                      ) : null
                    }
                  />
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
                  r={
                    (calStep === "cantos" && hoverIdx === i) ||
                    (calStep === "ancoras" && anchorCorner === i)
                      ? 8
                      : 6
                  }
                  fill="var(--state-info)"
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
                <text x={`${p.x * 100}%`} y={`${p.y * 100}%`} dx={9} dy={4} fontSize={12} fill="var(--state-info)">
                  {i + 1}
                </text>
                {/* Âncora associada: nome/MAC ao lado do canto (só quando há uma). */}
                {cornerMacs[i] && (
                  <text
                    x={`${p.x * 100}%`}
                    y={`${p.y * 100}%`}
                    dx={9}
                    dy={17}
                    fontSize={10}
                    fill="var(--state-info)"
                    opacity={0.75}
                  >
                    {macName(cornerMacs[i])}
                  </text>
                )}
              </g>
            ))}
          {/* Estação BLE: marcador de "antena/beacon" (anel radiante + ponto), cor distinta dos cantos. */}
          {mode === "calibrar" && station && (
            <g>
              <circle
                cx={`${station.x * 100}%`}
                cy={`${station.y * 100}%`}
                r={calStep === "estacao" && hoverIdx === 0 ? 12 : 10}
                fill="none"
                stroke="var(--state-warn)"
                strokeWidth={1.5}
                opacity={0.6}
              />
              <circle
                cx={`${station.x * 100}%`}
                cy={`${station.y * 100}%`}
                r={calStep === "estacao" && hoverIdx === 0 ? 6 : 5}
                fill="var(--state-warn)"
                stroke="var(--bg)"
                strokeWidth={2}
              />
              <text
                x={`${station.x * 100}%`}
                y={`${station.y * 100}%`}
                dx={13}
                dy={4}
                fontSize={12}
                fill="var(--state-warn)"
              >
                estação
              </text>
            </g>
          )}
          {/* Tag de referência: LOSANGO (distinto dos cantos-círculo e da estação-antena), em --state-info. */}
          {mode === "calibrar" && refTag?.px && (
            <svg x={`${refTag.px.x * 100}%`} y={`${refTag.px.y * 100}%`} width={1} height={1} overflow="visible">
              <rect
                x={-7}
                y={-7}
                width={14}
                height={14}
                transform={`rotate(45) scale(${calStep === "referencia" && hoverIdx === 0 ? 1.2 : 1})`}
                fill="var(--state-info)"
                stroke="var(--bg)"
                strokeWidth={2}
              />
              <text x={13} y={4} fontSize={12} fill="var(--state-info)">
                ref
              </text>
            </svg>
          )}
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
