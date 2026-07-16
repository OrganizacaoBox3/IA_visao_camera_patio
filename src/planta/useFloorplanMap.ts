// useFloorplanMap — a FIAÇÃO de dados da Planta BLE: a planta baixa salva (dimensões + posição das
// antenas em metros) + as leituras BLE POR ESTAÇÃO (?all=1) + o registro/nome/liveness das estações
// → a view geométrica de um quadro. A escolha da fonte e o filtro temporal ficam depois, em
// useContinuousFloorplan, para que posição medida/inferida, rejeição e estado não sejam misturados.
// Efêmero/LGPD: só metadados de rádio; persistem planta, antenas e geometria das áreas de trabalho.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getFloorplan,
  saveFloorplan,
  type Floorplan,
  type FloorplanWorkArea,
  type Fingerprint,
  type Vec2,
} from "../api";
import { useBleReadings } from "../camera/useBleReadings";
import { buildFreshLiveVectors } from "./useFingerprints";
import { useStationNames } from "../fusion/useStationNames";
import {
  deriveFloorplanView,
  type FloorplanStation,
  type FloorplanView,
} from "../fusion/floorplan";
import { fitPathLoss, type AnchorObs, type PathLossModel } from "../fusion/floor-plot";

// Janela de "estação viva" — RÉPLICA do STALE_MS do hub (15 s), mesmo critério da aba Estações e do
// topdown. Antena fora dela é "sem sinal": entra no desenho (marcador) mas NÃO mede.
const STATION_STALE_MS = 15_000;
const EMPTY: Floorplan = { widthM: 0, heightM: 0, stations: {}, workAreas: [] };

/** Linha do editor de setup: uma por estação CONHECIDA (registro ∪ planta), com a posição salva. */
export type FloorplanSetupRow = { id: string; label: string; live: boolean; pos: Vec2 | null };

export type UseFloorplanMap = {
  /** View geométrica crua; soluções incompatíveis já chegam rejeitadas, sem clamp para cantos. */
  view: FloorplanView;
  widthM: number;
  heightM: number;
  workAreas: FloorplanWorkArea[];
  /** Registro ∪ planta → as linhas do editor (toda estação conhecida, posicionada ou não). */
  rows: FloorplanSetupRow[];
  /** Tem o mínimo para desenhar um mapa útil: caixa definida + ≥1 antena posicionada. */
  hasSetup: boolean;
  loading: boolean;
  saving: boolean;
  /** Persiste a planta (durável-primeiro no hub). Devolve {ok} ou {ok:false,error} para a UI mostrar. */
  save: (next: Floorplan) => Promise<{ ok: boolean; error?: string }>;
};

export function useFloorplanMap(
  enabled = true,
  fingerprints: readonly Fingerprint[] = [],
): UseFloorplanMap {
  const [config, setConfig] = useState<Floorplan>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Carga da planta (uma vez; recarrega se reabrir). GET nulo/nunca-salvo → vazio (widthM:0).
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    getFloorplan()
      .then((fp) => {
        if (!alive) return;
        setConfig(
          fp && typeof fp.widthM === "number"
            ? { ...EMPTY, ...fp, stations: fp.stations ?? {}, workAreas: fp.workAreas ?? [] }
            : EMPTY,
        );
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const readings = useBleReadings(enabled, true); // ?all=1 → uma linha por (estação, tag)
  const { stations: registered, nameOf } = useStationNames(enabled);

  // Antenas VIVAS = postaram < 15 s no registro. (A morta entra no desenho, mas não mede.)
  const liveIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      registered.filter((s) => s.ativo && now - s.ultimaVezEm < STATION_STALE_MS).map((s) => s.id),
    );
  }, [registered]);

  // Estações POSICIONADAS (as que têm x,y na planta) → entram no núcleo, com liveness e nome.
  const stations = useMemo<FloorplanStation[]>(() => {
    return Object.entries(config.stations ?? {}).map(([id, pos]) => ({
      id,
      label: nameOf(id) || id,
      pos,
      live: liveIds.has(id),
    }));
  }, [config.stations, nameOf, liveIds]);

  const readingsIn = useMemo(() => {
    const labels = new Map(
      readings.map((reading) => [reading.mac.toUpperCase(), reading.rotulo] as const),
    );
    return [...buildFreshLiveVectors(readings)].flatMap(([mac, live]) =>
      Object.entries(live.vec).map(([stationId, rssi]) => ({
        stationId,
        mac,
        rssi,
        rotulo: labels.get(mac) ?? null,
      })),
    );
  }, [readings]);

  // Cada estação recebe seu próprio modelo, ajustado a partir dos pontos conhecidos do survey.
  // Ganhos diferentes dos celulares deixam de ser tratados como se fossem uma única antena ideal.
  const stationModels = useMemo<Record<string, PathLossModel>>(() => {
    const out: Record<string, PathLossModel> = {};
    for (const station of stations) {
      const stationKey = station.id.toUpperCase();
      const anchors: AnchorObs[] = [];
      for (const sample of fingerprints) {
        if (typeof sample.x !== "number" || typeof sample.y !== "number") continue;
        const cell = Object.entries(sample.vec).find(
          ([id]) => id.toUpperCase() === stationKey,
        )?.[1];
        if (!cell || !Number.isFinite(cell.mean)) continue;
        anchors.push({
          mac: sample.id,
          world: { x: sample.x, y: sample.y },
          rssi: cell.mean,
        });
      }
      out[station.id] = fitPathLoss(anchors, station.pos);
    }
    return out;
  }, [fingerprints, stations]);

  const rawView = useMemo(
    () =>
      deriveFloorplanView({
        widthM: config.widthM,
        heightM: config.heightM,
        stations,
        readings: readingsIn,
        stationModels,
      }),
    [config.widthM, config.heightM, stations, readingsIn, stationModels],
  );

  // A suavização antiga por EMA foi removida: ela mascarava a origem e mantinha pontos ruins nos
  // cantos. O filtro cinemático com estado/halo vive em useContinuousFloorplan, após escolher a fonte.
  const view: FloorplanView = rawView;

  // Linhas do editor: TODA estação conhecida (registro), com a posição salva na planta (ou null).
  const rows = useMemo<FloorplanSetupRow[]>(() => {
    const ids = new Set<string>([...registered.map((s) => s.id), ...Object.keys(config.stations ?? {})]);
    return [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        id,
        label: nameOf(id) || id,
        live: liveIds.has(id),
        pos: config.stations?.[id] ?? null,
      }));
  }, [registered, config.stations, nameOf, liveIds]);

  const hasSetup = config.widthM > 0 && config.heightM > 0 && stations.length > 0;

  const save = useCallback(async (next: Floorplan): Promise<{ ok: boolean; error?: string }> => {
    setSaving(true);
    try {
      const saved = await saveFloorplan(next);
      setConfig({
        ...EMPTY,
        ...saved,
        stations: saved.stations ?? {},
        workAreas: saved.workAreas ?? [],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Falha ao salvar a planta." };
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    view,
    widthM: config.widthM,
    heightM: config.heightM,
    workAreas: config.workAreas ?? [],
    rows,
    hasSetup,
    loading,
    saving,
    save,
  };
}
