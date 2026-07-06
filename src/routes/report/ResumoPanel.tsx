// Resumo executivo: um cartão-porta por dimensão (Atividade/Fadiga/Leitura/Objetos) com os
// KPIs consolidados — tocar num cartão abre o modo. Consome só os SUMMARIES dos view-models.
import {
  fmtMin,
  type Kpis,
  type ReadingKpis,
  type ObjectKpis,
  type FadigaKpis,
} from "../../report/calc";
import { classLabel } from "./ObjetosPanel";

export function ResumoPanel({
  periodLabel,
  shiftLabel,
  k,
  tips,
  fk,
  fOccFadiga,
  fOccCelular,
  ftips,
  rk,
  rtips,
  ok,
  oLoads,
  onOpenMode,
}: {
  periodLabel: string;
  shiftLabel: string;
  k: Kpis;
  tips: string[];
  fk: FadigaKpis;
  fOccFadiga: number;
  fOccCelular: number;
  ftips: string[];
  rk: ReadingKpis;
  rtips: string[];
  ok: ObjectKpis;
  oLoads: number;
  onOpenMode: (m: "atividade" | "fadiga" | "leitura" | "objetos") => void;
}) {
  return (
    <>
      <div className="rep-lens">
        Resumo executivo · <b>{periodLabel}</b> · Turno: {shiftLabel}
      </div>
      <div className="rep-resumo">
        <button className="resumo-card" onClick={() => onOpenMode("atividade")}>
          <div className="rc-h">
            Operação <span className="muted">atividade</span>
          </div>
          <div className="rc-kpis">
            <div className="rc-k">
              {/* going-gray: verde incondicional removido — cor só condicional a estado */}
              <b>{k.activePct}%</b>
              <span>tempo ativo</span>
            </div>
            <div className="rc-k">
              <b>{fmtMin(k.idleMin)}</b>
              <span>parado</span>
            </div>
            <div className="rc-k">
              <b style={{ color: k.alerts ? "var(--state-critical)" : undefined }}>{k.alerts}</b>
              <span>alertas</span>
            </div>
          </div>
          <div className="rc-foot">
            área mais parada: {k.topArea} · pico {String(k.peakHour).padStart(2, "0")}h
          </div>
        </button>

        <button className="resumo-card" onClick={() => onOpenMode("fadiga")}>
          <div className="rc-h">
            Segurança <span className="muted">operador/fadiga</span>
          </div>
          <div className="rc-kpis">
            <div className="rc-k">
              <b
                style={{
                  // going-gray: ≤2% é o normal → sem cor; saturada só no risco.
                  color:
                    fk.alertPct <= 2
                      ? undefined
                      : fk.alertPct <= 10
                        ? "var(--state-warn)"
                        : "var(--state-critical)",
                }}
              >
                {fk.alertPct}%
              </b>
              <span>em alerta</span>
            </div>
            <div className="rc-k">
              <b style={{ color: fOccFadiga ? "var(--state-warn)" : undefined }}>{fOccFadiga}</b>
              <span>fadiga</span>
            </div>
            <div className="rc-k">
              <b style={{ color: fOccCelular ? "var(--state-warn)" : undefined }}>{fOccCelular}</b>
              <span>celular</span>
            </div>
          </div>
          <div className="rc-foot">horário crítico: {String(fk.peakHour).padStart(2, "0")}h</div>
        </button>

        <button className="resumo-card" onClick={() => onOpenMode("leitura")}>
          <div className="rc-h">
            Logística <span className="muted">leitura/expedição</span>
          </div>
          <div className="rc-kpis">
            <div className="rc-k">
              <b>{rk.boxes.toLocaleString("pt-BR")}</b>
              <span>caixas</span>
            </div>
            <div className="rc-k">
              <b
                style={{
                  // going-gray: taxa boa (≥95%) é o normal → sem cor; saturada só no degradado.
                  color:
                    rk.ratePct >= 95
                      ? undefined
                      : rk.ratePct >= 80
                        ? "var(--state-warn)"
                        : "var(--state-critical)",
                }}
              >
                {rk.ratePct}%
              </b>
              <span>taxa</span>
            </div>
            <div className="rc-k">
              <b style={{ color: rk.noReads ? "var(--state-critical)" : undefined }}>
                {rk.noReads}
              </b>
              <span>no-reads</span>
            </div>
          </div>
          <div className="rc-foot">ponto de maior volume: {rk.topPonto}</div>
        </button>

        <button className="resumo-card" onClick={() => onOpenMode("objetos")}>
          <div className="rc-h">
            Objetos <span className="muted">contagem/presença</span>
          </div>
          <div className="rc-kpis">
            <div className="rc-k">
              <b>{ok.avgCount}</b>
              <span>médios</span>
            </div>
            <div className="rc-k">
              <b>{ok.peak}</b>
              <span>pico</span>
            </div>
            <div className="rc-k">
              <b style={{ color: oLoads ? "var(--state-warn)" : undefined }}>{oLoads}</b>
              <span>carregam.</span>
            </div>
          </div>
          <div className="rc-foot">predominante: {classLabel(ok.topClasse)}</div>
        </button>
      </div>
      <section className="insight">
        <b>Destaques</b>{" "}
        {[...tips.slice(0, 1), ...ftips.slice(0, 1), ...rtips.slice(0, 1)]
          .filter(Boolean)
          .join(" · ") || "Sem ocorrências relevantes no período."}
      </section>
      <p className="rep-foot">
        Toque num cartão para abrir o detalhe. Indicadores agregados, sem imagens (LGPD).
      </p>
    </>
  );
}
