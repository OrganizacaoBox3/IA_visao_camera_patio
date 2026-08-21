import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth";
import { Tabs, TabsContent, EmptyState, Alert, PageHeader, IconButton } from "../ui";
import { listDvrs, listDvrAuditoria, type DvrItem, type DvrAuditItem } from "../api";
import { DvrsTab } from "./dvrs/DvrsTab";
import { AuditoriaTab } from "./dvrs/AuditoriaTab";

// Painel do suporte (ponte-dvr): lista os DVRs por cliente + auditoria de acessos. Molde:
// UsersPage (admin superadmin — lista + ações + auditoria). O poll dos DVRs vive no PAI (segue
// atualizando o status de sessão mesmo com a aba de Auditoria à frente); o estado que cruza abas
// (rows/audit/err/secao) fica aqui porque as abas Radix desmontam o painel inativo.
const POLL_MS = 15_000; // status de sessão muda no site (o coletor abre/fecha) sem avisar o hub

export function DvrsPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<DvrItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<DvrAuditItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [secao, setSecao] = useState<"dvrs" | "auditoria">("dvrs");

  async function refresh() {
    setErr(null);
    try {
      setRows(await listDvrs());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha ao carregar os DVRs.");
    }
    setLoading(false);
  }
  async function refreshAudit() {
    try {
      setAudit(await listDvrAuditoria());
    } catch {
      // Auditoria é secundária: falha aqui não derruba a tela (o Alert principal é dos DVRs).
    }
    setAuditLoading(false);
  }

  useEffect(() => {
    if (user.papel !== "superadmin") {
      setLoading(false);
      setAuditLoading(false);
      return;
    }
    refresh();
    refreshAudit();
    const t = setInterval(refresh, POLL_MS); // poll leve só da lista de DVRs (status de sessão)
    return () => clearInterval(t);
  }, [user.papel]);

  if (user.papel !== "superadmin") {
    return (
      <div className="page">
        <PageHeader title="DVRs" />
        <EmptyState>Acesso restrito ao superadmin.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="DVRs" subtitle="Acesso remoto de suporte aos DVRs por cliente">
        <IconButton
          label="Atualizar"
          onClick={() => {
            refresh();
            refreshAudit();
          }}
        >
          <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </PageHeader>

      {/* Cadeia flex (page → body → tabs → painel): a lista cresce com a viewport (scroll interno
          na ScrollArea da Table — a página nunca ganha scroll-x). */}
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] overflow-auto p-[var(--sp-4)]">
        {err && <Alert tone="alert">{err}</Alert>}

        <Tabs
          className="min-h-0 flex-1"
          items={[
            { value: "dvrs", label: "DVRs" },
            { value: "auditoria", label: "Auditoria" },
          ]}
          value={secao}
          onValueChange={(v) => setSecao(v as typeof secao)}
          ariaLabel="Seção de DVRs"
        >
          <TabsContent
            value="dvrs"
            className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] pt-[var(--sp-4)]"
          >
            <DvrsTab rows={rows} loading={loading} refresh={refresh} setErr={setErr} />
          </TabsContent>

          <TabsContent
            value="auditoria"
            className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] pt-[var(--sp-4)]"
          >
            <AuditoriaTab rows={audit} loading={auditLoading} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
