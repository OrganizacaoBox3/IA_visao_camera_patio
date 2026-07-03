import { type Dispatch, type SetStateAction } from "react";
import {
  Button,
  Input,
  Field,
  Switch,
  CheckboxRow,
  ScrollArea,
  useToast,
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
} from "../../api";
import type { ConfirmRemove } from "./types";

const TIPO_LABEL: Record<string, string> = {
  atividade: "Atividade / parada",
  fadiga: "Operador / fadiga",
  leitura: "Leitura / expedição",
  objetos: "Objetos / presença",
};

type NovoDest = { nome: string; numero: string; somenteCriticos: boolean };

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

type Props = {
  wa: WaStatus | null;
  waNum: string;
  setWaNum: Dispatch<SetStateAction<string>>;
  waMsg: string | null;
  setWaMsg: Dispatch<SetStateAction<string | null>>;
  dests: Recipient[];
  setDests: Dispatch<SetStateAction<Recipient[]>>;
  novoDest: NovoDest;
  setNovoDest: Dispatch<SetStateAction<NovoDest>>;
  notif: NotifSettings | null;
  setNotif: Dispatch<SetStateAction<NotifSettings | null>>;
  preview: Record<string, string> | null;
  setPreview: Dispatch<SetStateAction<Record<string, string> | null>>;
  notifMsg: string | null;
  setNotifMsg: Dispatch<SetStateAction<string | null>>;
  setErr: Dispatch<SetStateAction<string | null>>;
  setConfirmRemove: Dispatch<SetStateAction<ConfirmRemove | null>>;
};

export function NotificacoesTab({
  wa,
  waNum,
  setWaNum,
  waMsg,
  setWaMsg,
  dests,
  setDests,
  novoDest,
  setNovoDest,
  notif,
  setNotif,
  preview,
  setPreview,
  notifMsg,
  setNotifMsg,
  setErr,
  setConfirmRemove,
}: Props) {
  const { toast } = useToast();

  async function onWaTest() {
    setWaMsg(null);
    try {
      await waTest(waNum.trim());
      setWaMsg("Mensagem de teste enviada.");
      toast("Mensagem de teste enviada.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha no envio.";
      setWaMsg(m);
      toast(m, "alert");
    }
  }
  function setTipo(
    k: string,
    patch: Partial<{ ativo: boolean; titulo: string; instrucao: string }>,
  ) {
    setNotif((n) => (n ? { ...n, tipos: { ...n.tipos, [k]: { ...n.tipos[k], ...patch } } } : n));
  }
  async function onSaveNotif() {
    if (!notif) return;
    setNotifMsg(null);
    try {
      setNotif(await saveNotifSettings(notif));
      setNotifMsg("Configuração salva.");
      toast("Configuração salva.", "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Falha ao salvar.";
      setNotifMsg(m);
      toast(m, "alert");
    }
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
    patch: Partial<{ ativo: boolean; somenteCriticos: boolean }>,
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
    try {
      await deleteRecipient(id);
      await refreshDests();
      toast("Destinatário removido.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao remover destinatário.", "alert");
    }
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
    setErr(null);
    try {
      await createRecipient(novoDest);
      setNovoDest({ nome: "", numero: "", somenteCriticos: true });
      await refreshDests();
      toast("Destinatário cadastrado.", "ok");
    } catch (e2) {
      const m = e2 instanceof Error ? e2.message : "Falha ao cadastrar destinatário.";
      setErr(m);
      toast(m, "alert");
    }
  }

  return (
    <>
      <section className="panel shrink-0">
        <h2 className={H2_SEC}>
          WhatsApp (andon){" "}
          {wa && (
            <span className={`wa-dot ${wa.connected ? "on" : wa.enabled ? "wait" : "off"}`} />
          )}
        </h2>
        {!wa || !wa.enabled ? (
          <p className="muted">
            Desligado. Defina <code>WHATSAPP_ENABLED=1</code> no hub (systemd) e pareie aqui. Use um
            número dedicado (Baileys é não-oficial).
          </p>
        ) : wa.connected ? (
          <div>
            <p>
              <b className="text-ok">Conectado.</b> Os alertas elegíveis serão enviados aos
              usuários com WhatsApp ativo.
            </p>
            <div className="wa-test">
              <Input
                placeholder="Número p/ teste (+55…)"
                aria-label="Número do WhatsApp para teste"
                value={waNum}
                onChange={(e) => setWaNum(e.target.value)}
              />
              <Button onClick={onWaTest} disabled={waNum.replace(/\D/g, "").length < 10}>
                Enviar teste
              </Button>
              {waMsg && <span className="muted">{waMsg}</span>}
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
          <h2 className={H2_SEC}>Mensagens & alertas</h2>
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
            <Button variant="primary" onClick={onSaveNotif}>
              Salvar
            </Button>
            <Button onClick={onPreview}>Pré-visualizar</Button>
            {notifMsg && <span className="prof-ok">{notifMsg}</span>}
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

      {/* Lista de destinatários cresce com a viewport (flex-fill; sem max-h fixo). */}
      <section className="panel flex flex-1 flex-col">
        <h2 className={H2_SEC}>Destinatários do WhatsApp ({dests.length})</h2>
        <p className="meta-text muted">
          Números avulsos que recebem os alertas (além dos usuários que cadastram o próprio número
          em "Meu perfil"). Você é responsável pelo consentimento (LGPD).
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
            disabled={novoDest.numero.replace(/\D/g, "").length < 10}
          >
            Adicionar
          </Button>
        </form>
        <ScrollArea orientation="both" className="mt-2 min-h-[160px] flex-1">
          <table className="rtable">
            <thead>
              <tr>
                {/* Nome absorve a largura livre; demais colunas compactas (sem faixa morta). */}
                <th className="w-full">Nome</th>
                <th className="whitespace-nowrap">Número</th>
                <th className="whitespace-nowrap">Filtro</th>
                <th className="whitespace-nowrap">Status</th>
                <th className="whitespace-nowrap text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {dests.map((d) => (
                <tr key={d.id}>
                  <td>{d.nome}</td>
                  <td className="mono">{d.numero}</td>
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
                    <Button variant="danger" size="sm" onClick={() => requestDeleteDest(d)}>
                      Remover
                    </Button>
                  </td>
                </tr>
              ))}
              {dests.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-note">
                    Nenhum destinatário avulso.
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
