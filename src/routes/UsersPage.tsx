import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Button, IconButton, Input, Field, Select, Switch, CheckboxRow, Tabs, TabsContent, ScrollArea, AlertDialog, EmptyState, Alert, Skeleton, useToast } from "../ui";
import { copyToClipboard } from "../ui/clipboard";
import { listUsers, createUser, patchUser, deleteUser, getCameraEnroll, getWaStatus, waTest, listRecipients, createRecipient, patchRecipient, deleteRecipient, getNotifSettings, saveNotifSettings, previewNotif, type AdminUser, type WaStatus, type Recipient, type NotifSettings } from "../api";

const TIPO_LABEL: Record<string, string> = { atividade: "Atividade / parada", fadiga: "Operador / fadiga", leitura: "Leitura / expedição", objetos: "Objetos / presença" };
// Papéis atribuíveis (RBAC Setup × Live — Onda C item 12). "engenheiro" = equipe de configuração
// (pode editar thresholds/zonas); "usuario" = operador só-visualização; "superadmin" = acesso total.
const PAPEL_OPTS = [{ value: "usuario", label: "Usuário" }, { value: "engenheiro", label: "Engenheiro" }, { value: "superadmin", label: "Superadmin" }];

// Painel do superadmin: CRUD de usuários. Senha só por hash no servidor — ao criar/resetar,
// a senha aparece UMA vez aqui para o superadmin repassar (modelo de reset seguro).
function genSenha(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789"; // sem caracteres ambíguos
  let s = ""; for (let i = 0; i < 10; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function UsersPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ usuario: string; senha: string } | null>(null);

  const [novo, setNovo] = useState({ usuario: "", senha: "", papel: "usuario" });
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
  // Confirmação destrutiva centralizada (substitui window.confirm) — Radix AlertDialog controlado.
  const [confirmRemove, setConfirmRemove] = useState<{ title: string; description: string; run: () => void } | null>(null);

  async function refresh() {
    setLoading(true); setErr(null);
    try { setRows(await listUsers()); } catch (e) { setErr(e instanceof Error ? e.message : "falha ao carregar"); }
    setLoading(false);
  }
  useEffect(() => {
    if (user.papel !== "superadmin") { setLoading(false); return; }
    refresh();
    getCameraEnroll().then((r) => setCamToken(r.token)).catch(() => {});
    listRecipients().then(setDests).catch(() => {});
    getNotifSettings().then(setNotif).catch(() => {});
    const poll = () => getWaStatus().then(setWa).catch(() => {});
    poll();
    const t = setInterval(poll, 5000); // atualiza QR/status
    return () => clearInterval(t);
  }, [user.papel]);

  async function onWaTest() {
    setWaMsg(null);
    try { await waTest(waNum.trim()); setWaMsg("Mensagem de teste enviada."); toast("Mensagem de teste enviada.", "ok"); }
    catch (e) { const m = e instanceof Error ? e.message : "Falha no envio."; setWaMsg(m); toast(m, "alert"); }
  }
  function setTipo(k: string, patch: Partial<{ ativo: boolean; titulo: string; instrucao: string }>) {
    setNotif((n) => (n ? { ...n, tipos: { ...n.tipos, [k]: { ...n.tipos[k], ...patch } } } : n));
  }
  async function onSaveNotif() {
    if (!notif) return; setNotifMsg(null);
    try { setNotif(await saveNotifSettings(notif)); setNotifMsg("Configuração salva."); toast("Configuração salva.", "ok"); }
    catch (e) { const m = e instanceof Error ? e.message : "Falha ao salvar."; setNotifMsg(m); toast(m, "alert"); }
  }
  async function onPreview() {
    if (!notif) return;
    try { setPreview(await previewNotif(notif)); }
    catch (e) { toast(e instanceof Error ? e.message : "Falha ao gerar a pré-visualização.", "alert"); }
  }

  async function refreshDests() { try { setDests(await listRecipients()); } catch (e) { toast(e instanceof Error ? e.message : "Falha ao recarregar destinatários.", "alert"); } }
  // Toggles de destinatário: antes eram `.then(refreshDests)` sem catch → falha silenciosa + unhandled rejection.
  async function onPatchDest(id: string, patch: Partial<{ ativo: boolean; somenteCriticos: boolean }>) {
    try { await patchRecipient(id, patch); await refreshDests(); }
    catch (e) { toast(e instanceof Error ? e.message : "Falha ao atualizar destinatário.", "alert"); await refreshDests(); }
  }
  async function onDeleteDest(id: string) {
    try { await deleteRecipient(id); await refreshDests(); toast("Destinatário removido.", "ok"); }
    catch (e) { toast(e instanceof Error ? e.message : "Falha ao remover destinatário.", "alert"); }
  }
  function requestDeleteDest(d: Recipient) {
    setConfirmRemove({ title: "Remover destinatário?", description: `"${d.nome || d.numero}" deixará de receber os alertas do WhatsApp.`, run: () => onDeleteDest(d.id) });
  }
  async function onCopyEnroll() {
    if (!enrollUrl) return;
    const ok = await copyToClipboard(enrollUrl);
    toast(ok ? "Link copiado." : "Não foi possível copiar. Selecione o link e copie manualmente.", ok ? "ok" : "alert");
  }
  async function onAddDest(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { await createRecipient(novoDest); setNovoDest({ nome: "", numero: "", somenteCriticos: true }); await refreshDests(); toast("Destinatário cadastrado.", "ok"); }
    catch (e2) { const m = e2 instanceof Error ? e2.message : "Falha ao cadastrar destinatário."; setErr(m); toast(m, "alert"); }
  }

  const enrollUrl = camToken ? `${location.origin}/camera?key=${encodeURIComponent(camToken)}` : null;

  if (user.papel !== "superadmin") {
    return <div className="page"><header className="page-head"><h1 className="page-title">Usuários</h1></header><EmptyState>Acesso restrito ao superadmin.</EmptyState></div>;
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const senha = novo.senha.trim() || genSenha();
    try {
      await createUser({ usuario: novo.usuario.trim(), senha, papel: novo.papel });
      setReveal({ usuario: novo.usuario.trim(), senha });
      setNovo({ usuario: "", senha: "", papel: "usuario" });
      await refresh(); toast("Usuário criado.", "ok");
    } catch (e2) { const m = e2 instanceof Error ? e2.message : "Falha ao criar usuário."; setErr(m); toast(m, "alert"); }
  }
  async function onPatch(id: string, patch: Partial<{ ativo: boolean; papel: string; senha: string }>) {
    setErr(null);
    try { await patchUser(id, patch); await refresh(); toast("Usuário atualizado.", "ok"); }
    catch (e) { const m = e instanceof Error ? e.message : "Falha ao atualizar."; setErr(m); toast(m, "alert"); }
  }
  async function onReset(u: AdminUser) {
    const senha = genSenha();
    setErr(null);
    try { await patchUser(u.id, { senha }); setReveal({ usuario: u.usuario, senha }); toast("Senha redefinida.", "ok"); }
    catch (e) { const m = e instanceof Error ? e.message : "Falha ao resetar."; setErr(m); toast(m, "alert"); }
  }
  function onDelete(u: AdminUser) {
    // window.confirm → AlertDialog (variant danger): só remove ao confirmar.
    setConfirmRemove({ title: "Remover usuário?", description: `O usuário "${u.usuario}" será removido permanentemente.`, run: () => doDeleteUser(u) });
  }
  async function doDeleteUser(u: AdminUser) {
    setErr(null);
    try { await deleteUser(u.id); await refresh(); toast("Usuário removido.", "ok"); }
    catch (e) { const m = e instanceof Error ? e.message : "Falha ao remover."; setErr(m); toast(m, "alert"); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Usuários</h1>
        <div className="spacer" />
        <IconButton label="Recarregar" onClick={refresh}>↻</IconButton>
      </header>

      <div className="users-body">
        {reveal && (
          <div className="users-reveal">
            Senha de <b>{reveal.usuario}</b>: <code>{reveal.senha}</code> — copie agora, não será exibida de novo.
            <Button variant="ghost" size="sm" onClick={() => setReveal(null)}>ok</Button>
          </div>
        )}
        {err && <Alert tone="alert">{err}</Alert>}

        <Tabs
          items={[{ value: "usuarios", label: "Usuários" }, { value: "notificacoes", label: "Notificações" }, { value: "cameras", label: "Câmeras" }]}
          value={secao} onValueChange={(v) => setSecao(v as typeof secao)} ariaLabel="Seção de administração"
        >

        <TabsContent value="cameras">
        <section className="panel">
          <h3>Câmeras — link de enrolamento</h3>
          {enrollUrl ? (
            <div className="enroll">
              <Input readOnly value={enrollUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={onCopyEnroll}>Copiar</Button>
              <p className="meta-text muted">Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem login humano.</p>
            </div>
          ) : (
            <p className="meta-text muted">Defina <code>CAMERA_TOKEN</code> no hub (systemd) para gerar o link de enrolamento. Sem ele, a câmera usa a sessão de um usuário logado no mesmo navegador.</p>
          )}
        </section>
        </TabsContent>

        <TabsContent value="notificacoes">
        <section className="panel">
          <h3>WhatsApp (andon) {wa && <span className={`wa-dot ${wa.connected ? "on" : wa.enabled ? "wait" : "off"}`} />}</h3>
          {!wa || !wa.enabled ? (
            <p className="meta-text muted">Desligado. Defina <code>WHATSAPP_ENABLED=1</code> no hub (systemd) e pareie aqui. Use um número dedicado (Baileys é não-oficial).</p>
          ) : wa.connected ? (
            <div className="wa-conn">
              <p className="meta-text"><b style={{ color: "var(--ok)" }}>Conectado.</b> Os alertas elegíveis serão enviados aos usuários com WhatsApp ativo.</p>
              <div className="wa-test">
                <Input placeholder="Número p/ teste (+55…)" value={waNum} onChange={(e) => setWaNum(e.target.value)} />
                <Button onClick={onWaTest} disabled={waNum.replace(/\D/g, "").length < 10}>Enviar teste</Button>
                {waMsg && <span className="meta-text muted">{waMsg}</span>}
              </div>
            </div>
          ) : wa.qr ? (
            <div className="wa-qr">
              <img src={wa.qr} alt="QR de pareamento do WhatsApp" width={220} height={220} />
              <p className="meta-text muted">Abra o WhatsApp do número remetente → Aparelhos conectados → Conectar aparelho → escaneie. O QR atualiza sozinho.</p>
            </div>
          ) : (
            <p className="meta-text muted">Iniciando conexão… aguarde o QR aparecer.</p>
          )}
        </section>

        {notif && (
          <section className="panel">
            <h3>Mensagens & alertas</h3>
            <p className="meta-text muted">Defina o que cada notificação envia. Vale para todos os destinatários.</p>
            <div className="users-new">
              <Field label="Marca / assinatura" htmlFor="notif-marca" className="ui-grow">
                <Input id="notif-marca" value={notif.marca} onChange={(e) => setNotif({ ...notif, marca: e.target.value })} />
              </Field>
              <CheckboxRow id="chk-local" checked={notif.incluirLocal} onCheckedChange={(v) => setNotif({ ...notif, incluirLocal: v })}>local</CheckboxRow>
              <CheckboxRow id="chk-hora" checked={notif.incluirHora} onCheckedChange={(v) => setNotif({ ...notif, incluirHora: v })}>data/hora</CheckboxRow>
              <CheckboxRow id="chk-rodape" checked={notif.incluirRodape} onCheckedChange={(v) => setNotif({ ...notif, incluirRodape: v })}>rodapé</CheckboxRow>
            </div>

            <div className="notif-types">
              {Object.keys(notif.tipos).map((k) => (
                <div className="notif-type" key={k}>
                  <div className="nt-head">
                    <Switch checked={notif.tipos[k].ativo} onCheckedChange={(v) => setTipo(k, { ativo: v })} ariaLabel={`Notificar ${TIPO_LABEL[k] ?? k}`} />
                    <b>{TIPO_LABEL[k] ?? k}</b>
                  </div>
                  <Input placeholder="Título" value={notif.tipos[k].titulo} onChange={(e) => setTipo(k, { titulo: e.target.value })} />
                  <Input placeholder="Instrução extra (opcional, ex.: acionar o supervisor)" value={notif.tipos[k].instrucao} onChange={(e) => setTipo(k, { instrucao: e.target.value })} />
                </div>
              ))}
            </div>

            <div className="prof-actions">
              <Button variant="primary" onClick={onSaveNotif}>Salvar</Button>
              <Button onClick={onPreview}>Pré-visualizar</Button>
              {notifMsg && <span className="prof-ok">{notifMsg}</span>}
            </div>
            {preview && (
              <div className="notif-preview">
                {Object.entries(preview).map(([t, m]) => (<div key={t}><span className="np-tag">{TIPO_LABEL[t] ?? t}</span><pre>{m}</pre></div>))}
              </div>
            )}
          </section>
        )}

        <section className="panel">
          <h3>Destinatários do WhatsApp ({dests.length})</h3>
          <p className="meta-text muted">Números avulsos que recebem os alertas (além dos usuários que cadastram o próprio número em "Meu perfil"). Você é responsável pelo consentimento (LGPD).</p>
          <form className="users-new" onSubmit={onAddDest}>
            <Input placeholder="Nome (ex.: Supervisor)" value={novoDest.nome} onChange={(e) => setNovoDest((d) => ({ ...d, nome: e.target.value }))} />
            <Input placeholder="Número +55…" value={novoDest.numero} onChange={(e) => setNovoDest((d) => ({ ...d, numero: e.target.value }))} />
            <CheckboxRow id="chk-dest-crit" checked={novoDest.somenteCriticos} onCheckedChange={(v) => setNovoDest((d) => ({ ...d, somenteCriticos: v }))}>só críticos</CheckboxRow>
            <Button variant="primary" type="submit" disabled={novoDest.numero.replace(/\D/g, "").length < 10}>Adicionar</Button>
          </form>
          <ScrollArea orientation="both" style={{ maxHeight: 320, marginTop: "var(--sp-2)" }}>
            <table className="rtable">
              <thead><tr><th>Nome</th><th>Número</th><th>Filtro</th><th>Status</th><th>Ações</th></tr></thead>
              <tbody>
                {dests.map((d) => (
                  <tr key={d.id}>
                    <td>{d.nome}</td>
                    <td className="mono">{d.numero}</td>
                    <td><div className="cell-toggle"><Switch checked={d.somenteCriticos} onCheckedChange={(v) => onPatchDest(d.id, { somenteCriticos: v })} ariaLabel="só críticos" /><span>{d.somenteCriticos ? "só críticos" : "todos"}</span></div></td>
                    <td><div className="cell-toggle"><Switch checked={d.ativo} onCheckedChange={(v) => onPatchDest(d.id, { ativo: v })} ariaLabel="ativo" /><span>{d.ativo ? "Ativo" : "Inativo"}</span></div></td>
                    <td><Button variant="danger" size="sm" onClick={() => requestDeleteDest(d)}>Remover</Button></td>
                  </tr>
                ))}
                {dests.length === 0 && <tr><td colSpan={5} className="empty-note">Nenhum destinatário avulso.</td></tr>}
              </tbody>
            </table>
          </ScrollArea>
        </section>
        </TabsContent>

        <TabsContent value="usuarios">
        <section className="panel">
          <h3>Novo usuário</h3>
          <form className="users-new" onSubmit={onCreate}>
            <Input placeholder="Usuário" value={novo.usuario} onChange={(e) => setNovo((n) => ({ ...n, usuario: e.target.value }))} />
            <span className="users-pwd">
              <Input placeholder="Senha (vazio = gerar)" value={novo.senha} onChange={(e) => setNovo((n) => ({ ...n, senha: e.target.value }))} />
              <IconButton label="Gerar senha" onClick={() => setNovo((n) => ({ ...n, senha: genSenha() }))}>🎲</IconButton>
            </span>
            <Select value={novo.papel} onChange={(v) => setNovo((n) => ({ ...n, papel: v }))} options={PAPEL_OPTS} ariaLabel="Papel" />
            <Button variant="primary" type="submit" disabled={!novo.usuario.trim()}>Criar</Button>
          </form>
        </section>

        <section className="panel panel-events">
          <h3>{loading ? "Carregando…" : `${rows.length} usuário(s)`}</h3>
          <ScrollArea orientation="both" style={{ maxHeight: 460 }}>
            <table className="rtable">
              <thead><tr><th>Usuário</th><th>Papel</th><th>Status</th><th>Ações</th></tr></thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>{u.usuario}{u.id === user.id && <span className="muted"> (você)</span>}</td>
                    <td><Select value={u.papel} onChange={(v) => onPatch(u.id, { papel: v })} options={PAPEL_OPTS} ariaLabel="Papel" /></td>
                    <td><div className="cell-toggle"><Switch checked={u.ativo} onCheckedChange={(v) => onPatch(u.id, { ativo: v })} ariaLabel="ativo" /><span>{u.ativo ? "Ativo" : "Inativo"}</span></div></td>
                    <td className="users-actions">
                      <Button size="sm" onClick={() => onReset(u)}>Resetar senha</Button>
                      <Button variant="danger" size="sm" onClick={() => onDelete(u)} disabled={u.id === user.id}>Remover</Button>
                    </td>
                  </tr>
                ))}
                {loading && Array.from({ length: 3 }).map((_, i) => <tr key={`sk-${i}`}><td colSpan={4}><Skeleton w="100%" h={16} /></td></tr>)}
                {!loading && rows.length === 0 && <tr><td colSpan={4} className="empty-note">Nenhum usuário.</td></tr>}
              </tbody>
            </table>
          </ScrollArea>
        </section>
        </TabsContent>

        </Tabs>

        <AlertDialog
          open={!!confirmRemove}
          onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}
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
