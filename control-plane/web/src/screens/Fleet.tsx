import { useEffect, useState } from "react";
import { ApiError, getOverview } from "../api";
import type { Cliente, Overview, Partner, Site } from "../types";
import { Badge, EmptyState, ErrorState, Loading } from "../ui";

// Agrupa os sites (planos no contrato) na árvore partner → cliente → site para exibir.
function groupSites(ov: Overview): Array<{
  partner: Partner;
  clientes: Array<{ cliente: Cliente; sites: Site[] }>;
}> {
  const sitesByCliente = new Map<string, Site[]>();
  for (const s of ov.sites) {
    const arr = sitesByCliente.get(s.cliente_id) ?? [];
    arr.push(s);
    sitesByCliente.set(s.cliente_id, arr);
  }
  const clientesByPartner = new Map<string, Cliente[]>();
  for (const c of ov.clientes) {
    const arr = clientesByPartner.get(c.partner_id) ?? [];
    arr.push(c);
    clientesByPartner.set(c.partner_id, arr);
  }
  return ov.partners.map((partner) => ({
    partner,
    clientes: (clientesByPartner.get(partner.id) ?? []).map((cliente) => ({
      cliente,
      sites: sitesByCliente.get(cliente.id) ?? [],
    })),
  }));
}

function SiteRow({ site, onOpen }: { site: Site; onOpen: (s: Site) => void }) {
  return (
    <button className="cp-site-row" onClick={() => onOpen(site)}>
      <span className="cp-site-row__name">{site.nome}</span>
      {site.online ? (
        <Badge tone="online">ONLINE</Badge>
      ) : (
        <Badge tone="offline">OFFLINE</Badge>
      )}
      <Badge tone={site.alarms24h > 0 ? "alarm" : "neutral"}>
        {site.alarms24h} alarme{site.alarms24h === 1 ? "" : "s"} (24h)
      </Badge>
    </button>
  );
}

export function Fleet({ onOpenSite }: { onOpenSite: (site: Site) => void }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; overview: Overview }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    getOverview()
      .then((ov) => alive && setState({ kind: "ready", overview: ov }))
      .catch((err) => {
        if (!alive) return;
        // 401 já é tratado no api.ts (volta ao login); não sobrescreve com mensagem.
        if (err instanceof ApiError && err.status === 401) return;
        setState({
          kind: "error",
          message: err instanceof ApiError ? err.message : "falha ao carregar a frota",
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "loading") return <Loading label="Carregando a frota…" />;
  if (state.kind === "error") return <ErrorState message={state.message} />;

  const grouped = groupSites(state.overview);
  const totalSites = state.overview.sites.length;

  if (totalSites === 0) {
    return <EmptyState>Nenhum site no seu escopo ainda.</EmptyState>;
  }

  return (
    <div>
      {grouped.map(({ partner, clientes }) => {
        const hasSites = clientes.some((c) => c.sites.length > 0);
        if (!hasSites) return null;
        return (
          <section className="cp-tree-partner" key={partner.id}>
            <h2>{partner.nome}</h2>
            {clientes.map(({ cliente, sites }) =>
              sites.length === 0 ? null : (
                <div className="cp-tree-cliente" key={cliente.id}>
                  <h3>{cliente.nome}</h3>
                  {sites.map((s) => (
                    <SiteRow key={s.id} site={s} onOpen={onOpenSite} />
                  ))}
                </div>
              ),
            )}
          </section>
        );
      })}
    </div>
  );
}
