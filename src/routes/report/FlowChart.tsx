import { ArrowDown, ArrowUp } from "lucide-react";

// Fluxo de pessoas por hora — UM gráfico bidirecional (eram DOIS: "Entradas por hora" e
// "Saídas por hora", lado a lado, com a MESMA escala e o mesmo eixo de horas: o gestor tinha
// de comparar duas caixas p/ ler um único fato — "entrou mais do que saiu às 14h?").
// Entradas sobem do eixo, saídas descem: o SALDO da hora vira leitura visual direta.
//
// Nunca só-por-cor (doutrina): o SENTIDO (acima/abaixo do eixo) é o que carrega a informação;
// a legenda traz ícone + texto, e cada coluna leva os dois números no `title`.
// Going-gray: entrada é o accent do produto; saída é neutra — nenhuma é anormalidade.
const pad2 = (h: number) => String(h).padStart(2, "0");

export function FlowBiChart({
  hours,
  max,
}: {
  hours: { in: number; out: number }[];
  max: number; // maior valor entre entradas e saídas (escala COMUM aos dois sentidos)
}) {
  const den = max || 1;
  const pct = (v: number) => (v <= 0 ? 0 : Math.max(2, Math.round((v / den) * 100)));
  return (
    <>
      <div
        className="flowbi"
        role="img"
        aria-label={`Fluxo por hora: ${hours
          .map((v, h) => `${pad2(h)}h ${v.in} entradas ${v.out} saídas`)
          .join("; ")}`}
      >
        {hours.map((v, h) => (
          <div
            className="flowbi-col"
            key={h}
            title={`${pad2(h)}h · ${v.in} entradas · ${v.out} saídas · saldo ${v.in - v.out}`}
          >
            <div className="flowbi-up">
              <div className="flowbi-bar in" style={{ height: `${pct(v.in)}%` }} />
            </div>
            <div className="flowbi-axis" />
            <div className="flowbi-dn">
              <div className="flowbi-bar out" style={{ height: `${pct(v.out)}%` }} />
            </div>
            <span className="flowbi-lbl">{h % 3 === 0 ? `${pad2(h)}h` : ""}</span>
          </div>
        ))}
      </div>
      <p className="flowbi-legend">
        <span>
          <ArrowUp size={13} strokeWidth={1.75} aria-hidden className="flowbi-ico in" /> acima do
          eixo: entradas
        </span>
        <span>
          <ArrowDown size={13} strokeWidth={1.75} aria-hidden className="flowbi-ico out" /> abaixo:
          saídas
        </span>
      </p>
    </>
  );
}
