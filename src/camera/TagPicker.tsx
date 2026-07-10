// Lista de TAGS BLE visíveis agora como botões escolhíveis ("rótulo||mac · rssi dBm"). Seam extraído
// do CalibrationPanel, onde os passos "referência" e "âncoras" repetiam a mesma UI. Presentational:
// não faz poll (recebe `readings` de useBleReadings) e não guarda estado — só reporta `onPick(mac)`.
//   • Going-gray: o selecionado é o único saturado (variant primary); os demais neutros (ghost).
//   • Vazio → a mesma dica neutra do original ("Nenhuma tag visível…").
//   • `leading` = nós opcionais renderizados ANTES dos botões, dentro do mesmo flex-wrap (ex.: o botão
//     "Sem âncora" do passo de âncoras). Só aparece quando há tags (igual ao inline original).
import type { ReactNode } from "react";
import { Button } from "../ui";
import type { BtReading } from "../api";

type Props = {
  readings: BtReading[];
  selectedMac: string | null;
  onPick: (mac: string) => void;
  leading?: ReactNode;
};

export function TagPicker({ readings, selectedMac, onPick, leading }: Props) {
  if (readings.length === 0) {
    return <span className="text-[12px] text-text-muted">Nenhuma tag visível — verifique a estação.</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {leading}
      {readings.map((r) => {
        const selected = selectedMac === r.mac;
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
