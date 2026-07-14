// Aba "Pessoas" (valor interno "presenca") do drawer da câmera — KPIs de pessoas em cena
// (agora/pico/permanência). Componente puro: recebe o snapshot já resolvido pelo CameraWorkspace.
import { fmtDuration } from "../../format";
import { HelpTip, Kpi, SectionTitle } from "../../ui";

export function PresencaTab({
  presence,
  paused,
}: {
  presence: { now: number; peak: number; dwell: number };
  paused: boolean;
}) {
  return (
    <>
      {/* Seção com heading semântico (<h2> via SectionTitle) — o painel deixa de ser um <div> mudo. */}
      <SectionTitle>Pessoas em cena</SectionTitle>
      <div className="kpis">
        <Kpi value={presence.now} label="agora" />
        <Kpi value={presence.peak} label="pico" />
        <Kpi value={fmtDuration(presence.dwell)} label="permanência" />
      </div>
      <p className="empty-note mt-sp2">
        IDs efêmeros, sem identidade.{" "}
        <HelpTip label="Ajuda da presença">
          Cada pessoa em cena recebe um número anônimo só para contagem e permanência — nada é
          reconhecido nem persistido; os números zeram por sessão.
        </HelpTip>
        {paused ? " Pausado: rótulos mostram o tempo em cena." : ""}
      </p>
    </>
  );
}
