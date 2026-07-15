// Vista 2D em TELA CHEIA — o "Mapa 2D" que ocupa TODA a área do palco (vídeo + drawer) quando o
// operador liga no cabeçalho. É uma VISÃO ALTERNATIVA para operar a área SÓ POR BLUETOOTH; NÃO
// substitui o vídeo (o "Sair" volta pra câmera; o <video> segue vivo atrás, só coberto). Mesma fonte
// de dados (useTopdownView) e mesmo desenho (TopdownCanvas) da aba pequena — só o tamanho muda.
//
// ADR-007: isto NÃO é Radix Dialog — é uma sobreposição absoluta DENTRO da casca fullscreen (nada
// remonta o <canvas>/rAF do palco; o trap de foco manual da casca segue no lugar).
import { Map as MapIcon, X } from "lucide-react";
import { Button, EmptyState } from "../ui";
import { useTopdownView } from "./useTopdownView";
import { TopdownCanvas } from "./TopdownCanvas";

export function Vista2DStage({ cameraId, onClose }: { cameraId: string; onClose: () => void }) {
  const { view, hasCal } = useTopdownView(cameraId, true);
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-bg"
      role="region"
      aria-label="Mapa 2D da área"
    >
      <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-3 py-2">
        <MapIcon size={16} strokeWidth={1.75} aria-hidden />
        <b className="text-body">Mapa 2D</b>
        <span className="text-sec text-text-muted max-[640px]:hidden">
          vista superior do chão — o beacon mais próximo de cada tag
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X size={14} strokeWidth={1.75} aria-hidden /> Sair
        </Button>
      </div>
      {!hasCal ? (
        <div className="grid flex-1 place-items-center p-4">
          <EmptyState>
            Calibre a câmera primeiro (o retângulo do chão e o ponto de cada estação BLE) para ter a
            vista de topo. Sem calibração não há a geometria do chão para plotar.
          </EmptyState>
        </div>
      ) : (
        <TopdownCanvas
          view={view}
          className="relative min-h-0 flex-1 overflow-hidden"
          ariaLabel="Vista superior 2D do chão em tela cheia — beacons e tags por proximidade"
        />
      )}
    </div>
  );
}
