// useFloorplanMap — a FIAÇÃO de dados da Planta BLE: a planta baixa salva (dimensões + posição das
// antenas em metros) + as leituras BLE POR ESTAÇÃO (?all=1) + o registro/nome/liveness das estações
// → a view de mundo (deriveFloorplanView) com a posição de cada tag SUAVIZADA no tempo (EMA).
//
// Por que o hook e não o núcleo carregam a suavização: o núcleo (fusion/floorplan.ts) é 1 quadro puro
// e honesto; o EMA é estado que atravessa polls (a tag oscila entre leituras — RSSI ruidoso), então
// mora aqui. Efêmero/LGPD: só metadados de rádio, nada persiste além da planta (dimensões/antenas).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFloorplan, saveFloorplan, type Floorplan, type Vec2 } from "../api";
import { useBleReadings } from "../camera/useBleReadings";
import { useStationNames } from "../fusion/useStationNames";
import {
  deriveFloorplanView,
  type FloorplanStation,
  type FloorplanView,
} from "../fusion/floorplan";

// Janela de "estação viva" — RÉPLICA do STALE_MS do hub (15 s), mesmo critério da aba Estações e do
// topdown. Antena fora dela é "sem sinal": entra no desenho (marcador) mas NÃO mede.
const STATION_STALE_MS = 15_000;
// Peso do quadro NOVO no EMA da posição. 0.35 = suaviza o tremor do RSSI sem ficar preguiçoso demais
// (a tag anda a passo humano; o poll é ~2 s). Puramente visual — não muda a honestidade do núcleo.
const EMA_ALPHA = 0.35;
const EMPTY: Floorplan = { widthM: 0, heightM: 0, stations: {} };

/** Linha do editor de setup: uma por estação CONHECIDA (registro ∪ planta), com a posição salva. */
export type FloorplanSetupRow = { id: string; label: string; live: boolean; pos: Vec2 | null };

export type UseFloorplanMap = {
  /** View pronta para o canvas — tags já com a posição suavizada (EMA). */
  view: FloorplanView;
  widthM: number;
  heightM: number;
  /** Registro ∪ planta → as linhas do editor (toda estação conhecida, posicionada ou não). */
  rows: FloorplanSetupRow[];
  /** Tem o mínimo para desenhar um mapa útil: caixa definida + ≥1 antena posicionada. */
  hasSetup: boolean;
  loading: boolean;
  saving: boolean;
  /** Persiste a planta (durável-primeiro no hub). Devolve {ok} ou {ok:false,error} para a UI mostrar. */
  save: (next: Floorplan) => Promise<{ ok: boolean; error?: string }>;
};

export function useFloorplanMap(enabled = true): UseFloorplanMap {
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
        setConfig(fp && typeof fp.widthM === "number" ? { ...EMPTY, ...fp, stations: fp.stations ?? {} } : EMPTY);
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

  const readingsIn = useMemo(
    () => readings.map((r) => ({ stationId: r.stationId ?? "", mac: r.mac, rssi: r.rssi, rotulo: r.rotulo })),
    [readings],
  );

  const rawView = useMemo(
    () =>
      deriveFloorplanView({
        widthM: config.widthM,
        heightM: config.heightM,
        stations,
        readings: readingsIn,
      }),
    [config.widthM, config.heightM, stations, readingsIn],
  );

  // ── EMA da posição por tag (só visual). Guarda a última pos suavizada por MAC; grampeia a nova ao
  // caminho entre a anterior e a estimativa crua. Tags que somem são podadas (não arrastam fantasma). ──
  const emaRef = useRef<Map<string, Vec2>>(new Map());
  const view = useMemo<FloorplanView>(() => {
    const prev = emaRef.current;
    const next = new Map<string, Vec2>();
    const tags = rawView.tags.map((t) => {
      if (!t.pos) return t; // fix "none" (sem X,Y) não suaviza nada
      const p0 = prev.get(t.mac);
      const smoothed: Vec2 = p0
        ? { x: p0.x + EMA_ALPHA * (t.pos.x - p0.x), y: p0.y + EMA_ALPHA * (t.pos.y - p0.y) }
        : t.pos;
      next.set(t.mac, smoothed);
      return { ...t, pos: smoothed };
    });
    emaRef.current = next;
    return { ...rawView, tags };
  }, [rawView]);

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
      setConfig({ ...EMPTY, ...saved, stations: saved.stations ?? {} });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Falha ao salvar a planta." };
    } finally {
      setSaving(false);
    }
  }, []);

  return { view, widthM: config.widthM, heightM: config.heightM, rows, hasSetup, loading, saving, save };
}
