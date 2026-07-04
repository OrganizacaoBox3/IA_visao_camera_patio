import { type ReactNode } from "react";
import { ScrollArea } from "../../ui";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

// Escala "quente" para valores negativos (ociosidade/risco) — âmbar→vermelho.
export function heatColor(v: number, max: number): string {
  if (v <= 0) return "transparent";
  const t = Math.min(1, v / max);
  const r = Math.round(40 + t * 199),
    g = Math.round(55 - t * 5),
    b = Math.round(72 - t * 40);
  return `rgba(${r}, ${g}, ${b}, ${0.18 + t * 0.82})`;
}

// Leitura/objetos: volume é POSITIVO → escala azul (accent), distinta da ociosidade (âmbar/vermelho).
export function readColor(v: number, max: number): string {
  if (v <= 0) return "transparent";
  return `rgba(56, 189, 248, ${0.12 + Math.min(1, v / max) * 0.78})`;
}

// Largura mínima do heatmap (rótulo 84px + 24 colunas de hora). Abaixo disso a ScrollArea
// horizontal entra (R3.2); em telas largas o grid 1fr preenche, então o layout desktop não muda.
const HEATMAP_MIN_WIDTH = 640;

// Heatmap (.hm-row) com rolagem horizontal previsível em telas estreitas, sem alterar o desktop.
// Reusa a classe .rep-matrixscroll (mesmo tratamento de impressão da matriz Setor×Classe).
function HeatScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="rep-matrixscroll" orientation="horizontal">
      <div className="heatmap" style={{ minWidth: HEATMAP_MIN_WIDTH }}>
        {children}
      </div>
    </ScrollArea>
  );
}

export type HeatRow = { key: string; label: ReactNode; title: string; hours: number[] };

// Heatmap hora-do-dia × linha. Quando `onCellClick` é fornecido, as células viram clicáveis
// (usado por Alarmes p/ filtrar por hora); caso contrário são estáticas.
export function Heatmap({
  rows,
  cellColor,
  cellTitle,
  legendLeft,
  legendRight,
  scaleRead = false,
  onCellClick,
  isCellSelected,
}: {
  rows: HeatRow[];
  cellColor: (row: HeatRow, v: number, h: number) => string;
  cellTitle: (row: HeatRow, v: number, h: number) => string;
  legendLeft: string;
  legendRight: string;
  scaleRead?: boolean;
  onCellClick?: (row: HeatRow, h: number) => void;
  isCellSelected?: (row: HeatRow, h: number) => boolean;
}) {
  return (
    <HeatScroll>
      <div className="hm-axis">
        <span />{" "}
        {HOURS.map((h) => (
          <span key={h} className="hm-h">
            {h % 2 === 0 ? String(h).padStart(2, "0") : ""}
          </span>
        ))}
      </div>
      {/* title= aqui é DADO (rótulo completo do setor + valor hora×linha de cada célula),
          não affordance de controle. Exceção documentada (plano-padronizacao-visual §Radix):
          célula de dado fica no title= nativo — virar <Tooltip> em ~24 células/linha seria
          overengineering + custo de perf sem ganho de acessibilidade. Não converter. */}
      {rows.map((row) => (
        <div className="hm-row" key={row.key}>
          <span className="hm-area" title={row.title}>
            {row.label}
          </span>
          {row.hours.map((v, h) => {
            const background = cellColor(row, v, h);
            const title = cellTitle(row, v, h); // title em dado, não affordance (ver nota acima)
            if (onCellClick) {
              const sel = isCellSelected ? isCellSelected(row, h) : false;
              return (
                <span
                  key={h}
                  className={`hm-cell clk ${sel ? "sel" : ""}`}
                  style={{ background }}
                  title={title}
                  onClick={() => onCellClick(row, h)}
                />
              );
            }
            return <span key={h} className="hm-cell" style={{ background }} title={title} />;
          })}
        </div>
      ))}
      <div className="hm-legend">
        <span>{legendLeft}</span>
        <i className={scaleRead ? "hm-scale read" : "hm-scale"} />
        <span>{legendRight}</span>
      </div>
    </HeatScroll>
  );
}
