// Cascas comuns dos painéis do Relatório: a "lente" (recorte atual) e o rodapé de histórico.
// Extraídos p/ eliminar a repetição idêntica entre os modos (Atividade/Leitura/Objetos/Fadiga).

import { Lightbulb, type LucideIcon } from "lucide-react";
import type { ShiftBar } from "./aggregate";
import "./report.css";

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

// Agregado por turno (byShiftA/byShiftR do ReportPage) — antes duplicado em cada painel.
// As barras vêm PRONTAS do byShift (chave+rótulo+valor): a lista fixa `SHIFTS` de 3 strings
// morreu junto com o hardcode 06/14/22 — hoje os turnos são os do CADASTRO (ou os legados que o
// dado antigo carrega), e a ordem já vem resolvida do agregador.
export type ByShift = { rows: ShiftBar[]; max: number };

// Faixa de insights idêntica entre os modos — só mudam rótulo/dicas (e o ícone: Bell no modo
// Alarmes). Going-gray (#12): superfície neutra (.rep-insight, ./report.css) + Lucide no lugar
// do emoji 💡/🔔 — padrão do shell (18/16px, stroke 1.75, currentColor).
export function Insight({
  label,
  tips,
  icon: Icon = Lightbulb,
}: {
  label: string;
  tips: string[];
  icon?: LucideIcon;
}) {
  return (
    <section className="rep-insight">
      <Icon size={16} strokeWidth={1.75} aria-hidden className="rep-insight__ico" />
      <div className="rep-insight__text">
        <b>{label}</b> {tips.join(" · ")}
      </div>
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

export function HistoryFooter() {
  return (
    <div className="rep-foot">
      {/* fonte real (banco/arquivo) aparece na barra de filtros via /api/data/status.
          A AÇÃO "limpar histórico" (#13) virou botão explícito na barra de ferramentas
          do ReportPage (era link mono escondido aqui) — o rodapé é só informação. */}
      Histórico do servidor · indicadores agregados, sem imagens
    </div>
  );
}
