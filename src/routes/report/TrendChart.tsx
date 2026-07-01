export type TrendBar = { key: string | number; label: string; value: number; title: string };

// Barras de tendência (14 dias) reutilizadas por Atividade/Leitura/Objetos/Fadiga.
// `read=true` usa a variante azul (.evo-bar.read) para volume positivo.
export function TrendChart({
  bars,
  max,
  read = false,
}: {
  bars: TrendBar[];
  max: number;
  read?: boolean;
}) {
  return (
    <div className="evo">
      {bars.map((b) => (
        <div className="evo-col" key={b.key} title={b.title}>
          <div
            className={read ? "evo-bar read" : "evo-bar"}
            style={{ height: `${Math.max(2, Math.round((b.value / max) * 100))}%` }}
          />
          <span className="evo-lbl">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
