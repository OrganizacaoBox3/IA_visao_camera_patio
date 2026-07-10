// Adaptadores da costura (ADR-012): mapeiam as FONTES ATUAIS (heurístico de hoje) para o
// contrato estável `LocatedEntity`. Funções PURAS — sem React, sem I/O — para serem testáveis
// e reusáveis por qualquer consumidor. Quando o motor científico existir, ele produz
// `LocatedEntity[]` por outro caminho; a UI não muda.

import type { TagLocation, BtReading } from "../api";
import type { LocatedEntity, LatLon } from "./entity";

const isFiniteLatLon = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon);

/**
 * Funde a ÚLTIMA localização por tag (`TagLocation[]`, ex.: GET /api/bt/locations) com as
 * leituras VISÍVEIS AGORA (`BtReading[]`, ex.: GET /api/bt/readings), por MAC, no formato da
 * costura. Mesma lógica de merge da TagsMapPage:
 *   • posição vem do bt-locations (última conhecida);
 *   • `live` = a tag aparece nas readings deste instante;
 *   • `label` = rótulo cadastrado (?? MAC), com a rotulagem da reading tendo prioridade quando presente;
 *   • `source` = "gps" (a posição vem do GPS do celular que viu a tag).
 *
 * @param rows     últimas localizações por tag
 * @param readings tags visíveis neste instante
 * @param now      epoch-ms "agora" (injetado → determinístico/testável)
 */
export function fromTagLocations(
  rows: TagLocation[],
  readings: BtReading[],
  now: number,
): LocatedEntity[] {
  const byId = new Map<string, LocatedEntity>();

  for (const t of rows) {
    const position: LatLon | null = isFiniteLatLon(t.lat, t.lon) ? { lat: t.lat, lon: t.lon } : null;
    byId.set(t.mac, {
      id: t.mac,
      label: t.rotulo ?? t.mac,
      position,
      accuracyM: t.acc ?? null,
      seenAt: t.ts,
      live: false,
      source: "gps",
    });
  }

  for (const r of readings) {
    const id = String(r.mac).toUpperCase();
    const ex = byId.get(id);
    if (ex) {
      // Visível agora: promove a live e atualiza a observação para o instante atual.
      ex.live = true;
      ex.seenAt = now;
      if (r.rotulo) ex.label = r.rotulo;
    } else {
      // Vista agora mas sem localização conhecida ainda (ex.: nunca teve GPS).
      byId.set(id, {
        id,
        label: r.rotulo ?? id,
        position: null,
        accuracyM: null,
        seenAt: now,
        live: true,
        source: "gps",
      });
    }
  }

  return [...byId.values()];
}
