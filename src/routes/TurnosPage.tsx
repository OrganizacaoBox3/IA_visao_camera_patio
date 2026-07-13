import { useEffect, useState } from "react";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
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
  ToggleGroup,
  Switch,
  useConfirm,
  useToast,
} from "../ui";
import {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
  type Shift,
  type ShiftPausa,
} from "../api";

// Cadastro GLOBAL de turnos (spec-turnos-por-zona F1): a fonte única do "quando a área deveria
// estar trabalhando". Cada turno = nome + dias da semana em que INICIA (D1/D5) + início/fim
// wall-clock (fim ≤ início ⇒ +1 dia — D2, a UI só MOSTRA o "+1 dia") + pausas dentro da janela
// (D3). A REGRA DE NEGÓCIO mora no servidor (server/shifts.js): esta tela não revalida — envia
// e exibe o erro do 400. Escrita gated por canConfigure (leitura livre p/ autenticados).

const DIA_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const DIA_LONGO = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];
const DIA_ITEMS = DIA_CURTO.map((label, i) => ({
  value: String(i),
  label,
  ariaLabel: DIA_LONGO[i],
}));

// Estado do formulário (criar/editar). duracaoMin fica como string (valor cru do input);
// a conversão acontece no submit e a validação, no servidor.
type FormPausa = { inicio: string; duracaoMin: string };
type Form = {
  id: string | null; // null = criando; senão editando este turno
  nome: string;
  dias: string[];
  inicio: string;
  fim: string;
  pausas: FormPausa[];
};
const FORM_VAZIO: Form = { id: null, nome: "", dias: [], inicio: "", fim: "", pausas: [] };

// "+1 dia" (D2): fim ≤ início ⇒ o turno termina no dia seguinte. Comparação lexicográfica
// funciona porque input[type=time] devolve sempre "HH:MM". É APRESENTAÇÃO, não validação.
const viraDia = (inicio: string, fim: string) => !!inicio && !!fim && fim <= inicio;

function horarioLabel(s: Shift): string {
  return `${s.inicio}–${s.fim}${viraDia(s.inicio, s.fim) ? " (+1 dia)" : ""}`;
}
function pausasLabel(pausas: ShiftPausa[]): string {
  return pausas.map((p) => `${p.inicio} (${p.duracaoMin}min)`).join(" · ");
}

export function TurnosPage() {
  const { canConfigure } = useAuth();
  const confirm = useConfirm();
  // Feedback em UM padrão só (DoD §3): TOAST no sucesso da ação, Alert no erro de página.
  const { toast } = useToast();
  const [rows, setRows] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      setRows(await getShifts());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao carregar turnos");
    }
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);

  function openCreate() {
    setErr(null);
    setForm({ ...FORM_VAZIO });
  }
  function openEdit(s: Shift) {
    setErr(null);
    setForm({
      id: s.id,
      nome: s.nome,
      dias: s.dias.map(String),
      inicio: s.inicio,
      fim: s.fim,
      pausas: s.pausas.map((p) => ({ inicio: p.inicio, duracaoMin: String(p.duracaoMin) })),
    });
  }

  // Envia como o usuário digitou — a validação (duração/dias/pausas) é do SERVIDOR; o 400
  // volta com mensagem clara e fica no Alert, com o formulário aberto para corrigir.
  async function submit() {
    if (!form) return;
    setSaving(true);
    setErr(null);
    const body = {
      nome: form.nome,
      dias: form.dias.map(Number),
      inicio: form.inicio,
      fim: form.fim,
      pausas: form.pausas.map((p) => ({ inicio: p.inicio, duracaoMin: Number(p.duracaoMin) })),
    };
    const editando = !!form.id;
    try {
      if (form.id) await updateShift(form.id, body);
      else await createShift(body);
      setForm(null);
      toast(editando ? "Turno salvo." : `Turno "${body.nome}" criado.`, "ok");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao salvar turno");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAtivo(s: Shift, ativo: boolean) {
    setErr(null);
    try {
      await updateShift(s.id, { ativo });
      toast(`Turno "${s.nome}" ${ativo ? "ativado" : "desativado"}.`, "ok");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao atualizar turno");
    }
  }

  async function removeShift(s: Shift) {
    const ok = await confirm({
      title: `Remover o turno "${s.nome}"?`,
      description: "Zonas que apontam para este turno voltam a valer 24/7 nessa janela.",
      confirmLabel: "Remover",
      variant: "danger",
    });
    if (!ok) return;
    setErr(null);
    try {
      await deleteShift(s.id);
      toast(`Turno "${s.nome}" removido.`, "ok");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao remover turno");
    }
  }

  const setPausa = (i: number, patch: Partial<FormPausa>) =>
    setForm((f) =>
      f ? { ...f, pausas: f.pausas.map((p, j) => (j === i ? { ...p, ...patch } : p)) } : f,
    );

  return (
    <div className="page">
      <PageHeader
        title="Turnos"
        subtitle="Quando cada área deveria estar trabalhando — cadastre aqui e atribua às zonas."
      >
        {canConfigure && !form && (
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus size={15} strokeWidth={1.75} aria-hidden /> Novo turno
          </Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {err && <Alert tone="alert">{err}</Alert>}

        {/* ── Formulário (criar/editar) ─────────────────────────────────── */}
        {form && (
          <form
            className="flex flex-col gap-3 rounded-sm border border-border bg-panel-2 p-3"
            aria-label={form.id ? "Editar turno" : "Novo turno"}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Nome" htmlFor="turno-nome" className="w-56">
                <Input
                  id="turno-nome"
                  value={form.nome}
                  placeholder='ex.: "Turno 1", "Madrugada"'
                  autoFocus
                  onChange={(e) => setForm({ ...form, nome: e.target.value })}
                />
              </Field>
              <Field label="Início" htmlFor="turno-inicio">
                <Input
                  id="turno-inicio"
                  type="time"
                  className="min-w-0 w-28"
                  value={form.inicio}
                  onChange={(e) => setForm({ ...form, inicio: e.target.value })}
                />
              </Field>
              <Field
                label="Fim"
                htmlFor="turno-fim"
                hint={viraDia(form.inicio, form.fim) ? "+1 dia (termina no dia seguinte)" : undefined}
              >
                <Input
                  id="turno-fim"
                  type="time"
                  className="min-w-0 w-28"
                  value={form.fim}
                  onChange={(e) => setForm({ ...form, fim: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Dias da semana em que o turno inicia">
              <ToggleGroup
                type="multiple"
                ariaLabel="Dias da semana em que o turno inicia"
                items={DIA_ITEMS}
                value={form.dias}
                onValueChange={(dias) => setForm({ ...form, dias })}
              />
            </Field>

            <Field label="Pausas (almoço/café — zona vazia é esperada)">
              <div className="flex flex-col gap-2">
                {form.pausas.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      type="time"
                      className="min-w-0 w-28"
                      aria-label={`Início da pausa ${i + 1}`}
                      value={p.inicio}
                      onChange={(e) => setPausa(i, { inicio: e.target.value })}
                    />
                    <Input
                      type="number"
                      min={1}
                      className="min-w-0 w-24"
                      aria-label={`Duração da pausa ${i + 1} em minutos`}
                      placeholder="min"
                      value={p.duracaoMin}
                      onChange={(e) => setPausa(i, { duracaoMin: e.target.value })}
                    />
                    <span className="text-sec text-text-muted">min</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remover pausa ${i + 1}`}
                      onClick={() =>
                        setForm({ ...form, pausas: form.pausas.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm({ ...form, pausas: [...form.pausas, { inicio: "", duracaoMin: "" }] })
                    }
                  >
                    <Plus size={14} strokeWidth={1.75} aria-hidden /> Adicionar pausa
                  </Button>
                </div>
              </div>
            </Field>

            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? "Salvando…" : form.id ? "Salvar turno" : "Criar turno"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}

        {/* ── Lista ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div
            className="flex items-center gap-2 text-body text-text-muted"
            aria-busy="true"
            aria-label="Carregando turnos"
          >
            <Spinner /> Carregando turnos…
          </div>
        ) : rows.length === 0 && !form ? (
          <EmptyState>
            <CalendarClock size={22} strokeWidth={1.5} aria-hidden />
            Nenhum turno cadastrado. Sem turno atribuído, toda zona vale 24/7 (comportamento
            atual).
            {canConfigure && (
              <Button variant="primary" size="sm" onClick={openCreate}>
                <Plus size={15} strokeWidth={1.75} aria-hidden /> Criar o primeiro turno
              </Button>
            )}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Turnos cadastrados">
            {rows.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-panel-2 px-3 py-2"
                style={{ opacity: s.ativo ? 1 : 0.55 }}
              >
                <span
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-panel text-text-dim"
                  aria-hidden
                >
                  <CalendarClock size={15} strokeWidth={1.75} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-title font-medium text-text">
                    <span className="truncate">{s.nome}</span>
                    {!s.ativo && <Badge>inativo</Badge>}
                  </span>
                  <span className="text-label text-text-muted">
                    {s.dias.map((d) => DIA_CURTO[d]).join(" · ")} · {horarioLabel(s)}
                    {s.pausas.length > 0 && <> · pausas: {pausasLabel(s.pausas)}</>}
                  </span>
                </div>
                {canConfigure && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={s.ativo}
                      onCheckedChange={(v) => toggleAtivo(s, v)}
                      ariaLabel={`Turno ${s.nome} ativo`}
                    />
                    <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>
                      editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => removeShift(s)}>
                      remover
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
