// Bancada de simulação (docs/cientifica/simulador.md) — Fase 0, Trilha P: player de replay.
// V1 SÓ SINTÉTICO (os 8 cenários pinados de replay-fusion.ts) — abrir gravação REAL fica para
// quando a Fase 1 (World Spec) estabilizar o contrato de cabeçalho de mundo. Não simula, não
// associa: só projeta o que `derivePlayerFrame`/`playback-transport` (fusion/player/) já calculam
// — mesma disciplina do resto do domínio (o que a tela mostra É o que o harness mediu).
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, Button, Select, Slider } from "../ui";
import { FUSION_SCENARIOS } from "../fusion/replay-fusion";
import { simulateFusionScenario } from "../fusion/sim";
import type { SimFusionScenario } from "../fusion/sim";
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

// Mesma cadência de sim.ts/session-loader.ts (TICK_MS/DEFAULT_TICK_MS — não exportada de lá, mas é
// contrato já compartilhado por toda a fusão indoor).
const TICK_MS = 500;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
// Domínio fixo do simulador (FLOOR_PAIRS de sim.ts: chão 8×6 m) — v1 só sintético, então o mundo é
// sempre este; gravação real (extensão futura) precisará de um domínio por sessão.
const WORLD_W_M = 8;
const WORLD_H_M = 6;

function worldToCanvas(x: number, y: number, w: number, h: number): [number, number] {
  return [(x / WORLD_W_M) * w, h - (y / WORLD_H_M) * h];
}

function clearCanvas(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, w, h);
}

function drawPlanta(canvas: HTMLCanvasElement | null, frame: PlayerFrame | null): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  clearCanvas(ctx, w, h);
  ctx.strokeStyle = "#233";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  if (!frame) return;

  if (frame.stationWorld) {
    const [x, y] = worldToCanvas(frame.stationWorld.x, frame.stationWorld.y, w, h);
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
    const [x, y] = worldToCanvas(a.world.x, a.world.y, w, h);
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
    const [x, y] = worldToCanvas(t.worldPos.x, t.worldPos.y, w, h);
    const truth = frame.truthTagByTrack[t.id];
    ctx.fillStyle = truth ? "#4ade80" : "#94a3b8"; // verde = tem tag-verdade; cinza = pessoa sem tag
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(truth ? `${t.id} · ${truth}` : `${t.id}`, x + 8, y - 8);
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
    const truth = frame.truthTagByTrack[t.id];
    ctx.fillStyle = "#bae6fd";
    ctx.fillText(truth ? `${t.id} · ${truth}` : `${t.id}`, px + 2, Math.max(10, py - 4));
  }
}

export function ReplayPlayerPage() {
  const [scenarioName, setScenarioName] = useState(FUSION_SCENARIOS[0].name);
  const scenario: SimFusionScenario = useMemo(() => {
    const def = FUSION_SCENARIOS.find((s) => s.name === scenarioName) ?? FUSION_SCENARIOS[0];
    return simulateFusionScenario(def.opts, def.seed);
  }, [scenarioName]);
  const totalTicks = scenario.ticks.length;

  const [playback, setPlayback] = useState<PlaybackState>(initialPlaybackState);
  useEffect(() => setPlayback(initialPlaybackState()), [scenarioName]);

  const plantaRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<HTMLCanvasElement | null>(null);
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
    const frame = tick
      ? derivePlayerFrame(tick, scenario.H, scenario.stationPx, scenario.anchors)
      : null;
    drawPlanta(plantaRef.current, frame);
    drawCamera(cameraRef.current, frame);
  }, [scenario, playback.currentIdx]);

  const currentTick = scenario.ticks[playback.currentIdx];

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Bancada de simulação — player de replay"
        subtitle="Fase 0 (Trilha P) de docs/cientifica/simulador.md — v1 só cenários sintéticos; gravação real na próxima fase"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={scenarioName}
          onChange={setScenarioName}
          options={FUSION_SCENARIOS.map((s) => ({ value: s.name, label: s.name }))}
          ariaLabel="Cenário"
        />
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
      </div>
    </div>
  );
}
