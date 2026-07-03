// Cascas comuns dos painéis do Relatório: a "lente" (recorte atual) e o rodapé de histórico.
// Extraídos p/ eliminar a repetição idêntica entre os modos (Atividade/Leitura/Objetos/Fadiga).

import type { ReactNode } from "react";
import type { Shift } from "../../report/mock";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// Aba interna (Radix Tabs) compartilhada entre os modos — o estado vive no ReportPage.
// "fluxo" só existe no modo Atividade (e só quando o hub expõe o kind "flow"); ao trocar de
// modo o ReportPage devolve o estado para "quando".
export type RepTab = "quando" | "onde" | "tendencia" | "eventos" | "fluxo";

// Classe padrão dos tabpanels do Relatório: além do .rep-tabpanel (cadeia de scroll no CSS),
// vira coluna flex p/ as seções internas PREENCHEREM a altura útil (flex-1 nos filhos) em vez
// de deixar vazio abaixo do conteúdo — sem alturas fixas (contrato: o container rola, não corta).
export const REP_TABPANEL_CLS = "rep-tabpanel flex flex-col gap-[var(--sp-3)]";

// Título de seção do padrão da casa: h2 com o visual do antigo `.panel h3` (label 11 uppercase).
// Transitório até a frente A1 publicar o átomo SectionTitle em src/ui (troca de import 1:1).
export function SectionTitle({
  children,
  className,
  flush,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean; // sem a margem inferior padrão (ex.: dentro de toolbar)
}) {
  return (
    <h2
      className={cx(
        "m-0",
        !flush && "mb-3",
        "text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted",
        className,
      )}
    >
      {children}
    </h2>
  );
}

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
      {/* fonte real (banco/arquivo) aparece na barra de filtros via /api/data/status */}
      Histórico do servidor · indicadores agregados, sem imagens ·{" "}
      <button onClick={onClear} disabled={busy} className="linkbtn">
        limpar histórico
      </button>
    </div>
  );
}
