import { useMemo, useState } from "react";
import { Select, Skeleton, Table, TableEmpty, SectionTitle } from "../../ui";
import type { DvrAuditItem } from "../../api";

// Aba "Auditoria" do painel do suporte: trilha append-only (contratos §4/§5) — quem fez o quê,
// quando e em qual coletor. Só metadados (LGPD/invariante 6). Read-only. O filtro por coletor é
// feito NO CLIENTE a partir dos coletores presentes nos eventos já carregados (o endpoint também
// aceita `?coletor=`, mas filtrar aqui evita um ida-e-volta e não perde o histórico já em mãos).

// Rótulos amigáveis das ações conhecidas (contratos §4/§5); ação desconhecida cai no valor cru.
const ACAO_LABEL: Record<string, string> = {
  "sessao.abrir": "Abriu acesso",
  "sessao.encerrar": "Encerrou acesso",
  "sessao.timeout": "Acesso expirou (timeout)",
  "acesso.tecnico": "Acesso do técnico",
  "dvr.registrar": "Registrou DVR",
  "dvr.atualizar": "Atualizou DVR",
};
const acaoLabel = (a: string) => ACAO_LABEL[a] ?? a;

type Props = {
  rows: DvrAuditItem[];
  loading: boolean;
};

// Sentinela do filtro "todos" — NÃO pode ser "" (Radix Select proíbe value vazio em Item).
const TODOS = "__todos__";

export function AuditoriaTab({ rows, loading }: Props) {
  const [coletor, setColetor] = useState<string>(TODOS);

  // Coletores presentes nos eventos → opções do filtro (dedup + ordenado).
  const coletorOpts = useMemo(() => {
    const ids = Array.from(
      new Set(rows.map((r) => r.coletor_id).filter((v): v is string => Boolean(v))),
    ).sort((a, b) => a.localeCompare(b, "pt-BR"));
    return [
      { value: TODOS, label: "Todos os coletores" },
      ...ids.map((id) => ({ value: id, label: id })),
    ];
  }, [rows]);

  // Filtra por coletor (quando escolhido) e ordena por "quando" desc (o servidor já manda desc;
  // reordenar aqui é defensivo e barato).
  const view = useMemo(
    () =>
      rows
        .filter((r) => coletor === TODOS || r.coletor_id === coletor)
        .slice()
        .sort((a, b) => b.ts - a.ts),
    [rows, coletor],
  );

  return (
    <section className="panel panel-events flex flex-1 flex-col" aria-busy={loading}>
      <div className="flex items-center justify-between gap-[var(--sp-3)]">
        <SectionTitle>
          {view.length} {view.length === 1 ? "evento" : "eventos"}
        </SectionTitle>
        <Select
          value={coletor}
          onChange={setColetor}
          options={coletorOpts}
          ariaLabel="Filtrar por coletor"
        />
      </div>
      <Table
        ariaLabel="Auditoria de acessos aos DVRs"
        className="min-h-[200px] flex-1"
        columns={[
          { label: "Quando", className: "whitespace-nowrap" },
          { label: "Ação", className: "whitespace-nowrap" },
          { label: "Ator", className: "w-full" },
          { label: "Coletor", className: "whitespace-nowrap" },
        ]}
      >
        <tbody>
          {view.map((r) => (
            <tr key={r.id}>
              <td className="mono whitespace-nowrap">
                {new Date(r.ts).toLocaleString("pt-BR")}
              </td>
              <td className="whitespace-nowrap">{acaoLabel(r.acao)}</td>
              <td>{r.ator ?? <span className="muted">—</span>}</td>
              <td className="mono whitespace-nowrap">
                {r.coletor_id ?? <span className="muted">—</span>}
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
          {!loading && view.length === 0 && (
            <TableEmpty colSpan={4}>Nenhum evento de auditoria.</TableEmpty>
          )}
        </tbody>
      </Table>
    </section>
  );
}
