import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapPin, Radar } from "lucide-react";
import { PageHeader, Badge, EmptyState, ScrollArea } from "../ui";
import { getBtLocations, type TagLocation } from "../api";

// Mapa OpenStreetMap com a ÚLTIMA localização de cada tag (estilo AirTag). O TC22 é MÓVEL: a
// posição mostrada é onde o celular estava quando viu a tag por último — não a posição "ao vivo".
// Fonte: POLLING do GET /api/bt/locations a cada ~4s (robustez > socket; ver contrato em api.ts).
// LGPD: só coordenadas/metadados — nenhum frame. Marcadores via L.divIcon (CSS puro, SEM imagem
// externa) para não esbarrar no CSP dos ícones default do Leaflet.

const POLL_MS = 4000;
// Centro só usado quando NÃO há nenhum pin (com pins, o mapa dá fitBounds). Sobral/CE (CD Grendene).
const DEFAULT_CENTER: L.LatLngExpression = [-3.688, -40.348];
const DEFAULT_ZOOM = 13;

// Going-gray por FRESCOR: recém-vista = cor viva; parada há muito = cinza (a cor É a informação).
const FRESH_MS = 2 * 60_000; // < 2 min → verde (--state-ok): acabou de ser vista
const STALE_MS = 10 * 60_000; // > 10 min → cinza (--state-neutral): localização velha
type Tier = "fresh" | "recent" | "stale";
const TIER_COLOR: Record<Tier, string> = {
  fresh: "var(--state-ok)",
  recent: "var(--state-info)",
  stale: "var(--state-neutral)",
};
function tierOf(ageMs: number): Tier {
  if (ageMs < FRESH_MS) return "fresh";
  if (ageMs < STALE_MS) return "recent";
  return "stale";
}

// "visto há X" — humano e curto. Base = quando o celular viu a tag (ts da leitura).
function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "visto agora";
  const min = Math.round(s / 60);
  if (min < 60) return `visto há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `visto há ${h} h`;
  return `visto há ${Math.round(h / 24)} d`;
}

// HTML do pino (divIcon): círculo colorido com anel — cor resolve var(--state-*) no documento.
function pinHtml(color: string): string {
  return `<span style="display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:2px solid var(--panel);box-shadow:0 0 0 1.5px ${color},0 1px 3px rgba(0,0,0,.5);"></span>`;
}
function makeIcon(tier: Tier): L.DivIcon {
  return L.divIcon({
    html: pinHtml(TIER_COLOR[tier]),
    className: "tag-pin", // sem estilos default do Leaflet (evita o ícone-imagem)
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
}
function popupHtml(t: TagLocation, now: number): string {
  const name = t.rotulo ?? t.mac;
  const acc = t.acc != null ? ` · ±${Math.round(t.acc)} m` : "";
  // textContent-safe: o nome pode vir do cadastro; escapamos para não injetar HTML.
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<strong>${esc(name)}</strong><br/><span style="opacity:.75">${esc(agoLabel(t.ts, now))}${esc(acc)}</span>`;
}

export function TagsMapPage() {
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; tier: Tier }>>(new Map());
  const didFitRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [tags, setTags] = useState<TagLocation[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // ── Cria o mapa uma vez (cleanup no unmount) ──────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    // O container é dimensionado por flexbox: força o Leaflet a remedir após o layout.
    const t = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      didFitRef.current = false;
    };
  }, []);

  // ── Poll a cada ~4s (e no mount). Sem socket: robustez e simplicidade. ─────
  useEffect(() => {
    let dead = false;
    const tick = () => {
      getBtLocations()
        .then((rows) => {
          if (dead) return;
          setTags(Array.isArray(rows) ? rows : []);
          setNow(Date.now());
          setError(false);
        })
        .catch(() => {
          if (!dead) setError(true);
        })
        .finally(() => {
          if (!dead) setLoaded(true);
        });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, []);

  // ── Sincroniza marcadores (upsert por mac, move sem recriar, recolore por frescor) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const store = markersRef.current;
    const seen = new Set<string>();

    for (const t of tags) {
      if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
      seen.add(t.mac);
      const tier = tierOf(now - t.ts);
      const pos: L.LatLngExpression = [t.lat, t.lon];
      const existing = store.get(t.mac);
      if (existing) {
        existing.marker.setLatLng(pos);
        if (existing.tier !== tier) {
          existing.marker.setIcon(makeIcon(tier));
          existing.tier = tier;
        }
        existing.marker.setPopupContent(popupHtml(t, now));
        existing.marker.setTooltipContent(t.rotulo ?? t.mac);
      } else {
        const marker = L.marker(pos, { icon: makeIcon(tier) })
          .addTo(map)
          .bindTooltip(t.rotulo ?? t.mac, { direction: "top", offset: [0, -8] })
          .bindPopup(popupHtml(t, now));
        store.set(t.mac, { marker, tier });
      }
    }

    // Remove marcadores de tags que sumiram da resposta.
    for (const [mac, entry] of store) {
      if (!seen.has(mac)) {
        entry.marker.remove();
        store.delete(mac);
      }
    }

    // Primeiro enquadramento: centraliza no conjunto de pins.
    if (!didFitRef.current && store.size > 0) {
      const bounds = L.latLngBounds([...store.values()].map((e) => e.marker.getLatLng()));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
      didFitRef.current = true;
    }
  }, [tags, now]);

  // Lista lateral: ordenada por frescor (vista mais recente primeiro).
  const rows = useMemo(
    () => [...tags].filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon)).sort((a, b) => b.ts - a.ts),
    [tags],
  );

  const focus = useCallback((t: TagLocation) => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([t.lat, t.lon], Math.max(map.getZoom(), 17), { animate: true });
    markersRef.current.get(t.mac)?.marker.openPopup();
  }, []);

  return (
    <div className="page">
      <PageHeader
        title="Mapa de tags"
        subtitle="Última localização conhecida de cada tag (estilo AirTag) — onde o celular a viu por último."
      >
        <Badge tone={error ? "warn" : undefined}>
          <Radar size={12} strokeWidth={1.75} aria-hidden />
          {error ? "sem conexão" : `${rows.length} tag${rows.length === 1 ? "" : "s"}`}
        </Badge>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* Mapa — ocupa a área principal; height:100% p/ o Leaflet medir o container flex. */}
        <div ref={containerRef} className="min-h-0 flex-1" style={{ height: "100%" }} />

        {/* Lista lateral (some no mobile): clicar centraliza no pin. */}
        <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-panel-2 md:flex">
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Tags
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {!loaded ? (
              <div className="p-3 text-[13px] text-text-muted">Carregando…</div>
            ) : rows.length === 0 ? (
              <div className="p-3">
                <EmptyState>
                  Nenhuma tag localizada ainda. Assim que o app do celular vir uma tag, ela aparece
                  aqui no mapa.
                </EmptyState>
              </div>
            ) : (
              <ul className="flex flex-col p-2">
                {rows.map((t) => {
                  const tier = tierOf(now - t.ts);
                  return (
                    <li key={t.mac}>
                      <button
                        type="button"
                        onClick={() => focus(t)}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-panel"
                      >
                        <span
                          className="inline-flex size-4 shrink-0 items-center justify-center"
                          aria-hidden
                        >
                          <MapPin
                            size={14}
                            strokeWidth={2}
                            style={{ color: TIER_COLOR[tier] }}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] text-text">
                            {t.rotulo ?? t.mac}
                          </span>
                          <span className="text-[11px] text-text-muted">
                            {agoLabel(t.ts, now)}
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
