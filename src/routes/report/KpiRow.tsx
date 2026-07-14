// Kpi/KpiRow/Delta migraram para o átomo compartilhado src/ui/Kpi.tsx (mesma API, byte-idêntica).
// Este módulo permanece como REEXPORT para os 5 painéis do Relatório que importam de "./KpiRow"
// seguirem funcionando sem tocar. Novos consumidores devem importar de "../../ui".
export { Kpi, KpiRow, Delta } from "../../ui";
