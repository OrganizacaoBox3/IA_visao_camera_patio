import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../../config";
import { useAuth } from "../../auth";
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
  SectionTitle,
} from "../../ui";
import { getCameraCfg, setCameraCfg, type CameraCfg } from "../../cameraConfig";
import { type Camera } from "../dashboard/types";
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

// ── Lista UNIFICADA de câmeras (/cameras) ──────────────────────────────────────────────────
// Antes esta tela tinha DUAS listas que se sobrepunham: "Câmeras IP / RTSP" (cadastro/identidade
// via GET /api/cameras — inclui offline, com Editar/Remover) e "Ajustes desta câmera" (câmeras
// CONECTADAS via socket, com papel + vídeo no painel). Aqui elas viram UMA só listagem por câmera,
// reconciliando as duas fontes por `id` (a duplicação de iteração/lista/nota foi extinta).
//
// DUAS FONTES (reconciliadas por id):
//   A. REGISTRO IP (GET /api/cameras, via listCameras) — url/transporte/estado + Editar/Remover +
//      "Adicionar câmera IP". É superadmin-only (a API é superadmin); os demais papéis não a buscam.
//      Inclui câmeras OFFLINE (cadastradas mas ainda não conectadas ao hub).
//   B. CONECTADAS (socket role:"dashboard" + watch{ids:[]}) — a MESMA lista que a grade da Central:
//      inclui nós locais/webcam (que NÃO estão no registro IP). Zero relé de vídeo aqui (watch vazio).
//      Visível a todos os papéis (o write-through do camcfg degrada em silêncio p/ operador).
//
// FRONTEIRA online × offline: papel (área × operador/fadiga) e "Vídeo no painel" (MJPEG × WebRTC)
// só fazem sentido para a câmera CONECTADA — setCameraCfg é aplicado quando ela está na grade. Para
// a IP-offline (cadastrada mas fora do ar) esses ajustes ficam DESABILITADOS com dica; identidade +
// Editar/Remover seguem disponíveis (não se perde a gestão do cadastro por estar offline).
//
// LGPD/segurança: a url pode conter credenciais — nunca é logada e é exibida mascarada (host visível,
// usuário/senha ocultos). Renderiza os controles de CRUD só para superadmin.

// Tipo do stream deduzido da URL — só informativo, para a lista (o hub decide pelo esquema).
function cameraKind(url: string): string {
  const u = (url ?? "").trim().toLowerCase();
  if (u.startsWith("rtsp")) return "RTSP";
  if (u.includes(".m3u8")) return "HLS";
  return "HTTP/MJPEG";
}

// Linha reconciliada: identidade + de qual(is) fonte(s) veio. `ip` = registro IP (superadmin);
// `online` = está conectada agora (aparece no socket). Nem toda linha tem `ip` (nós locais) nem
// todo `ip` está online (cadastro parado/erro).
type CameraRow = { id: string; label: string; ip: IpCamera | null; online: boolean };

export function CamerasList() {
  const { token, isSuper } = useAuth();
  const { toast } = useToast();

  // Fonte B — câmeras CONECTADAS (todos os papéis). Socket só-para-a-lista: `watch({ ids: [] })`
  // no connect blinda contra o relé de frames (zero vídeo nesta tela).
  const [connected, setConnected] = useState<Camera[]>([]);
  const socketRef = useRef<Socket | null>(null);
  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      socket.emit("watch", { ids: [] }); // sem vídeo aqui — só a lista de câmeras
    });
    socket.on("cameras", (list: Camera[]) => setConnected(list));
    return () => {
      socket.disconnect();
    };
  }, [token]);

  // Fonte A — REGISTRO de câmeras IP (com url). Superadmin only; os demais nem chamam a API. Falha
  // vira estado de erro claro (com "Tentar de novo"), não um toast passageiro.
  const [ipCams, setIpCams] = useState<IpCamera[]>([]);
  const [loading, setLoading] = useState(isSuper);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!isSuper) return; // registro IP é superadmin-only
    setLoading(true);
    try {
      setIpCams(await listCameras());
      setLoadErr(null);
    } catch (e) {
      // Não logar a url; a lista nem carregou aqui, então só a mensagem amigável.
      setLoadErr(
        e instanceof ApiError ? e.message : "Não foi possível carregar as câmeras IP.",
      );
    } finally {
      setLoading(false);
    }
  }, [isSuper]);
  useEffect(() => {
    void load();
  }, [load]);

  // camcfg por câmera (papel/transporte). setCameraCfg persiste; este estado reflete no mesmo tick.
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of connected)
        if (!next[c.id]) {
          next[c.id] = getCameraCfg(c.id);
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [connected]);
  function cfgOf(id: string): CameraCfg {
    return cfgs[id] ?? getCameraCfg(id);
  }
  function setKind(id: string, fadiga: boolean) {
    setCfgs((prev) => {
      const merged: CameraCfg = { ...cfgOf(id), modo: fadiga ? "fadiga" : "atividade" };
      setCameraCfg(id, merged);
      return { ...prev, [id]: merged };
    });
  }
  function setTransport(id: string, transport: CameraCfg["transport"]) {
    setCfgs((prev) => {
      const merged: CameraCfg = { ...cfgOf(id), transport };
      setCameraCfg(id, merged);
      return { ...prev, [id]: merged };
    });
  }

  // ── RECONCILIAÇÃO das duas fontes por id ──
  // Ordem: primeiro os cadastros IP (na ordem do registro, offline inclusos), depois as CONECTADAS
  // que não estão no registro (nós locais/webcam). União sem duplicar a câmera IP que está online.
  const connectedById = new Map(connected.map((c) => [c.id, c]));
  const ipIds = new Set(ipCams.map((c) => c.id));
  const rows: CameraRow[] = [
    ...ipCams.map((ip) => ({
      id: ip.id,
      label: ip.label || "(sem nome)",
      ip,
      online: connectedById.has(ip.id),
    })),
    ...connected
      .filter((c) => !ipIds.has(c.id))
      .map((c) => ({ id: c.id, label: c.label || "(sem nome)", ip: null, online: true })),
  ];

  // ── CRUD do registro IP (superadmin) ── Form (Dialog) serve CRIAR (editing=null) e EDITAR.
  const [busy, setBusy] = useState(false); // trava dupla submissão / mutações concorrentes
  const [confirmDel, setConfirmDel] = useState<IpCamera | null>(null);
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
    <section className="panel" aria-label="Câmeras">
      <SectionTitle>Câmeras da central</SectionTitle>
      <p className="muted cam-sec-hint">
        Uma linha por câmera — de rede (IP/RTSP) ou nó local (webcam). Câmera IP cadastrada aparece
        aqui mesmo <b>offline</b> (com Editar/Remover); ao conectar, o hub a mostra na Central
        automaticamente. <b>Papel</b> e <b>Vídeo no painel</b> só valem para câmera{" "}
        <b>conectada</b> (ficam desabilitados enquanto offline). A URL pode conter credenciais — é
        tratada como sensível (exibida com o usuário/senha ocultos).
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
      {!loading && !loadErr && rows.length === 0 && (
        <p className="empty-note">
          {isSuper
            ? "Nenhuma câmera IP cadastrada ainda."
            : "Nenhuma câmera conectada. Abra um nó local abaixo; ele aparece aqui assim que conectar à central."}
        </p>
      )}
      {!loading && !loadErr && rows.length > 0 && (
        <div className="cam-list">
          {rows.map((row) => {
            const cfg = cfgOf(row.id);
            const isFadiga = cfg.modo === "fadiga";
            const canAdjust = row.online; // papel/vídeo só p/ câmera conectada (na grade)
            return (
              <div key={`cam-${row.id}`} className="cam-row cam-set-row">
                <div className="cam-row__name">
                  <b>{row.label}</b>
                  {/* IP → url mascarada (host visível, credenciais ocultas — LGPD); nó local → id.
                      title= aqui anota um DADO exibido (span não-interativo), não uma affordance de
                      controle — segue no title= nativo (mesma exceção do heatmap). */}
                  {row.ip ? (
                    <span className="muted" title="URL com credenciais ocultas">
                      {maskCameraUrl(row.ip.url)}
                    </span>
                  ) : (
                    <span className="muted">{row.id}</span>
                  )}
                </div>
                {row.ip && <Badge>{cameraKind(row.ip.url)}</Badge>}
                {/* going-gray: online = neutro (operação normal); offline = âmbar (atenção). */}
                <span className="cam-status" data-online={row.online ? "1" : "0"}>
                  {row.online ? "Online" : "Offline"}
                </span>
                {row.ip && (
                  <label className="switch">
                    <Switch
                      checked={row.ip.enabled}
                      onCheckedChange={() => void toggleEnabled(row.ip!)}
                      disabled={busy}
                      ariaLabel={
                        row.ip.enabled
                          ? `Desabilitar ${row.label}`
                          : `Habilitar ${row.label}`
                      }
                    />{" "}
                    {row.ip.enabled ? "Ativa" : "Parada"}
                  </label>
                )}
                <div className="cam-set-controls">
                  <Select
                    value={isFadiga ? "fadiga" : "area"}
                    onChange={(v) => setKind(row.id, v === "fadiga")}
                    ariaLabel="Tipo da câmera"
                    disabled={!canAdjust}
                    options={[
                      { value: "area", label: "Câmera de área (zonas)" },
                      { value: "fadiga", label: "Operador (fadiga)" },
                    ]}
                  />
                  {/* Transporte do VÍDEO NO PAINEL (go2rtc). Rótulo desambiguado do `transport`
                      tcp/udp do RTSP (no cadastro IP) — aquele é do ffmpeg. "Automático" (padrão) =
                      melhor disponível; MJPEG/WebRTC são OVERRIDES manuais (escape hatch). */}
                  <Select
                    value={cfg.transport}
                    onChange={(v) => setTransport(row.id, v as CameraCfg["transport"])}
                    ariaLabel="Vídeo no painel"
                    disabled={!canAdjust}
                    options={[
                      { value: "auto", label: "Vídeo no painel: Automático (melhor disponível)" },
                      { value: "mjpeg", label: "Vídeo no painel: MJPEG" },
                      { value: "webrtc", label: "Vídeo no painel: WebRTC" },
                    ]}
                  />
                  {!canAdjust && (
                    <span className="muted cam-adjust-hint">
                      Conecte a câmera para ajustar papel e vídeo.
                    </span>
                  )}
                </div>
                {row.ip && (
                  <div className="cam-row__actions">
                    <Tooltip content="Editar cadastro (nome, URL, transporte, avançado)">
                      <Button size="sm" disabled={busy} onClick={() => openEdit(row.ip!)}>
                        Editar
                      </Button>
                    </Tooltip>
                    <Tooltip content="Remover câmera">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => setConfirmDel(row.ip)}
                      >
                        Remover
                      </Button>
                    </Tooltip>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Cadastro de câmera IP — só superadmin (a API /api/cameras é superadmin). */}
      {isSuper && (
        <div className="cam-sec-foot">
          <Button variant="primary" onClick={openCreate}>
            + Adicionar câmera IP
          </Button>
        </div>
      )}

      <p className="muted cam-set-note">
        <b>Automático</b> (padrão) = melhor disponível: usa WebRTC (vídeo fluido via go2rtc) quando o
        go2rtc serve a câmera e cai para MJPEG (frames do relé) quando não — sem configurar nada.
        <b> MJPEG</b> e <b>WebRTC</b> forçam um transporte fixo (override manual).
      </p>

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
