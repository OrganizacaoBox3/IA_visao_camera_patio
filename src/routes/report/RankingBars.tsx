import { type ReactNode } from "react";

export type RankItem = { key: string; label: ReactNode; value: number; valueText: ReactNode };

// Ranking horizontal (.rank-row) reutilizado por área/atividade/ponto/câmera/setor/classe/turno.
// `read=true` usa a barra azul (.rank-bar > i.read); `emptyNote` mostra aviso quando não há linhas.
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
      {rows.map((r) => (
        <div className="rank-row" key={r.key}>
          <div className="rank-head">
            <span>{r.label}</span>
            <span className="rank-val">{r.valueText}</span>
          </div>
          <div className="rank-bar">
            <i
              className={read ? "read" : undefined}
              style={{ width: `${Math.round((r.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </>
  );
}
