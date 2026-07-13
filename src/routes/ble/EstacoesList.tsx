import { useState } from "react";
import { RadioTower } from "lucide-react";
import { Badge, Button, EmptyState, Field, Input, SectionTitle, Switch, Table } from "../../ui";
import type { BtStation } from "../../api";

// APRESENTAÇÃO da lista de estações BLE (a aba Estações da tela BLE). Zero rede, zero contexto:
// recebe as linhas + o relógio + a CAPACIDADE (canConfigure) e devolve markup — por isso é
// testável em Vitest (renderToStaticMarkup, o padrão de src/ui/Panel.test.tsx).
//
// POR QUE ISTO É UM ARQUIVO SEPARADO (e não o corpo do EstacoesTab): o RBAC desta aba deixou de ser
// protegido pela ROTA (a /estacoes morreu na unificação — spec-arquitetura-informacao §3) e passou a
// ser protegido AQUI DENTRO. Um gate que vive dentro de um componente que só monta com socket/fetch/
// contexto é um gate que ninguém testa. Separando a apresentação, o gate vira asserção:
// `EstacoesList.test.tsx` quebra o build se um controle de escrita vazar para quem não configura.
//
// Estado LOCAL (só de UI): qual linha está em edição de nome. O salvamento é do container — ele
// devolve `true` quando gravou (e só então o editor fecha).

// Janela de staleness: RÉPLICA de STALE_MS de server/bt/bt-readings.js (15 s — a leitura mais velha
// que isso já sumiu do snapshot do hub). Mesmo limiar aqui ⇒ "SEM SINAL" na tela == sumiu do hub.
export const STALE_MS = 15_000;

const fmtData = (ms: number) =>
  ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

// "há 3 s" / "há 4 min" / "há 2 h" — leitura humana do último POST (going-gray: texto, não cor).
export function haQuantoTempo(ms: number, agora: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((agora - ms) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return `há ${Math.round(s / 3600)} h`;
}

/** Estação viva = postou dentro da janela de staleness do hub. PURA (usada na tela e no teste). */
export function estacaoViva(s: BtStation, agora: number): boolean {
  return agora - s.ultimaVezEm <= STALE_MS;
}

export type EstacoesListProps = {
  rows: BtStation[];
  /** Relógio do container (tick de 5 s) — deriva VIVA/SEM SINAL sem re-render próprio. */
  agora: number;
  /** Capacidade de CONFIGURAÇÃO (engenheiro/superadmin). Falso ⇒ leitura pura, sem controle algum. */
  canConfigure: boolean;
  /** Grava o nome. Resolve `true` quando gravou (o editor fecha); `false` mantém o editor aberto. */
  onRename: (s: BtStation, nome: string) => Promise<boolean>;
  onToggleAtivo: (s: BtStation, ativo: boolean) => void;
  onRemove: (s: BtStation) => void;
};

export function EstacoesList({
  rows,
  agora,
  canConfigure,
  onRename,
  onToggleAtivo,
  onRemove,
}: EstacoesListProps) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState("");
  const [saving, setSaving] = useState(false);

  async function salvar(s: BtStation) {
    const nome = editNome.trim();
    if (!nome) return;
    setSaving(true);
    const ok = await onRename(s, nome);
    setSaving(false);
    if (ok) setEditId(null);
  }

  if (rows.length === 0) {
    return (
      <EmptyState>
        <RadioTower size={22} strokeWidth={1.5} aria-hidden />
        Nenhuma estação ainda — instale o app no celular e aponte para este hub; ela aparece aqui
        sozinha.
      </EmptyState>
    );
  }

  return (
    <>
      <Table
        ariaLabel="Estações BLE"
        className="flex-1"
        columns={[
          { label: "Estação", className: "w-full" },
          { label: "Status", className: "whitespace-nowrap" },
          { label: "Última leitura", className: "whitespace-nowrap" },
          { label: "Primeira vez", className: "whitespace-nowrap" },
          ...(canConfigure
            ? [
                { label: "Ativa", className: "whitespace-nowrap" },
                { label: "Ações", className: "whitespace-nowrap text-right" },
              ]
            : []),
        ]}
      >
        <tbody>
          {rows.map((s) => {
            const viva = estacaoViva(s, agora);
            const pendente = s.nome === s.id; // ainda com o id técnico como nome
            const editando = canConfigure && editId === s.id;
            return (
              <tr key={s.id} style={{ opacity: s.ativo ? 1 : 0.55 }}>
                <td>
                  {editando ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label="Nome da estação" htmlFor={`est-nome-${s.id}`}>
                        <Input
                          id={`est-nome-${s.id}`}
                          value={editNome}
                          placeholder='ex.: "Doca 3", "Expedição"'
                          autoFocus
                          onChange={(e) => setEditNome(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") salvar(s);
                            if (e.key === "Escape") setEditId(null);
                          }}
                        />
                      </Field>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={saving || !editNome.trim()}
                        onClick={() => salvar(s)}
                      >
                        {saving ? "Salvando…" : "Salvar"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 text-body font-medium text-text">
                        <span className="truncate">{s.nome}</span>
                        {pendente && <Badge tone="info">sem nome</Badge>}
                        {!s.ativo && <Badge>inativa</Badge>}
                      </span>
                      {/* id TÉCNICO (o que o app manda): informação de suporte, nunca o rótulo. */}
                      <span className="text-micro text-text-muted">{s.id}</span>
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <Badge tone={viva ? "ok" : "warn"}>{viva ? "viva" : "sem sinal"}</Badge>
                </td>
                <td className="whitespace-nowrap text-label text-text-dim">
                  {haQuantoTempo(s.ultimaVezEm, agora)}
                </td>
                <td className="whitespace-nowrap text-label text-text-dim">
                  {fmtData(s.primeiraVezEm)}
                </td>
                {canConfigure && (
                  <>
                    <td className="whitespace-nowrap">
                      <Switch
                        checked={s.ativo}
                        onCheckedChange={(v) => onToggleAtivo(s, v)}
                        ariaLabel={`Estação ${s.nome} ativa`}
                      />
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {!editando && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditId(s.id);
                            setEditNome(pendente ? "" : s.nome);
                          }}
                        >
                          {pendente ? "nomear" : "renomear"}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => onRemove(s)}>
                        remover
                      </Button>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>

      {/* SOMENTE-LEITURA explícito (mesmo padrão da AlarmHealthPage): antes o operador que abrisse
          /estacoes via a tabela sem os botões e sem NENHUMA explicação. Agora a tela DIZ por quê —
          e a ausência de controle deixa de parecer bug. Informação por TEXTO, nunca só por cor. */}
      {!canConfigure && (
        <section className="flex flex-col gap-1">
          <SectionTitle flush>Configuração das estações</SectionTitle>
          <EmptyState>
            Somente perfis de configuração (engenheiro/superadmin) podem nomear, desativar ou
            remover uma estação. Você está em modo somente-leitura.
          </EmptyState>
        </section>
      )}
    </>
  );
}
