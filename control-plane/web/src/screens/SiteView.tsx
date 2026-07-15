import { useEffect, useState } from "react";
import { ApiError, getSiteAlarms } from "../api";
import type { Alarm, Site } from "../types";
import { Badge, Button, EmptyState, ErrorState, Loading } from "../ui";
import { cameraZona, formatTs } from "../format";

// O contrato é `where ts >= since order by ts DESC limit N` (teto 500). Com essa forma,
// `since` é um PISO — não serve de cursor "para trás". A paginação honesta que o contrato
// permite é AUMENTAR o limit: um limit maior revela alarmes mais ANTIGOS (a cauda do desc).
// "Carregar mais" cresce o limit em passos de PAGE até o teto; re-busca com since=0.
const PAGE = 50;
const MAX = 500;

export function SiteView({ site, onBack }: { site: Site; onBack: () => void }) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    let alive = true;
    const first = limit === PAGE;
    if (first) setStatus("loading");
    else setLoadingMore(true);
    setError(null);

    getSiteAlarms(site.id, { limit, since: 0 })
      .then(({ alarms: page }) => {
        if (!alive) return;
        setAlarms(page);
        // Fim se veio menos que o pedido, ou se batemos o teto do contrato.
        setReachedEnd(page.length < limit || limit >= MAX);
        setStatus("ready");
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) return; // api.ts volta ao login
        const msg = err instanceof ApiError ? err.message : "falha ao carregar alarmes";
        if (first) setStatus("error");
        setError(msg);
      })
      .finally(() => {
        if (alive) setLoadingMore(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, limit]);

  function loadMore() {
    setLimit((n) => Math.min(n + PAGE, MAX));
  }

  return (
    <div>
      <button className="cp-back" onClick={onBack}>
        ← Voltar à frota
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: "1.15rem" }}>{site.nome}</h1>
        {site.online ? <Badge tone="online">ONLINE</Badge> : <Badge tone="offline">OFFLINE</Badge>}
      </div>

      {status === "loading" && <Loading label="Carregando alarmes…" />}
      {status === "error" && <ErrorState message={error ?? "erro ao carregar"} />}

      {status === "ready" &&
        (alarms.length === 0 ? (
          <EmptyState>Nenhum alarme registrado neste site.</EmptyState>
        ) : (
          <>
            <div className="cp-table-wrap cp-panel" style={{ padding: 0 }}>
              <table className="cp-table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Quando</th>
                    <th>Câmera / Zona</th>
                  </tr>
                </thead>
                <tbody>
                  {alarms.map((a) => (
                    <tr key={a.id}>
                      <td>{a.tipo}</td>
                      <td>{formatTs(a.ts)}</td>
                      <td>{cameraZona(a.meta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <ErrorState message={error} />}

            <div style={{ marginTop: 16, textAlign: "center" }}>
              {reachedEnd ? (
                <span className="cp-scope">
                  {limit >= MAX
                    ? `Mostrando os ${alarms.length} mais recentes (teto de ${MAX}).`
                    : `Fim da lista (${alarms.length} alarme${alarms.length === 1 ? "" : "s"}).`}
                </span>
              ) : (
                <Button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Carregando…" : "Carregar mais"}
                </Button>
              )}
            </div>
          </>
        ))}
    </div>
  );
}
