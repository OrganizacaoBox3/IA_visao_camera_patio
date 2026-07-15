// Aba "Vista 2D" — a VISTA SUPERIOR (top-down) do chão calibrado num canvas, para rodar o teste SÓ
// COM OS BEACONS BLUETOOTH, sem a câmera. Só-leitura (natureza de observação, como Pessoas/Timeline).
//
// O núcleo de geometria (mundo) vive em fusion/topdown.ts (testado); o desenho em camera/drawTopdown.ts;
// aqui só a FIAÇÃO: carrega a calibração (getCalibration) + as leituras BLE vivas (useBleReadings) + os
// nomes/liveness das estações (useStationNames) e alimenta os dois. O dado BLE é lento (~2 s) → redesenha
// quando a vista muda + no resize (sem rAF). FÍSICA HONESTA (topdown.ts): a tag não vira ponto — anel de
// distância por beacon + o MAIS PRÓXIMO destacado.
import { useEffect, useMemo, useRef, useState } from "react";
import { getCalibration } from "../../api";
import { EmptyState } from "../../ui";
import { useBleReadings } from "../useBleReadings";
import { useStationNames } from "../../fusion/useStationNames";
import {
  deriveTopdownView,
  topdownBounds,
  worldToCanvas,
  type TopdownStation,
} from "../../fusion/topdown";
import { drawTopdown } from "../drawTopdown";
import type { FloorCalibration } from "../../fusion/useFloorTags";

// Janela de "estação viva" — RÉPLICA do STALE_MS de server/bt/bt-readings.js (15 s), o mesmo critério
// da aba Estações / CalibracaoTab. Beacon fora dela é "sem sinal" (going-gray), não mede.
const STATION_STALE_MS = 15_000;
const EMPTY_CAL: FloorCalibration = { H: null, station: null, points: [] };

export function Vista2DTab({ cameraId }: { cameraId: string }) {
  // Calibração da câmera (H + cantos + pontos das estações). Recarrega ao trocar de câmera (a aba
  // remonta ao ser selecionada, então pega a calibração corrente sem precisar de calibrationRev aqui).
  const [cal, setCal] = useState<FloorCalibration>(EMPTY_CAL);
  useEffect(() => {
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        setCal({
          H: c?.H ?? null,
          station: c?.station ?? null,
          points: c?.points ?? [],
          ...(c?.stations ? { stations: c.stations } : {}),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cameraId]);

  const readings = useBleReadings(true); // a aba só monta quando visível → poll só aqui
  const { stations: registered, nameOf } = useStationNames(true);

  // Estações VIVAS = postaram < 15 s (registro). Beacon morto entra no desenho como "sem sinal", mas
  // NÃO mede (topdown.ts filtra).
  const liveIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      registered.filter((s) => s.ativo && now - s.ultimaVezEm < STATION_STALE_MS).map((s) => s.id),
    );
  }, [registered]);

  // Estações p/ o núcleo: multi-antena (calibration.stations) OU o ponto único legado (calibration.station).
  const stations = useMemo<TopdownStation[]>(() => {
    const map = cal.stations;
    if (map && Object.keys(map).length) {
      return Object.entries(map).map(([id, px]) => ({ id, px, label: nameOf(id), live: liveIds.has(id) }));
    }
    if (cal.station) return [{ id: "", px: cal.station, label: "Estação", live: liveIds.size > 0 }];
    return [];
  }, [cal.stations, cal.station, nameOf, liveIds]);

  const corners = useMemo(() => (cal.points ?? []).map((p) => p.px), [cal.points]);
  const readingsIn = useMemo(
    () => readings.map((r) => ({ stationId: r.stationId ?? "", mac: r.mac, rssi: r.rssi, rotulo: r.rotulo })),
    [readings],
  );

  // MVP: sem âncoras no fit → modelo de path-loss default DECLARADO (source:"default"). O NEAREST
  // (maior RSSI) é correto independentemente do modelo; a distância é estimativa grosseira. Ligar as
  // tags-âncora dos cantos ao fit por estação (distância calibrada) é FOLLOW-UP.
  const view = useMemo(
    () => deriveTopdownView({ H: cal.H, corners, stations, readings: readingsIn }),
    [cal.H, corners, stations, readingsIn],
  );

  // Desenho: redesenha quando a vista muda (BLE ~2 s) e no resize do contêiner. Sem rAF (dado lento).
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const tf = worldToCanvas(topdownBounds(view), { w, h }, 24);
      drawTopdown(ctx, view, tf, { w, h });
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [view]);

  const hasCal = !!cal.H && stations.length > 0;
  const beaconLabel = useMemo(
    () => new Map(view.beacons.map((b) => [b.id, b.label] as const)),
    [view.beacons],
  );
  const fmtD = (d: number) => (d < 10 ? d.toFixed(1) : String(Math.round(d)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {!hasCal ? (
        <EmptyState>
          Calibre a câmera primeiro (o retângulo do chão e o ponto de cada estação BLE) para ter a
          vista de topo. Sem calibração não há a geometria do chão para plotar.
        </EmptyState>
      ) : (
        <>
          <div
            ref={wrapRef}
            className="relative min-h-[220px] flex-1 overflow-hidden rounded-sm border border-border bg-panel"
          >
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full"
              aria-label="Vista superior 2D do chão — beacons e tags por proximidade"
            />
          </div>
          {/* O que o dono lê no teste sem câmera: por tag, o beacon MAIS PRÓXIMO + a distância. */}
          <ul className="flex flex-col gap-1 text-sec" aria-label="Tags e o beacon mais próximo">
            {view.tags.length === 0 ? (
              <li className="text-text-muted">Nenhuma tag sendo ouvida por um beacon vivo agora.</li>
            ) : (
              view.tags.map((t) => (
                <li key={t.mac} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-text">{t.label}</span>
                  {t.nearest ? (
                    <span className="text-text-muted">
                      → mais próximo: {beaconLabel.get(t.nearest.beaconId) ?? t.nearest.beaconId} ·
                      d≈{fmtD(t.nearest.distM)} m
                    </span>
                  ) : (
                    <span className="text-text-dim">sem beacon vivo ouvindo</span>
                  )}
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}
