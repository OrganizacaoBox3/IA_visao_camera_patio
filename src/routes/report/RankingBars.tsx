import { type ReactNode } from "react";
import { Meter } from "../../ui";

export type RankItem = { key: string; label: ReactNode; value: number; valueText: ReactNode };

// Ranking horizontal (.rank-row) reutilizado por área/atividade/ponto/câmera/setor/classe/turno.
// A barra é o átomo <Meter> (proporção analógica going-gray): `read=true` usa o tom info, caso
// contrário o accent azul. `emptyNote` mostra aviso quando não há linhas.
export function RankingBars({
  rows,
  max,
  read = false,
  emptyNote,
}: {
  rows: RankItem[];
  max: number;
  read?: boolean;
  emptyNote?: string;
}) {
  return (
    <>
      {emptyNote != null && rows.length === 0 && <p className="empty-note">{emptyNote}</p>}
      {rows.map((r) => {
        const pct = Math.round((r.value / max) * 100);
        return (
          <div className="rank-row" key={r.key}>
            <div className="rank-head">
              <span>{r.label}</span>
              <span className="rank-val">{r.valueText}</span>
            </div>
            <div className="flex">
              <Meter value={pct} ariaLabel={`${pct}% do máximo`} tone={read ? "info" : "accent"} />
            </div>
          </div>
        );
      })}
    </>
  );
}
