import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth";
import {
  Button,
  IconButton,
  Tabs,
  TabsContent,
  AlertDialog,
  EmptyState,
  Alert,
  PageHeader,
} from "../ui";
import {
  listUsers,
  getCameraEnroll,
  getWaStatus,
  listRecipients,
  getNotifSettings,
  getConnectedCameras,
  type AdminUser,
  type WaStatus,
  type Recipient,
  type NotifSettings,
  type ConnectedCamera,
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
  // Câmeras conhecidas pelo hub — usado no seletor de alocação do papel "cliente" (RBAC com
  // escopo). Superadmin vê todas aqui (a rota não escopa quem já é equipe).
  const [cameras, setCameras] = useState<ConnectedCamera[]>([]);
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [waNum, setWaNum] = useState("");
  const [dests, setDests] = useState<Recipient[]>([]);
  const [destsLoading, setDestsLoading] = useState(true);
  const [novoDest, setNovoDest] = useState({
    nome: "",
    numero: "",
    somenteCriticos: true,
    userId: user.id,
    principal: false,
  });
  const [notif, setNotif] = useState<NotifSettings | null>(null);
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
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
      .catch(() => {})
      .finally(() => setDestsLoading(false));
    getNotifSettings()
      .then(setNotif)
      .catch(() => {});
    getConnectedCameras()
      .then((r) => setCameras(r.cameras))
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
        <PageHeader title="Usuários" />
        <EmptyState>Acesso restrito ao superadmin.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Usuários">
        <IconButton label="Recarregar" onClick={refresh}>
          <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </PageHeader>

      {/* Cadeia flex (page → body → tabs → painel): a lista cresce com a viewport
          (plano de padronização visual — layout SaaS, sem max-h em conteúdo). */}
      <div className="users-body min-h-0 flex-1">
        {/* Feedback ÚNICO (spec §3): a revelação de senha usa o átomo Alert (tom ok,
            role=status — anunciada por leitor de tela) no lugar do banner bespoke .users-reveal. */}
        {reveal && (
          <Alert tone="ok">
            <span>
              Senha de <b>{reveal.usuario}</b>: <code>{reveal.senha}</code> — copie agora, não será
              exibida de novo.
            </span>
            <Button variant="ghost" size="sm" onClick={() => setReveal(null)}>
              ok
            </Button>
          </Alert>
        )}
        {err && <Alert tone="alert">{err}</Alert>}

        <Tabs
          className="min-h-0 flex-1"
          items={[
            { value: "usuarios", label: "Usuários" },
            { value: "notificacoes", label: "Notificações" },
            { value: "cameras", label: "Câmeras" },
          ]}
          value={secao}
          onValueChange={(v) => setSecao(v as typeof secao)}
          ariaLabel="Seção de administração"
        >
          <TabsContent
            value="cameras"
            className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] pt-[var(--sp-4)]"
          >
            <CamerasTab camToken={camToken} />
          </TabsContent>

          <TabsContent
            value="notificacoes"
            className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] pt-[var(--sp-4)]"
          >
            <NotificacoesTab
              wa={wa}
              waNum={waNum}
              setWaNum={setWaNum}
              dests={dests}
              users={rows}
              setDests={setDests}
              loading={destsLoading}
              novoDest={novoDest}
              setNovoDest={setNovoDest}
              notif={notif}
              setNotif={setNotif}
              preview={preview}
              setPreview={setPreview}
              setErr={setErr}
              setConfirmRemove={setConfirmRemove}
            />
          </TabsContent>

          <TabsContent
            value="usuarios"
            className="flex min-h-0 flex-1 flex-col gap-[var(--sp-4)] pt-[var(--sp-4)]"
          >
            <UsersTab
              rows={rows}
              loading={loading}
              novo={novo}
              setNovo={setNovo}
              refresh={refresh}
              setErr={setErr}
              setReveal={setReveal}
              setConfirmRemove={setConfirmRemove}
              cameras={cameras}
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
