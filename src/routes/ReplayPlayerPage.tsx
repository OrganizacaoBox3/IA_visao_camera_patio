// Bancada de simulação (docs/cientifica/simulador.md §5–6) — player de replay.
// Abre os 8 cenários SINTÉTICOS (replay-fusion.ts) E gravação REAL (.jsonl do server/bt/,
// lida NO CLIENTE — nenhum frame/arquivo sobe pro servidor). Não simula, não associa: só projeta
// o que `derivePlayerFrame`/`playback-transport` (fusion/player/) já calculam. Com gravação real
// carregada, o painel de ANOTAÇÃO (§6) consome o núcleo puro de annotation.ts: selecionar track →
// atribuir tag (MAC) ou "sem tag" → exportar SessionTruth (download local manual, mesmo padrão
// LGPD do cine-loop); importar retoma uma anotação salva.
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { PageHeader, Button, Select, Slider, Input, Tooltip, ScrollArea } from "../ui";
import { FUSION_SCENARIOS } from "../fusion/replay-fusion";
import { simulateFusionScenario } from "../fusion/sim";
import type { SimFusionScenario } from "../fusion/sim";
import { parseFusionSession } from "../fusion/session-loader";
import type { LoadedFusionSession, SessionTruth } from "../fusion/session-loader";
import { derivePlayerFrame } from "../fusion/player/derive-player-frame";
import type { PlayerFrame } from "../fusion/player/derive-player-frame";
import {
  advance,
  initialPlaybackState,
  pause,
  play,
  scrubTo,
  setSpeed,
  stepBy,
} from "../fusion/player/playback-transport";
import type { PlaybackState } from "../fusion/player/playback-transport";
import {
  annotationSummary,
  assignTag,
  clearAssignment,
  exportSessionTruth,
  importSessionTruth,
  initialAnnotationState,
} from "../fusion/player/annotation";
import type { AnnotationState } from "../fusion/player/annotation";
import {
  SYNTH_WORLD_DOMAIN,
  collectTrackIds,
  parseSessionTruthJson,
  sessionWorldDomain,
} from "../fusion/player/session-view";
import type { WorldDomain } from "../fusion/player/session-view";

// Mesma cadência de sim.ts/session-loader.ts (TICK_MS/DEFAULT_TICK_MS — não exportada de lá, mas é
// contrato já compartilhado por toda a fusão indoor).
const TICK_MS = 500;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

// Gravação REAL carregada (o LoadedFusionSession é um SimFusionScenario válido — os canvases não
// mudam) + o nome do arquivo, só pra UI/nome do export.
type LoadedSession = { fileName: string; data: LoadedFusionSession };

function worldToCanvas(x: number, y: number, d: WorldDomain, w: number, h: number): [number, number] {
  return [((x - d.minX) / (d.maxX - d.minX)) * w, h - ((y - d.minY) / (d.maxY - d.minY)) * h];
}

function clearCanvas(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, w, h);
}

function drawPlanta(
  canvas: HTMLCanvasElement | null,
  frame: PlayerFrame | null,
  domain: WorldDomain,
): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  clearCanvas(ctx, w, h);
  ctx.strokeStyle = "#233";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  if (!frame) return;

  if (frame.stationWorld) {
    const [x, y] = worldToCanvas(frame.stationWorld.x, frame.stationWorld.y, domain, w, h);
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#bae6fd";
    ctx.font = "10px monospace";
    ctx.fillText("estação", x + 8, y + 3);
  }

  ctx.fillStyle = "#facc15";
  for (const a of frame.anchorsWorld) {
    const [x, y] = worldToCanvas(a.world.x, a.world.y, domain, w, h);
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.font = "10px monospace";
  for (const t of frame.planta) {
    if (!t.worldPos) continue;
    const [x, y] = worldToCanvas(t.worldPos.x, t.worldPos.y, domain, w, h);
    // TRÊS estados da verdade (annotation.ts): mac = com tag; null = "sem tag" EXPLÍCITO (decisão
    // do anotador — precisa parecer diferente de não-anotado, senão ele não vê que a anotação
    // pegou); chave ausente = não anotado.
    const annotated = t.id in frame.truthTagByTrack;
    const truth = frame.truthTagByTrack[t.id];
    ctx.fillStyle = truth ? "#4ade80" : annotated ? "#f59e0b" : "#94a3b8"; // verde | âmbar | cinza
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(truth ? `${t.id} · ${truth}` : annotated ? `${t.id} · sem tag` : `${t.id}`, x + 8, y - 8);
  }
}

function drawCamera(canvas: HTMLCanvasElement | null, frame: PlayerFrame | null): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  clearCanvas(ctx, w, h);
  if (!frame) return;

  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.5;
  ctx.font = "10px monospace";
  for (const t of frame.camera) {
    const [x, y, bw, bh] = t.bbox;
    const px = x * w;
    const py = y * h;
    ctx.strokeRect(px, py, bw * w, bh * h);
    // Mesmos TRÊS estados da planta: com tag (verde), "sem tag" explícito (âmbar), não anotado.
    const annotated = t.id in frame.truthTagByTrack;
    const truth = frame.truthTagByTrack[t.id];
    ctx.fillStyle = truth ? "#4ade80" : annotated ? "#f59e0b" : "#bae6fd";
    ctx.fillText(
      truth ? `${t.id} · ${truth}` : annotated ? `${t.id} · sem tag` : `${t.id}`,
      px + 2,
      Math.max(10, py - 4),
    );
  }
}

/** Download local manual de um JSON (Blob + a.download) — mesmo padrão LGPD do cine-loop. */
function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReplayPlayerPage() {
  const [scenarioName, setScenarioName] = useState(FUSION_SCENARIOS[0].name);
  const [session, setSession] = useState<LoadedSession | null>(null);
  const [annotation, setAnnotation] = useState<AnnotationState>(initialAnnotationState);
  const [notice, setNotice] = useState<string | null>(null); // erros de arquivo (abrir/importar)

  const synthetic: SimFusionScenario = useMemo(() => {
    const def = FUSION_SCENARIOS.find((s) => s.name === scenarioName) ?? FUSION_SCENARIOS[0];
    return simulateFusionScenario(def.opts, def.seed);
  }, [scenarioName]);
  const scenario: SimFusionScenario = session ? session.data : synthetic;
  const totalTicks = scenario.ticks.length;

  // Sintético: domínio fixo 8×6 m (FLOOR_PAIRS de sim.ts). Real: bounding box das posições-mundo
  // projetadas dos primeiros N ticks COM TRACKS (session-view.ts), com fallback pro 8×6 sem H.
  const domain: WorldDomain = useMemo(
    () =>
      session
        ? sessionWorldDomain(session.data.ticks, session.data.H, session.data.stationPx)
        : SYNTH_WORLD_DOMAIN,
    [session],
  );

  const trackIds = useMemo(
    () => (session ? collectTrackIds(session.data.ticks) : []),
    [session],
  );
  const summary = annotationSummary(annotation);

  const [playback, setPlayback] = useState<PlaybackState>(initialPlaybackState);

  const plantaRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<HTMLCanvasElement | null>(null);
  const openFileRef = useRef<HTMLInputElement | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const rafRef = useRef(0);
  const lastRafTsRef = useRef<number | null>(null);

  // Relógio real (rAF) → avança o playback proporcionalmente à velocidade escolhida. O player NÃO
  // recomputa nada do cenário aqui — só decide qual tick mostrar (playback-transport.ts, puro).
  useEffect(() => {
    lastRafTsRef.current = null;
    const loop = (t: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const last = lastRafTsRef.current;
      lastRafTsRef.current = t;
      if (last === null) return;
      setPlayback((s) => advance(s, t - last, TICK_MS, totalTicks));
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [totalTicks]);

  useEffect(() => {
    const tick = scenario.ticks[playback.currentIdx];
    let frame = tick
      ? derivePlayerFrame(tick, scenario.H, scenario.stationPx, scenario.anchors)
      : null;
    // Gravação real não tem verdade nos ticks (truth vazia no parse) — a anotação EM PROGRESSO
    // vira a "verdade" desenhada, então atribuir tag pinta o track na hora (feedback do anotador).
    if (frame && session) frame = { ...frame, truthTagByTrack: exportSessionTruth(annotation) };
    drawPlanta(plantaRef.current, frame, domain);
    drawCamera(cameraRef.current, frame);
  }, [scenario, playback.currentIdx, session, annotation, domain]);

  const selectScenario = (name: string) => {
    setScenarioName(name);
    setSession(null); // escolher um cenário sintético fecha a gravação real
    setAnnotation(initialAnnotationState());
    setPlayback(initialPlaybackState());
    setNotice(null);
  };

  const onOpenSession = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite reabrir o mesmo arquivo
    if (!file) return;
    try {
      // Leitura 100% NO CLIENTE (File.text) — o .jsonl nunca sobe pro servidor.
      const text = await file.text();
      const data = parseFusionSession(text.split(/\r?\n/), {}); // replay visual não precisa de verdade
      setSession({ fileName: file.name, data });
      setAnnotation(initialAnnotationState());
      setPlayback(initialPlaybackState());
      setNotice(null);
    } catch {
      setNotice(`Falha ao ler o arquivo "${file.name}".`);
    }
  };

  const onImportTruth = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const truth = parseSessionTruthJson(await file.text());
      if (truth === null) {
        setNotice(`"${file.name}" não é um SessionTruth válido (JSON objeto trackId → MAC | null).`);
        return;
      }
      // annotation.ts fica puro/agnóstico; a PÁGINA (que conhece a gravação carregada) filtra
      // entradas de tracks que não existem nela — senão inflam o resumo e re-exportam invisíveis.
      const known = new Set(trackIds);
      const filtered: SessionTruth = {};
      let dropped = 0;
      for (const [key, mac] of Object.entries(truth)) {
        const id = Number(key);
        if (known.has(id)) filtered[id] = mac;
        else dropped++;
      }
      setAnnotation(importSessionTruth(filtered));
      setNotice(
        dropped > 0
          ? `${dropped} entrada(s) de tracks inexistentes nesta gravação foram ignoradas.`
          : null,
      );
    } catch {
      setNotice(`Falha ao ler o arquivo "${file.name}".`);
    }
  };

  const exportTruth = () => {
    const base = session ? session.fileName.replace(/\.jsonl$/i, "") : "sessao";
    downloadJson(`session-truth-${base}.json`, exportSessionTruth(annotation));
  };

  const currentTick = scenario.ticks[playback.currentIdx];
  const diag = session?.data.diag ?? null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Bancada de simulação — player de replay"
        subtitle="docs/cientifica/simulador.md §5–6 — cenários sintéticos e gravação real (.jsonl); anotação de verdade-terreno em gravação real"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={session ? "" : scenarioName}
          onChange={selectScenario}
          options={FUSION_SCENARIOS.map((s) => ({ value: s.name, label: s.name }))}
          placeholder={session ? "(gravação real aberta)" : undefined}
          ariaLabel="Cenário"
        />
        <Button onClick={() => openFileRef.current?.click()}>Abrir gravação (.jsonl)</Button>
        <input
          ref={openFileRef}
          type="file"
          accept=".jsonl"
          className="hidden"
          onChange={onOpenSession}
          aria-label="Arquivo de gravação (.jsonl)"
        />
        {session && (
          <span className="text-[12px] text-text">
            {session.fileName}
            <Button
              size="sm"
              variant="ghost"
              className="ml-1"
              onClick={() => selectScenario(scenarioName)}
              aria-label="Fechar gravação"
            >
              ✕
            </Button>
          </span>
        )}
        <Button onClick={() => setPlayback((s) => (s.playing ? pause(s) : play(s)))}>
          {playback.playing ? "Pausar" : "Tocar"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setPlayback((s) => stepBy(s, -1, totalTicks))}
          aria-label="Passo anterior"
        >
          ◀
        </Button>
        <Button
          variant="ghost"
          onClick={() => setPlayback((s) => stepBy(s, 1, totalTicks))}
          aria-label="Próximo passo"
        >
          ▶
        </Button>
        <Select
          value={String(playback.speed)}
          onChange={(v) => setPlayback((s) => setSpeed(s, Number(v)))}
          options={SPEEDS.map((sp) => ({ value: String(sp), label: `${sp}×` }))}
          ariaLabel="Velocidade"
        />
        <span className="text-[12px] text-text-muted">
          tick {totalTicks ? playback.currentIdx + 1 : 0}/{totalTicks} · ts {currentTick?.ts ?? 0} ms
        </span>
      </div>
      {diag && (
        <span className="text-[12px] text-text-muted">
          diagnóstico do parse: {diag.linesTotal} linha(s) · {diag.linesDropped} descartada(s) ·
          câmeras: {Object.keys(diag.cameras).join(", ") || "nenhuma"} · {totalTicks} tick(s)
          {totalTicks === 0 && " — nada reproduzível neste arquivo"}
          {session?.data.H === null && " · sem calibração (H) — planta sem posições"}
        </span>
      )}
      {notice && <span className="text-[12px] text-critical">{notice}</span>}
      <Slider
        value={playback.currentIdx}
        onChange={(v) => setPlayback((s) => scrubTo(s, v, totalTicks))}
        min={0}
        max={Math.max(0, totalTicks - 1)}
        step={1}
        ariaLabel="Posição na gravação"
      />
      <div className="flex flex-wrap gap-4">
        <div>
          <div className="mb-1 text-[12px] text-text-muted">Planta (top-down)</div>
          <canvas
            ref={plantaRef}
            width={480}
            height={360}
            className="rounded border border-border"
          />
        </div>
        <div>
          <div className="mb-1 text-[12px] text-text-muted">Vista-câmera</div>
          <canvas
            ref={cameraRef}
            width={480}
            height={360}
            className="rounded border border-border"
          />
        </div>
        {session ? (
          <div className="flex w-[420px] flex-col gap-2">
            <div className="text-[12px] text-text-muted">Anotação (verdade-terreno, §6)</div>
            <span className="text-[12px] text-text-muted">
              {summary.withTag} com tag · {summary.withoutTag} sem tag · {summary.total}/
              {trackIds.length} track(s) anotado(s)
            </span>
            {trackIds.length === 0 ? (
              <span className="text-[12px] text-text-muted">
                Nenhum track visto na gravação — nada a anotar.
              </span>
            ) : (
              <ScrollArea className="max-h-[300px] rounded border border-border">
                <div className="flex flex-col gap-1 p-2">
                  {trackIds.map((id) => {
                    const val = annotation.assignments[id]; // string | null | undefined
                    return (
                      <div key={id} className="flex items-center gap-2">
                        <span className="w-10 shrink-0 font-mono text-[12px] text-text">{id}</span>
                        <Input
                          value={val ?? ""}
                          placeholder={val === null ? "sem tag" : "MAC da tag"}
                          onChange={(e) => {
                            const v = e.target.value;
                            // Campo esvaziado = desfaz (ausente ≠ "sem tag" — annotation.ts).
                            setAnnotation((s) =>
                              v.trim() === "" ? clearAssignment(s, id) : assignTag(s, id, v),
                            );
                          }}
                          aria-label={`MAC da tag do track ${id}`}
                        />
                        <Button
                          size="sm"
                          active={val === null}
                          onClick={() => setAnnotation((s) => assignTag(s, id, null))}
                        >
                          sem tag
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={val === undefined}
                          onClick={() => setAnnotation((s) => clearAssignment(s, id))}
                        >
                          limpar
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={exportTruth}>
                Exportar SessionTruth
              </Button>
              <Button onClick={() => importFileRef.current?.click()}>Importar</Button>
              <input
                ref={importFileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={onImportTruth}
                aria-label="Arquivo de SessionTruth (.json)"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-text-muted">Anotação</div>
            <Tooltip content="A verdade-terreno sintética já nasce pronta no cenário (truthTagByTrack) — o modo anotação só faz sentido com uma gravação real aberta.">
              <span className="inline-flex" tabIndex={0}>
                <Button disabled>Modo anotação</Button>
              </span>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
