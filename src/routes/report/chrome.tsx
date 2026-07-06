// Cascas comuns dos painéis do Relatório: a "lente" (recorte atual) e o rodapé de histórico.
// Extraídos p/ eliminar a repetição idêntica entre os modos (Atividade/Leitura/Objetos/Fadiga).

import type { Shift } from "../../report/calc";

// Título de seção do padrão da casa (átomo de src/ui). Re-exportado aqui para os painéis do
// Relatório seguirem importando de "./chrome" sem alteração (troca de origem 1:1, A1 concluída).
export { SectionTitle } from "../../ui";

// Aba interna (Radix Tabs) compartilhada entre os modos — o estado vive no ReportPage.
// "fluxo" só existe no modo Atividade (e só quando o hub expõe o kind "flow"); ao trocar de
// modo o ReportPage devolve o estado para "quando".
export type RepTab = "quando" | "onde" | "tendencia" | "eventos" | "fluxo";

// Nível de cômputo de um view-model de modo (useAtividadeVM & irmãos): "off" = modo inativo,
// nada computa; "summary" = Resumo executivo, só janela+KPIs+insights; "full" = modo aberto,
// tudo (gráficos/eventos). Os hooks são sempre CHAMADOS (ordem estável) — o gate é interno.
export type VmView = "off" | "summary" | "full";

// Classe padrão dos tabpanels do Relatório: além do .rep-tabpanel (cadeia de scroll no CSS),
// vira coluna flex p/ as seções internas PREENCHEREM a altura útil (flex-1 nos filhos) em vez
// de deixar vazio abaixo do conteúdo — sem alturas fixas (contrato: o container rola, não corta).
export const REP_TABPANEL_CLS = "rep-tabpanel flex flex-col gap-[var(--sp-3)]";

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
