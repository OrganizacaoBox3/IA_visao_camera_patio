// Cascas comuns dos painéis do Relatório: a "lente" (recorte atual) e o rodapé de histórico.
// Extraídos p/ eliminar a repetição idêntica entre os modos (Atividade/Leitura/Objetos/Fadiga).

import type { Shift } from "../../report/mock";

// Aba interna (Radix Tabs) compartilhada entre os modos — o estado vive no ReportPage.
export type RepTab = "quando" | "onde" | "tendencia" | "eventos";

// Turnos na ordem canônica dos rankings "Por turno" (antes duplicado em cada painel).
export const SHIFTS: Shift[] = ["Manhã", "Tarde", "Noite"];

// Agregado por turno (byShiftA/byShiftR do ReportPage) — antes duplicado em cada painel.
export type ByShift = { m: Record<Shift, number>; max: number };

// Faixa de insights ("💡 …") idêntica entre os modos — só mudam o rótulo e as dicas.
export function Insight({ label, tips }: { label: string; tips: string[] }) {
  return (
    <section className="insight">
      <b>{label}</b> {tips.join(" · ")}
    </section>
  );
}

export function RepLens({ lens }: { lens: string }) {
  return (
    <div className="rep-lens">
      Visão: <b>{lens}</b>
    </div>
  );
}

export function HistoryFooter({ onClear, busy }: { onClear: () => void; busy: boolean }) {
  return (
    <div className="rep-foot">
      Histórico (Postgres) · indicadores agregados, sem imagens ·{" "}
      <button onClick={onClear} disabled={busy} className="linkbtn">
        limpar histórico
      </button>
    </div>
  );
}
