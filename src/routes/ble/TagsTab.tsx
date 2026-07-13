import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { BluetoothSearching, Tag } from "lucide-react";
import { useAuth } from "../../auth";
import { APP_CONFIG } from "../../config";
import { Badge, EmptyState, Spinner, Button, Input, Alert, SectionTitle, useToast } from "../../ui";
import {
  apiGet,
  getBtReadings,
  getBtTags,
  createBtTag,
  updateBtTag,
  type BtReading,
  type BtTag,
} from "../../api";
import { useStationNames } from "../../fusion/useStationNames";

// Aba TAGS da tela BLE (spec-arquitetura-informacao §3, desenho C). Era a rota /tags-ble inteira
// (BtTagsPage); agora é o painel de uma das duas abas — a outra é o cadastro das ESTAÇÕES que
// produzem estas leituras. NADA da lógica mudou: o que saiu daqui foi o <PageHeader> (a tela tem
// UM h1 só, o da BlePage) — o Badge "ao vivo" desceu para a faixa de status do próprio painel.
//
// Mostra AO VIVO cada tag vista pelas estações, ordenada por sinal (mais forte primeiro), marcando
// como "sumindo" as que pararam de ser reportadas.
//
// Vivo pelo SOCKET (`bt-readings`, relay do hub — contrato ADITIVO); a semente inicial vem do
// GET /api/bt/readings?all=1 (para quem abre depois). Sem polling: o socket empurra as leituras.
// MULTI-ANTENA (F2): as leituras são POR FONTE (estação|MAC) — o merge antigo por MAC descartava o
// stationId e duas estações se sobrescreviam. Com 2+ estações a lista vira SEÇÕES por estação; com
// uma só, o layout é o de sempre (CA-3). LGPD: só RSSI/rótulo trafegam, efêmeros (ADR-002).

// Leitura "viva" no cliente: guarda a FONTE (estação), o RSSI e o TS de RECEPÇÃO local (não o do
// hub — imune a skew de relógio, mesmo critério do overlay analysis-tracks).
type Live = { stationId: string; mac: string; rotulo: string | null; rssi: number; ts: number };

const STALE_MS = 8000; // sem update há mais que isto → a linha fica esmaecida ("sumindo")
const TICK_MS = 2000; // re-avaliação local do "stale" (não é polling ao servidor)

// RSSI (dBm, negativo) → 0..100% para a barra de sinal. -40 dBm ~ colado; -95 dBm ~ no limite.
export function rssiPct(rssi: number): number {
  return Math.round(Math.min(100, Math.max(0, ((rssi + 95) / 55) * 100)));
}

export function TagsTab({ onVerEstacoes }: { onVerEstacoes?: () => void }) {
  const { token, canConfigure } = useAuth();
  const { toast } = useToast();
  // QUEM é a fonte: o NOME que o operador deu à estação na aba Estações ("Doca 3"), no lugar do id
  // técnico cru que o app carimba na leitura. Sem registro (hub antigo/erro) o nome degrada para o
  // próprio id; leitura sem fonte (fonte única/legada) fica "sem id" — nunca vazio.
  const { nameOf, stations } = useStationNames();
  const stationLabel = useCallback((id: string) => nameOf(id) || "sem id", [nameOf]);
  // Chave composta `${stationId}|${MAC}` — cada FONTE mantém sua série (o merge por MAC colidia).
  const [byKey, setByKey] = useState<Record<string, Live>>({});
  const [connected, setConnected] = useState(false);
  const [seeded, setSeeded] = useState(false);
  // ERRO de página (DoD §3 "Estados"): a semente falhou nas DUAS rotas (hub fora do ar) — antes isso
  // era engolido em silêncio e a tela ficava eternamente "vazia" sem dizer por quê.
  const [err, setErr] = useState<string | null>(null);
  // Tick só para re-renderizar e recalcular o "stale" localmente quando nada chega pelo socket.
  const [, setNowTick] = useState(0);
  // Registro (QUEM é a tag): nome↔MAC. Só carregado p/ quem configura (o cadastro exige engenharia).
  // Editar um nome grava no cadastro (bt_tags); a estação/overlay passam a mostrar a pessoa.
  // Chave = MAC maiúsculo.
  const [tagByMac, setTagByMac] = useState<Record<string, BtTag>>({});
  // Identidade da LINHA em edição = chave composta (a mesma tag pode aparecer em 2 estações;
  // o formulário abre só na linha clicada). O SAVE segue por MAC — o cadastro é da tag, não da fonte.
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingMac, setSavingMac] = useState<string | null>(null);

  const loadTags = useCallback(() => {
    if (!canConfigure) return;
    getBtTags()
      .then((list) => {
        const m: Record<string, BtTag> = {};
        for (const t of list) m[t.btName.toUpperCase()] = t;
        setTagByMac(m);
      })
      .catch(() => {
        /* sem permissão / hub antigo — segue só com as leituras */
      });
  }, [canConfigure]);
  useEffect(() => {
    loadTags();
  }, [loadTags]);

  // Salvar o nome: sucesso → TOAST; falha → Alert de página (um padrão de feedback só, DoD §3).
  async function saveName(mac: string) {
    const name = editName.trim();
    if (!name) return;
    setSavingMac(mac);
    try {
      const existing = tagByMac[mac.toUpperCase()];
      if (existing) await updateBtTag(existing.id, { rotulo: name });
      else await createBtTag(mac, name);
      setEditKey(null);
      setErr(null);
      toast(`Tag ${mac} agora é "${name}".`, "ok");
      loadTags();
    } catch (e) {
      // mantém a edição aberta em caso de erro — e agora DIZ o que houve
      setErr(e instanceof Error ? e.message : "falha ao salvar o nome da tag");
    } finally {
      setSavingMac(null);
    }
  }

  // Mescla um lote de leituras no mapa por FONTE×MAC, carimbando o TS de recepção local. A fonte vem
  // da própria leitura (rec.stationId, enriquecido no hub) ou do envelope do socket (fallback).
  const mergeReadings = useCallback((rows: BtReading[], envelopeStation = "") => {
    const now = Date.now();
    setByKey((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        const mac = String(r?.mac || "").toUpperCase();
        const rssi = Number(r?.rssi);
        if (!mac || !Number.isFinite(rssi)) continue;
        const stationId = String(r?.stationId ?? envelopeStation ?? "");
        next[`${stationId}|${mac}`] = { stationId, mac, rotulo: r.rotulo ?? null, rssi, ts: now };
      }
      return next;
    });
  }, []);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Semente: snapshot COMPLETO (todas as fontes — ?all=1, F2). Hub antigo não conhece o parâmetro
  // (404) → cai no GET colapsado de sempre (1 rec/MAC — 1 estação implícita). Falhar as DUAS =
  // hub fora do ar → Alert com retry (o botão chama `seed` de novo).
  const seed = useCallback(() => {
    setSeeded(false);
    apiGet<BtReading[]>("/api/bt/readings?all=1")
      .catch(() => getBtReadings())
      .then((rows) => {
        if (!aliveRef.current) return;
        if (Array.isArray(rows)) mergeReadings(rows);
        setErr(null);
      })
      .catch((e) => {
        if (aliveRef.current)
          setErr(e instanceof Error ? e.message : "falha ao carregar as leituras do hub");
      })
      .finally(() => {
        if (aliveRef.current) setSeeded(true);
      });
  }, [mergeReadings]);
  useEffect(() => {
    seed();
  }, [seed]);

  useEffect(() => {
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
    // O envelope carrega o stationId da fonte (um envelope por POST de estação — contrato aditivo).
    socket.on("bt-readings", (p: { stationId?: string; readings?: BtReading[] }) => {
      if (p && Array.isArray(p.readings)) mergeReadings(p.readings, String(p.stationId ?? ""));
    });
    return () => {
      socket.disconnect();
    };
  }, [token, mergeReadings]);

  // Re-render periódico só para atualizar o esmaecimento das linhas paradas (local, sem rede).
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Seções POR ESTAÇÃO (ordem alfabética estável — não trocam de lugar entre eventos); dentro de
  // cada uma, sinal mais forte primeiro (RSSI maior/mais próximo de 0). Com 1 estação: 1 seção sem
  // cabeçalho = o layout de sempre (CA-3).
  const now = Date.now();
  const groups = useMemo(() => {
    const by = new Map<string, Live[]>();
    for (const r of Object.values(byKey)) {
      const arr = by.get(r.stationId);
      if (arr) arr.push(r);
      else by.set(r.stationId, [r]);
    }
    return [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stationId, rows]) => ({ stationId, rows: rows.sort((a, b) => b.rssi - a.rssi) }));
  }, [byKey]);
  const entries = groups.flatMap((g) => g.rows);
  // Tags DISTINTAS: a mesma tag vista por 2 estações conta UMA no resumo (as leituras, não).
  const macCount = new Set(entries.map((r) => r.mac)).size;
  const staleCount = entries.filter((r) => now - r.ts > STALE_MS).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {/* Faixa de status do painel: o Badge "ao vivo" que morava no PageHeader (a tela unificada
          tem UM header só, e ele não pode falar por duas abas). */}
      <div className="flex flex-wrap items-center gap-3 text-sec text-text-muted">
        <Badge tone={connected ? "ok" : "warn"}>
          <BluetoothSearching size={12} strokeWidth={1.75} aria-hidden />
          {connected ? "ao vivo" : "conectando…"}
        </Badge>
        {seeded && entries.length > 0 && (
          <>
            <span>
              {macCount} tag{macCount === 1 ? "" : "s"} visível
              {macCount === 1 ? "" : "eis"}
            </span>
            {groups.length > 1 && <span>· {groups.length} estações</span>}
            {staleCount > 0 && (
              <span>
                · {staleCount} sem sinal recente (&gt; {STALE_MS / 1000}s)
              </span>
            )}
          </>
        )}
      </div>

      {err && (
        <Alert tone="alert">
          <span className="flex-1">{err}</span>
          <Button size="sm" onClick={seed}>
            Tentar novamente
          </Button>
        </Alert>
      )}

      {!seeded ? (
        <div
          className="flex items-center gap-2 text-body text-text-muted"
          aria-busy="true"
          aria-label="Carregando leituras"
        >
          <Spinner /> Carregando leituras…
        </div>
      ) : entries.length === 0 ? (
        // COSTURA Tag↔Estação (o ganho da tela unificada): sem leitura, a pergunta seguinte é
        // sempre "e a estação, está de pé?". O registro JÁ está carregado aqui (useStationNames) —
        // então o vazio diz quantas existem e leva à aba que responde. NÃO afirmamos "viva/morta"
        // aqui: este registro é repescado a cada 30 s e a verdade do sinal (janela de 15 s) mora na
        // aba Estações — prometer o que o instrumento não resolve é a Regra 9 do CLAUDE.md.
        <EmptyState>
          {stations.length === 0
            ? "Nenhuma tag detectada e nenhuma estação cadastrada. Ligue a estação de varredura e aproxime uma tag BLE — a estação aparece sozinha e as leituras entram aqui."
            : `Nenhuma tag detectada. ${stations.length} estação${stations.length === 1 ? "" : "ões"} cadastrada${stations.length === 1 ? "" : "s"} — confira na aba Estações se ela está reportando.`}
          {stations.length > 0 && onVerEstacoes && (
            <Button size="sm" onClick={onVerEstacoes}>
              Ver estações
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.stationId || "estacao"} className="flex flex-col gap-2">
              {/* Cabeçalho da fonte SÓ com 2+ estações — com uma, o layout de sempre (CA-3).
                  <h2> via SectionTitle (doutrina regra 7: seção com título é heading). O rótulo é
                  o NOME cadastrado; o id técnico continua ali, discreto (normal-case, sem o negrito
                  do título) — e some quando é o próprio nome (estação pendente de batismo). */}
              {groups.length > 1 && (
                <SectionTitle flush className="flex items-center gap-1.5">
                  <BluetoothSearching size={12} strokeWidth={1.75} aria-hidden />
                  <span>Estação {stationLabel(g.stationId)}</span>
                  {g.stationId && stationLabel(g.stationId) !== g.stationId && (
                    <span className="font-normal normal-case tracking-normal">{g.stationId}</span>
                  )}
                  <span>
                    · {g.rows.length} leitura{g.rows.length === 1 ? "" : "s"}
                  </span>
                </SectionTitle>
              )}
              <ul
                className="flex flex-col gap-2"
                aria-label={
                  groups.length > 1
                    ? `Tags BLE detectadas — estação ${stationLabel(g.stationId)}`
                    : "Tags BLE detectadas"
                }
              >
                {g.rows.map((r) => {
                  const key = `${r.stationId}|${r.mac}`;
                  const stale = now - r.ts > STALE_MS;
                  const pct = rssiPct(r.rssi);
                  const reg = tagByMac[r.mac]; // MAC já é maiúsculo (mergeReadings)
                  const name = reg?.rotulo ?? r.rotulo ?? null; // registro local (fresco) → enriquecido → nada
                  const editing = editKey === key;
                  return (
                    <li
                      key={key}
                      className="flex items-center gap-3 rounded-sm border border-border bg-panel-2 px-3 py-2 transition-opacity"
                      style={{ opacity: stale ? 0.45 : 1 }}
                    >
                      <span
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-panel text-text-dim"
                        aria-hidden
                      >
                        <Tag size={15} strokeWidth={1.75} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        {editing ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="Nome da pessoa"
                              aria-label={`Nome da pessoa da tag ${r.mac}`}
                              className="w-48"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveName(r.mac);
                                if (e.key === "Escape") setEditKey(null);
                              }}
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={savingMac === r.mac || !editName.trim()}
                              onClick={() => saveName(r.mac)}
                            >
                              {savingMac === r.mac ? "…" : "Salvar"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditKey(null)}>
                              Cancelar
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span className="truncate text-title font-medium text-text">
                              {name ?? r.mac}
                            </span>
                            <span className="text-label text-text-muted">
                              {name ? r.mac : "sem nome"}
                              {stale && " · sem sinal recente"}
                            </span>
                          </>
                        )}
                      </div>
                      {/* Barra de sinal analógica + valor cru (going-gray: neutro; nunca só número). */}
                      <div className="flex w-40 shrink-0 items-center gap-2">
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
                        <span className="w-16 text-right text-sec tabular-nums text-text-dim">
                          {r.rssi} dBm
                        </span>
                      </div>
                      {canConfigure && !editing && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => {
                            setEditKey(key);
                            setEditName(name ?? "");
                          }}
                        >
                          {name ? "editar" : "nomear"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
