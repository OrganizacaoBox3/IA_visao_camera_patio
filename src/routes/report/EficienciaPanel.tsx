// Painel de EFICIÊNCIA — o rendimento do posto, decomposto. Vai na tela E no PDF.
//
// O QUE ELE NÃO É: eficiência de PESSOA. O sistema não identifica ninguém (a caixa nunca exibe
// número, o id do tracker é interno e muda a cada re-associação). O que se mede é o POSTO num
// TURNO; ligar isso a alguém é leitura do gestor, que sabe a escala — não afirmação do sistema.
// O rodapé do painel diz isso em voz alta, na tela e no papel, porque o PDF vai circular sem
// quem o gerou por perto para explicar.
//
// POR QUE TRÊS NÚMEROS E NÃO UM: `bruta = efetiva × aproveitamento`. Um indicador único somaria
// duas causas com ações OPOSTAS — posto vazio (escala) e ritmo baixo (método/gargalo). A
// decomposição é o produto aqui; o percentual é só a embalagem.
import { Card, Kpi, KpiRow } from "../../ui";
import { MOTIVO_TEXTO, type Eficiencia } from "../../report/calc/eficiencia";

const num = (v: number | null, sufixo = "") => (v === null ? "—" : `${v}${sufixo}`);

export function EficienciaPanel({
  ef,
  metaPorHora,
  onMetaChange,
  periodLabel,
  filtroLabel,
}: {
  ef: Eficiencia;
  metaPorHora: number | null;
  onMetaChange: (v: number | null) => void;
  periodLabel: string;
  filtroLabel: string;
}) {
  const semNada = ef.motivo === "sem-turno";
  return (
    <Card className="rep-ef">
      <h2 className="rep-ef-title">
        Eficiência do posto <span className="rep-ef-lens">· {periodLabel} · {filtroLabel}</span>
      </h2>

      {/* A meta é entrada de NEGÓCIO — o sistema não tem como inferi-la. Fica aqui, ao lado do
          número que ela produz, e não no rodapé de engenharia (que é gated por RBAC: esconder a
          meta atrás de permissão de configuração deixaria o gestor sem o próprio indicador).
          `no-print`: no PDF a meta aparece como TEXTO na conta abaixo, não como campo. */}
      <label className="rep-ef-meta no-print">
        Meta de produção
        <input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={metaPorHora ?? ""}
          placeholder="—"
          onChange={(e) => {
            const v = Number(e.target.value);
            onMetaChange(e.target.value === "" || !Number.isFinite(v) || v <= 0 ? null : v);
          }}
        />
        <span>{ef.unidade}/hora trabalhada</span>
      </label>

      {semNada ? (
        <p className="rep-ef-vazio">{MOTIVO_TEXTO["sem-turno"]}</p>
      ) : (
        <>
          <KpiRow>
            {/* A TAXA é a manchete pedida — e só existe com meta informada. Sem ela, o lugar
                mostra "—" e o motivo aparece abaixo, em vez de um 0% que ninguém pode defender. */}
            <Kpi
              value={num(ef.taxaPct, "%")}
              label="taxa de eficiência"
              valueStyle={{
                color:
                  ef.taxaPct === null
                    ? "var(--state-neutral)"
                    : ef.taxaPct >= 100
                      ? "var(--state-ok)"
                      : ef.taxaPct >= 80
                        ? "var(--state-warn)"
                        : "var(--state-alert)",
              }}
            />
            <Kpi
              value={num(ef.produtividadeEfetiva)}
              label={`${ef.unidade}/hora com presença`}
            />
            <Kpi value={num(ef.aproveitamentoPct, "%")} label="aproveitamento do turno" />
            <Kpi value={num(ef.produtividadeBruta)} label={`${ef.unidade}/hora de turno`} />
          </KpiRow>

          {/* A conta ABERTA. Um relatório de eficiência que não mostra o denominador é opinião —
              e é o denominador que o gestor precisa contestar quando discordar do número. */}
          <table className="rep-ef-conta">
            <tbody>
              <tr>
                <th>Horas de turno (pausas fora)</th>
                <td>{num(ef.horasTurno, " h")}</td>
              </tr>
              <tr>
                <th>Horas com presença detectada</th>
                <td>{num(ef.horasComPresenca, " h")}</td>
              </tr>
              <tr>
                <th>Meta informada</th>
                <td>{metaPorHora ? `${metaPorHora} ${ef.unidade}/hora` : "—"}</td>
              </tr>
              <tr>
                <th>Como a taxa é calculada</th>
                <td className="rep-ef-formula">
                  {ef.unidade}/hora com presença ÷ meta · e {ef.unidade}/hora de turno ={" "}
                  {ef.unidade}/hora com presença × aproveitamento
                </td>
              </tr>
            </tbody>
          </table>

          {ef.motivo && <p className="rep-ef-motivo">{MOTIVO_TEXTO[ef.motivo]}</p>}
        </>
      )}

      <p className="rep-ef-nota">
        Mede o <b>posto</b>, não a pessoa: o sistema conta presença anônima e volume produzido, não
        identifica quem trabalhou. A presença vem de amostragem por câmera, não de relógio de ponto.
      </p>
    </Card>
  );
}
