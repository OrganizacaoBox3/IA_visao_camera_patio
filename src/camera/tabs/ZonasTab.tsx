// Aba "Zonas" do drawer da câmera — lista de zonas (cada uma com seu modo de IA + telemetria)
// e a legenda do overlay. Componente puro: recebe estado/handlers já resolvidos pelo CameraWorkspace.
import { APP_CONFIG } from "../../config";
import { fmtDuration } from "../../format";
import { sensitivityFactor } from "../../processors/atividade";
import { objClass } from "../../objects/catalog";
import { ZONE_MODE_LABEL, type Zone } from "../../zones";
import { Badge, Tooltip } from "../../ui";
import { MetricCell } from "../../components/Sparkline";
import { RISK_LABEL, stateVar, type ZoneResult } from "../draw";
import {
  EAR_HI,
  NOREAD_BAND,
  RATE_BAND,
  OCC_BAND,
  OCC_HI,
  stateToMetric,
  rateToMetric,
  noReadMetric,
  occMetric,
  riskToMetric,
} from "../useTelemetry";
import { MODE_TONE, RISK_TONE } from "./tone";

type Props = {
  zonesLoading: boolean;
  zones: Zone[];
  canConfigure: boolean;
  panel: Map<string, ZoneResult>;
  paintZoneId: string | null;
  hist: (zoneId: string, key: string) => number[];
  legend: { color: string; label: string }[];
  setCfgZoneId: (id: string) => void;
  startPaint: (z: Zone) => void;
  setPaintZoneId: (id: string | null) => void;
  removeZone: (id: string) => void;
};

export function ZonasTab({
  zonesLoading,
  zones,
  canConfigure,
  panel,
  paintZoneId,
  hist,
  legend,
  setCfgZoneId,
  startPaint,
  setPaintZoneId,
  removeZone,
}: Props) {
  return (
    <>
      {zonesLoading && <p className="empty-note">Carregando zonas…</p>}
      {!zonesLoading && zones.length > 0 && canConfigure && (
        <p className="empty-note">
          Cada zona roda um modo de IA na sua área (Atividade, Leitura, Objetos ou Fadiga). Para
          trocar: ⚙ na zona → <b>Modo</b>.
        </p>
      )}
      {!zonesLoading && zones.length === 0 && (
        <p className="empty-note">
          {canConfigure
            ? "Use “✎ Zona” para desenhar uma área sobre o vídeo; depois ⚙ na zona → Modo (Atividade, Leitura, Objetos ou Fadiga)."
            : "Nenhuma zona configurada. A edição de zonas requer perfil de engenharia."}
        </p>
      )}
      {zones.map((z) => {
        const r = panel.get(z.id);
        const st = r?.modo === "atividade" ? r.view.state : "ATIVA";
        return (
          <div key={z.id} className={`zone ${st}`}>
            <div className="row">
              <span className="zone-head">
                {/* title em dado, não affordance: .zone-name trunca (ellipsis) — o title
                    revela o VALOR completo do rótulo, não é dica de controle. */}
                <b className="zone-name" title={z.label}>
                  {z.label}
                </b>
                <Badge tone={MODE_TONE[z.modo]}>{ZONE_MODE_LABEL[z.modo]}</Badge>
              </span>
              <span className="zone-tools">
                <Tooltip
                  content={
                    canConfigure
                      ? "Configurar zona (modo e parâmetros)"
                      : "Configuração requer perfil de engenharia"
                  }
                >
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Configurar zona"
                    onClick={() => canConfigure && setCfgZoneId(z.id)}
                  >
                    ⚙
                  </button>
                </Tooltip>
                <Tooltip
                  content={
                    canConfigure
                      ? "Pintar a área (blueprint em grade)"
                      : "Edição requer perfil de engenharia"
                  }
                >
                  <button
                    className={`del ${paintZoneId === z.id ? "on" : ""}`}
                    disabled={!canConfigure}
                    aria-label="Pintar área"
                    onClick={() =>
                      canConfigure && (paintZoneId === z.id ? setPaintZoneId(null) : startPaint(z))
                    }
                  >
                    🖌
                  </button>
                </Tooltip>
                <Tooltip content={canConfigure ? "Remover zona" : "Remover requer perfil de engenharia"}>
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Remover zona"
                    onClick={() => canConfigure && removeZone(z.id)}
                  >
                    ✕
                  </button>
                </Tooltip>
              </span>
            </div>

            {z.modo === "atividade" &&
              (r?.modo === "atividade" ? (
                (() => {
                  const ms = stateToMetric(r.view.state);
                  const activeThr = sensitivityFactor(z.sensitivity) / 6; // limiar ATIVA em unidades de view.motion
                  return (
                    <>
                      {/* estado/parada: indicadores categóricos/temporais (mantidos como KPI) */}
                      <div className="kpis ws-kpis">
                        <div className="kpi">
                          <div className="v" style={{ color: stateVar(r.view.state), fontSize: 13 }}>
                            {r.view.state}
                          </div>
                          <div className="l">estado</div>
                        </div>
                        <div className="kpi">
                          <div className="v">{fmtDuration(r.view.idleMs)}</div>
                          <div className="l">parada</div>
                        </div>
                      </div>
                      {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                      <MetricCell
                        label="Movimento"
                        value={`${Math.round(r.view.motion * 100)}%`}
                        values={hist(z.id, "motion")}
                        band={{ lo: activeThr, hi: 1 }}
                        bandLabel="alvo: zona ativa"
                        state={ms}
                        min={0}
                        max={1}
                      />
                      <MetricCell
                        label="Ocupação"
                        value={`${r.view.people}`}
                        values={hist(z.id, "people")}
                        band={OCC_BAND}
                        bandLabel={`alvo 1–${OCC_HI} pessoas`}
                        state={occMetric(r.view.people)}
                        min={0}
                      />
                      <div className="zone-flow">
                        <span>Fluxo</span>
                        <span className={`flow-chip ${r.view.flowLevel}`}>{r.view.flowLevel}</span>
                        <span className="spark">
                          {r.view.flow.map((s, i) => (
                            <i key={i} style={{ height: `${Math.max(6, Math.round(s * 100))}%` }} />
                          ))}
                        </span>
                      </div>
                    </>
                  );
                })()
              ) : (
                <p className="ws-wait">iniciando…</p>
              ))}

            {z.modo === "leitura" &&
              (r?.modo === "leitura" ? (
                <>
                  {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                  <MetricCell
                    label="Taxa de leitura"
                    value={`${r.ratePct}%`}
                    values={hist(z.id, "rate")}
                    band={RATE_BAND}
                    bandLabel="alvo ≥ 95%"
                    state={rateToMetric(r.ratePct)}
                    min={0}
                    max={100}
                  />
                  <MetricCell
                    label="Lidas/min"
                    value={`${r.perMin}`}
                    values={hist(z.id, "perMin")}
                    min={0}
                  />
                  <MetricCell
                    label="No-reads"
                    value={`${r.noReads}`}
                    values={hist(z.id, "noReads")}
                    band={NOREAD_BAND}
                    bandLabel="alvo 0"
                    state={noReadMetric(r.noReads)}
                    min={0}
                  />
                  <div className="ws-code">
                    <span className="muted">último código</span>
                    <code>{r.lastCode ?? "—"}</code>
                  </div>
                  <div className="ws-metric-row">
                    Ponto <b>{z.ponto}</b> · {r.passes} passagens
                  </div>
                </>
              ) : (
                <p className="ws-wait">iniciando…</p>
              ))}

            {z.modo === "objetos" && (
              <>
                <div className="ws-counts">
                  {z.selectedClasses.length === 0 && (
                    <span className="muted">nenhuma classe — abra ⚙</span>
                  )}
                  {z.selectedClasses.map((k) => {
                    const o = objClass(k);
                    const n = r?.modo === "objetos" ? (r.counts[k] ?? 0) : 0;
                    return (
                      // title em dado, não affordance: o chip mostra emoji + contagem;
                      // o title revela o VALOR (rótulo da classe atrás do emoji).
                      <span
                        key={k}
                        className={`count-chip ${n > 0 ? "on" : ""}`}
                        style={n > 0 ? { borderColor: o?.color, color: o?.color } : undefined}
                        title={o?.label}
                      >
                        {o?.emoji} <b>{n}</b>
                      </span>
                    );
                  })}
                </div>
                {/* telemetria: total em cena com tendência (sem faixa-alvo fixa — depende da cena) */}
                <MetricCell
                  label="Total em cena"
                  value={`${r?.modo === "objetos" ? r.total : 0}`}
                  values={hist(z.id, "total")}
                  min={0}
                />
              </>
            )}

            {z.modo === "fadiga" && (
              <>
                <div className="ws-fadiga">
                  {r?.modo === "fadiga" && r.faceState === "ready" ? (
                    <>
                      <Badge tone={RISK_TONE[r.risk]}>{RISK_LABEL[r.risk]}</Badge>
                      <span className="muted">📱 {r.phone ? "sim" : "não"}</span>
                    </>
                  ) : (
                    <span className="muted">
                      {r?.modo === "fadiga"
                        ? r.faceState === "loading"
                          ? "carregando modelo…"
                          : "modelo falhou"
                        : "iniciando…"}
                    </span>
                  )}
                </div>
                {r?.modo === "fadiga" && r.faceState === "ready" && (
                  /* telemetria "nunca número cru": EAR com faixa-alvo (olhos abertos) */
                  <MetricCell
                    label="EAR (abertura ocular)"
                    value={r.ear == null ? "--" : r.ear.toFixed(2)}
                    values={hist(z.id, "ear")}
                    band={{ lo: APP_CONFIG.fadiga.eyesClosedEarThreshold, hi: EAR_HI }}
                    bandLabel={`alvo ≥ ${APP_CONFIG.fadiga.eyesClosedEarThreshold.toFixed(2)}`}
                    state={riskToMetric(r.risk)}
                    min={0}
                    max={EAR_HI}
                  />
                )}
                <p className="empty-note zone-note">
                  Monitora 1 operador na ROI da zona (recorte). Som/calibração na câmera dedicada.
                </p>
              </>
            )}

            {z.modo === "exclusao" && (
              <p className="empty-note zone-note">
                Máscara de supressão: pessoas com o pé nesta área são ignoradas (não contam, não
                rastreiam). Sem indicador.
              </p>
            )}
          </div>
        );
      })}
      {legend.length > 0 && (
        <div className="ws-legend">
          <div className="ws-legend-title">Legenda do overlay</div>
          <div className="ws-legend-items">
            {legend.map((e, i) => (
              <span key={i} className="leg">
                <i style={{ background: e.color }} />
                {e.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
