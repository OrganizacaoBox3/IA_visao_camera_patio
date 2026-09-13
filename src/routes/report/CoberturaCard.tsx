// COBERTURA DA ANÁLISE — a faixa que responde "dá para confiar nos zeros deste relatório?".
//
// Vem ANTES de qualquer indicador, e não no rodapé, pelo mesmo motivo que a saúde de alarmes
// fica no topo: se o período não foi observado, TODO número abaixo é suspeito, e descobrir isso
// depois de ler o relatório inteiro é tarde demais.
//
// Going-gray com uma exceção deliberada: cobertura boa é o normal e sai em neutro; cobertura
// abaixo do piso é anormalidade DE MEDIÇÃO — o único caso em que a cor aqui é informação, e
// nunca sozinha (vem com ícone e com a frase que explica o que fazer da leitura).
import { TriangleAlert } from "lucide-react";
import { Card } from "../../ui";
import {
  COBERTURA_OK_PCT,
  MOTIVO_COBERTURA_TEXTO,
  coberturaConfiavel,
  duracaoHumana,
  type Cobertura,
} from "../../report/calc";

export function CoberturaCard({ c, periodLabel }: { c: Cobertura; periodLabel: string }) {
  // Sem medição não se afirma nem cobertura nem falta dela — mostra o motivo e sai.
  if (c.pct === null) {
    return (
      <Card className="rep-cob">
        <h2 className="rep-cob-title">
          Cobertura da análise <span className="rep-cob-lens">· {periodLabel}</span>
        </h2>
        <p className="rep-cob-vazio">{c.motivo ? MOTIVO_COBERTURA_TEXTO[c.motivo] : "—"}</p>
      </Card>
    );
  }
  const ok = coberturaConfiavel(c);
  return (
    <Card className="rep-cob" data-baixa={ok ? "0" : "1"}>
      <h2 className="rep-cob-title">
        Cobertura da análise <span className="rep-cob-lens">· {periodLabel}</span>
      </h2>
      <div className="rep-cob-row">
        <span className="rep-cob-pct" data-baixa={ok ? "0" : "1"}>
          {c.pct}%
        </span>
        <div className="rep-cob-txt">
          {/* O DENOMINADOR junto do número, sempre: é ele que alguém vai querer contestar. */}
          <p className="rep-cob-conta">
            {duracaoHumana(c.observadoMs)} analisados de {duracaoHumana(c.esperadoMs)} esperados ·{" "}
            {c.cameras} câmera{c.cameras === 1 ? "" : "s"}
            {c.horasSemDado > 0 && (
              <>
                {" · "}
                <b>
                  {c.horasSemDado} de {c.horasEsperadas} hora
                  {c.horasEsperadas === 1 ? "" : "s"} sem dado nenhum
                </b>
              </>
            )}
          </p>
          {ok ? (
            <p className="rep-cob-nota">
              Os zeros deste relatório são medição: onde não há ocorrência, houve observação.
            </p>
          ) : (
            // Nunca só-por-cor: ícone + texto ao lado do realce.
            <p className="rep-cob-alerta">
              <TriangleAlert size={14} strokeWidth={1.75} aria-hidden /> Abaixo de{" "}
              {COBERTURA_OK_PCT}% do período observado: um <b>zero</b> aqui pode ser ausência de
              medição, não ausência de ocorrência. Verifique as câmeras antes de concluir que
              nada aconteceu.
            </p>
          )}
        </div>
      </div>
      <p className="rep-cob-esc">
        Cobertura do <b>período</b>, sem recorte de turno: uma hora que não gerou dado não tem
        carimbo de turno, e um denominador de turno teria de ser inventado. Câmera desativada não
        entra na conta.
      </p>
    </Card>
  );
}
