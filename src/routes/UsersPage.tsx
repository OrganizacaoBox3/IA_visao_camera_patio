import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Button, IconButton, Tabs, TabsContent, AlertDialog, EmptyState, Alert } from "../ui";
import {
  listUsers,
  getCameraEnroll,
  getWaStatus,
  listRecipients,
  getNotifSettings,
  type AdminUser,
  type WaStatus,
  type Recipient,
  type NotifSettings,
} from "../api";
import { UsersTab } from "./users/UsersTab";
import { NotificacoesTab } from "./users/NotificacoesTab";
import { CamerasTab } from "./users/CamerasTab";
import type { ConfirmRemove, NovoUser, Reveal } from "./users/types";

// Painel do superadmin: orquestra as seções (Usuários, Notificações, Câmeras). O estado que
// cruza seções (reveal/err/confirmRemove) e os formulários locais vivem aqui — as abas Radix
// desmontam o painel inativo, então manter o estado no pai preserva o que o usuário digitou ao
// alternar de aba. O carregamento inicial e o polling do WhatsApp (uma instância) ficam no pai.
export function UsersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const [novo, setNovo] = useState<NovoUser>({ usuario: "", senha: "", papel: "usuario" });
  const [camToken, setCamToken] = useState<string | null>(null);
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [waNum, setWaNum] = useState("");
  const [waMsg, setWaMsg] = useState<string | null>(null);
  const [dests, setDests] = useState<Recipient[]>([]);
  const [novoDest, setNovoDest] = useState({ nome: "", numero: "", somenteCriticos: true });
  const [notif, setNotif] = useState<NotifSettings | null>(null);
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [notifMsg, setNotifMsg] = useState<string | null>(null);
  const [secao, setSecao] = useState<"usuarios" | "notificacoes" | "cameras">("usuarios");
  const [confirmRemove, setConfirmRemove] = useState<ConfirmRemove | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setRows(await listUsers());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao carregar");
    }
    setLoading(false);
  }
  useEffect(() => {
    if (user.papel !== "superadmin") {
      setLoading(false);
      return;
    }
    refresh();
    getCameraEnroll()
      .then((r) => setCamToken(r.token))
      .catch(() => {});
    listRecipients()
      .then(setDests)
      .catch(() => {});
    getNotifSettings()
      .then(setNotif)
      .catch(() => {});
    const poll = () =>
      getWaStatus()
        .then(setWa)
        .catch(() => {});
    poll();
    const t = setInterval(poll, 5000); // atualiza QR/status
    return () => clearInterval(t);
  }, [user.papel]);

  if (user.papel !== "superadmin") {
    return (
      <div className="page">
        <header className="page-head">
          <h1 className="page-title">Usuários</h1>
        </header>
        <EmptyState>Acesso restrito ao superadmin.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Usuários</h1>
        <div className="spacer" />
        <IconButton label="Recarregar" onClick={refresh}>
          ↻
        </IconButton>
      </header>

      <div className="users-body">
        {reveal && (
          <div className="users-reveal">
            Senha de <b>{reveal.usuario}</b>: <code>{reveal.senha}</code> — copie agora, não será
            exibida de novo.
            <Button variant="ghost" size="sm" onClick={() => setReveal(null)}>
              ok
            </Button>
          </div>
        )}
        {err && <Alert tone="alert">{err}</Alert>}

        <Tabs
          items={[
            { value: "usuarios", label: "Usuários" },
            { value: "notificacoes", label: "Notificações" },
            { value: "cameras", label: "Câmeras" },
          ]}
          value={secao}
          onValueChange={(v) => setSecao(v as typeof secao)}
          ariaLabel="Seção de administração"
        >
          <TabsContent value="cameras">
            <CamerasTab camToken={camToken} />
          </TabsContent>

          <TabsContent value="notificacoes">
            <NotificacoesTab
              wa={wa}
              waNum={waNum}
              setWaNum={setWaNum}
              waMsg={waMsg}
              setWaMsg={setWaMsg}
              dests={dests}
              setDests={setDests}
              novoDest={novoDest}
              setNovoDest={setNovoDest}
              notif={notif}
              setNotif={setNotif}
              preview={preview}
              setPreview={setPreview}
              notifMsg={notifMsg}
              setNotifMsg={setNotifMsg}
              setErr={setErr}
              setConfirmRemove={setConfirmRemove}
            />
          </TabsContent>

          <TabsContent value="usuarios">
            <UsersTab
              rows={rows}
              loading={loading}
              novo={novo}
              setNovo={setNovo}
              refresh={refresh}
              setErr={setErr}
              setReveal={setReveal}
              setConfirmRemove={setConfirmRemove}
            />
          </TabsContent>
        </Tabs>

        <AlertDialog
          open={!!confirmRemove}
          onOpenChange={(o) => {
            if (!o) setConfirmRemove(null);
          }}
          title={confirmRemove?.title ?? ""}
          description={confirmRemove?.description}
          confirmLabel="Remover"
          variant="danger"
          onConfirm={() => confirmRemove?.run()}
        />
      </div>
    </div>
  );
}
