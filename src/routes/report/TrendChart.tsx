import { SectionTitle } from "../../ui";

export type TrendBar = {
  key: string | number;
  label: string;
  value: number;
  title: string;
  /** dia com alarme CRÍTICO (só Alarmes) — realce; o número real vive no `title`, nunca só-cor. */
  critical?: boolean;
};

// Barras de tendência (14 dias) reutilizadas por Atividade/Leitura/Objetos/Fadiga/Alarmes.
// `read=true` usa a variante azul (.evo-bar.read) para volume positivo.
// `onPick` transforma a coluna em BOTÃO (clique p/ filtrar o dia — era um bloco .evo à parte,
// escrito à mão no AlarmesPanel).
export function TrendChart({
  bars,
  max,
  read = false,
  onPick,
  isSelected,
}: {
  bars: TrendBar[];
  max: number;
  read?: boolean;
  onPick?: (b: TrendBar) => void;
  isSelected?: (b: TrendBar) => boolean;
}) {
  const den = max || 1; // max=0 (série toda zerada) não vira NaN%
  const barCls = (b: TrendBar) =>
    `evo-bar${read ? " read" : ""}${b.critical ? " crit" : ""}`;
  const h = (b: TrendBar) => `${Math.max(2, Math.round((b.value / den) * 100))}%`;
  return (
    <div className="evo">
      {bars.map((b) =>
        onPick ? (
          <button
            type="button"
            key={b.key}
            className={`evo-col clk ${isSelected?.(b) ? "sel" : ""}`}
            title={b.title}
            onClick={() => onPick(b)}
            aria-pressed={!!isSelected?.(b)}
          >
            <div className={barCls(b)} style={{ height: h(b) }} />
            <span className="evo-lbl">{b.label}</span>
          </button>
        ) : (
          <div className="evo-col" key={b.key} title={b.title}>
            <div className={barCls(b)} style={{ height: h(b) }} />
            <span className="evo-lbl">{b.label}</span>
          </div>
        ),
      )}
    </div>
  );
}

// A SEÇÃO "Tendência (14 dias)" — a MESMA peça era reescrita 5× (Atividade/Leitura/Objetos/
// Fadiga/Alarmes), cada uma com seu <section>/<SectionTitle>. Agora é uma só.
// O texto "Tendência (14 dias)" é CONTRATO (fixado no e2e) — `note` só acrescenta a unidade
// depois dele; `hint` é a dica de interação (muted), quando as barras são clicáveis.
export function TrendSection({
  bars,
  max,
  read,
  note,
  hint,
  fill = true,
  onPick,
  isSelected,
}: {
  bars: TrendBar[];
  max: number;
  read?: boolean;
  /** unidade/qualificador do modo (ex.: "objetos médios/dia") — vem DEPOIS do título fixo. */
  note?: string;
  /** dica de interação (ex.: "clique p/ filtrar o dia") — em tom muted, nunca no título. */
  hint?: string;
  /** ocupa a altura livre do tabpanel (default). `false` quando divide a linha com outra peça. */
  fill?: boolean;
  onPick?: (b: TrendBar) => void;
  isSelected?: (b: TrendBar) => boolean;
}) {
  return (
    <section className={fill ? "panel flex-1" : "panel"}>
      <SectionTitle>
        Tendência (14 dias)
        {note ? ` — ${note}` : ""}
        {hint ? <span className="muted text-label font-normal"> — {hint}</span> : null}
      </SectionTitle>
      <TrendChart bars={bars} max={max} read={read} onPick={onPick} isSelected={isSelected} />
    </section>
  );
}
