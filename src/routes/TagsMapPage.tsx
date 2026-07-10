import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapPin, Radar, Search, Wifi, X } from "lucide-react";
import { PageHeader, Badge, EmptyState, ScrollArea, Input } from "../ui";
import { getBtLocations, getBtReadings, type TagLocation, type BtReading } from "../api";
import { fromTagLocations } from "../localizacao/adapters";
import type { LocatedEntity } from "../localizacao/entity";

// Busca acento-insensível (rótulo "João" casa "joao"; MAC casa por substring).
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Mapa = CENTRAL DO COLETOR. Consome a COSTURA do ADR-012 (src/localizacao): as duas fontes brutas
// (GET /api/bt/locations = última posição por tag; GET /api/bt/readings = visíveis agora) são fundidas
// pelo adapter `fromTagLocations` no contrato estável `LocatedEntity[]`. Esta página NÃO conhece o
// heurístico nem o motor futuro — só o contrato. O RSSI (detalhe de sensor, fora do contrato) fica num
// lookup à parte só para exibição. Pino VIVO (verde, halo) = live; desbota (going-gray) = última posição.
const POLL_MS = 4000;
// Centro só usado quando NÃO há nenhum pin (com pins, o mapa dá fitBounds). Sobral/CE (CD Grendene).
const DEFAULT_CENTER: L.LatLngExpression = [-3.688, -40.348];
const DEFAULT_ZOOM = 13;

// Going-gray por FRESCOR (só p/ tags que NÃO estão visíveis agora): recém-vista = azul; velha = cinza.
const FRESH_MS = 2 * 60_000;
const C_LIVE = "var(--state-ok)"; // VISÍVEL AGORA (em alcance) — o sinal mais forte
const C_RECENT = "var(--state-info)"; // vista há pouco
const C_STALE = "var(--state-neutral)"; // parada há muito

function colorFor(e: LocatedEntity, now: number): string {
  if (e.live) return C_LIVE;
  return now - e.seenAt < FRESH_MS ? C_RECENT : C_STALE;
}

// "visto há X" — humano e curto.
function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "visto agora";
  const min = Math.round(s / 60);
  if (min < 60) return `visto há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `visto há ${h} h`;
  return `visto há ${Math.round(h / 24)} d`;
}

// HTML do pino (divIcon, CSS puro — sem imagem externa/CSP). `live` ganha um halo colorido.
function pinHtml(color: string, live: boolean): string {
  const halo = live ? `,0 0 0 5px ${color}` : "";
  return `<span style="display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:2px solid var(--panel);box-shadow:0 0 0 1.5px ${color},0 1px 3px rgba(0,0,0,.5)${halo};"></span>`;
}
function makeIcon(color: string, live: boolean): L.DivIcon {
  return L.divIcon({
    html: pinHtml(color, live),
    className: "tag-pin",
    iconSize: live ? [22, 22] : [16, 16],
    iconAnchor: live ? [11, 11] : [8, 8],
    popupAnchor: [0, -8],
  });
}
function statusLabel(e: LocatedEntity, now: number, rssi: number | null): string {
  if (e.live) return `visível agora${rssi != null ? ` · ${rssi} dBm` : ""}`;
  if (e.position) {
    const acc = e.accuracyM != null ? ` · ±${Math.round(e.accuracyM)} m` : "";
    return `${agoLabel(e.seenAt, now)}${acc}`;
  }
  return "sem localização ainda";
}
function popupHtml(e: LocatedEntity, now: number, rssi: number | null): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<strong>${esc(e.label)}</strong><br/><span style="opacity:.75">${esc(statusLabel(e, now, rssi))}</span>`;
}

export function TagsMapPage() {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; key: string }>>(new Map());
  const didFitRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [tags, setTags] = useState<TagLocation[]>([]);
  const [readings, setReadings] = useState<BtReading[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const lastAutoFocus = useRef<string | null>(null);

  // ── Cria o mapa uma vez (cleanup no unmount) ──────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const markers = markersRef.current; // captura estável p/ o cleanup (o Map nunca é reatribuído)
    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true });
    // Satélite (limpo, sem ruído de ruas): Esri World Imagery — grátis, sem chave de API.
    // Esri só tem imagem até ~z17 nesta região (interior/CE) — z18+ retorna o placeholder "Map data not
    // yet available". maxNativeZoom:17 amplia o tile z17 no zoom alto em vez de pedir os tiles de z18+.
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 19, maxNativeZoom: 17 },
    ).addTo(map);
    mapRef.current = map;
    const t = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markers.clear();
      didFitRef.current = false;
    };
  }, []);

  // ── Poll a cada ~4s: localizações + leituras ao vivo (allSettled → uma fonte falhar não derruba a outra). ──
  useEffect(() => {
    let dead = false;
    const tick = () => {
      Promise.allSettled([getBtLocations(), getBtReadings()]).then(([locR, readR]) => {
        if (dead) return;
        if (locR.status === "fulfilled") {
          setTags(Array.isArray(locR.value) ? locR.value : []);
          setError(false);
        } else setError(true);
        if (readR.status === "fulfilled") setReadings(Array.isArray(readR.value) ? readR.value : []);
        setNow(Date.now());
        setLoaded(true);
      });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, []);

  // ── A COSTURA: as fontes brutas viram LocatedEntity[] pelo adapter. A página consome só isto. ──
  const entities = useMemo<LocatedEntity[]>(() => fromTagLocations(tags, readings, now), [tags, readings, now]);
  // RSSI por MAC — detalhe de sensor FORA do contrato; só p/ exibir na lista/popup.
  const rssiByMac = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of readings) m.set(String(r.mac).toUpperCase(), r.rssi);
    return m;
  }, [readings]);

  const visibleCount = useMemo(() => entities.filter((e) => e.live).length, [entities]);

  // ── Sincroniza marcadores (só entidades com posição). live = visível agora → pino verde com halo. ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const store = markersRef.current;
    const seen = new Set<string>();

    for (const e of entities) {
      if (!e.position) continue;
      seen.add(e.id);
      const color = colorFor(e, now);
      const key = `${e.live ? "live" : "last"}:${color}`;
      const pos: L.LatLngExpression = [e.position.lat, e.position.lon];
      const rssi = rssiByMac.get(e.id) ?? null;
      const existing = store.get(e.id);
      if (existing) {
        existing.marker.setLatLng(pos);
        if (existing.key !== key) {
          existing.marker.setIcon(makeIcon(color, e.live));
          existing.key = key;
        }
        existing.marker.setPopupContent(popupHtml(e, now, rssi));
        existing.marker.setTooltipContent(e.label);
      } else {
        const marker = L.marker(pos, { icon: makeIcon(color, e.live) })
          .addTo(map)
          .bindTooltip(e.label, { direction: "top", offset: [0, -8] })
          .bindPopup(popupHtml(e, now, rssi));
        store.set(e.id, { marker, key });
      }
    }

    for (const [id, entry] of store) {
      if (!seen.has(id)) {
        entry.marker.remove();
        store.delete(id);
      }
    }

    if (!didFitRef.current && store.size > 0) {
      const bounds = L.latLngBounds([...store.values()].map((en) => en.marker.getLatLng()));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
      didFitRef.current = true;
    }
  }, [entities, now, rssiByMac]);

  // Lista lateral: VISÍVEIS agora primeiro (por RSSI), depois localizadas por recência.
  const sorted = useMemo(
    () =>
      [...entities].sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.live && b.live) return (rssiByMac.get(b.id) ?? -999) - (rssiByMac.get(a.id) ?? -999);
        return b.seenAt - a.seenAt;
      }),
    [entities, rssiByMac],
  );

  const focus = useCallback((e: LocatedEntity) => {
    const map = mapRef.current;
    if (!map || !e.position) return;
    map.setView([e.position.lat, e.position.lon], Math.max(map.getZoom(), 17), { animate: true });
    markersRef.current.get(e.id)?.marker.openPopup();
  }, []);

  // ── Busca: casa por rótulo OU MAC (acento/caixa-insensível). matchIds=null → sem busca. ──
  const q = norm(search.trim());
  const matchIds = useMemo(() => {
    if (!q) return null;
    const s = new Set<string>();
    for (const e of sorted) if (norm(e.label).includes(q) || norm(e.id).includes(q)) s.add(e.id);
    return s;
  }, [q, sorted]);
  const visibleRows = matchIds ? sorted.filter((e) => matchIds.has(e.id)) : sorted;

  // Destaque no mapa: casa = opaco; não casa = esmaecido.
  useEffect(() => {
    for (const [id, entry] of markersRef.current) {
      entry.marker.setOpacity(!matchIds || matchIds.has(id) ? 1 : 0.25);
    }
  }, [matchIds, entities]);

  // Match único (forte) → centraliza e abre o popup uma vez.
  useEffect(() => {
    if (matchIds && matchIds.size === 1) {
      const [id] = matchIds;
      if (lastAutoFocus.current !== id) {
        const e = sorted.find((x) => x.id === id);
        if (e?.position) {
          focus(e);
          lastAutoFocus.current = id;
        }
      }
    } else {
      lastAutoFocus.current = null;
    }
  }, [matchIds, sorted, focus]);

  return (
    <div className="page">
      <PageHeader
        title="Mapa de tags"
        subtitle="Central do coletor — verde = visível agora (em alcance); desbotado = última localização conhecida."
      >
        <div className="relative">
          <span
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden
          >
            <Search size={14} strokeWidth={1.75} />
          </span>
          <Input
            type="text"
            role="searchbox"
            aria-label="Buscar tag por nome ou MAC"
            placeholder="Buscar tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && visibleRows[0]) {
                e.preventDefault();
                focus(visibleRows[0]);
              } else if (e.key === "Escape" && search) {
                e.preventDefault();
                setSearch("");
              }
            }}
            className="min-w-[160px] pl-7 pr-7"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Limpar busca"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-text-muted hover:text-text"
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        <Badge tone={visibleCount > 0 ? "ok" : undefined}>
          <Wifi size={12} strokeWidth={1.75} aria-hidden />
          {visibleCount} visíve{visibleCount === 1 ? "l" : "is"}
        </Badge>
        <Badge tone={error ? "warn" : undefined}>
          <Radar size={12} strokeWidth={1.75} aria-hidden />
          {error ? "sem conexão" : `${entities.length} tag${entities.length === 1 ? "" : "s"}`}
        </Badge>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="min-h-0 flex-1" style={{ height: "100%" }} />

        <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-panel-2 md:flex">
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Tags {matchIds ? `· ${visibleRows.length}/${entities.length}` : ""}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {!loaded ? (
              <div className="p-3 text-[13px] text-text-muted">Carregando…</div>
            ) : entities.length === 0 ? (
              <div className="p-3">
                <EmptyState>
                  Nenhuma tag ainda. Assim que o coletor vir uma tag, ela aparece aqui — e no mapa
                  quando tiver localização.
                </EmptyState>
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="p-3">
                <EmptyState>Nenhuma tag casa "{search.trim()}".</EmptyState>
              </div>
            ) : (
              <ul className="flex flex-col p-2">
                {visibleRows.map((e) => {
                  const color = colorFor(e, now);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => focus(e)}
                        disabled={!e.position}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-panel disabled:cursor-default disabled:opacity-60"
                        title={e.position ? "Centralizar no mapa" : "Ainda sem localização (GPS)"}
                      >
                        <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
                          {e.live ? (
                            <Wifi size={14} strokeWidth={2} style={{ color }} />
                          ) : (
                            <MapPin size={14} strokeWidth={2} style={{ color }} />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] text-text">{e.label}</span>
                          <span className="text-[11px] text-text-muted">
                            {statusLabel(e, now, rssiByMac.get(e.id) ?? null)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}
