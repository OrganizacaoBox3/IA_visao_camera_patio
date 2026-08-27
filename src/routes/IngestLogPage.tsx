import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth";
import { PageHeader, EmptyState, Alert, IconButton, Table, TableEmpty, Skeleton, Badge, SectionTitle } from "../ui";
import { getRtmpIngestLog, type RtmpIngestEvent, type RtmpIngestChannel } from "../api";

// Painel de log do ingest RTMP: "o canal que CHEGA é o mesmo que o painel PEDE?" (a pergunta do
// diagnóstico manual em docs/analises/rtmp-ingest/) sem precisar de SSH — lê o ring buffer em
// memória do relay (server/rtmp-ingest.js) via GET /api/rtmp-ingest/log. Molde: DvrsPage/AuditoriaTab
// (poll no pai, tabela read-only). Só metadados — sem URL/credencial, sem vídeo (LGPD/ADR-002).
const POLL_MS = 5_000; // canal cai/reconecta em segundos — mais rápido que o poll de 15s dos DVRs

const EVENT_TONE: Record<RtmpIngestEvent["type"], "ok" | "warn" | "alert" | "info" | undefined> = {
  aceito: undefined, // going-gray: aceitar publish é a operação normal, não uma anormalidade
  encerrado: undefined,
  repetido: "info",
  colisao: "warn",
  recusado: "alert",
};
const EVENT_LABEL: Record<RtmpIngestEvent["type"], string> = {
  aceito: "Aceito",
  encerrado: "Encerrado",
  repetido: "Reconectou",
  colisao: "Colisão desambiguada",
  recusado: "Recusado",
};

export function IngestLogPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<RtmpIngestEvent[]>([]);
  const [channels, setChannels] = useState<RtmpIngestChannel[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const log = await getRtmpIngestLog();
      setEvents(log.events);
      setChannels(log.channels);
      setEnabled(log.enabled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha ao carregar o log de ingest.");
    }
    setLoading(false);
  }

  useEffect(() => {
    if (user.papel !== "superadmin") {
      setLoading(false);
      return;
    }
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [user.papel]);

  if (user.papel !== "superadmin") {
    return (
      <div className="page">
        <PageHeader title="Log de ingest RTMP" />
        <EmptyState>Acesso restrito ao superadmin.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Log de ingest RTMP"
        subtitle="Canais que chegaram no relé × câmeras cadastradas no painel"
      >
        <IconButton label="Atualizar" onClick={refresh}>
          <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] overflow-auto p-[var(--sp-4)]">
        {err && <Alert tone="alert">{err}</Alert>}
        {!loading && !enabled && (
          <Alert tone="info">
            O relé de ingest RTMP não está ligado neste hub (go2rtc ausente, ou RTMP_INGEST=go2rtc
            no modo legado) — não há canal push pra comparar.
          </Alert>
        )}

        <section className="flex flex-col gap-[var(--sp-2)]">
          <SectionTitle>Canais ({channels.length})</SectionTitle>
          <Table
            ariaLabel="Canais de ingest RTMP"
            columns={[
              { label: "Canal", className: "w-full" },
              { label: "Cadastrada", className: "whitespace-nowrap" },
              { label: "Ao vivo agora", className: "whitespace-nowrap" },
              { label: "Última atividade", className: "whitespace-nowrap" },
            ]}
          >
            <tbody>
              {channels.map((c) => (
                <tr key={c.canal}>
                  <td className="mono">
                    {c.canal}
                    {c.label && <span className="muted"> · {c.label}</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    {c.cadastrada ? (
                      <Badge tone="ok">cadastrada</Badge>
                    ) : (
                      <Badge tone="warn">só no relé</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {c.aoVivo ? <Badge tone="ok">ao vivo</Badge> : <Badge>sem sessão</Badge>}
                  </td>
                  <td className="mono whitespace-nowrap">
                    {c.ultimaAtividade ? new Date(c.ultimaAtividade).toLocaleString("pt-BR") : "—"}
                  </td>
                </tr>
              ))}
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={4}>
                      <Skeleton w="100%" h={16} />
                    </td>
                  </tr>
                ))}
              {!loading && channels.length === 0 && (
                <TableEmpty colSpan={4}>Nenhum canal de ingest RTMP cadastrado ou visto.</TableEmpty>
              )}
            </tbody>
          </Table>
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-[var(--sp-2)]">
          <SectionTitle>
            {events.length} {events.length === 1 ? "evento" : "eventos"} recentes
          </SectionTitle>
          <Table
            ariaLabel="Eventos do relé de ingest RTMP"
            className="min-h-[200px] flex-1"
            columns={[
              { label: "Quando", className: "whitespace-nowrap" },
              { label: "Evento", className: "whitespace-nowrap" },
              { label: "Canal", className: "whitespace-nowrap" },
              { label: "Detalhe", className: "w-full" },
            ]}
          >
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="mono whitespace-nowrap">
                    {new Date(e.ts).toLocaleString("pt-BR")}
                  </td>
                  <td className="whitespace-nowrap">
                    <Badge tone={EVENT_TONE[e.type]}>{EVENT_LABEL[e.type]}</Badge>
                  </td>
                  <td className="mono whitespace-nowrap">{e.name}</td>
                  <td>{e.detail ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={`sk2-${i}`}>
                    <td colSpan={4}>
                      <Skeleton w="100%" h={16} />
                    </td>
                  </tr>
                ))}
              {!loading && events.length === 0 && (
                <TableEmpty colSpan={4}>Nenhum evento ainda.</TableEmpty>
              )}
            </tbody>
          </Table>
        </section>
      </div>
    </div>
  );
}
