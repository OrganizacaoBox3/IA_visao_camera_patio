// N1 — "o detector está confiável?" (a faixa do topo do Relatório; era a rota /alarmes-saude).
// Racionalização ISA-18.2 / EEMUA 191 (norma só em tooltip — jargão de engenharia não renderiza).
//
// AS DUAS REGRAS QUE DECIDEM ESTE ARQUIVO (spec-arquitetura-informacao §2.5):
//
// 1. ESCALA TEMPORAL PRÓPRIA. Isto é `/api/alarms/metrics` — janela de ~10 min em MEMÓRIA do hub.
//    O corpo do Relatório é `/api/alarms` + buckets — histórico PERSISTIDO (dias). "Taxa/min nos
//    últimos 30 dias" NÃO EXISTE no back e não se inventa: esta faixa NÃO obedece ao filtro de
//    período, e DIZ ISSO NA CARA ("agora · últimos {janela}"). As duas verdades convivem em
//    ALTURAS diferentes da página — jamais lado a lado sob o mesmo filtro.
// 2. O ÚNICO RELÓGIO DA TELA. Só esta faixa tem timer (7s). O corpo histórico é carga única — não
//    pode repintar embaixo do gestor enquanto ele lê um heatmap. Por isso o estado vive AQUI
//    dentro (o re-render do tick não sobe para o ReportPage).
//
// Posição no topo, e não no rodapé: se o alarme está inundando, TODO número abaixo é suspeito —
// a saúde precede a leitura. Going-gray: base neutra; cor saturada só p/ o % crítico fora do alvo.
import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Sparkline } from "../../components/Sparkline";
import { Alert, SectionTitle, Spinner, Tooltip } from "../../ui";
import { getAlarmMetrics, type AlarmCounts, type AlarmMetrics } from "../../api";
import { shiftSuppressionReasonLabel, type AlarmShiftSuppression } from "../../types/alarm";
import "./health.css";

const REFRESH_MS = 7000; // auto-refresh leve (5–10s) — o ÚNICO timer do Relatório
const HIST_CAP = 30; // amostras retidas p/ as mini-tendências (client-side)
const PRIOS: Array<keyof AlarmCounts> = ["advisory", "high", "critical"];
const PRIO_LABEL: Record<keyof AlarmCounts, string> = {
  advisory: "Aviso",
  high: "Alta",
  critical: "Crítico",
};

// A rota devolve os campos do gate de turno ao lado das métricas de emissão (alarmPolicy.metrics()).
type Metrics = AlarmMetrics & AlarmShiftSuppression;

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

export function AlarmHealthStrip() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rateHist, setRateHist] = useState<number[]>([]);
  const [critHist, setCritHist] = useState<number[]>([]);

  const load = useCallback(async (cancelled: () => boolean) => {
    try {
      const m = await getAlarmMetrics();
      if (cancelled()) return;
      setMetrics(m);
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

  // Auto-refresh cancelável: o flag ignora respostas após o unmount.
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

  if (loading && !metrics)
    return (
      <section className="ah-strip" aria-label="Saúde do sistema de alarmes">
        <div className="ah-foot">
          <Spinner /> Carregando a saúde do alarme…
        </div>
      </section>
    );
  if (error && !metrics)
    return (
      <section className="ah-strip" aria-label="Saúde do sistema de alarmes">
        <Alert tone="alert">{error}</Alert>
      </section>
    );
  if (!metrics) return null;

  return (
    <section className="ah-strip" aria-label="Saúde do sistema de alarmes">
      <header className="ah-strip__head">
        <SectionTitle flush>O detector está confiável?</SectionTitle>
        {/* O CARIMBO DA ESCALA (regra nº 1 acima): esta faixa NÃO obedece ao período do
            relatório — e o diz em texto, não em nota de rodapé. */}
        <span className="ah-strip__now">
          <span className="ah-foot__dot" aria-hidden /> agora · últimos{" "}
          {fmtDuration(metrics.windowMs)} · atualiza a cada {Math.round(REFRESH_MS / 1000)}s
        </span>
      </header>

      {error && (
        <Alert tone="warn">
          Falha na última atualização: {error} (mostrando o último valor conhecido).
        </Alert>
      )}

      <div className="ah-kpis">
        <div className="ah-kpi">
          <span className="ah-kpi__label">Taxa de alarmes</span>
          <span className="ah-kpi__value">
            {metrics.ratePerMin.toFixed(1)}
            <small className="ah-kpi__unit"> /min</small>
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
          <span className="ah-kpi__label">Críticos (alvo ≤ {metrics.criticalTargetPct}%)</span>
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
            // Nunca só-por-cor: ícone + texto ao lado do realce.
            <span className="ah-kpi__flag">
              <TriangleAlert size={12} strokeWidth={1.75} aria-hidden /> acima do alvo —
              ruído/sobrecarga
            </span>
          ) : (
            // Norma vira tooltip — a tela fala língua de produto.
            <Tooltip
              content={`Alvo de boas práticas (EEMUA 191 / ISA-18.2): críticos ≤ ${metrics.criticalTargetPct}% do total.`}
            >
              <span className="ah-kpi__sub">dentro do alvo</span>
            </Tooltip>
          )}
        </div>

        {/* O KPI "último minuto / hora" MORREU: a taxa/min acima já cobre, e "picos recentes"
            não indica ação (spec §2.3). */}

        <div className="ah-kpi">
          <span className="ah-kpi__label">Silenciados</span>
          <span className="ah-kpi__value">{metrics.shelvedActive}</span>
          <span className="ah-kpi__sub">expiram sozinhos ao fim da duração</span>
        </div>

        <ShiftSuppression m={metrics} />

        {/* Distribuição por prioridade da JANELA. A 2ª barra ("última hora") morreu: janela=10min
            × hora=60min davam escalas quase iguais — era duplicata visual (spec §2.3).
            Ela vive AQUI, ao lado dos KPIs de 10 min, porque é o MESMO relógio — nunca no corpo
            histórico (onde estaria sob o filtro de período, dizendo outra verdade). */}
        <div className="ah-kpi">
          <SectionTitle flush>Por prioridade — na janela</SectionTitle>
          <PriorityDist counts={metrics.byPriorityWindow} />
        </div>
      </div>
    </section>
  );
}

// Tile "Suprimidos por turno" (spec-turnos-por-zona §4.1): o gate de turno (server/alarm/shift.js)
// CALA alertas de ociosidade fora do turno/na pausa — e supressão silenciosa mata a confiança no
// sistema de alarme. Quem cala, MOSTRA que calou, e POR QUÊ (a quebra por motivo).
// Going-gray: é o gate FUNCIONANDO (informação normal) → neutro; nada aqui é anormalidade.
// Hub anterior a esta onda não manda os campos: a UI diz isso em vez de exibir um 0 mentiroso.
function ShiftSuppression({ m }: { m: Metrics }) {
  const total = m.suppressedByShift;
  if (typeof total !== "number") {
    return (
      <div className="ah-kpi">
        <span className="ah-kpi__label">Suprimidos por turno</span>
        <span className="ah-kpi__value">—</span>
        <span className="ah-kpi__sub">hub sem o gate de turno</span>
      </div>
    );
  }
  const lastHour = m.suppressedByShiftLastHour ?? 0;
  const reasons = Object.entries(m.suppressedByShiftReasons ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="ah-kpi">
      <Tooltip content="Alertas que o gate calou porque a zona estava FORA do turno ou em PAUSA — janela esperada de vazio (convenção OEE: fora do turno não é ociosidade). Nenhum alerta é perdido em silêncio: ele aparece aqui.">
        <span className="ah-kpi__label">Suprimidos por turno</span>
      </Tooltip>
      <span className="ah-kpi__value">{total}</span>
      <span className="ah-kpi__sub">{lastHour} na última hora</span>
      {reasons.length > 0 ? (
        <ul className="ah-reasons" aria-label="Suprimidos por turno, por motivo (última hora)">
          {reasons.map(([reason, n]) => (
            <li className="ah-reasons__row" key={reason}>
              <span className="ah-reasons__label">{shiftSuppressionReasonLabel(reason)}</span>
              <span className="ah-reasons__num">{n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="ah-kpi__sub">nenhum alerta calado na última hora</span>
      )}
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
      {/* A legenda é TEXTO (rótulo + número), não só a cor do segmento. */}
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
