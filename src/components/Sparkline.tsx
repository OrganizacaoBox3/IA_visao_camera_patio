// Telemetria lateral "NUNCA NÚMERO CRU" (NASA/HPHMI — P7 de 01-nasa-mission-control.md;
// north star da síntese: "valor + tendência (sparkline) + faixa-alvo").
// Componentes puros, SVG, SEM dependências:
//   • <Sparkline>  — a mini-série recente + a faixa-alvo (banda verde/aceitável), com a cor
//                    da linha ditada pelo estado (ok/warn/critical → tokens --state-*).
//   • <MetricCell> — embala rótulo + valor atual (colorido pelo estado) + sparkline + legenda
//                    da faixa-alvo. Realça (cor warn/critical) quando o valor sai da faixa.
// Toda a coloração consome os tokens da fundação (var(--state-*) / var(--cam-*)).
import "./telemetry.css";

export type Band = { lo: number; hi: number };
export type MetricState = "ok" | "warn" | "critical";

// Estado → cor da LINHA/ponto da sparkline (tokens da fundação).
// "ok" usa cinza neutro (going-gray: normal não grita); warn/critical usam saturação.
const STATE_STROKE: Record<MetricState, string> = {
  ok: "var(--state-neutral-fg)",
  warn: "var(--state-warn)",
  critical: "var(--state-critical)",
};
// Estado → cor do VALOR (texto). "ok" herda a cor do painel.
export const STATE_VALUE: Record<MetricState, string | undefined> = {
  ok: undefined,
  warn: "var(--state-warn-fg)",
  critical: "var(--state-critical-fg)",
};

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

type SparklineProps = {
  values: number[];      // série recente (mais antigo → mais novo)
  band?: Band;           // faixa-alvo (em unidades do dado) — banda verde
  min?: number;          // domínio fixo (default: deriva dos dados + banda)
  max?: number;
  state?: MetricState;   // cor da linha/ponto
  width?: number;        // viewBox (o CSS estica em largura via width:100%)
  height?: number;
  ariaLabel?: string;
};

export function Sparkline({ values, band, min, max, state = "ok", width = 96, height = 28, ariaLabel }: SparklineProps) {
  const pad = 2;
  const w = width, h = height;
  const pts = values.length ? values : [0];
  // Domínio inclui dados E banda, p/ a faixa-alvo aparecer mesmo quando a série está toda fora dela.
  let lo = min ?? Math.min(...pts, band ? band.lo : Infinity);
  let hi = max ?? Math.max(...pts, band ? band.hi : -Infinity);
  if (!isFinite(lo)) lo = 0;
  if (!isFinite(hi)) hi = 1;
  if (hi - lo < 1e-6) hi = lo + 1;

  const px = (i: number): number => pad + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (w - 2 * pad));
  const py = (v: number): number => { const t = (clamp(v, lo, hi) - lo) / (hi - lo); return h - pad - t * (h - 2 * pad); };
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const stroke = STATE_STROKE[state];

  let bandY = 0, bandH = 0;
  if (band) { const a = py(band.hi), b = py(band.lo); bandY = Math.min(a, b); bandH = Math.max(1, Math.abs(b - a)); }
  const lastX = px(pts.length - 1), lastY = py(pts[pts.length - 1]);

  return (
    <svg className="spark-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      {band && <rect className="spark-band" x={0} y={bandY} width={w} height={bandH} />}
      <path className="spark-line" d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle className="spark-dot" cx={lastX} cy={lastY} r={1.8} fill={stroke} />
    </svg>
  );
}

type MetricCellProps = {
  label: string;
  value: string;         // valor já formatado p/ exibição (ex.: "82%", "3", "0.27")
  values: number[];      // série crua p/ a sparkline (ring buffer leve)
  band?: Band;
  bandLabel?: string;    // legenda da faixa-alvo (ex.: "alvo ≥ 95%")
  state?: MetricState;
  min?: number;
  max?: number;
};

// Célula de telemetria: valor + sparkline + faixa-alvo. Realça quando fora da faixa.
export function MetricCell({ label, value, values, band, bandLabel, state = "ok", min, max }: MetricCellProps) {
  const out = state !== "ok";
  return (
    <div className={`metric ${out ? "out" : ""}`}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className="metric-value" style={{ color: STATE_VALUE[state] }}>
          {value}{out && <span className="metric-flag" style={{ color: STATE_VALUE[state] }}> ⚠ fora</span>}
        </span>
      </div>
      <Sparkline values={values} band={band} state={state} min={min} max={max} ariaLabel={`${label}: ${value}`} />
      {bandLabel && <div className="metric-band">{bandLabel}</div>}
    </div>
  );
}
