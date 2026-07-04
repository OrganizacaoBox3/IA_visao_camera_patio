import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Switch,
  Checkbox,
  Select,
  Input,
  Dialog,
  AlertDialog,
  Field,
  Badge,
  Alert,
  Tooltip,
  useToast,
} from "../../ui";
import {
  listCameras,
  createCamera,
  updateCamera,
  deleteCamera,
  isValidCameraUrl,
  maskCameraUrl,
  ApiError,
  type Camera as IpCamera,
  type CameraTransport,
  type NewCamera,
} from "../../api";

// Câmeras IP/RTSP (superadmin) — CRUD na tela /cameras (lógica movida do antigo
// dashboard/IpCameraDialog, que foi removido; agora com EDIÇÃO além de criar/ativar/excluir).
// Cadastra câmeras dinâmicas (POST /api/cameras); a grade da Central se atualiza sozinha pelos
// eventos socket `cameras`/`camera-status` (não refazemos o relé). A lista COM url (sensível)
// vem do GET /api/cameras; a url nunca é logada e é mascarada na exibição (LGPD/segurança).
// Renderizado só para superadmin (o pai monta esta seção sob a guarda `isSuper`).

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

// Tipo do stream deduzido da URL — só informativo, para a lista (o hub decide pelo esquema).
function cameraKind(url: string): string {
  const u = (url ?? "").trim().toLowerCase();
  if (u.startsWith("rtsp")) return "RTSP";
  if (u.includes(".m3u8")) return "HLS";
  return "HTTP/MJPEG";
}

export function IpCamerasSection() {
  const { toast } = useToast();
  const [cams, setCams] = useState<IpCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // trava dupla submissão / mutações concorrentes
  const [confirmDel, setConfirmDel] = useState<IpCamera | null>(null);

  // Form (Dialog) — serve para CRIAR (editing=null) e EDITAR (editing=Camera).
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IpCamera | null>(null);
  const [fLabel, setFLabel] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fTransport, setFTransport] = useState<CameraTransport>("tcp");
  const [fUrlError, setFUrlError] = useState<string | null>(null);
  const [fAdvanced, setFAdvanced] = useState(false);
  const [fFps, setFFps] = useState("");
  const [fWidth, setFWidth] = useState("");
  const [fQuality, setFQuality] = useState("");

  // Carrega a lista de câmeras IP (com url) do backend. Falha vira estado de erro claro na
  // seção (com "Tentar de novo"), não só um toast passageiro.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCams(await listCameras());
      setLoadErr(null);
    } catch (e) {
      // Não logar a url; a lista nem carregou aqui, então só a mensagem amigável.
      setLoadErr(
        e instanceof ApiError ? e.message : "Não foi possível carregar as câmeras IP.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setFLabel("");
    setFUrl("");
    setFTransport("tcp");
    setFUrlError(null);
    setFAdvanced(false);
    setFFps("");
    setFWidth("");
    setFQuality("");
    setFormOpen(true);
  }

  // Edição: pré-preenche com o cadastro atual. A URL fica VAZIA de propósito (LGPD: nunca
  // exibimos a url completa com credenciais); em branco = mantém a atual (o placeholder mostra
  // a versão mascarada). Avançado abre já expandido quando a câmera tem override salvo.
  function openEdit(c: IpCamera) {
    setEditing(c);
    setFLabel(c.label ?? "");
    setFUrl("");
    setFTransport(c.transport ?? "tcp");
    setFUrlError(null);
    const hasAdv = c.fps != null || c.width != null || c.quality != null;
    setFAdvanced(hasAdv);
    setFFps(c.fps != null ? String(c.fps) : "");
    setFWidth(c.width != null ? String(c.width) : "");
    setFQuality(c.quality != null ? String(c.quality) : "");
    setFormOpen(true);
  }

  // URL efetiva para decidir o seletor de transporte: na edição com campo em branco vale a
  // url salva; vazia (criação) mostra o seletor (default do form é rtsp, o caso comum).
  const effectiveUrl = editing && !fUrl.trim() ? editing.url : fUrl.trim();
  const urlIsRtsp = effectiveUrl === "" || /^rtsps?:\/\//i.test(effectiveUrl);

  // Salva (criar OU editar): valida a url no cliente ANTES de chamar a API; sucesso → toast +
  // fecha o form (a grade da Central atualiza pelo socket). transport só vai p/ rtsp; avançado
  // (fps/width/quality) só quando expandido — o backend valida/clampa os números.
  async function submitForm() {
    const url = fUrl.trim();
    if (editing == null || url !== "") {
      // criação exige url; edição só valida se o campo foi preenchido (em branco = mantém)
      if (!isValidCameraUrl(url)) {
        setFUrlError("URL inválida. Use rtsp://, rtsps:// ou http(s)://.");
        return; // bloqueia antes da rede
      }
    }
    setFUrlError(null);
    const body: Partial<NewCamera> = {};
    if (url) body.url = url;
    if (fLabel.trim()) body.label = fLabel.trim();
    if (urlIsRtsp) body.transport = fTransport;
    if (fAdvanced) {
      const fps = Number.parseInt(fFps, 10);
      const width = Number.parseInt(fWidth, 10);
      const quality = Number.parseInt(fQuality, 10);
      if (Number.isFinite(fps)) body.fps = fps;
      if (Number.isFinite(width)) body.width = width;
      if (Number.isFinite(quality)) body.quality = quality;
    }
    setBusy(true);
    try {
      if (editing) {
        await updateCamera(editing.id, body);
        toast("Câmera atualizada.", "ok");
      } else {
        await createCamera(body as NewCamera); // url garantida acima na criação
        toast("Câmera IP adicionada. Conectando…", "ok");
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      toast(
        e instanceof ApiError
          ? e.message
          : editing
            ? "Não foi possível atualizar a câmera."
            : "Não foi possível adicionar a câmera.",
        "alert",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(c: IpCamera) {
    setBusy(true);
    try {
      await updateCamera(c.id, { enabled: !c.enabled });
      toast(c.enabled ? "Câmera desabilitada." : "Câmera habilitada.", "ok");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar a câmera.", "alert");
    } finally {
      setBusy(false);
    }
  }

  async function removeCamera(c: IpCamera) {
    setBusy(true);
    try {
      await deleteCamera(c.id);
      toast("Câmera removida.", "default");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível remover a câmera.", "alert");
    } finally {
      setBusy(false);
      setConfirmDel(null);
    }
  }

  return (
    <section className="panel" aria-label="Câmeras IP / RTSP">
      <h2 className={H2_SEC}>Câmeras IP / RTSP</h2>
      <p className="muted cam-sec-hint">
        Câmeras de rede (RTSP/HLS/MJPEG). Ao salvar, o hub conecta e a câmera aparece na Central
        automaticamente. A URL pode conter credenciais — é tratada como sensível (exibida com o
        usuário/senha ocultos).
      </p>

      {loading && <p className="empty-note">Carregando…</p>}
      {!loading && loadErr && (
        <Alert tone="alert">
          {loadErr}{" "}
          <Button size="sm" onClick={() => void load()}>
            Tentar de novo
          </Button>
        </Alert>
      )}
      {!loading && !loadErr && cams.length === 0 && (
        <p className="empty-note">Nenhuma câmera IP cadastrada ainda.</p>
      )}
      {!loading && !loadErr && cams.length > 0 && (
        <div className="cam-list">
          {cams.map((c) => (
            <div key={`ipc-${c.id}`} className="cam-row">
              <div className="cam-row__name">
                <b>{c.label || "(sem nome)"}</b>
                {/* url mascarada: mostra host, oculta credenciais (LGPD). title= aqui anota um
                    DADO exibido (span não-interativo), não é affordance de controle — fica no
                    title= nativo (mesma exceção do heatmap). Os controles interativos da linha
                    (Editar/Remover, abaixo) é que usam <Tooltip>. */}
                <span className="muted" title="URL com credenciais ocultas">
                  {maskCameraUrl(c.url)}
                </span>
              </div>
              <Badge>{cameraKind(c.url)}</Badge>
              <label className="switch">
                <Switch
                  checked={c.enabled}
                  onCheckedChange={() => void toggleEnabled(c)}
                  disabled={busy}
                  ariaLabel={c.enabled ? `Desabilitar ${c.label || c.id}` : `Habilitar ${c.label || c.id}`}
                />{" "}
                {c.enabled ? "Ativa" : "Parada"}
              </label>
              <div className="cam-row__actions">
                <Tooltip content="Editar cadastro (nome, URL, transporte, avançado)">
                  <Button size="sm" disabled={busy} onClick={() => openEdit(c)}>
                    Editar
                  </Button>
                </Tooltip>
                <Tooltip content="Remover câmera">
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmDel(c)}>
                    Remover
                  </Button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cam-sec-foot">
        <Button variant="primary" onClick={openCreate}>
          + Adicionar câmera IP
        </Button>
      </div>

      {/* Form de criação/edição (Dialog). Mesmo form nos dois modos; na edição a URL em branco
          mantém a atual (nunca pré-preenchemos a url completa — credenciais). */}
      <Dialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        title={editing ? `Editar câmera IP — ${editing.label || editing.id}` : "Adicionar câmera IP"}
        description={
          editing
            ? "Altere só o que precisar. Deixe a URL em branco para manter a atual."
            : "Cadastre uma câmera de rede (RTSP/HLS/MJPEG). Ao salvar, o hub conecta e ela entra na grade automaticamente."
        }
      >
        <form
          className="cam-ip-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
        >
          <Field label="Nome (opcional)" htmlFor="cam-label">
            <Input
              id="cam-label"
              value={fLabel}
              onChange={(e) => setFLabel(e.target.value)}
              placeholder="Ex.: Doca 3"
            />
          </Field>
          <Field
            label="URL da câmera"
            htmlFor="cam-url"
            error={fUrlError ?? undefined}
            hint={
              editing
                ? "Em branco mantém a URL atual. rtsp:// · rtsps:// · http(s)://"
                : "rtsp:// · rtsps:// · http(s):// (HLS .m3u8 ou MJPEG)"
            }
          >
            <Input
              id="cam-url"
              value={fUrl}
              onChange={(e) => {
                setFUrl(e.target.value);
                if (fUrlError) setFUrlError(null);
              }}
              placeholder={
                editing
                  ? maskCameraUrl(editing.url)
                  : "rtsp://usuario:senha@10.0.0.52:554/Streaming/Channels/101"
              }
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {urlIsRtsp && (
            <Field
              label="Transporte (RTSP)"
              hint="TCP é o mais compatível; auto deixa o ffmpeg decidir."
            >
              <Select
                value={fTransport}
                onChange={(v) => setFTransport(v as CameraTransport)}
                ariaLabel="Transporte RTSP"
                options={[
                  { value: "tcp", label: "TCP (padrão)" },
                  { value: "udp", label: "UDP" },
                  { value: "http", label: "HTTP" },
                  { value: "auto", label: "Automático" },
                ]}
              />
            </Field>
          )}
          <label className="cam-ip-adv-toggle">
            <Checkbox
              checked={fAdvanced}
              onCheckedChange={(v) => setFAdvanced(!!v)}
              ariaLabel="Opções avançadas"
            />{" "}
            Opções avançadas (fps / largura / qualidade)
          </label>
          {fAdvanced && (
            <div className="cam-ip-adv">
              {/* Placeholders = defaults reais do hub (server/rtsp.js defaultCfg): fps 10 · width 720 · q 4.
                  Hints orientam o caso rua/panorâmica (item 2.5 do plano-melhoria-reconhecimento):
                  720 px encolhe pedestre distante p/ ~5–11 px — abaixo do mínimo do detector. */}
              <Field
                label="fps (1–30)"
                htmlFor="cam-fps"
                hint="Quadros/s que o hub extrai do stream; padrão 10. Menos fps = menos CPU."
              >
                <Input
                  id="cam-fps"
                  type="number"
                  min={1}
                  max={30}
                  value={fFps}
                  onChange={(e) => setFFps(e.target.value)}
                  placeholder="10"
                />
              </Field>
              <Field
                label="Largura (px, 160–1920)"
                htmlFor="cam-width"
                hint="Padrão 720. Use 1280–1920 p/ câmeras de rua/panorâmicas — em 720 um pedestre distante fica pequeno demais p/ o detector. Mais largura = mais CPU."
              >
                <Input
                  id="cam-width"
                  type="number"
                  min={160}
                  max={1920}
                  value={fWidth}
                  onChange={(e) => setFWidth(e.target.value)}
                  placeholder="720"
                />
              </Field>
              <Field
                label="Qualidade (1–31)"
                htmlFor="cam-quality"
                hint="Compressão JPEG do ffmpeg — MENOR = melhor imagem; padrão 4."
              >
                <Input
                  id="cam-quality"
                  type="number"
                  min={1}
                  max={31}
                  value={fQuality}
                  onChange={(e) => setFQuality(e.target.value)}
                  placeholder="4"
                />
              </Field>
            </div>
          )}
          <div className="cam-ip-foot">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Salvando…" : editing ? "Salvar alterações" : "Adicionar câmera"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Confirmação destrutiva da remoção (Radix AlertDialog controlado). */}
      <AlertDialog
        open={confirmDel != null}
        onOpenChange={(o) => {
          if (!o) setConfirmDel(null);
        }}
        title="Remover câmera?"
        description={
          confirmDel
            ? `A câmera "${confirmDel.label || confirmDel.id}" será desconectada e removida do cadastro.`
            : ""
        }
        confirmLabel="Remover"
        variant="danger"
        busy={busy}
        onConfirm={() => {
          if (confirmDel) void removeCamera(confirmDel);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </section>
  );
}
