import { type Dispatch, type SetStateAction } from "react";
import { useAuth } from "../../auth";
import {
  Button,
  IconButton,
  Input,
  Select,
  Switch,
  ScrollArea,
  Skeleton,
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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
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
  }
  async function onPatch(
    id: string,
    patch: Partial<{ ativo: boolean; papel: string; senha: string }>,
  ) {
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
  }
  async function onReset(u: AdminUser) {
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
            <IconButton
              label="Gerar senha"
              onClick={() => setNovo((n) => ({ ...n, senha: genSenha() }))}
            >
              🎲
            </IconButton>
          </span>
          <Select
            value={novo.papel}
            onChange={(v) => setNovo((n) => ({ ...n, papel: v }))}
            options={PAPEL_OPTS}
            ariaLabel="Papel"
          />
          <Button variant="primary" type="submit" disabled={!novo.usuario.trim()}>
            Criar
          </Button>
        </form>
      </section>

      {/* Lista cresce com a viewport (flex-1 + min-h-0 na cadeia; scroll interno na ScrollArea)
          — nada de max-h fixo em conteúdo (plano de padronização visual). */}
      <section className="panel panel-events flex flex-1 flex-col">
        <SectionTitle>{loading ? "Carregando…" : `${rows.length} usuário(s)`}</SectionTitle>
        <ScrollArea orientation="both" className="min-h-[200px] flex-1">
          <table className="rtable">
            <thead>
              <tr>
                {/* Usuário absorve a largura livre (some a faixa morta); demais colunas compactas. */}
                <th className="w-full">Usuário</th>
                <th className="whitespace-nowrap">Papel</th>
                <th className="whitespace-nowrap">Status</th>
                <th className="whitespace-nowrap text-right">Ações</th>
              </tr>
            </thead>
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
                      onChange={(v) => onPatch(u.id, { papel: v })}
                      options={PAPEL_OPTS}
                      ariaLabel="Papel"
                    />
                  </td>
                  <td>
                    <div className="cell-toggle">
                      <Switch
                        checked={u.ativo}
                        onCheckedChange={(v) => onPatch(u.id, { ativo: v })}
                        ariaLabel="ativo"
                      />
                      <span>{u.ativo ? "Ativo" : "Inativo"}</span>
                    </div>
                  </td>
                  <td className="users-actions justify-end whitespace-nowrap">
                    <Button size="sm" onClick={() => onReset(u)}>
                      Resetar senha
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => onDelete(u)}
                      disabled={u.id === user.id}
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
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-note">
                    Nenhum usuário.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollArea>
      </section>
    </>
  );
}
