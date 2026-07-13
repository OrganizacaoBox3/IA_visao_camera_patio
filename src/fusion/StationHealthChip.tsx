// Chip de saúde da estação de referência (FASE 2). Só EXIBE — nenhuma conta aqui (o hook já entrega tudo).
// Going-gray: neutro em operação normal; amarelo (--state-warn, via Badge tone="warn") só na anormalidade
// (sem sinal ou drift). Reusa o Badge da casa (src/ui) p/ casar padding/tipografia dos demais chips.
// Multi-antena (F2): `station` (OPCIONAL) identifica a fonte quando há mais de uma — o chamador renderiza
// um chip POR estação viva; com uma só, omite e o chip fica idêntico ao de sempre (CA-3).
// COSTURA do cadastro: a fonte é identificada pelo NOME que o operador deu em /estacoes ("Doca 3"), não
// pelo id técnico. O id NÃO some (é o que ele digita no app do celular) — vira detalhe DISCRETO, muted,
// ao lado do nome; e some de vez quando a estação ainda é pendente (nome == id ⇒ não repete).
import { Badge } from "../ui";
import type { StationLabel } from "./useStationNames";

type ChipHealth = {
  alive: boolean;
  rssi: number | null;
  driftDb: number | null;
  status: string;
  rssiAt1m?: number | null;
};

// Rótulo da fonte: NOME em 1º plano + id técnico discreto. Sem estação (fonte única) → "Estação".
function StationLabelText({ station }: { station?: StationLabel }) {
  if (!station) return <>Estação</>;
  const nome = station.nome?.trim() || station.id;
  const pendente = nome === station.id; // ainda não batizada: o id JÁ é o rótulo, não repete
  return (
    <>
      {nome}
      {!pendente && <span className="font-normal text-text-muted">{station.id}</span>}
    </>
  );
}

export function StationHealthChip({
  health,
  station,
}: {
  health: ChipHealth;
  station?: StationLabel;
}) {
  const nome = <StationLabelText station={station} />;
  // DOWN → sem sinal (anormal): amarelo.
  if (health.status === "down") {
    return <Badge tone="warn">{nome} · sem sinal</Badge>;
  }
  // DRIFT → viva mas o RSSI desviou do baseline (anormal): amarelo + o delta com sinal.
  if (health.status === "drift") {
    const d = Math.round(health.driftDb ?? 0);
    const drift = `${d > 0 ? "+" : ""}${d}`;
    return (
      <Badge tone="warn">
        {nome} · ✓ {health.rssi} dBm · drift {drift} dB
      </Badge>
    );
  }
  // OK → operação normal: neutro (Badge default = panel-2/text-dim). Mostra o RSSI@1m quando calibrado.
  return (
    <Badge>
      {nome} · ✓ {health.rssi} dBm
      {health.rssiAt1m != null && ` · 1m≈${Math.round(health.rssiAt1m)} dBm`}
    </Badge>
  );
}
