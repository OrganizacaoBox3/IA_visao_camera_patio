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
  FieldLabel,
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

type IpCameraDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Câmeras IP/RTSP (superadmin) — cadastro + gestão pela home.
// Cadastra câmeras dinâmicas (POST /api/cameras); a grade se atualiza sozinha pelos eventos socket
// `cameras`/`camera-status` (não refazemos o relé). A lista COM url (sensível) vem do GET
// /api/cameras e só é buscada com o painel aberto; a url nunca é logada e é mascarada na exibição.
// Renderizado só para superadmin (o pai monta este componente sob a guarda `isSuper`).
export function IpCameraDialog({ open, onOpenChange }: IpCameraDialogProps) {
  const { toast } = useToast();
  const [ipCameras, setIpCameras] = useState<IpCamera[]>([]);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipBusy, setIpBusy] = useState(false); // trava dupla submissão / mutações concorrentes
  const [confirmDel, setConfirmDel] = useState<IpCamera | null>(null);
  // Formulário de cadastro.
  const [fLabel, setFLabel] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fTransport, setFTransport] = useState<CameraTransport>("tcp");
  const [fUrlError, setFUrlError] = useState<string | null>(null);
  const [fAdvanced, setFAdvanced] = useState(false);
  const [fFps, setFFps] = useState("");
  const [fWidth, setFWidth] = useState("");
  const [fQuality, setFQuality] = useState("");

  // Carrega a lista de câmeras IP (com url) do backend — só com o painel aberto.
  const loadIpCameras = useCallback(async () => {
    setIpLoading(true);
    try {
      setIpCameras(await listCameras());
    } catch (e) {
      // Não logar a url; a lista nem carregou aqui, então só a mensagem amigável.
      toast(e instanceof ApiError ? e.message : "Não foi possível carregar as câmeras IP.", "alert");
    } finally {
      setIpLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) void loadIpCameras();
  }, [open, loadIpCameras]);

  function resetCameraForm() {
    setFLabel("");
    setFUrl("");
    setFTransport("tcp");
    setFUrlError(null);
    setFAdvanced(false);
    setFFps("");
    setFWidth("");
    setFQuality("");
  }

  // A URL vazia ou rtsp/rtsps mostra o seletor de transporte (só faz sentido p/ rtsp).
  const urlIsRtsp = fUrl.trim() === "" || /^rtsps?:\/\//i.test(fUrl.trim());

  // Cadastra a câmera: valida a url no cliente ANTES de chamar a API; sucesso → toast + limpa o form
  // (a câmera entra na grade pelo socket). transport só vai p/ rtsp; avançado (fps/width/quality) é opcional.
  async function submitCamera() {
    const url = fUrl.trim();
    if (!isValidCameraUrl(url)) {
      setFUrlError("URL inválida. Use rtsp://, rtsps:// ou http(s)://.");
      return; // bloqueia antes da rede
    }
    setFUrlError(null);
    const body: NewCamera = { url };
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
    setIpBusy(true);
    try {
      await createCamera(body); // o backend valida/clampa; a grade atualiza pelo socket
      toast("Câmera IP adicionada. Conectando…", "ok");
      resetCameraForm();
      await loadIpCameras();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível adicionar a câmera.", "alert");
    } finally {
      setIpBusy(false);
    }
  }

  async function toggleCameraEnabled(c: IpCamera) {
    setIpBusy(true);
    try {
      await updateCamera(c.id, { enabled: !c.enabled });
      toast(c.enabled ? "Câmera desabilitada." : "Câmera habilitada.", "ok");
      await loadIpCameras();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível atualizar a câmera.", "alert");
    } finally {
      setIpBusy(false);
    }
  }

  async function removeCamera(c: IpCamera) {
    setIpBusy(true);
    try {
      await deleteCamera(c.id);
      toast("Câmera removida.", "default");
      await loadIpCameras();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Não foi possível remover a câmera.", "alert");
    } finally {
      setIpBusy(false);
      setConfirmDel(null);
    }
  }

  return (
    <>
      {/* Câmeras IP/RTSP (superadmin): cadastro + gestão pela home. A grade se atualiza pelos
          eventos socket (`cameras`/`camera-status`) — aqui só disparamos as chamadas HTTP.
          LGPD: a url é sensível (credenciais) — mascarada na exibição e nunca logada. */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          onOpenChange(o);
          if (!o) {
            resetCameraForm();
            setConfirmDel(null);
          }
        }}
        title="Câmeras IP / RTSP"
        description={
          <>
            Cadastre câmeras de rede (RTSP/HLS/MJPEG). Ao salvar, o hub conecta e a câmera aparece na
            grade automaticamente. A URL pode conter credenciais — é tratada como sensível (exibida
            com o usuário/senha ocultos).
          </>
        }
      >
        <form
          className="cam-ip-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCamera();
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
            hint="rtsp:// · rtsps:// · http(s):// (HLS .m3u8 ou MJPEG)"
          >
            <Input
              id="cam-url"
              value={fUrl}
              onChange={(e) => {
                setFUrl(e.target.value);
                if (fUrlError) setFUrlError(null);
              }}
              placeholder="rtsp://usuario:senha@10.0.0.52:554/Streaming/Channels/101"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {urlIsRtsp && (
            <Field label="Transporte (RTSP)" hint="TCP é o mais compatível; auto deixa o ffmpeg decidir.">
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
              <Field label="fps (1–30)" htmlFor="cam-fps">
                <Input
                  id="cam-fps"
                  type="number"
                  min={1}
                  max={30}
                  value={fFps}
                  onChange={(e) => setFFps(e.target.value)}
                  placeholder="8"
                />
              </Field>
              <Field label="Largura (160–1920)" htmlFor="cam-width">
                <Input
                  id="cam-width"
                  type="number"
                  min={160}
                  max={1920}
                  value={fWidth}
                  onChange={(e) => setFWidth(e.target.value)}
                  placeholder="480"
                />
              </Field>
              <Field label="Qualidade (1–31)" htmlFor="cam-quality">
                <Input
                  id="cam-quality"
                  type="number"
                  min={1}
                  max={31}
                  value={fQuality}
                  onChange={(e) => setFQuality(e.target.value)}
                  placeholder="7"
                />
              </Field>
            </div>
          )}
          <div className="views-mgr__foot">
            <Button type="submit" variant="primary" disabled={ipBusy}>
              {ipBusy ? "Salvando…" : "Adicionar câmera"}
            </Button>
          </div>
        </form>

        <div className="views-mgr mt-3">
          <FieldLabel>Câmeras IP cadastradas</FieldLabel>
          {ipLoading && <p className="empty-note">Carregando…</p>}
          {!ipLoading && ipCameras.length === 0 && (
            <p className="empty-note">Nenhuma câmera IP cadastrada ainda.</p>
          )}
          {ipCameras.map((c) => (
            <div key={`ipc-${c.id}`} className="views-mgr__row">
              <div className="views-mgr__name">
                <b>{c.label || "(sem nome)"}</b>
                {/* url mascarada: mostra host, oculta credenciais (LGPD) */}
                <span className="muted" title="URL com credenciais ocultas">
                  {maskCameraUrl(c.url)}
                </span>
              </div>
              <label className="switch">
                <Switch
                  checked={c.enabled}
                  onCheckedChange={() => void toggleCameraEnabled(c)}
                  disabled={ipBusy}
                  ariaLabel={c.enabled ? "Desabilitar câmera" : "Habilitar câmera"}
                />{" "}
                {c.enabled ? "Ativa" : "Parada"}
              </label>
              <Tooltip content="Remover câmera">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={ipBusy}
                  onClick={() => setConfirmDel(c)}
                >
                  Remover
                </Button>
              </Tooltip>
            </div>
          ))}
        </div>
      </Dialog>

      {/* Confirmação destrutiva da remoção de câmera IP (Radix AlertDialog controlado). */}
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
        busy={ipBusy}
        onConfirm={() => {
          if (confirmDel) void removeCamera(confirmDel);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </>
  );
}
