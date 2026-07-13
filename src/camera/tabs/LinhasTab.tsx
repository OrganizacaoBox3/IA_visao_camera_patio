// Aba "Linhas" do drawer da câmera — linhas de contagem (tripwires) + contadores in/out "hoje".
// Componente puro: recebe estado/handlers já resolvidos pelo CameraWorkspace (edição via hook useTripwires).
import { ArrowLeftRight, RotateCcw, X } from "lucide-react";
import { Button, HelpTip, SectionTitle, Tooltip, Badge } from "../../ui";
import { type Tripwire, type TripwireCounts } from "../../vision/counting";

type Props = {
  tripwireMode: boolean;
  canConfigure: boolean;
  toggleTripwireMode: () => void;
  resetCounts: () => void;
  tripwires: Tripwire[];
  twCounts: Record<string, TripwireCounts>;
  // "hub" → o "hoje" exibido é SÓ o acumulado do servidor (o hub grava os mesmos cruzamentos);
  // "local" → acumulado do dia (servidor) + sessão corrente.
  analysisEngine: "hub" | "local";
  hubFlowToday: Record<string, TripwireCounts>;
  flowBase: Record<string, TripwireCounts>;
  invertTripwire: (id: string) => void;
  removeTripwire: (id: string) => void;
};

export function LinhasTab({
  tripwireMode,
  canConfigure,
  toggleTripwireMode,
  resetCounts,
  tripwires,
  twCounts,
  analysisEngine,
  hubFlowToday,
  flowBase,
  invertTripwire,
  removeTripwire,
}: Props) {
  return (
    <>
      {/* Seção com heading semântico (<h2> via SectionTitle) — o painel deixa de ser <div> mudo. */}
      <SectionTitle>Linhas de contagem</SectionTitle>
      <div className="row tw-actions">
        <Tooltip
          content={
            canConfigure
              ? "Clique em A e arraste até B sobre o vídeo"
              : "Edição requer perfil de engenharia"
          }
        >
          <Button size="sm" active={tripwireMode} disabled={!canConfigure} onClick={toggleTripwireMode}>
            {tripwireMode ? (
              "Traçando…"
            ) : (
              <>
                <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden /> Nova linha
              </>
            )}
          </Button>
        </Tooltip>
        <Tooltip content="Zera SÓ a contagem desta sessão (geometria mantida). O acumulado do dia, salvo no servidor, permanece.">
          <Button size="sm" onClick={resetCounts}>
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Zerar contagem
          </Button>
        </Tooltip>
        {/* Mecânica da contagem sai da superfície (regra de ouro) e mora no "?" da barra. */}
        <HelpTip label="Como funciona a contagem">
          A contagem reusa o rastreio de pessoas em cena (requer uma zona de Atividade ativa).
          Contadores da sessão zeram ao fechar; o acumulado do dia fica salvo no servidor.
        </HelpTip>
      </div>
      {tripwires.length === 0 && (
        <p className="empty-note">
          {canConfigure ? (
            <>
              Use “Nova linha” e arraste sobre o vídeo (A→B).{" "}
              <HelpTip label="Ajuda das linhas">
                Cruzar no sentido da seta conta como Entrada; o sentido oposto, como Saída. Dá para
                inverter a direção na ferramenta da linha.
              </HelpTip>
            </>
          ) : (
            "Nenhuma linha de contagem configurada. A edição requer perfil de engenharia."
          )}
        </p>
      )}
      {tripwires.map((w, i) => {
        // (1.2) "hoje" = acumulado do DIA no servidor (flowBase) + sessão corrente (twCounts).
        // F1-C (ADR-009) — modo HUB: o servidor conta os MESMOS cruzamentos que a sessão local →
        // somar os dois exibiria 2×. "hoje" passa a ser SÓ o servidor (hubFlowToday); a sessão
        // local vira feedback imediato no tooltip (não entra na soma exibida).
        const c = twCounts[w.id] ?? { in: 0, out: 0 };
        const hub = analysisEngine === "hub";
        const b = (hub ? hubFlowToday[w.id] : flowBase[w.id]) ?? { in: 0, out: 0 };
        const tIn = hub ? b.in : b.in + c.in;
        const tOut = hub ? b.out : b.out + c.out;
        const tipIn = hub
          ? `servidor (hoje) ${b.in} · sessão local ${c.in} (não somada — o hub grava os mesmos cruzamentos)`
          : `sessão ${c.in} · dia (servidor) ${b.in}`;
        const tipOut = hub
          ? `servidor (hoje) ${b.out} · sessão local ${c.out} (não somada — o hub grava os mesmos cruzamentos)`
          : `sessão ${c.out} · dia (servidor) ${b.out}`;
        return (
          <div key={w.id} className="zone">
            <div className="row">
              <span className="zone-head">
                <b className="zone-name">Linha {i + 1}</b>
                <Badge tone="info">contagem</Badge>
              </span>
              <span className="zone-tools">
                <Tooltip
                  content={
                    canConfigure
                      ? "Inverter direção (troca Entrada↔Saída)"
                      : "Edição requer perfil de engenharia"
                  }
                >
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Inverter direção"
                    onClick={() => canConfigure && invertTripwire(w.id)}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </Tooltip>
                <Tooltip content={canConfigure ? "Remover linha" : "Remover requer perfil de engenharia"}>
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Remover linha"
                    onClick={() => canConfigure && removeTripwire(w.id)}
                  >
                    <X size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </Tooltip>
              </span>
            </div>
            <div className="kpis ws-kpis">
              <Tooltip content={tipIn}>
                <div className="kpi">
                  <div className="v" style={{ color: "var(--state-info)" }}>
                    {tIn}
                  </div>
                  <div className="l">entradas hoje</div>
                </div>
              </Tooltip>
              <Tooltip content={tipOut}>
                <div className="kpi">
                  <div className="v" style={{ color: "var(--state-neutral)" }}>
                    {tOut}
                  </div>
                  <div className="l">saídas hoje</div>
                </div>
              </Tooltip>
            </div>
          </div>
        );
      })}
      {/* Nota mecânica dos contadores migrou p/ o HelpTip da barra de ações (regra de ouro:
          prosa >1 linha não mora na superfície). */}
    </>
  );
}
