// Cascas comuns dos painéis do Relatório: a "lente" (recorte atual) e o rodapé de histórico.
// Extraídos p/ eliminar a repetição idêntica entre os modos (Atividade/Leitura/Objetos/Fadiga).

// Aba interna (Radix Tabs) compartilhada entre os modos — o estado vive no ReportPage.
export type RepTab = "quando" | "onde" | "tendencia" | "eventos";

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
