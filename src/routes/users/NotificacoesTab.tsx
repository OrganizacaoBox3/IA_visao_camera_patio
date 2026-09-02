import { useState, type Dispatch, type SetStateAction } from "react";
import {
  Button,
  Input,
  Field,
  Select,
  Switch,
  CheckboxRow,
  HelpTip,
  Skeleton,
  StatusDot,
  Table,
  TableEmpty,
  useToast,
  SectionTitle,
} from "../../ui";
import {
  waTest,
  listRecipients,
  createRecipient,
  patchRecipient,
  deleteRecipient,
  saveNotifSettings,
  previewNotif,
  type WaStatus,
  type Recipient,
  type NotifSettings,
  type AdminUser,
} from "../../api";
import type { ConfirmRemove } from "./types";

const TIPO_LABEL: Record<string, string> = {
  atividade: "Atividade / parada",
  fadiga: "Operador / fadiga",
  leitura: "Leitura / expedição",
  objetos: "Objetos / presença",
};

type NovoDest = {
  nome: string;
  numero: string;
  somenteCriticos: boolean;
  userId: string;
  principal: boolean;
};

type Props = {
  wa: WaStatus | null;
  waNum: string;
  setWaNum: Dispatch<SetStateAction<string>>;
  dests: Recipient[];
  users: AdminUser[];
  setDests: Dispatch<SetStateAction<Recipient[]>>;
  loading: boolean;
  novoDest: NovoDest;
  setNovoDest: Dispatch<SetStateAction<NovoDest>>;
  notif: NotifSettings | null;
  setNotif: Dispatch<SetStateAction<NotifSettings | null>>;
  preview: Record<string, string> | null;
  setPreview: Dispatch<SetStateAction<Record<string, string> | null>>;
  setErr: Dispatch<SetStateAction<string | null>>;
  setConfirmRemove: Dispatch<SetStateAction<ConfirmRemove | null>>;
};

export function NotificacoesTab({
  wa,
  waNum,
  setWaNum,
  dests,
  users,
  setDests,
  loading,
  novoDest,
  setNovoDest,
  notif,
  setNotif,
  preview,
  setPreview,
  setErr,
  setConfirmRemove,
}: Props) {
  const { toast } = useToast();
  // Trava dupla submissão / mutações concorrentes (padrão da casa — IpCamerasSection):
  // sem ela, clique duplo em "Adicionar"/"Salvar"/"Enviar teste" duplicava a ação.
  const [busy, setBusy] = useState(false);

  // Feedback ÚNICO (spec §3): sucesso/erro de AÇÃO → toast; os antigos spans inline
  // (waMsg/notifMsg) duplicavam o mesmo texto e saíram.
  async function onWaTest() {
    if (busy) return;
    setBusy(true);
    try {
      await waTest(waNum.trim());
      toast("Mensagem entregue pelo WhatsApp.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha no envio.", "alert");
    }
    setBusy(false);
  }
  function setTipo(
    k: string,
    patch: Partial<{ ativo: boolean; titulo: string; instrucao: string }>,
  ) {
    setNotif((n) => (n ? { ...n, tipos: { ...n.tipos, [k]: { ...n.tipos[k], ...patch } } } : n));
  }
  async function onSaveNotif() {
    if (!notif || busy) return;
    setBusy(true);
    try {
      setNotif(await saveNotifSettings(notif));
      toast("Configuração salva.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao salvar.", "alert");
    }
    setBusy(false);
  }
  async function onPreview() {
    if (!notif) return;
    try {
      setPreview(await previewNotif(notif));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao gerar a pré-visualização.", "alert");
    }
  }

  async function refreshDests() {
    try {
      setDests(await listRecipients());
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao recarregar destinatários.", "alert");
    }
  }
  // Toggles de destinatário: antes eram `.then(refreshDests)` sem catch → falha silenciosa + unhandled rejection.
  async function onPatchDest(
    id: string,
    patch: Partial<{
      ativo: boolean;
      somenteCriticos: boolean;
      userId: string;
      principal: boolean;
    }>,
  ) {
    try {
      await patchRecipient(id, patch);
      await refreshDests();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao atualizar destinatário.", "alert");
      await refreshDests();
    }
  }
  async function onDeleteDest(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await deleteRecipient(id);
      await refreshDests();
      toast("Destinatário removido.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao remover destinatário.", "alert");
    }
    setBusy(false);
  }
  function requestDeleteDest(d: Recipient) {
    setConfirmRemove({
      title: "Remover destinatário?",
      description: `"${d.nome || d.numero}" deixará de receber os alertas do WhatsApp.`,
      run: () => onDeleteDest(d.id),
    });
  }
  async function onAddDest(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createRecipient(novoDest);
      setNovoDest((d) => ({
        nome: "",
        numero: "",
        somenteCriticos: true,
        userId: d.userId,
        principal: false,
      }));
      await refreshDests();
      toast("Destinatário cadastrado.", "ok");
    } catch (e2) {
      const m = e2 instanceof Error ? e2.message : "Falha ao cadastrar destinatário.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }

  return (
    <>
      <section className="panel shrink-0">
        <SectionTitle>
          WhatsApp (andon){" "}
          {wa && (
            <StatusDot
              tone={wa.connected ? "ok" : wa.enabled ? "warn" : "neutral"}
              label={
                wa.connected ? "conectado" : wa.enabled ? "aguardando conexão" : "desativado"
              }
            />
          )}
        </SectionTitle>
        {!wa || !wa.enabled ? (
          // Linguagem de PRODUTO na tela (achado #5 da auditoria): env var/systemd/lib são
          // detalhe de infra e vivem SÓ no tooltip técnico, nunca no texto visível.
          <p className="muted">
            Notificações por WhatsApp não estão ativas neste servidor — fale com o administrador.{" "}
            <HelpTip label="Detalhe técnico da ativação">
              Ativação (feita pelo administrador do servidor): definir WHATSAPP_ENABLED=1 no
              ambiente do hub e parear um número dedicado nesta tela.
            </HelpTip>
          </p>
        ) : wa.connected ? (
          <div>
            <p>
              <b className="text-ok">Conectado.</b> Os alertas elegíveis serão enviados aos usuários
              com WhatsApp ativo.
            </p>
            <div className="wa-test">
              <Input
                placeholder="Número p/ teste (+55…)"
                aria-label="Número do WhatsApp para teste"
                value={waNum}
                onChange={(e) => setWaNum(e.target.value)}
              />
              <Button onClick={onWaTest} disabled={busy || waNum.replace(/\D/g, "").length < 10}>
                Enviar teste
              </Button>
            </div>
          </div>
        ) : wa.qr ? (
          <div className="wa-qr">
            <img src={wa.qr} alt="QR de pareamento do WhatsApp" width={220} height={220} />
            <p className="muted">
              Abra o WhatsApp do número remetente → Aparelhos conectados → Conectar aparelho →
              escaneie. O QR atualiza sozinho.
            </p>
          </div>
        ) : (
          <p className="muted">Iniciando conexão… aguarde o QR aparecer.</p>
        )}
      </section>

      {notif && (
        <section className="panel shrink-0">
          <SectionTitle>Mensagens & alertas</SectionTitle>
          <p className="muted">
            Defina o que cada notificação envia. Vale para todos os destinatários.
          </p>
          <div className="users-new">
            <Field label="Marca / assinatura" htmlFor="notif-marca" className="flex-1 min-w-0">
              <Input
                id="notif-marca"
                value={notif.marca}
                onChange={(e) => setNotif({ ...notif, marca: e.target.value })}
              />
            </Field>
            {/* Grupo rotulado (achado 8.5): os 3 toggles deixam de flutuar soltos à direita
                do input — uma linha própria com rótulo diz o que eles incluem. */}
            <div
              className="flex flex-wrap items-center gap-[var(--sp-2)]"
              role="group"
              aria-label="Incluir na mensagem"
            >
              <span className="text-label text-text-dim">Incluir na mensagem:</span>
              <CheckboxRow
                id="chk-local"
                checked={notif.incluirLocal}
                onCheckedChange={(v) => setNotif({ ...notif, incluirLocal: v })}
              >
                local
              </CheckboxRow>
              <CheckboxRow
                id="chk-hora"
                checked={notif.incluirHora}
                onCheckedChange={(v) => setNotif({ ...notif, incluirHora: v })}
              >
                data/hora
              </CheckboxRow>
              <CheckboxRow
                id="chk-rodape"
                checked={notif.incluirRodape}
                onCheckedChange={(v) => setNotif({ ...notif, incluirRodape: v })}
              >
                rodapé
              </CheckboxRow>
            </div>
          </div>

          {/* items-stretch + h-full: os 4 cards de mensagem alinham a altura na mesma linha. */}
          <div className="notif-types items-stretch">
            {Object.keys(notif.tipos).map((k) => (
              <div className="notif-type h-full" key={k}>
                <div className="nt-head">
                  <Switch
                    checked={notif.tipos[k].ativo}
                    onCheckedChange={(v) => setTipo(k, { ativo: v })}
                    ariaLabel={`Notificar ${TIPO_LABEL[k] ?? k}`}
                  />
                  <b>{TIPO_LABEL[k] ?? k}</b>
                </div>
                <Input
                  placeholder="Título"
                  aria-label={`Título — ${TIPO_LABEL[k] ?? k}`}
                  value={notif.tipos[k].titulo}
                  onChange={(e) => setTipo(k, { titulo: e.target.value })}
                />
                <Input
                  placeholder="Instrução extra (opcional, ex.: acionar o supervisor)"
                  aria-label={`Instrução extra — ${TIPO_LABEL[k] ?? k}`}
                  value={notif.tipos[k].instrucao}
                  onChange={(e) => setTipo(k, { instrucao: e.target.value })}
                />
              </div>
            ))}
          </div>

          <div className="prof-actions">
            <Button variant="primary" onClick={onSaveNotif} disabled={busy}>
              Salvar
            </Button>
            <Button onClick={onPreview}>Pré-visualizar</Button>
          </div>
          {preview && (
            <div className="notif-preview">
              {Object.entries(preview).map(([t, m]) => (
                <div key={t}>
                  <span className="np-tag">{TIPO_LABEL[t] ?? t}</span>
                  <pre>{m}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Lista de destinatários cresce com a viewport (flex-fill; sem max-h fixo).
          panel-events (como a lista irmã de Usuários) tira o cap de 320px do .rtable-wrap
          para a lista crescer de fato; aria-busy espelha o loader de Skeleton. */}
      <section className="panel panel-events flex flex-1 flex-col" aria-busy={loading}>
        <SectionTitle>Destinatários do WhatsApp ({dests.length})</SectionTitle>
        {/* Prosa >1 linha vira tooltip (regra de ouro): a tela fica com 1 linha essencial. */}
        <p className="meta-text muted">
          Cada número pertence a um usuário e recebe apenas alertas das câmeras permitidas.{" "}
          <HelpTip label="Mais sobre destinatários">
            O número principal aparece em “Meu perfil”. Números adicionais ficam somente aqui.
            Quem cadastra número de terceiros responde pelo consentimento (LGPD).
          </HelpTip>
        </p>
        <form className="users-new" onSubmit={onAddDest}>
          <Input
            placeholder="Nome (ex.: Supervisor)"
            aria-label="Nome do destinatário"
            value={novoDest.nome}
            onChange={(e) => setNovoDest((d) => ({ ...d, nome: e.target.value }))}
          />
          <Input
            placeholder="Número +55…"
            aria-label="Número do destinatário"
            value={novoDest.numero}
            onChange={(e) => setNovoDest((d) => ({ ...d, numero: e.target.value }))}
          />
          <Select
            value={novoDest.userId}
            onChange={(userId) => setNovoDest((d) => ({ ...d, userId }))}
            options={users.map((u) => ({ value: u.id, label: u.usuario }))}
            ariaLabel="Usuário responsável"
          />
          <CheckboxRow
            id="chk-dest-principal"
            checked={novoDest.principal}
            onCheckedChange={(principal) => setNovoDest((d) => ({ ...d, principal }))}
          >
            principal
          </CheckboxRow>
          <CheckboxRow
            id="chk-dest-crit"
            checked={novoDest.somenteCriticos}
            onCheckedChange={(v) => setNovoDest((d) => ({ ...d, somenteCriticos: v }))}
          >
            só críticos
          </CheckboxRow>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || novoDest.numero.replace(/\D/g, "").length < 10}
          >
            Adicionar
          </Button>
        </form>
        {/* Átomo Table da casa: th scope="col" por construção + rolagem interna (regra A12). */}
        <Table
          ariaLabel="Destinatários do WhatsApp"
          className="mt-2 min-h-[160px] flex-1"
          columns={[
            // Nome absorve a largura livre; demais colunas compactas (sem faixa morta).
            { label: "Nome", className: "w-full" },
            { label: "Número", className: "whitespace-nowrap" },
            { label: "Usuário", className: "whitespace-nowrap" },
            { label: "Principal", className: "whitespace-nowrap" },
            { label: "Filtro", className: "whitespace-nowrap" },
            { label: "Status", className: "whitespace-nowrap" },
            { label: "Ações", className: "whitespace-nowrap text-right" },
          ]}
        >
          <tbody>
            {dests.map((d) => (
              <tr key={d.id}>
                <td>{d.nome}</td>
                <td className="mono">{d.numero}</td>
                <td>
                  <Select
                    value={d.userId}
                    onChange={(userId) => onPatchDest(d.id, { userId })}
                    options={users.map((u) => ({ value: u.id, label: u.usuario }))}
                    ariaLabel={`Usuário responsável por ${d.nome || d.numero}`}
                  />
                </td>
                <td>
                  <Switch
                    checked={d.principal}
                    onCheckedChange={(principal) => onPatchDest(d.id, { principal })}
                    ariaLabel={`Número principal de ${d.nome || d.numero}`}
                  />
                </td>
                <td>
                  <div className="cell-toggle">
                    <Switch
                      checked={d.somenteCriticos}
                      onCheckedChange={(v) => onPatchDest(d.id, { somenteCriticos: v })}
                      ariaLabel="só críticos"
                    />
                    <span>{d.somenteCriticos ? "só críticos" : "todos"}</span>
                  </div>
                </td>
                <td>
                  <div className="cell-toggle">
                    <Switch
                      checked={d.ativo}
                      onCheckedChange={(v) => onPatchDest(d.id, { ativo: v })}
                      ariaLabel="ativo"
                    />
                    <span>{d.ativo ? "Ativo" : "Inativo"}</span>
                  </div>
                </td>
                <td className="whitespace-nowrap text-right">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => requestDeleteDest(d)}
                    disabled={busy}
                  >
                    Remover
                  </Button>
                </td>
              </tr>
            ))}
            {loading &&
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  <td colSpan={7}>
                    <Skeleton w="100%" h={16} />
                  </td>
                </tr>
              ))}
            {!loading && dests.length === 0 && (
              <TableEmpty colSpan={7}>Nenhum destinatário cadastrado.</TableEmpty>
            )}
          </tbody>
        </Table>
      </section>
    </>
  );
}
