import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapPin, Radar, Search, Wifi, X } from "lucide-react";
import { PageHeader, Badge, EmptyState, ScrollArea, Input } from "../ui";
import { getBtLocations, getBtReadings, type TagLocation, type BtReading } from "../api";

// Busca acento-insensível (rótulo "João" casa "joao"; MAC casa por substring).
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Mapa = CENTRAL DO COLETOR. Duas fontes (polling ~4s):
//  • GET /api/bt/locations → ÚLTIMA localização por tag (estilo AirTag: onde o celular a viu por último).
//  • GET /api/bt/readings  → tags VISÍVEIS AGORA (em alcance do coletor neste instante) + RSSI.
// Pino VIVO (verde, com halo) = visível agora; pino que desbota (going-gray) = só última localização.
// Assim o operador vê no mapa TUDO que o coletor enxerga + onde cada tag ficou. LGPD: só metadados.
const POLL_MS = 4000;
// Centro só usado quando NÃO há nenhum pin (com pins, o mapa dá fitBounds). Sobral/CE (CD Grendene).
const DEFAULT_CENTER: L.LatLngExpression = [-3.688, -40.348];
const DEFAULT_ZOOM = 13;

// Going-gray por FRESCOR (só p/ tags que NÃO estão visíveis agora): recém-vista = azul; velha = cinza.
const FRESH_MS = 2 * 60_000;
const C_LIVE = "var(--state-ok)"; // VISÍVEL AGORA (em alcance) — o sinal mais forte
const C_RECENT = "var(--state-info)"; // vista há pouco
const C_STALE = "var(--state-neutral)"; // parada há muito

type Row = {
  mac: string;
  name: string; // rótulo cadastrado, senão o MAC
  loc: TagLocation | null; // última localização (null = ainda sem GPS)
  rssi: number | null; // RSSI se visível agora
  visible: boolean; // em alcance do coletor NESTE instante
};

function colorFor(r: Row, now: number): string {
  if (r.visible) return C_LIVE;
  const age = r.loc ? now - r.loc.ts : Infinity;
  if (age < FRESH_MS) return C_RECENT;
  return C_STALE;
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
function popupHtml(r: Row, now: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  let sub: string;
  if (r.visible) sub = `visível agora${r.rssi != null ? ` · ${r.rssi} dBm` : ""}`;
  else if (r.loc) {
    const acc = r.loc.acc != null ? ` · ±${Math.round(r.loc.acc)} m` : "";
    sub = `${agoLabel(r.loc.ts, now)}${acc}`;
  } else sub = "sem localização ainda";
  return `<strong>${esc(r.name)}</strong><br/><span style="opacity:.75">${esc(sub)}</span>`;
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
    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    const t = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
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

  // ── Merge: última localização (posição) × leituras ao vivo (visível agora + RSSI), por MAC. ──
  const merged = useMemo<Row[]>(() => {
    const byMac = new Map<string, Row>();
    for (const t of tags) {
      byMac.set(t.mac, { mac: t.mac, name: t.rotulo ?? t.mac, loc: t, rssi: null, visible: false });
    }
    for (const r of readings) {
      const mac = String(r.mac).toUpperCase();
      const ex = byMac.get(mac);
      if (ex) {
        ex.visible = true;
        ex.rssi = r.rssi;
        if (r.rotulo) ex.name = r.rotulo;
      } else {
        byMac.set(mac, { mac, name: r.rotulo ?? mac, loc: null, rssi: r.rssi, visible: true });
      }
    }
    return [...byMac.values()];
  }, [tags, readings]);

  const visibleCount = useMemo(() => merged.filter((r) => r.visible).length, [merged]);

  // ── Sincroniza marcadores (só tags com localização). live = visível agora → pino verde com halo. ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const store = markersRef.current;
    const seen = new Set<string>();

    for (const r of merged) {
      if (!r.loc || !Number.isFinite(r.loc.lat) || !Number.isFinite(r.loc.lon)) continue;
      seen.add(r.mac);
      const color = colorFor(r, now);
      const key = `${r.visible ? "live" : "last"}:${color}`;
      const pos: L.LatLngExpression = [r.loc.lat, r.loc.lon];
      const existing = store.get(r.mac);
      if (existing) {
        existing.marker.setLatLng(pos);
        if (existing.key !== key) {
          existing.marker.setIcon(makeIcon(color, r.visible));
          existing.key = key;
        }
        existing.marker.setPopupContent(popupHtml(r, now));
        existing.marker.setTooltipContent(r.name);
      } else {
        const marker = L.marker(pos, { icon: makeIcon(color, r.visible) })
          .addTo(map)
          .bindTooltip(r.name, { direction: "top", offset: [0, -8] })
          .bindPopup(popupHtml(r, now));
        store.set(r.mac, { marker, key });
      }
    }

    for (const [mac, entry] of store) {
      if (!seen.has(mac)) {
        entry.marker.remove();
        store.delete(mac);
      }
    }

    if (!didFitRef.current && store.size > 0) {
      const bounds = L.latLngBounds([...store.values()].map((e) => e.marker.getLatLng()));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
      didFitRef.current = true;
    }
  }, [merged, now]);

  // Lista lateral: VISÍVEIS agora primeiro (por RSSI), depois localizadas por recência.
  const sorted = useMemo(
    () =>
      [...merged].sort((a, b) => {
        if (a.visible !== b.visible) return a.visible ? -1 : 1;
        if (a.visible && b.visible) return (b.rssi ?? -999) - (a.rssi ?? -999);
        return (b.loc?.ts ?? 0) - (a.loc?.ts ?? 0);
      }),
    [merged],
  );

  const focus = useCallback((r: Row) => {
    const map = mapRef.current;
    if (!map || !r.loc) return;
    map.setView([r.loc.lat, r.loc.lon], Math.max(map.getZoom(), 17), { animate: true });
    markersRef.current.get(r.mac)?.marker.openPopup();
  }, []);

  // ── Busca: casa por rótulo OU MAC (acento/caixa-insensível). matchMacs=null → sem busca. ──
  const q = norm(search.trim());
  const matchMacs = useMemo(() => {
    if (!q) return null;
    const s = new Set<string>();
    for (const r of sorted) if (norm(r.name).includes(q) || norm(r.mac).includes(q)) s.add(r.mac);
    return s;
  }, [q, sorted]);
  const visibleRows = matchMacs ? sorted.filter((r) => matchMacs.has(r.mac)) : sorted;

  // Destaque no mapa: casa = opaco; não casa = esmaecido.
  useEffect(() => {
    for (const [mac, entry] of markersRef.current) {
      entry.marker.setOpacity(!matchMacs || matchMacs.has(mac) ? 1 : 0.25);
    }
  }, [matchMacs, merged]);

  // Match único (forte) → centraliza e abre o popup uma vez.
  useEffect(() => {
    if (matchMacs && matchMacs.size === 1) {
      const [mac] = matchMacs;
      if (lastAutoFocus.current !== mac) {
        const r = sorted.find((x) => x.mac === mac);
        if (r?.loc) {
          focus(r);
          lastAutoFocus.current = mac;
        }
      }
    } else {
      lastAutoFocus.current = null;
    }
  }, [matchMacs, sorted, focus]);

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
          {error ? "sem conexão" : `${merged.length} tag${merged.length === 1 ? "" : "s"}`}
        </Badge>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="min-h-0 flex-1" style={{ height: "100%" }} />

        <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-panel-2 md:flex">
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Tags {matchMacs ? `· ${visibleRows.length}/${merged.length}` : ""}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {!loaded ? (
              <div className="p-3 text-[13px] text-text-muted">Carregando…</div>
            ) : merged.length === 0 ? (
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
                {visibleRows.map((r) => {
                  const color = colorFor(r, now);
                  const status = r.visible
                    ? `visível agora${r.rssi != null ? ` · ${r.rssi} dBm` : ""}`
                    : r.loc
                      ? agoLabel(r.loc.ts, now)
                      : "sem localização ainda";
                  return (
                    <li key={r.mac}>
                      <button
                        type="button"
                        onClick={() => focus(r)}
                        disabled={!r.loc}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-panel disabled:cursor-default disabled:opacity-60"
                        title={r.loc ? "Centralizar no mapa" : "Ainda sem localização (GPS)"}
                      >
                        <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
                          {r.visible ? (
                            <Wifi size={14} strokeWidth={2} style={{ color }} />
                          ) : (
                            <MapPin size={14} strokeWidth={2} style={{ color }} />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] text-text">{r.name}</span>
                          <span className="text-[11px] text-text-muted">{status}</span>
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
