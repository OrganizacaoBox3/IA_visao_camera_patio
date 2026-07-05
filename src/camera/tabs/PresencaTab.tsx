// Aba "Presença" do drawer da câmera — KPIs de pessoas em cena (agora/pico/permanência).
// Componente puro: recebe o snapshot já resolvido pelo CameraWorkspace.
import { fmtDuration } from "../../format";

export function PresencaTab({
  presence,
  paused,
}: {
  presence: { now: number; peak: number; dwell: number };
  paused: boolean;
}) {
  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{presence.now}</div>
          <div className="l">agora</div>
        </div>
        <div className="kpi">
          <div className="v">{presence.peak}</div>
          <div className="l">pico</div>
        </div>
        <div className="kpi">
          <div className="v">{fmtDuration(presence.dwell)}</div>
          <div className="l">permanência</div>
        </div>
      </div>
      <p className="empty-note" style={{ marginTop: "var(--sp-2)" }}>
        Pessoas recebem ID efêmero (sem identidade); reseta por sessão.
        {paused ? " ⏸ Pausado: rótulos com tempo em cena." : ""}
      </p>
    </>
  );
}
