import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { BluetoothSearching, Tag } from "lucide-react";
import { useAuth } from "../auth";
import { APP_CONFIG } from "../config";
import { PageHeader, Badge, EmptyState, Spinner } from "../ui";
import { getBtReadings, type BtReading } from "../api";

// Tela CRUA das tags BLE (Fase 1 do plano — analises/tags-bluetooth/00-avaliacao-e-plano.md §5.1):
// mostra AO VIVO cada tag vista pela estação, ordenada por sinal (mais forte primeiro), marcando
// como "sumindo" as que pararam de ser reportadas. Prova a ponta-a-ponta do ingest BLE.
//
// Vivo pelo SOCKET (`bt-readings`, relay do hub — contrato ADITIVO); a semente inicial vem do
// GET /api/bt/readings (para quem abre depois). Sem polling: o socket empurra as leituras.
// LGPD: só RSSI/rótulo trafegam, efêmeros em memória — nada é persistido aqui (ADR-002).

// Leitura "viva" no cliente: guarda o RSSI e o TS de RECEPÇÃO local (não o do hub — imune a
// skew de relógio, mesmo critério do overlay analysis-tracks).
type Live = { mac: string; rotulo: string | null; rssi: number; ts: number };

const STALE_MS = 8000; // sem update há mais que isto → a linha fica esmaecida ("sumindo")
const TICK_MS = 2000; // re-avaliação local do "stale" (não é polling ao servidor)

// RSSI (dBm, negativo) → 0..100% para a barra de sinal. -40 dBm ~ colado; -95 dBm ~ no limite.
function rssiPct(rssi: number): number {
  return Math.round(Math.min(100, Math.max(0, ((rssi + 95) / 55) * 100)));
}

export function BtTagsPage() {
  const { token } = useAuth();
  const [byMac, setByMac] = useState<Record<string, Live>>({});
  const [connected, setConnected] = useState(false);
  const [seeded, setSeeded] = useState(false);
  // Tick só para re-renderizar e recalcular o "stale" localmente quando nada chega pelo socket.
  const [, setNowTick] = useState(0);

  // Mescla um lote de leituras no mapa por MAC, carimbando o TS de recepção local.
  function mergeReadings(rows: BtReading[]) {
    const now = Date.now();
    setByMac((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        const mac = String(r?.mac || "").toUpperCase();
        const rssi = Number(r?.rssi);
        if (!mac || !Number.isFinite(rssi)) continue;
        next[mac] = { mac, rotulo: r.rotulo ?? null, rssi, ts: now };
      }
      return next;
    });
  }

  useEffect(() => {
    let dead = false;
    // Semente: snapshot do que está visível agora (para quem abre depois do início da varredura).
    getBtReadings()
      .then((rows) => {
        if (!dead && Array.isArray(rows)) mergeReadings(rows);
      })
      .catch(() => {
        /* hub antigo / sem estação — segue vazio, o socket povoa quando chegar leitura */
      })
      .finally(() => {
        if (!dead) setSeeded(true);
      });

    // Vivo: mesmo padrão da Central/Saúde de alarmes — socket só-para-eventos. `watch({ids:[]})`
    // deixa a room legada (zero frames de vídeo nesta tela); `bt-readings` chega pela room
    // "dashboards" (o hub relaya para lá), independente do watch.
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("watch", { ids: [] });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("bt-readings", (p: { readings?: BtReading[] }) => {
      if (p && Array.isArray(p.readings)) mergeReadings(p.readings);
    });
    return () => {
      dead = true;
      socket.disconnect();
    };
  }, [token]);

  // Re-render periódico só para atualizar o esmaecimento das linhas paradas (local, sem rede).
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Lista ordenada por sinal (mais forte = RSSI maior/mais próximo de 0 primeiro).
  const now = Date.now();
  const rows = useMemo(
    () => Object.values(byMac).sort((a, b) => b.rssi - a.rssi),
    [byMac],
  );
  const staleCount = rows.filter((r) => now - r.ts > STALE_MS).length;

  return (
    <div className="page">
      <PageHeader
        title="Tags BLE"
        subtitle="Tags detectadas pela estação, ao vivo — ordenadas por sinal (mais forte primeiro)."
      >
        <Badge tone={connected ? "ok" : "warn"}>
          <BluetoothSearching size={12} strokeWidth={1.75} aria-hidden />
          {connected ? "ao vivo" : "conectando…"}
        </Badge>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {!seeded ? (
          <div className="flex items-center gap-2 text-[13px] text-text-muted">
            <Spinner /> Carregando leituras…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState>
            Nenhuma tag detectada. Ligue a estação de varredura e aproxime uma tag BLE — as
            leituras aparecem aqui automaticamente.
          </EmptyState>
        ) : (
          <>
            <div className="flex items-center gap-3 text-[12px] text-text-muted">
              <span>
                {rows.length} tag{rows.length === 1 ? "" : "s"} visível
                {rows.length === 1 ? "" : "eis"}
              </span>
              {staleCount > 0 && (
                <span>· {staleCount} sem sinal recente (&gt; {STALE_MS / 1000}s)</span>
              )}
            </div>
            <ul className="flex flex-col gap-2" aria-label="Tags BLE detectadas">
              {rows.map((r) => {
                const stale = now - r.ts > STALE_MS;
                const pct = rssiPct(r.rssi);
                return (
                  <li
                    key={r.mac}
                    className="flex items-center gap-3 rounded-sm border border-border bg-panel-2 px-3 py-2 transition-opacity"
                    style={{ opacity: stale ? 0.45 : 1 }}
                  >
                    <span
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-panel text-text-dim"
                      aria-hidden
                    >
                      <Tag size={15} strokeWidth={1.75} />
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[14px] font-medium text-text">
                        {r.rotulo ?? r.mac}
                      </span>
                      <span className="text-[11px] text-text-muted">
                        {r.rotulo ? r.mac : "tag não cadastrada"}
                        {stale && " · sem sinal recente"}
                      </span>
                    </div>
                    <div className="flex-1" />
                    {/* Barra de sinal analógica + valor cru (going-gray: neutro; nunca só número). */}
                    <div className="flex w-40 items-center gap-2">
                      <span
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel"
                        role="img"
                        aria-label={`sinal ${pct}%`}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: stale ? "var(--border)" : "var(--state-ok)",
                          }}
                        />
                      </span>
                      <span className="w-16 text-right text-[12px] tabular-nums text-text-dim">
                        {r.rssi} dBm
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
