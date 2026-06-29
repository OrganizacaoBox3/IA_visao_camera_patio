import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Sparkline } from "../components/Sparkline";
import {
  PageHeader, Button, Field, Input, Select, Alert, Spinner, EmptyState, useToast,
  ScrollArea, AlertDialog, Tooltip,
} from "../ui";
import {
  getAlarmMetrics, listShelves, createShelve, deleteShelve,
  type AlarmMetrics, type AlarmCounts, type Shelve,
} from "../api";
import "./alarm-health.css";

// Tela de SAÚDE DE ALARMES (ISA-18.2 / EEMUA 191 — racionalização · Onda B).
// É uma tela de engenharia/ops: monitora a saúde do PRÓPRIO sistema de alertas (taxa, % de
// críticos vs. o alvo ≤5%, distribuição por prioridade) e gerencia SHELVES (silenciamentos
// temporários com expiração). going-gray: base neutra, cor saturada só p/ anormalidade.
//
// RBAC (decisão documentada): o LINK de navegação só aparece p/ canConfigure (é tela de
// engenharia). Mesmo assim, a rota é acessível por URL — então quem NÃO tem canConfigure vê
// as métricas em modo somente-leitura e os controles de shelve (criar/remover) ficam ocultos.

const REFRESH_MS = 7000;         // auto-refresh leve (5–10s)
const HIST_CAP = 30;             // amostras retidas p/ as mini-tendências (client-side)
const PRIOS: Array<keyof AlarmCounts> = ["advisory", "high", "critical"];
const PRIO_LABEL: Record<keyof AlarmCounts, string> = { advisory: "Aviso", high: "Alta", critical: "Crítico" };

// Opções de duração do shelve (com expiração automática — não é desabilitar permanente).
const DUR_OPTS = [
  { value: String(15 * 60_000), label: "15 minutos" },
  { value: String(30 * 60_000), label: "30 minutos" },
  { value: String(60 * 60_000), label: "1 hora" },
  { value: String(120 * 60_000), label: "2 horas" },
  { value: String(8 * 60 * 60_000), label: "8 horas (turno)" },
];

function fmtDuration(ms: number): string {
  if (ms <= 0) return "expirado";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function AlarmHealthPage() {
  const { user, canConfigure } = useAuth();
  const { toast } = useToast();

  const [metrics, setMetrics] = useState<AlarmMetrics | null>(null);
  const [shelves, setShelves] = useState<Shelve[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mini-tendências (ring buffers client-side: a API dá o instantâneo, acumulamos a série).
  const [rateHist, setRateHist] = useState<number[]>([]);
  const [critHist, setCritHist] = useState<number[]>([]);

  // Formulário de criação de shelve.
  const [fKey, setFKey] = useState("");
  const [fDur, setFDur] = useState(DUR_OPTS[1].value);
  const [fReason, setFReason] = useState("");
  const [fBusy, setFBusy] = useState(false);
  const [fErr, setFErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null); // shelve aguardando confirmação de remoção

  const load = useCallback(async (cancelled: () => boolean) => {
    try {
      const [m, sh] = await Promise.all([getAlarmMetrics(), listShelves()]);
      if (cancelled()) return;
      setMetrics(m); setShelves(sh); setError(null);
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
    return () => { dead = true; window.clearInterval(id); };
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const key = fKey.trim();
    if (!key) { setFErr("Informe a chave (cameraId|zona|tipo)."); return; }
    setFBusy(true); setFErr(null);
    try {
      await createShelve({ key, ms: Number(fDur), reason: fReason.trim() || undefined });
      setFKey(""); setFReason("");
      toast("Shelve criado.", "ok");
      await load(() => false);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Falha ao criar shelve.";
      setFErr(msg); toast(msg, "alert");
    } finally { setFBusy(false); }
  }

  async function onRemove(key: string) {
    setRemoving(key);
    try {
      await deleteShelve(key);
      setShelves((s) => (s ? s.filter((x) => x.key !== key) : s));
      toast("Shelve removido.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao remover shelve.", "alert");
    } finally { setRemoving(null); }
  }

  return (
    <div className="page">
      <PageHeader title="Saúde de alarmes" subtitle="Racionalização do sistema de alertas (ISA-18.2 / EEMUA 191)">
        <span className="ah-foot"><span className="ah-foot__dot" aria-hidden>●</span> atualiza a cada {Math.round(REFRESH_MS / 1000)}s</span>
      </PageHeader>

      <div className="ah-body">
        {loading && !metrics ? (
          <div className="ah-foot"><Spinner /> Carregando métricas…</div>
        ) : error && !metrics ? (
          <Alert tone="alert">{error}</Alert>
        ) : metrics ? (
          <>
            {error && <Alert tone="warn">Falha na última atualização: {error} (mostrando o último valor conhecido).</Alert>}

            {/* KPIs de saúde — overview glanceable (nunca só número cru). */}
            <section className="ah-kpis" aria-label="Indicadores de saúde">
              <div className="ah-kpi">
                <span className="ah-kpi__label">Taxa de alarmes</span>
                <span className="ah-kpi__value">{metrics.ratePerMin.toFixed(1)}<small style={{ fontSize: 12 }}> /min</small></span>
                <Sparkline values={rateHist.length ? rateHist : [metrics.ratePerMin]} state="ok" ariaLabel="tendência da taxa de alarmes" />
                <span className="ah-kpi__sub">{metrics.inWindow} na janela de {fmtDuration(metrics.windowMs)}</span>
              </div>

              <div className="ah-kpi" data-over={metrics.overTarget ? "1" : "0"}>
                <span className="ah-kpi__label">Críticos (alvo ≤ {metrics.criticalTargetPct}%)</span>
                <span className="ah-kpi__value" data-over={metrics.overTarget ? "1" : "0"}>{metrics.criticalPct.toFixed(1)}%</span>
                <Sparkline
                  values={critHist.length ? critHist : [metrics.criticalPct]}
                  band={{ lo: 0, hi: metrics.criticalTargetPct }}
                  state={metrics.overTarget ? "critical" : "ok"}
                  min={0}
                  ariaLabel="tendência do percentual de críticos"
                />
                {metrics.overTarget
                  ? <span className="ah-kpi__flag">⚠ acima do alvo — ruído/sobrecarga</span>
                  : <span className="ah-kpi__sub">dentro do alvo EEMUA</span>}
              </div>

              <div className="ah-kpi">
                <span className="ah-kpi__label">Último minuto / hora</span>
                <span className="ah-kpi__value">{metrics.lastMinute}<small style={{ fontSize: 12, color: "var(--state-neutral-fg)" }}> · {metrics.lastHour}/h</small></span>
                <span className="ah-kpi__sub">picos recentes do sistema</span>
              </div>

              <div className="ah-kpi">
                <span className="ah-kpi__label">Shelves ativos</span>
                <span className="ah-kpi__value">{metrics.shelvedActive}</span>
                <span className="ah-kpi__sub">silenciamentos com expiração</span>
              </div>
            </section>

            {/* Distribuição por prioridade (analógica) — janela e última hora. */}
            <section className="ah-kpis" aria-label="Distribuição por prioridade">
              <div className="ah-kpi">
                <span className="ah-kpi__label">Por prioridade — janela</span>
                <PriorityDist counts={metrics.byPriorityWindow} />
              </div>
              <div className="ah-kpi">
                <span className="ah-kpi__label">Por prioridade — última hora</span>
                <PriorityDist counts={metrics.byPriorityHour} />
              </div>
            </section>

            {/* Shelves: lista ativa + criação (criação/remoção só p/ canConfigure). */}
            <div className="ah-cols">
              <section className="ah-kpi">
                <span className="ah-kpi__label">Shelves ativos</span>
                {shelves == null ? (
                  <div className="ah-foot"><Spinner /> carregando…</div>
                ) : shelves.length === 0 ? (
                  <EmptyState>Nenhum alarme silenciado. Os alertas seguem o fluxo normal.</EmptyState>
                ) : (
                  <ScrollArea className="ah-shelves-scroll" style={{ maxHeight: 360 }}>
                    <div className="ah-shelves">
                      {shelves.map((s) => (
                        <div className="ah-shelve" key={s.key}>
                          <div className="ah-shelve__top">
                            <span className="ah-shelve__key">{s.key}</span>
                            <span className="ah-shelve__remaining">⏳ {fmtDuration(s.remainingMs)}</span>
                          </div>
                          <div className="ah-shelve__meta">
                            {s.reason && <span>motivo: {s.reason}</span>}
                            {s.by && <span>por: {s.by}</span>}
                            <span>expira: {new Date(s.expiresAt).toLocaleTimeString("pt-BR")}</span>
                          </div>
                          {canConfigure && (
                            <div className="ah-shelve__actions">
                              <Button variant="danger" size="sm" disabled={removing === s.key} onClick={() => setConfirmKey(s.key)}>
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
                  <span className="ah-kpi__label">Silenciar temporariamente (shelve)</span>
                  <p className="ah-form__hint">
                    Chave no formato <code>cameraId|zona|tipo</code>, com <code>*</code> como curinga.
                    Ex.: <code>cam-1|doca-3|fadiga</code> (específico), <code>cam-1|*|*</code> (toda a câmera),
                    {" "}<code>*|*|leitura</code> (um tipo em tudo). Expira sozinho ao fim da duração.
                  </p>
                  <Field label="Chave" htmlFor="ah-key">
                    <Input id="ah-key" placeholder="cameraId|zona|tipo" value={fKey} onChange={(e) => setFKey(e.target.value)} />
                  </Field>
                  <Field label="Duração" htmlFor="ah-dur">
                    <Select ariaLabel="Duração do shelve" value={fDur} onChange={setFDur} options={DUR_OPTS} />
                  </Field>
                  <Field label="Motivo (registro)" htmlFor="ah-reason" hint="Ex.: limpeza da doca, manutenção da câmera.">
                    <Input id="ah-reason" placeholder="motivo do silenciamento" value={fReason} onChange={(e) => setFReason(e.target.value)} />
                  </Field>
                  <div>
                    <Button variant="primary" type="submit" disabled={fBusy || !fKey.trim()}>{fBusy ? "Criando…" : "Criar shelve"}</Button>
                  </div>
                  {fErr && <Alert tone="alert">{fErr}</Alert>}
                </form>
              ) : (
                <section className="ah-kpi">
                  <span className="ah-kpi__label">Gerenciar shelves</span>
                  <EmptyState>Somente perfis de configuração (engenheiro/superadmin) podem criar ou remover silenciamentos. Você está em modo somente-leitura.</EmptyState>
                </section>
              )}
            </div>

            <div className="ah-foot">Sessão: {user.usuario} · papel {user.papel}{canConfigure ? "" : " (somente leitura)"}.</div>

            {/* Confirmação destrutiva da remoção de shelve (controlada via AlertDialog). */}
            <AlertDialog
              open={confirmKey !== null}
              onOpenChange={(o) => { if (!o) setConfirmKey(null); }}
              title="Remover shelve?"
              description={confirmKey
                ? <>O silenciamento <code>{confirmKey}</code> será removido e os alertas correspondentes voltam ao fluxo normal.</>
                : undefined}
              confirmLabel="Remover"
              cancelLabel="Cancelar"
              variant="danger"
              onConfirm={() => { const k = confirmKey; setConfirmKey(null); if (k) void onRemove(k); }}
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
      <div className="ah-dist__bar" role="img" aria-label={`Distribuição: ${PRIOS.map((p) => `${PRIO_LABEL[p]} ${counts[p] || 0}`).join(", ")}`}>
        {total > 0
          ? PRIOS.map((p) => {
              const v = counts[p] || 0;
              if (v <= 0) return null;
              return (
                <Tooltip key={p} content={`${PRIO_LABEL[p]}: ${v} (${Math.round((v / total) * 100)}%)`}>
                  <span className="ah-dist__seg" data-prio={p} style={{ width: `${(v / total) * 100}%` }} />
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
        <span className="ah-dist__key">total <span className="ah-dist__num">{total}</span></span>
      </div>
    </div>
  );
}
