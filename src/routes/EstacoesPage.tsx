import { useCallback, useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import { useAuth } from "../auth";
import {
  PageHeader,
  Badge,
  EmptyState,
  Spinner,
  Alert,
  Button,
  Input,
  Field,
  Switch,
  Table,
  useConfirm,
} from "../ui";
import { getBtStations, updateBtStation, deleteBtStation, type BtStation } from "../api";

// Cadastro das ESTAÇÕES BLE (os celulares/coletores que varrem o BLE e postam as leituras).
// A estação NÃO nasce de um formulário: ela se AUTO-DESCOBRE no hub (server/bt/stations.js → seen)
// no primeiro POST /api/bt/reading, com o id técnico como nome ("pendente"). Esta tela é onde o
// operador a BATIZA ("Doca 3"), (des)ativa e remove — e onde vê se ela está VIVA.
// A REGRA DE NEGÓCIO mora no SERVIDOR (formato do id, nome ≤ 60, ativo booleano): a tela envia e
// exibe o erro do 400. Escrita gated por canConfigure; leitura livre p/ autenticados (a saúde e a
// calibração precisam do nome amigável). LGPD: só metadados de config.

// Janela de staleness: RÉPLICA de STALE_MS de server/bt/bt-readings.js (15 s — a leitura mais velha
// que isso já sumiu do snapshot do hub). Mesmo limiar aqui ⇒ "SEM SINAL" na tela == sumiu do hub.
const STALE_MS = 15_000;
const REFRESH_MS = 5000; // repesca o registro (ultimaVezEm é carimbado a cada POST da estação)

const fmtData = (ms: number) =>
  ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";

// "há 3 s" / "há 4 min" / "há 2 h" — leitura humana do último POST (going-gray: texto, não cor).
function haQuantoTempo(ms: number, agora: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((agora - ms) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return `há ${Math.round(s / 3600)} h`;
}

export function EstacoesPage() {
  const { canConfigure } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<BtStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState("");
  const [saving, setSaving] = useState(false);
  // Tick do relógio: o status VIVA/SEM SINAL é derivado de `ultimaVezEm` — sem re-render periódico
  // uma estação que morre ficaria "viva" na tela até o próximo poll.
  const [agora, setAgora] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setRows(await getBtStations());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao carregar as estações");
    }
    setAgora(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function salvarNome(s: BtStation) {
    const nome = editNome.trim();
    if (!nome) return;
    setSaving(true);
    setErr(null);
    try {
      await updateBtStation(s.id, { nome });
      setEditId(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao renomear a estação");
    } finally {
      setSaving(false);
    }
  }

  async function alternarAtivo(s: BtStation, ativo: boolean) {
    setErr(null);
    try {
      await updateBtStation(s.id, { ativo });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao atualizar a estação");
    }
  }

  async function remover(s: BtStation) {
    const ok = await confirm({
      title: `Remover a estação "${s.nome}"?`,
      description:
        "O registro (nome amigável) é apagado. Se o celular voltar a postar, a estação reaparece aqui com o id técnico, pendente de nome.",
      confirmLabel: "Remover",
      variant: "danger",
    });
    if (!ok) return;
    setErr(null);
    try {
      await deleteBtStation(s.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao remover a estação");
    }
  }

  const vivas = rows.filter((s) => agora - s.ultimaVezEm <= STALE_MS).length;

  return (
    <div className="page">
      <PageHeader
        title="Estações BLE"
        subtitle="Os celulares que varrem as tags e enviam as leituras ao hub. Cadastro automático: a estação aparece aqui sozinha ao postar — dê um nome a ela."
      >
        {rows.length > 0 && (
          <Badge tone={vivas > 0 ? "ok" : "warn"}>
            <RadioTower size={12} strokeWidth={1.75} aria-hidden />
            {vivas} de {rows.length} viva{vivas === 1 ? "" : "s"}
          </Badge>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {err && <Alert tone="alert">{err}</Alert>}

        {loading ? (
          <div className="flex items-center gap-2 text-sec text-text-muted">
            <Spinner /> Carregando estações…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState>
            <RadioTower size={22} strokeWidth={1.5} aria-hidden />
            Nenhuma estação ainda — instale o app no celular e aponte para este hub; ela aparece aqui
            sozinha.
          </EmptyState>
        ) : (
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
                const viva = agora - s.ultimaVezEm <= STALE_MS;
                const pendente = s.nome === s.id; // ainda com o id técnico como nome
                const editando = editId === s.id;
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
                                if (e.key === "Enter") salvarNome(s);
                                if (e.key === "Escape") setEditId(null);
                              }}
                            />
                          </Field>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={saving || !editNome.trim()}
                            onClick={() => salvarNome(s)}
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
                            onCheckedChange={(v) => alternarAtivo(s, v)}
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
                          <Button size="sm" variant="ghost" onClick={() => remover(s)}>
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
        )}
      </div>
    </div>
  );
}
