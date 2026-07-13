import { useState, type Dispatch, type SetStateAction } from "react";
import { Dices } from "lucide-react";
import { useAuth } from "../../auth";
import {
  Button,
  IconButton,
  Input,
  Select,
  Switch,
  Skeleton,
  Table,
  TableEmpty,
  useConfirm,
  useToast,
  SectionTitle,
} from "../../ui";
import { createUser, patchUser, deleteUser, type AdminUser } from "../../api";
import type { ConfirmRemove, NovoUser, Reveal } from "./types";

// Papéis atribuíveis (RBAC Setup × Live — Onda C item 12). "engenheiro" = equipe de configuração
// (pode editar thresholds/zonas); "usuario" = operador só-visualização; "superadmin" = acesso total.
const PAPEL_OPTS = [
  { value: "usuario", label: "Usuário" },
  { value: "engenheiro", label: "Engenheiro" },
  { value: "superadmin", label: "Superadmin" },
];

// Hierarquia de privilégio p/ decidir quando a troca de papel é ELEVAÇÃO (exige confirmação).
const PAPEL_RANK: Record<string, number> = { usuario: 0, engenheiro: 1, superadmin: 2 };
const PAPEL_LABEL: Record<string, string> = Object.fromEntries(
  PAPEL_OPTS.map((o) => [o.value, o.label]),
);

// Senha só por hash no servidor — ao criar/resetar, a senha aparece UMA vez para o superadmin
// repassar (modelo de reset seguro).
function genSenha(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789"; // sem caracteres ambíguos
  let s = "";
  for (let i = 0; i < 10; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

type Props = {
  rows: AdminUser[];
  loading: boolean;
  novo: NovoUser;
  setNovo: Dispatch<SetStateAction<NovoUser>>;
  refresh: () => Promise<void>;
  setErr: Dispatch<SetStateAction<string | null>>;
  setReveal: Dispatch<SetStateAction<Reveal | null>>;
  setConfirmRemove: Dispatch<SetStateAction<ConfirmRemove | null>>;
};

export function UsersTab({
  rows,
  loading,
  novo,
  setNovo,
  refresh,
  setErr,
  setReveal,
  setConfirmRemove,
}: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Trava dupla submissão / mutações concorrentes (padrão da casa — IpCamerasSection):
  // sem ela, clique duplo em "Criar" criava usuário DUPLICADO (integridade, não estética).
  const [busy, setBusy] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    const senha = novo.senha.trim() || genSenha();
    try {
      await createUser({ usuario: novo.usuario.trim(), senha, papel: novo.papel });
      setReveal({ usuario: novo.usuario.trim(), senha });
      setNovo({ usuario: "", senha: "", papel: "usuario" });
      await refresh();
      toast("Usuário criado.", "ok");
    } catch (e2) {
      const m = e2 instanceof Error ? e2.message : "Falha ao criar usuário.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }
  async function onPatch(
    id: string,
    patch: Partial<{ ativo: boolean; papel: string; senha: string }>,
  ) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await patchUser(id, patch);
      await refresh();
      toast("Usuário atualizado.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha ao atualizar.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }
  // Troca de papel com assimetria de risco corrigida: ELEVAR (ganhar privilégio) exige
  // confirmação — antes aplicava na hora, enquanto REMOVER confirmava (risco invertido).
  // Decisão documentada: REBAIXAR terceiros aplica direto (reversível em 1 clique e não
  // amplia poder); auto-rebaixamento também confirma (te tranca fora desta tela).
  async function onChangePapel(u: AdminUser, papel: string) {
    if (papel === u.papel) return;
    const elevando = (PAPEL_RANK[papel] ?? 0) > (PAPEL_RANK[u.papel] ?? 0);
    const autoRebaixando = !elevando && u.id === user.id;
    if (elevando) {
      const ok = await confirm({
        title: `Promover a ${PAPEL_LABEL[papel] ?? papel}?`,
        description: `"${u.usuario}" passará a ter os poderes de ${PAPEL_LABEL[papel] ?? papel}${
          papel === "superadmin" ? " — acesso total, incluindo gestão de usuários" : ""
        }.`,
        confirmLabel: "Promover",
        variant: "default",
      });
      if (!ok) return; // Select controlado volta ao papel atual (rows não mudou)
    } else if (autoRebaixando) {
      const ok = await confirm({
        title: "Rebaixar o próprio papel?",
        description: "Você perderá o acesso a esta tela de administração imediatamente.",
        confirmLabel: "Rebaixar",
        variant: "danger",
      });
      if (!ok) return;
    }
    await onPatch(u.id, { papel });
  }
  async function onReset(u: AdminUser) {
    if (busy) return;
    setBusy(true);
    const senha = genSenha();
    setErr(null);
    try {
      await patchUser(u.id, { senha });
      setReveal({ usuario: u.usuario, senha });
      toast("Senha redefinida.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha ao resetar.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }
  function onDelete(u: AdminUser) {
    // window.confirm → AlertDialog (variant danger): só remove ao confirmar.
    setConfirmRemove({
      title: "Remover usuário?",
      description: `O usuário "${u.usuario}" será removido permanentemente.`,
      run: () => doDeleteUser(u),
    });
  }
  async function doDeleteUser(u: AdminUser) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteUser(u.id);
      await refresh();
      toast("Usuário removido.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha ao remover.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }

  return (
    <>
      <section className="panel shrink-0">
        <SectionTitle>Novo usuário</SectionTitle>
        <form className="users-new" onSubmit={onCreate}>
          <Input
            placeholder="Usuário"
            aria-label="Nome do novo usuário"
            value={novo.usuario}
            onChange={(e) => setNovo((n) => ({ ...n, usuario: e.target.value }))}
          />
          <span className="users-pwd">
            <Input
              placeholder="Senha (vazio = gerar)"
              aria-label="Senha do novo usuário (vazio = gerar)"
              value={novo.senha}
              onChange={(e) => setNovo((n) => ({ ...n, senha: e.target.value }))}
            />
            {/* Lucide no lugar do emoji 🎲 (padrão do shell: 18px/1.75/currentColor);
                o nome acessível segue no label do IconButton. */}
            <IconButton
              label="Gerar senha"
              onClick={() => setNovo((n) => ({ ...n, senha: genSenha() }))}
            >
              <Dices size={18} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </span>
          <Select
            value={novo.papel}
            onChange={(v) => setNovo((n) => ({ ...n, papel: v }))}
            options={PAPEL_OPTS}
            ariaLabel="Papel"
          />
          <Button variant="primary" type="submit" disabled={busy || !novo.usuario.trim()}>
            Criar
          </Button>
        </form>
      </section>

      {/* Lista cresce com a viewport (flex-1 + min-h-0 na cadeia; scroll interno na ScrollArea)
          — nada de max-h fixo em conteúdo (plano de padronização visual). */}
      <section className="panel panel-events flex flex-1 flex-col">
        {/* Pluralização real no lugar de "(s)" (achado 8.3). */}
        <SectionTitle>
          {loading ? "Carregando…" : `${rows.length} ${rows.length === 1 ? "usuário" : "usuários"}`}
        </SectionTitle>
        {/* Átomo Table da casa: th scope="col" por construção + rolagem interna (regra A12). */}
        <Table
          ariaLabel="Usuários"
          className="min-h-[200px] flex-1"
          columns={[
            // Usuário absorve a largura livre (some a faixa morta); demais colunas compactas.
            { label: "Usuário", className: "w-full" },
            { label: "Papel", className: "whitespace-nowrap" },
            { label: "Status", className: "whitespace-nowrap" },
            { label: "Ações", className: "whitespace-nowrap text-right" },
          ]}
        >
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.usuario}
                  {u.id === user.id && <span className="muted"> (você)</span>}
                </td>
                <td>
                  <Select
                    value={u.papel}
                    onChange={(v) => onChangePapel(u, v)}
                    options={PAPEL_OPTS}
                    ariaLabel="Papel"
                    disabled={busy}
                  />
                </td>
                <td>
                  <div className="cell-toggle">
                    <Switch
                      checked={u.ativo}
                      onCheckedChange={(v) => onPatch(u.id, { ativo: v })}
                      ariaLabel="ativo"
                      disabled={busy}
                    />
                    <span>{u.ativo ? "Ativo" : "Inativo"}</span>
                  </div>
                </td>
                <td className="users-actions justify-end whitespace-nowrap">
                  <Button size="sm" onClick={() => onReset(u)} disabled={busy}>
                    Resetar senha
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onDelete(u)}
                    disabled={busy || u.id === user.id}
                  >
                    Remover
                  </Button>
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
            {!loading && rows.length === 0 && <TableEmpty colSpan={4}>Nenhum usuário.</TableEmpty>}
          </tbody>
        </Table>
      </section>
    </>
  );
}
