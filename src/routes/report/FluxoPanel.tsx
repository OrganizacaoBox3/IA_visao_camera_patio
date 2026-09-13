// Painel do modo FLUXO — o relatório das LINHAS DE CONTAGEM.
//
// Saiu de dentro de Atividade (era a 4ª aba de um modo cujo filtro é ÁREA, que não se aplica a
// cruzamento). O que ganhou ao virar modo próprio: comparação com o período anterior, tendência
// diária e filtro por linha — as três coisas que todo outro modo já tinha.
//
// O SALDO (entradas − saídas) é DIAGNÓSTICO, não meta: num ponto de passagem quem entra acaba
// saindo, então saldo grande denuncia linha mal posicionada ou travessia perdida de um lado —
// não "gente sobrando no prédio". Está rotulado assim para ninguém cobrar meta em cima dele.
import { ArrowDown, ArrowUp } from "lucide-react";
import { Kpi, KpiRow, SectionTitle } from "../../ui";
import { FlowBiChart } from "./FlowChart";
import { RankingBars } from "./RankingBars";
import { Insight, RepLens, HistoryFooter } from "./chrome";
import { deltaPct, flowLineKey, type FlowKpis } from "../../report/calc";
import type { FluxoDetails } from "./useFluxoVM";

const pad2 = (h: number) => String(h).padStart(2, "0");

/** Tendência diária: entradas e saídas lado a lado por dia (mesma escala nos dois sentidos). */
function EvolucaoDiaria({ evo }: { evo: FluxoDetails["evo"] }) {
  const den = evo.max || 1;
  const alt = (v: number) => (v <= 0 ? 0 : Math.max(2, Math.round((v / den) * 100)));
  return (
    <div
      className="flowevo"
      role="img"
      aria-label={`Tendência diária: ${evo.bars.map((b) => `${b.label} ${b.in} entradas ${b.out} saídas`).join("; ")}`}
    >
      {evo.bars.map((b) => (
        <div key={b.dayIndex} className="flowevo-col" title={`${b.label}: ${b.in} entradas · ${b.out} saídas`}>
          <div className="flowevo-bars">
            <span className="flowevo-in" style={{ height: `${alt(b.in)}%` }} />
            <span className="flowevo-out" style={{ height: `${alt(b.out)}%` }} />
          </div>
          <span className="flowevo-lab">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

export function FluxoPanel({
  lens,
  k,
  kPrev,
  tips,
  byHour,
  byLine,
  evo,
  labelOf,
}: {
  lens: string;
  k: FlowKpis;
  kPrev: FlowKpis;
  tips: string[];
  byHour: FluxoDetails["byHour"];
  byLine: FluxoDetails["byLine"];
  evo: FluxoDetails["evo"];
  /** chave → rótulo humano da linha; vem do calc, igual no PDF e no CSV. */
  labelOf: (key: string) => string;
}) {
  const variacao = deltaPct(k.total, kPrev.total);
  return (
    <>
      <RepLens lens={lens} />

      <section className="panel">
        <SectionTitle>Travessias no período</SectionTitle>
        <KpiRow>
          <Kpi
            value={k.in}
            label="entradas"
            valueStyle={{ color: "var(--state-info)" }}
          />
          <Kpi value={k.out} label="saídas" valueStyle={{ color: "var(--state-neutral)" }} />
          {/* Variação em texto NEUTRO, não no <Delta> verde/vermelho: volume de passagem não é
              anormalidade (going-gray). Mais gente cruzando a porta não é "bom" nem "ruim" — é
              o fato; quem julga é o gestor com o contexto da operação. */}
          <Kpi
            value={k.total}
            label={
              <>
                travessias
                {variacao !== null && (
                  <span className="muted"> · {variacao > 0 ? "+" : ""}{variacao}% vs. anterior</span>
                )}
              </>
            }
          />
          <Kpi value={k.peakHour === null ? "—" : `${pad2(k.peakHour)}h`} label="hora de pico" />
        </KpiRow>
        {/* going-gray: o saldo não é anormalidade — é conferência de instalação. */}
        <p className="muted text-label">
          Saldo (entradas − saídas): <b>{k.saldo > 0 ? `+${k.saldo}` : k.saldo}</b> — conferência
          da linha, não meta: num ponto de passagem quem entra acaba saindo.
        </p>
      </section>

      {tips.length > 0 && <Insight label="Leitura do fluxo" tips={tips} />}

      <section className="panel">
        <SectionTitle>Entradas e saídas por hora</SectionTitle>
        <FlowBiChart hours={byHour.hours} max={byHour.max} />
      </section>

      <section className="panel">
        <SectionTitle>Tendência por dia</SectionTitle>
        {evo.bars.length ? (
          <>
            <EvolucaoDiaria evo={evo} />
            <p className="muted text-label flowevo-leg">
              <ArrowUp size={13} strokeWidth={2} aria-hidden /> entradas ·{" "}
              <ArrowDown size={13} strokeWidth={2} aria-hidden /> saídas
            </p>
          </>
        ) : (
          <p className="empty-note">Histórico insuficiente para uma tendência.</p>
        )}
      </section>

      <section className="panel">
        <SectionTitle>Por linha</SectionTitle>
        <RankingBars
          rows={byLine.rows.map((r) => {
            const key = flowLineKey(r.cameraId, r.tripwireId);
            return {
              key,
              label: <span title={r.tripwireId}>{labelOf(key)}</span>,
              value: r.in + r.out,
              valueText: `${r.in} entradas · ${r.out} saídas`,
            };
          })}
          max={byLine.max}
          emptyNote="Sem travessias no período."
        />
      </section>

      <HistoryFooter />
    </>
  );
}
