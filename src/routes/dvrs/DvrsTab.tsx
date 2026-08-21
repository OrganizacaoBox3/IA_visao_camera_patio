import { useState, type Dispatch, type SetStateAction } from "react";
import {
  Button,
  Badge,
  StatusDot,
  Skeleton,
  Table,
  TableEmpty,
  SectionTitle,
  useConfirm,
  useToast,
} from "../../ui";
import { encerrarDvrSessao, type DvrItem } from "../../api";

// Aba "DVRs" do painel do suporte: lista os DVRs por cliente (tag `cliente_id`) com marca/modelo/
// ip/status. Molde: UsersTab (tabela + ações + confirm + toast). Ações por linha:
//   • "Abrir DVR" — SÓ com sessão ativa: leva à web do próprio DVR pelo túnel, em NOVA ABA
//     (`https://<hostPublico>`, `rel="noopener noreferrer"` — contratos §5: nunca em iframe; a
//     senha é digitada na tela de login do DVR, nunca trafega/armazena — §8 Leitura A).
//   • "Encerrar" — encerra a sessão de acesso (contratos §4, idempotente) atrás de useConfirm.
// O poll (~15s) e o carregamento vivem no PAI (DvrsPage); aqui só as mutações + o guard de
// dupla-submissão (padrão da casa — sem ele, clique duplo dispara a ação 2×).

type Props = {
  rows: DvrItem[];
  loading: boolean;
  refresh: () => Promise<void>;
  setErr: Dispatch<SetStateAction<string | null>>;
};

// Rótulo do cliente: o nome quando o servidor manda; senão o id (a tag do agrupamento).
const clienteLabel = (d: DvrItem) => d.cliente_nome ?? d.cliente_id;
// Endereço IP:porta do DVR na LAN (porta é opcional no cadastro — contratos §3).
const enderecoDvr = (d: DvrItem) => (d.porta ? `${d.ip}:${d.porta}` : d.ip);
// Sessão ativa ⇒ há túnel e a web do DVR é alcançável em https://<hostPublico> (contratos §4).
const temAcesso = (d: DvrItem) => d.sessao?.status === "ativa" && Boolean(d.sessao.hostPublico);

export function DvrsTab({ rows, loading, refresh, setErr }: Props) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function onEncerrar(d: DvrItem) {
    const sessao = d.sessao;
    if (!sessao) return;
    const ok = await confirm({
      title: "Encerrar acesso ao DVR?",
      description: `O acesso remoto a ${d.marca} ${d.modelo} (${clienteLabel(d)}) será encerrado — o técnico perde a conexão imediatamente.`,
      confirmLabel: "Encerrar",
      variant: "danger",
    });
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await encerrarDvrSessao(sessao.id);
      await refresh();
      toast("Acesso encerrado.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha ao encerrar o acesso.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }

  // Ordena por cliente (mesmo cliente fica junto — "por cliente") e depois por marca/modelo,
  // para uma leitura estável entre polls (evita a lista "pulando" quando o servidor reordena).
  const sorted = [...rows].sort(
    (a, b) =>
      clienteLabel(a).localeCompare(clienteLabel(b), "pt-BR") ||
      `${a.marca} ${a.modelo}`.localeCompare(`${b.marca} ${b.modelo}`, "pt-BR"),
  );

  return (
    <section className="panel panel-events flex flex-1 flex-col" aria-busy={loading}>
      <SectionTitle>
        {rows.length} {rows.length === 1 ? "DVR" : "DVRs"}
      </SectionTitle>
      <Table
        ariaLabel="DVRs por cliente"
        className="min-h-[200px] flex-1"
        columns={[
          { label: "Cliente", className: "whitespace-nowrap" },
          // DVR (marca/modelo) absorve a largura livre; as demais colunas ficam compactas.
          { label: "DVR", className: "w-full" },
          { label: "IP", className: "whitespace-nowrap" },
          { label: "Status", className: "whitespace-nowrap" },
          { label: "Ações", className: "whitespace-nowrap text-right" },
        ]}
      >
        <tbody>
          {sorted.map((d) => {
            const acesso = temAcesso(d);
            return (
              <tr key={d.id}>
                <td className="whitespace-nowrap">
                  <Badge>{clienteLabel(d)}</Badge>
                </td>
                <td>
                  {d.marca} {d.modelo}
                </td>
                <td className="mono whitespace-nowrap">{enderecoDvr(d)}</td>
                <td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-[var(--sp-2)]">
                    <StatusDot
                      tone={acesso ? "ok" : "neutral"}
                      label={acesso ? "Acesso ativo" : "Sem acesso"}
                    />
                    <span className={acesso ? undefined : "muted"}>
                      {acesso ? "Acesso ativo" : "Sem acesso"}
                    </span>
                  </span>
                </td>
                <td className="justify-end whitespace-nowrap">
                  <div className="flex items-center justify-end gap-[var(--sp-2)]">
                    {/* "Abrir DVR" só existe com sessão ativa → NOVA ABA (contratos §5).
                        Sem acesso, um botão desabilitado preserva o affordance sem navegar. */}
                    {acesso ? (
                      <Button asChild size="sm" variant="primary">
                        <a
                          href={`https://${d.sessao!.hostPublico}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Abrir DVR
                        </a>
                      </Button>
                    ) : (
                      <Button size="sm" variant="primary" disabled>
                        Abrir DVR
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onEncerrar(d)}
                      disabled={!acesso || busy}
                    >
                      Encerrar
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
          {loading &&
            Array.from({ length: 3 }).map((_, i) => (
              <tr key={`sk-${i}`}>
                <td colSpan={5}>
                  <Skeleton w="100%" h={16} />
                </td>
              </tr>
            ))}
          {!loading && rows.length === 0 && (
            <TableEmpty colSpan={5}>Nenhum DVR cadastrado.</TableEmpty>
          )}
        </tbody>
      </Table>
    </section>
  );
}
