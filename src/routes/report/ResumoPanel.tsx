// N2 — Resumo executivo: um cartão-porta por dimensão COM DADO (tocar no cartão abre o modo).
//
// O GATE DAS 4 DIMENSÕES MORREU (era: renderiza só se atividade E fadiga E leitura E objetos
// tivessem summary). `modo` é por CÂMERA e os 4 modos são mutuamente exclusivos — num CD com N
// câmeras de ocupação, 3 das 4 dimensões ficam PERMANENTEMENTE vazias, e a tela de abertura
// mostrava 4 cartões dos quais 3 eram zeros. Isso é PIOR que vazio: ensina o gestor a ignorar
// número. Agora cada cartão só existe se a dimensão tem dado.
//
// E entra o 5º cartão que faltava: ALARMES — a dimensão enteada (tinha modo próprio, mas nunca
// tinha aparecido no Resumo).
import {
  fmtMin,
  type AlarmKpis,
  type Kpis,
  type ReadingKpis,
  type ObjectKpis,
  type FadigaKpis,
} from "../../report/calc";
import { classLabel } from "./ObjetosPanel";
import { Insight, RepLens, HistoryFooter } from "./chrome";
import type { Mode } from "./labels";

export type ResumoAtividade = { k: Kpis; tips: string[] };
export type ResumoFadiga = {
  fk: FadigaKpis;
  fOccFadiga: number;
  fOccCelular: number;
  ftips: string[];
};
export type ResumoLeitura = { rk: ReadingKpis; rtips: string[] };
export type ResumoObjetos = { ok: ObjectKpis; oLoads: number };
export type ResumoAlarmes = { ak: AlarmKpis };

export function ResumoPanel({
  periodLabel,
  shiftLabel,
  atividade,
  fadiga,
  leitura,
  objetos,
  alarmes,
  onOpenMode,
}: {
  periodLabel: string;
  shiftLabel: string;
  // null = dimensão SEM DADO no histórico → o cartão não existe (não vira um cartão de zeros).
  atividade: ResumoAtividade | null;
  fadiga: ResumoFadiga | null;
  leitura: ResumoLeitura | null;
  objetos: ResumoObjetos | null;
  alarmes: ResumoAlarmes | null;
  onOpenMode: (m: Mode) => void;
}) {
  const tips = [
    ...(atividade?.tips.slice(0, 1) ?? []),
    ...(fadiga?.ftips.slice(0, 1) ?? []),
    ...(leitura?.rtips.slice(0, 1) ?? []),
  ].filter(Boolean);
  return (
    <>
      <RepLens lens={`Resumo executivo · ${periodLabel} · Turno: ${shiftLabel}`} />
      <div className="rep-resumo">
        {atividade && (
          <button className="resumo-card" onClick={() => onOpenMode("atividade")}>
            <div className="rc-h">
              Operação <span className="muted">atividade</span>
            </div>
            <div className="rc-kpis">
              <div className="rc-k">
                {/* going-gray: verde incondicional removido — cor só condicional a estado */}
                <b>{atividade.k.activePct}%</b>
                <span>tempo ativo</span>
              </div>
              <div className="rc-k">
                <b>{fmtMin(atividade.k.idleMin)}</b>
                <span>parado</span>
              </div>
              <div className="rc-k">
                <b style={{ color: atividade.k.alerts ? "var(--state-critical)" : undefined }}>
                  {atividade.k.alerts}
                </b>
                <span>alertas</span>
              </div>
            </div>
            <div className="rc-foot">
              área mais parada: {atividade.k.topArea} ·{" "}
              {String(atividade.k.peakHour).padStart(2, "0")}h
            </div>
          </button>
        )}

        {fadiga && (
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
                      fadiga.fk.alertPct <= 2
                        ? undefined
                        : fadiga.fk.alertPct <= 10
                          ? "var(--state-warn)"
                          : "var(--state-critical)",
                  }}
                >
                  {fadiga.fk.alertPct}%
                </b>
                <span>em alerta</span>
              </div>
              <div className="rc-k">
                <b style={{ color: fadiga.fOccFadiga ? "var(--state-warn)" : undefined }}>
                  {fadiga.fOccFadiga}
                </b>
                <span>fadiga</span>
              </div>
              <div className="rc-k">
                <b style={{ color: fadiga.fOccCelular ? "var(--state-warn)" : undefined }}>
                  {fadiga.fOccCelular}
                </b>
                <span>celular</span>
              </div>
            </div>
            <div className="rc-foot">
              horário crítico: {String(fadiga.fk.peakHour).padStart(2, "0")}h
            </div>
          </button>
        )}

        {leitura && (
          <button className="resumo-card" onClick={() => onOpenMode("leitura")}>
            <div className="rc-h">
              Logística <span className="muted">leitura/expedição</span>
            </div>
            <div className="rc-kpis">
              <div className="rc-k">
                <b>{leitura.rk.boxes.toLocaleString("pt-BR")}</b>
                <span>caixas</span>
              </div>
              <div className="rc-k">
                <b
                  style={{
                    // going-gray: taxa boa (≥95%) é o normal → sem cor; saturada só no degradado.
                    color:
                      leitura.rk.ratePct >= 95
                        ? undefined
                        : leitura.rk.ratePct >= 80
                          ? "var(--state-warn)"
                          : "var(--state-critical)",
                  }}
                >
                  {leitura.rk.ratePct}%
                </b>
                <span>taxa</span>
              </div>
              <div className="rc-k">
                <b style={{ color: leitura.rk.noReads ? "var(--state-critical)" : undefined }}>
                  {leitura.rk.noReads}
                </b>
                <span>no-reads</span>
              </div>
            </div>
            <div className="rc-foot">ponto de maior volume: {leitura.rk.topPonto}</div>
          </button>
        )}

        {objetos && (
          <button className="resumo-card" onClick={() => onOpenMode("objetos")}>
            <div className="rc-h">
              Objetos <span className="muted">contagem/presença</span>
            </div>
            <div className="rc-kpis">
              <div className="rc-k">
                <b>{objetos.ok.avgCount}</b>
                <span>médios</span>
              </div>
              <div className="rc-k">
                <b>{objetos.ok.peak}</b>
                <span>pico</span>
              </div>
              <div className="rc-k">
                <b style={{ color: objetos.oLoads ? "var(--state-warn)" : undefined }}>
                  {objetos.oLoads}
                </b>
                <span>carregam.</span>
              </div>
            </div>
            <div className="rc-foot">predominante: {classLabel(objetos.ok.topClasse)}</div>
          </button>
        )}

        {/* O 5º CARTÃO — Alarmes. A dimensão tinha modo próprio desde sempre e NUNCA aparecia no
            Resumo: o gestor abria a tela e não via se a operação tinha alarmado. */}
        {alarmes && (
          <button className="resumo-card" onClick={() => onOpenMode("alarmes")}>
            <div className="rc-h">
              Alarmes <span className="muted">fila de eventos</span>
            </div>
            <div className="rc-kpis">
              <div className="rc-k">
                <b>{alarmes.ak.total}</b>
                <span>no período</span>
              </div>
              <div className="rc-k">
                <b style={{ color: alarmes.ak.critical ? "var(--state-critical)" : undefined }}>
                  {alarmes.ak.critical}
                </b>
                <span>críticos</span>
              </div>
              <div className="rc-k">
                <b style={{ color: alarmes.ak.news ? "var(--state-warn)" : undefined }}>
                  {alarmes.ak.news}
                </b>
                <span>em aberto</span>
              </div>
            </div>
            <div className="rc-foot">metadados, sem imagens (LGPD)</div>
          </button>
        )}
      </div>
      <Insight
        label="Destaques"
        tips={[tips.join(" · ") || "Sem ocorrências relevantes no período."]}
      />
      <HistoryFooter />
    </>
  );
}
