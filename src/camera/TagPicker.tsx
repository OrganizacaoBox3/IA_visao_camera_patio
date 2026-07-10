// Lista de TAGS BLE visíveis agora como botões escolhíveis ("rótulo||mac · rssi dBm"). Seam extraído
// do CalibrationPanel, onde os passos "referência" e "âncoras" repetiam a mesma UI. Presentational:
// não faz poll (recebe `readings` de useBleReadings) e não guarda estado — só reporta `onPick(mac)`.
//   • Going-gray: o selecionado é o único saturado (variant primary); os demais neutros (ghost).
//   • Vazio → a mesma dica neutra do original ("Nenhuma tag visível…").
//   • `leading` = nós opcionais renderizados ANTES dos botões, dentro do mesmo flex-wrap (ex.: o botão
//     "Sem âncora" do passo de âncoras). Só aparece quando há tags (igual ao inline original).
//   • `taken` (aditivo) = MAC MAIÚSCULO → papel que já ocupa a tag ("âncora do canto 2", "tag de
//     referência"). Item ocupado fica VISÍVEL porém desabilitado com o papel ao lado do RSSI —
//     escondê-lo leria como "tag fora de alcance". A seleção corrente vence o mapa (nunca se
//     auto-desabilita). Papéis vêm de takenTags (src/camera/takenTags.ts).
import type { ReactNode } from "react";
import { Button } from "../ui";
import type { BtReading } from "../api";

type Props = {
  readings: BtReading[];
  selectedMac: string | null;
  onPick: (mac: string) => void;
  leading?: ReactNode;
  taken?: ReadonlyMap<string, string>;
};

export function TagPicker({ readings, selectedMac, onPick, leading, taken }: Props) {
  if (readings.length === 0) {
    return <span className="text-[12px] text-text-muted">Nenhuma tag visível — verifique a estação.</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {leading}
      {readings.map((r) => {
        // MAC é hex — comparação de seleção sem sensibilidade a caixa (calibração salva pode diferir).
        const selected = selectedMac?.toUpperCase() === r.mac.toUpperCase();
        const role = selected ? undefined : taken?.get(r.mac.toUpperCase());
        if (role) {
          // Ocupada por outro papel: neutra e inerte (pointer-events-none → sem hover, cursor default).
          return (
            <Button
              key={r.mac}
              size="sm"
              variant="ghost"
              disabled
              aria-pressed={false}
              className="pointer-events-none"
            >
              {r.rotulo || r.mac} · {r.rssi} dBm
              <span className="text-text-muted">— {role}</span>
            </Button>
          );
        }
        return (
          <Button
            key={r.mac}
            size="sm"
            variant={selected ? "primary" : "ghost"}
            aria-pressed={selected}
            onClick={() => onPick(r.mac)}
          >
            {r.rotulo || r.mac} · {r.rssi} dBm
          </Button>
        );
      })}
    </div>
  );
}
