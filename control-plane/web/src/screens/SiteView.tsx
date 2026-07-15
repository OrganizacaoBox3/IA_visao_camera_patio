import { useEffect, useState } from "react";
import { ApiError, getSiteAlarms } from "../api";
import type { Alarm, Site } from "../types";
import { Badge, Button, EmptyState, ErrorState, Loading } from "../ui";
import { cameraZona, formatTs } from "../format";

// Paginação por CURSOR real: a próxima página pede `before` = ts do ÚLTIMO alarme já carregado.
// A lista vem em ordem desc (ts), então o último é o mais ANTIGO; o backend traduz em
// `where ts < before`. "Fim" quando a página volta com menos que PAGE (0 inclusive → fim).
const PAGE = 50;

export function SiteView({ site, onBack }: { site: Site; onBack: () => void }) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // 1ª página: sem cursor. Recarrega do zero ao trocar de site.
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setError(null);
    setAlarms([]);
    setReachedEnd(false);

    getSiteAlarms(site.id, { limit: PAGE })
      .then(({ alarms: page }) => {
        if (!alive) return;
        setAlarms(page);
        setReachedEnd(page.length < PAGE);
        setStatus("ready");
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) return; // api.ts volta ao login
        setStatus("error");
        setError(err instanceof ApiError ? err.message : "falha ao carregar alarmes");
      });

    return () => {
      alive = false;
    };
  }, [site.id]);

  async function loadMore() {
    const last = alarms[alarms.length - 1];
    if (!last) return; // sem cursor de onde continuar
    setLoadingMore(true);
    setError(null);
    try {
      const { alarms: page } = await getSiteAlarms(site.id, { limit: PAGE, before: last.ts });
      setAlarms((prev) => [...prev, ...page]);
      if (page.length < PAGE) setReachedEnd(true); // veio 0 (ou menos que a página) → fim
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(err instanceof ApiError ? err.message : "falha ao carregar mais");
    } finally {
      setLoadingMore(false);
    }
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
                  Fim da lista ({alarms.length} alarme{alarms.length === 1 ? "" : "s"}).
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
