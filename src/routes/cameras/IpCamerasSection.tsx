import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Copy } from "lucide-react";
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
  FieldLabel,
  Badge,
  Alert,
  EmptyState,
  Tooltip,
  HelpTip,
  useToast,
  SectionTitle,
} from "../../ui";
import { copyToClipboard } from "../../ui/clipboard";
import { setCameraCfg, type CameraCfg } from "../../cameraConfig";
import { useCamCfgs } from "../useCamCfgs";
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

// ID de câmera encurtado p/ exibição (nó local = UUID): os 8 primeiros chars identificam;
// o ID completo fica no tooltip do botão copiar (auditoria #15 — UUID cru fora da superfície).
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// Linha reconciliada: identidade + de qual(is) fonte(s) veio. `ip` = registro IP (superadmin);
// `online` = está conectada agora (aparece no socket). Nem toda linha tem `ip` (nós locais) nem
// todo `ip` está online (cadastro parado/erro).
type CameraRow = { id: string; label: string; ip: IpCamera | null; online: boolean };

export function CamerasList() {
  const { token, isSuper, canConfigure } = useAuth();
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

  // camcfg por câmera (papel/transporte). setCameraCfg persiste (write-through) e responde
  // sucesso/falha: falha no PUT vira toast — o ajuste não some mais em silêncio (fica só no
  // cache local deste navegador). Estado local reflete no mesmo tick.
  const { setCfgs, cfgOf } = useCamCfgs(connected);
  function applyCfg(id: string, merged: CameraCfg) {
    setCfgs((prev) => ({ ...prev, [id]: merged }));
    void setCameraCfg(id, merged).then((ok) => {
      if (!ok)
        toast("Não foi possível salvar no servidor — ajuste mantido só neste navegador.", "alert");
    });
  }
  function setKind(id: string, fadiga: boolean) {
    applyCfg(id, { ...cfgOf(id), modo: fadiga ? "fadiga" : "atividade" });
  }
  function setTransport(id: string, transport: CameraCfg["transport"]) {
    applyCfg(id, { ...cfgOf(id), transport });
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

  // Copia o ID da câmera (nó local mostra o ID encurtado; o completo vai p/ a área de transferência).
  async function copyId(id: string) {
    const ok = await copyToClipboard(id);
    toast(ok ? "ID copiado." : "Não foi possível copiar o ID.", ok ? "ok" : "alert");
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
      {/* Prosa-manual (~57 palavras) virou tooltip "?" — hierarquia de ajuda da casa
          (label → placeholder → tooltip; nunca parágrafo permanente na tela). */}
      <div className="cam-sec-head">
        <SectionTitle flush>Câmeras da central</SectionTitle>
        <HelpTip label="Sobre a lista de câmeras">
          Uma linha por câmera — de rede (IP/RTSP) ou nó local (webcam). Câmera IP cadastrada
          aparece mesmo offline; ao conectar, entra na Central automaticamente. Tipo e vídeo só
          são ajustáveis com a câmera conectada. A URL é sensível: usuário/senha ficam ocultos.
        </HelpTip>
      </div>

      {loading && <p className="empty-note">Carregando…</p>}
      {!loading && loadErr && (
        <Alert tone="alert">
          {loadErr}{" "}
          <Button size="sm" onClick={() => void load()}>
            Tentar de novo
          </Button>
        </Alert>
      )}
      {/* Vazio na fórmula status + causa + ação (NN/g). O texto do superadmin é load-bearing
          no e2e (getByText exato) — preservado letra a letra. */}
      {!loading && !loadErr && rows.length === 0 && (
        <EmptyState>
          <p className="m-0">
            {isSuper ? "Nenhuma câmera IP cadastrada ainda." : "Nenhuma câmera conectada."}
          </p>
          <p className="m-0 text-sec text-text-muted">
            {isSuper
              ? "Adicione uma câmera de rede abaixo ou abra um nó local (webcam)."
              : "Abra um nó local abaixo — ele aparece aqui ao conectar."}
          </p>
        </EmptyState>
      )}
      {!loading && !loadErr && rows.length > 0 && (
        <div className="cam-list">
          {rows.map((row) => {
            const cfg = cfgOf(row.id);
            const isFadiga = cfg.modo === "fadiga";
            // papel/vídeo só p/ câmera conectada E perfil de configuração — o PUT /api/camconfig
            // exige canConfigure; deixar o Select habilitado p/ operador era falha silenciosa.
            const canAdjust = row.online && canConfigure;
            return (
              <div key={`cam-${row.id}`} className="cam-row cam-set-row">
                <div className="cam-row__name">
                  <b>{row.label}</b>
                  {/* IP → url mascarada (host visível, credenciais ocultas — LGPD); nó local →
                      ID encurtado + copiar (o UUID completo mora no tooltip, não na superfície).
                      title= no span anota um DADO exibido (não-interativo) — exceção documentada. */}
                  {row.ip ? (
                    <span className="muted" title="URL com credenciais ocultas">
                      {maskCameraUrl(row.ip.url)}
                    </span>
                  ) : (
                    <span className="muted cam-row__id">
                      {shortId(row.id)}
                      <Tooltip content={`ID completo: ${row.id}`}>
                        <button
                          type="button"
                          className="cam-help"
                          aria-label="Copiar ID da câmera"
                          onClick={() => void copyId(row.id)}
                        >
                          <Copy size={12} strokeWidth={1.75} aria-hidden />
                        </button>
                      </Tooltip>
                    </span>
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
                  <div className="cam-set-field">
                    <FieldLabel>Tipo da câmera</FieldLabel>
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
                  </div>
                  {/* Transporte do VÍDEO NO PAINEL (go2rtc). Rótulo EXTERNO (Field) + valores
                      limpos — o prefixo saiu de dentro do value (auditoria #15); a mecânica
                      auto/override (go2rtc × relé) mora no tooltip "?", não na superfície. */}
                  <div className="cam-set-field">
                    <span className="cam-set-field__label">
                      <FieldLabel>Vídeo no painel</FieldLabel>
                      <HelpTip label="Como o vídeo chega ao painel">
                        Automático (padrão) escolhe o melhor transporte e troca sozinho: WebRTC
                        (vídeo fluido) quando disponível, senão MJPEG — sem configurar nada.
                        MJPEG e WebRTC forçam um modo fixo (ajuste manual).
                      </HelpTip>
                    </span>
                    <Select
                      value={cfg.transport}
                      onChange={(v) => setTransport(row.id, v as CameraCfg["transport"])}
                      ariaLabel="Vídeo no painel"
                      disabled={!canAdjust}
                      options={[
                        { value: "auto", label: "Automático" },
                        { value: "mjpeg", label: "MJPEG" },
                        { value: "webrtc", label: "WebRTC" },
                      ]}
                    />
                  </div>
                  {!canAdjust && (
                    <span className="muted cam-adjust-hint">
                      {canConfigure
                        ? "Conecte a câmera para ajustar tipo e vídeo."
                        : "Seu perfil não permite alterar tipo e vídeo."}
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
            : "Ao salvar, a central conecta e a câmera entra na grade."
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
              editing ? "Em branco mantém a URL atual." : "rtsp:// ou http(s):// (HLS/MJPEG)"
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
            <Field label="Transporte (RTSP)" hint="TCP é o mais compatível.">
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
              <Field label="fps (1–30)" htmlFor="cam-fps" hint="Padrão 10 — menos fps, menos CPU.">
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
                hint="Padrão 720 — use 1280–1920 em câmera de rua/panorâmica. Mais largura, mais CPU."
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
                hint="Menor = melhor imagem; padrão 4."
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
