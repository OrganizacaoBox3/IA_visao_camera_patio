import { useCallback, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { Hourglass, TriangleAlert } from "lucide-react";
import { useAuth } from "../auth";
import { APP_CONFIG } from "../config";
import { Sparkline } from "../components/Sparkline";
import {
  PageHeader,
  Button,
  Field,
  Input,
  Select,
  Alert,
  Spinner,
  EmptyState,
  useToast,
  ScrollArea,
  AlertDialog,
  Tooltip,
} from "../ui";
import {
  getAlarmMetrics,
  listShelves,
  createShelve,
  deleteShelve,
  getZones,
  type AlarmMetrics,
  type AlarmCounts,
  type Shelve,
} from "../api";
import type { Camera } from "./dashboard/types";
import "./alarm-health.css";

// Tela de SAÚDE DE ALARMES (racionalização ISA-18.2 / EEMUA 191 · Onda B — normas só em
// tooltip/comentário; jargão de engenharia não renderiza). Monitora a saúde do PRÓPRIO
// sistema de alertas (taxa, % de críticos vs. alvo ≤5%, distribuição por prioridade) e
// gerencia SILENCIAMENTOS temporários com expiração (shelving, no vocabulário da norma).
// going-gray: base neutra, cor saturada só p/ anormalidade.
//
// RBAC (decisão documentada): o LINK de navegação só aparece p/ canConfigure (é tela de
// engenharia). Mesmo assim, a rota é acessível por URL — então quem NÃO tem canConfigure vê
// as métricas em modo somente-leitura e os controles de silenciamento ficam ocultos.

const REFRESH_MS = 7000; // auto-refresh leve (5–10s)
const HIST_CAP = 30; // amostras retidas p/ as mini-tendências (client-side)
const PRIOS: Array<keyof AlarmCounts> = ["advisory", "high", "critical"];
const PRIO_LABEL: Record<keyof AlarmCounts, string> = {
  advisory: "Aviso",
  high: "Alta",
  critical: "Crítico",
};

// Opções de duração do silenciamento (com expiração automática — nunca desliga permanente).
const DUR_OPTS = [
  { value: String(15 * 60_000), label: "15 minutos" },
  { value: String(30 * 60_000), label: "30 minutos" },
  { value: String(60 * 60_000), label: "1 hora" },
  { value: String(120 * 60_000), label: "2 horas" },
  { value: String(8 * 60 * 60_000), label: "8 horas (turno)" },
];

// Tipos de alerta da política (contrato AlarmTipo) — "*" = curinga do back ("qualquer").
const ANY = "*";
const TIPO_LABEL: Record<string, string> = {
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Operador (fadiga)",
  presenca: "Presença", // violação de zona proibida (spec alerta-por-atividade)
};
const TIPO_OPTS = [
  { value: ANY, label: "Qualquer tipo" },
  ...Object.entries(TIPO_LABEL).map(([value, label]) => ({ value, label })),
];

function fmtDuration(ms: number): string {
  if (ms <= 0) return "expirado";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function AlarmHealthPage() {
  const { token, canConfigure } = useAuth();
  const { toast } = useToast();

  const [metrics, setMetrics] = useState<AlarmMetrics | null>(null);
  const [shelves, setShelves] = useState<Shelve[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mini-tendências (ring buffers client-side: a API dá o instantâneo, acumulamos a série).
  const [rateHist, setRateHist] = useState<number[]>([]);
  const [critHist, setCritHist] = useState<number[]>([]);

  // Câmeras CONECTADAS (rótulos p/ o builder e p/ a lista de silenciamentos). Mesmo padrão
  // de /cameras: socket só-para-a-lista — `watch({ids:[]})` = zero vídeo nesta tela.
  const [cams, setCams] = useState<Camera[]>([]);
  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socket.on("connect", () => socket.emit("watch", { ids: [] }));
    socket.on("cameras", (list: Camera[]) => setCams(Array.isArray(list) ? list : []));
    return () => {
      socket.disconnect();
    };
  }, [token]);

  // ── Builder do silenciamento (#6): 3 Selects (câmera → zona → tipo) MONTAM a chave
  //    `cameraId|zona|tipo` do contrato do back por baixo — ninguém digita chave crua. ──
  const [fCam, setFCam] = useState(ANY);
  const [fZona, setFZona] = useState(ANY);
  const [fTipo, setFTipo] = useState(ANY);
  const [fDur, setFDur] = useState(DUR_OPTS[1].value);
  const [fReason, setFReason] = useState("");
  const [fBusy, setFBusy] = useState(false);
  const [fErr, setFErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null); // silenciamento aguardando confirmação de remoção

  // Zonas da câmera escolhida (rótulos) — zonas de exclusão nunca alarmam, ficam de fora.
  const [zoneOpts, setZoneOpts] = useState<string[]>([]);
  useEffect(() => {
    if (fCam === ANY) {
      setZoneOpts([]);
      return;
    }
    let dead = false;
    getZones(fCam)
      .then((zs) => {
        if (dead) return;
        const labels = zs
          .filter((z) => z.modo !== "exclusao")
          .map((z) => z.label.trim())
          .filter(Boolean);
        setZoneOpts([...new Set(labels)]);
      })
      .catch(() => {
        if (!dead) setZoneOpts([]); // sem zonas → só "qualquer zona" (a câmera inteira)
      });
    return () => {
      dead = true;
    };
  }, [fCam]);

  // Rótulos legíveis (a chave crua nunca renderiza; fica no tooltip p/ diagnóstico).
  const camLabel = useCallback(
    (seg: string) =>
      seg === ANY
        ? "qualquer câmera"
        : (cams.find((c) => c.id.toLowerCase() === seg.toLowerCase())?.label ?? seg),
    [cams],
  );
  const zonaLabel = (seg: string) => (seg === ANY ? "qualquer zona" : seg);
  const tipoLabel = (seg: string) => (seg === ANY ? "qualquer tipo" : (TIPO_LABEL[seg] ?? seg));
  const shelveLabel = useCallback(
    (key: string) => {
      const [cam = ANY, zona = ANY, tipo = ANY] = key.split("|");
      return `${camLabel(cam)} · ${zonaLabel(zona)} · ${tipoLabel(tipo)}`;
    },
    [camLabel],
  );

  const camOpts = useMemo(
    () => [
      { value: ANY, label: "Qualquer câmera" },
      ...cams.map((c) => ({ value: c.id, label: c.label })),
    ],
    [cams],
  );

  const load = useCallback(async (cancelled: () => boolean) => {
    try {
      const [m, sh] = await Promise.all([getAlarmMetrics(), listShelves()]);
      if (cancelled()) return;
      setMetrics(m);
      setShelves(sh);
      setError(null);
      setRateHist((h) => [...h, m.ratePerMin].slice(-HIST_CAP));
      setCritHist((h) => [...h, m.criticalPct].slice(-HIST_CAP));
    } catch (e) {
      if (cancelled()) return;
      setError(e instanceof Error ? e.message : "Falha ao carregar a saúde de alarmes.");
    } finally {
      if (!cancelled()) setLoading(false);
    }
  }, []);

  // Auto-refresh cancelável: o flag em ref ignora respostas após o unmount.
  useEffect(() => {
    let dead = false;
    const cancelled = () => dead;
    void load(cancelled);
    const id = window.setInterval(() => void load(cancelled), REFRESH_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    // Guard-rail: "qualquer" nas TRÊS dimensões silenciaria o sistema inteiro.
    if (fCam === ANY && fZona === ANY && fTipo === ANY) {
      setFErr("Escolha ao menos uma dimensão específica (câmera, zona ou tipo).");
      return;
    }
    // Chave do contrato do back ("cameraId|zona|tipo", "*" = curinga) montada aqui;
    // o servidor normaliza (trim/lowercase) via normShelveKey — contrato intacto.
    const key = `${fCam}|${fZona}|${fTipo}`;
    setFBusy(true);
    setFErr(null);
    try {
      await createShelve({ key, ms: Number(fDur), reason: fReason.trim() || undefined });
      setFCam(ANY);
      setFZona(ANY);
      setFTipo(ANY);
      setFReason("");
      toast("Silenciamento criado.", "ok");
      await load(() => false);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Falha ao criar o silenciamento.";
      setFErr(msg);
      toast(msg, "alert");
    } finally {
      setFBusy(false);
    }
  }

  async function onRemove(key: string) {
    setRemoving(key);
    try {
      await deleteShelve(key);
      setShelves((s) => (s ? s.filter((x) => x.key !== key) : s));
      toast("Silenciamento removido.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao remover o silenciamento.", "alert");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Saúde de alarmes"
        subtitle="Taxa, prioridades e silenciamentos temporários do sistema de alertas"
      >
        <span className="ah-foot">
          <span className="ah-foot__dot" aria-hidden /> atualiza a cada{" "}
          {Math.round(REFRESH_MS / 1000)}s
        </span>
      </PageHeader>

      <div className="ah-body">
        {loading && !metrics ? (
          <div className="ah-foot">
            <Spinner /> Carregando métricas…
          </div>
        ) : error && !metrics ? (
          <Alert tone="alert">{error}</Alert>
        ) : metrics ? (
          <>
            {error && (
              <Alert tone="warn">
                Falha na última atualização: {error} (mostrando o último valor conhecido).
              </Alert>
            )}

            {/* KPIs de saúde — overview glanceable (nunca só número cru). */}
            <section className="ah-kpis" aria-label="Indicadores de saúde">
              <div className="ah-kpi">
                <span className="ah-kpi__label">Taxa de alarmes</span>
                <span className="ah-kpi__value">
                  {metrics.ratePerMin.toFixed(1)}
                  <small className="text-[12px]"> /min</small>
                </span>
                <Sparkline
                  values={rateHist.length ? rateHist : [metrics.ratePerMin]}
                  state="ok"
                  ariaLabel="tendência da taxa de alarmes"
                />
                <span className="ah-kpi__sub">
                  {metrics.inWindow} na janela de {fmtDuration(metrics.windowMs)}
                </span>
              </div>

              <div className="ah-kpi" data-over={metrics.overTarget ? "1" : "0"}>
                <span className="ah-kpi__label">
                  Críticos (alvo ≤ {metrics.criticalTargetPct}%)
                </span>
                <span className="ah-kpi__value" data-over={metrics.overTarget ? "1" : "0"}>
                  {metrics.criticalPct.toFixed(1)}%
                </span>
                <Sparkline
                  values={critHist.length ? critHist : [metrics.criticalPct]}
                  band={{ lo: 0, hi: metrics.criticalTargetPct }}
                  state={metrics.overTarget ? "critical" : "ok"}
                  min={0}
                  ariaLabel="tendência do percentual de críticos"
                />
                {metrics.overTarget ? (
                  <span className="ah-kpi__flag">
                    <TriangleAlert size={12} strokeWidth={1.75} aria-hidden /> acima do alvo —
                    ruído/sobrecarga
                  </span>
                ) : (
                  // Norma vira tooltip (achado 10.3) — a tela fala língua de produto.
                  <Tooltip
                    content={`Alvo de boas práticas (EEMUA 191 / ISA-18.2): críticos ≤ ${metrics.criticalTargetPct}% do total.`}
                  >
                    <span className="ah-kpi__sub">dentro do alvo</span>
                  </Tooltip>
                )}
              </div>

              <div className="ah-kpi">
                <span className="ah-kpi__label">Último minuto / hora</span>
                <span className="ah-kpi__value">
                  {metrics.lastMinute}
                  <small className="text-[12px] text-[color:var(--state-neutral-fg)]">
                    {" "}
                    · {metrics.lastHour}/h
                  </small>
                </span>
                <span className="ah-kpi__sub">picos recentes do sistema</span>
              </div>

              <div className="ah-kpi">
                <span className="ah-kpi__label">Silenciamentos ativos</span>
                <span className="ah-kpi__value">{metrics.shelvedActive}</span>
                <span className="ah-kpi__sub">expiram sozinhos ao fim da duração</span>
              </div>
            </section>

            {/* Distribuição por prioridade (analógica) — janela e última hora. */}
            <section className="ah-kpis" aria-label="Distribuição por prioridade">
              <div className="ah-kpi">
                <h2 className="ah-kpi__label">Por prioridade — janela</h2>
                <PriorityDist counts={metrics.byPriorityWindow} />
              </div>
              <div className="ah-kpi">
                <h2 className="ah-kpi__label">Por prioridade — última hora</h2>
                <PriorityDist counts={metrics.byPriorityHour} />
              </div>
            </section>

            {/* Silenciamentos: lista ativa + criação (criar/remover só p/ canConfigure). */}
            <div className="ah-cols">
              <section className="ah-kpi">
                <h2 className="ah-kpi__label">Silenciamentos ativos</h2>
                {shelves == null ? (
                  <div className="ah-foot">
                    <Spinner /> carregando…
                  </div>
                ) : shelves.length === 0 ? (
                  <EmptyState>
                    Nenhum alarme silenciado. Os alertas seguem o fluxo normal.
                  </EmptyState>
                ) : (
                  <ScrollArea className="ah-shelves-scroll">
                    <div className="ah-shelves">
                      {shelves.map((s) => (
                        <div className="ah-shelve" key={s.key}>
                          <div className="ah-shelve__top">
                            {/* Rótulo legível (câmera · zona · tipo); a chave crua do
                                contrato só aparece no tooltip (diagnóstico). */}
                            <Tooltip content={`chave: ${s.key}`}>
                              <span className="ah-shelve__label">{shelveLabel(s.key)}</span>
                            </Tooltip>
                            <span className="ah-shelve__remaining">
                              <Hourglass size={12} strokeWidth={1.75} aria-hidden />{" "}
                              {fmtDuration(s.remainingMs)}
                            </span>
                          </div>
                          <div className="ah-shelve__meta">
                            {s.reason && <span>motivo: {s.reason}</span>}
                            {s.by && <span>por: {s.by}</span>}
                            <span>expira: {new Date(s.expiresAt).toLocaleTimeString("pt-BR")}</span>
                          </div>
                          {canConfigure && (
                            <div className="ah-shelve__actions">
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={removing === s.key}
                                onClick={() => setConfirmKey(s.key)}
                              >
                                {removing === s.key ? "Removendo…" : "Remover"}
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </section>

              {canConfigure ? (
                <form className="ah-kpi ah-form" onSubmit={onCreate}>
                  <h2 className="ah-kpi__label">Silenciar alertas temporariamente</h2>
                  <Field label="Câmera">
                    <Select
                      ariaLabel="Câmera"
                      value={fCam}
                      onChange={(v) => {
                        setFCam(v);
                        setFZona(ANY); // zona pertence à câmera — troca de câmera reseta
                      }}
                      options={camOpts}
                    />
                  </Field>
                  <Field
                    label="Zona"
                    hint={fCam === ANY ? "Escolha uma câmera para listar as zonas." : undefined}
                  >
                    <Select
                      ariaLabel="Zona"
                      value={fZona}
                      onChange={setFZona}
                      disabled={fCam === ANY}
                      options={[
                        { value: ANY, label: "Qualquer zona" },
                        ...zoneOpts.map((z) => ({ value: z, label: z })),
                      ]}
                    />
                  </Field>
                  <Field label="Tipo de alerta">
                    <Select
                      ariaLabel="Tipo de alerta"
                      value={fTipo}
                      onChange={setFTipo}
                      options={TIPO_OPTS}
                    />
                  </Field>
                  <Field label="Duração">
                    <Select
                      ariaLabel="Duração do silenciamento"
                      value={fDur}
                      onChange={setFDur}
                      options={DUR_OPTS}
                    />
                  </Field>
                  <Field
                    label="Motivo (registro)"
                    htmlFor="ah-reason"
                    hint="Ex.: limpeza da doca, manutenção da câmera."
                  >
                    <Input
                      id="ah-reason"
                      placeholder="motivo do silenciamento"
                      value={fReason}
                      onChange={(e) => setFReason(e.target.value)}
                    />
                  </Field>
                  <p className="ah-form__hint">
                    Vai silenciar:{" "}
                    <b>
                      {camLabel(fCam)} · {zonaLabel(fZona)} · {tipoLabel(fTipo)}
                    </b>{" "}
                    — expira sozinho ao fim da duração.
                  </p>
                  <div>
                    <Button variant="primary" type="submit" disabled={fBusy}>
                      {fBusy ? "Silenciando…" : "Silenciar"}
                    </Button>
                  </div>
                  {fErr && <Alert tone="alert">{fErr}</Alert>}
                </form>
              ) : (
                <section className="ah-kpi">
                  <h2 className="ah-kpi__label">Gerenciar silenciamentos</h2>
                  <EmptyState>
                    Somente perfis de configuração (engenheiro/superadmin) podem criar ou remover
                    silenciamentos. Você está em modo somente-leitura.
                  </EmptyState>
                </section>
              )}
            </div>

            {/* A linha "Sessão: usuário · papel" foi REMOVIDA (padronização A3): o AppShell já
                mostra usuário+papel no menu de conta, e o modo somente-leitura já é comunicado
                pelo painel "Gerenciar silenciamentos" — o rodapé era redundante e órfão. */}

            {/* Confirmação destrutiva da remoção (controlada via AlertDialog). */}
            <AlertDialog
              open={confirmKey !== null}
              onOpenChange={(o) => {
                if (!o) setConfirmKey(null);
              }}
              title="Remover silenciamento?"
              description={
                confirmKey ? (
                  <>
                    O silenciamento de <b>{shelveLabel(confirmKey)}</b> será removido e os
                    alertas correspondentes voltam ao fluxo normal.
                  </>
                ) : undefined
              }
              confirmLabel="Remover"
              cancelLabel="Cancelar"
              variant="danger"
              onConfirm={() => {
                const k = confirmKey;
                setConfirmKey(null);
                if (k) void onRemove(k);
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// Barra de distribuição por prioridade: proporção analógica + contagens (nunca só número cru).
function PriorityDist({ counts }: { counts: AlarmCounts }) {
  const total = PRIOS.reduce((a, p) => a + (counts[p] || 0), 0);
  return (
    <div className="ah-dist">
      <div
        className="ah-dist__bar"
        role="img"
        aria-label={`Distribuição: ${PRIOS.map((p) => `${PRIO_LABEL[p]} ${counts[p] || 0}`).join(", ")}`}
      >
        {total > 0
          ? PRIOS.map((p) => {
              const v = counts[p] || 0;
              if (v <= 0) return null;
              return (
                <Tooltip
                  key={p}
                  content={`${PRIO_LABEL[p]}: ${v} (${Math.round((v / total) * 100)}%)`}
                >
                  <span
                    className="ah-dist__seg"
                    data-prio={p}
                    style={{ width: `${(v / total) * 100}%` }}
                  />
                </Tooltip>
              );
            })
          : null}
      </div>
      <div className="ah-dist__legend">
        {PRIOS.map((p) => (
          <span className="ah-dist__key" key={p}>
            <span className="ah-dist__dot" data-prio={p} aria-hidden />
            {PRIO_LABEL[p]} <span className="ah-dist__num">{counts[p] || 0}</span>
          </span>
        ))}
        <span className="ah-dist__key">
          total <span className="ah-dist__num">{total}</span>
        </span>
      </div>
    </div>
  );
}
