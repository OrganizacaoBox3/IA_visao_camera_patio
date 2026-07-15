// Aba "Vista 2D" (pequena, no drawer) — a vista superior do chão para conferência rápida. A MESMA
// vista existe em TELA CHEIA (camera/Vista2DStage, pelo botão "Mapa 2D" do cabeçalho). Os dados
// (useTopdownView) e o desenho (TopdownCanvas) são compartilhados; aqui só o enquadramento de aba +
// a lista textual. Só-leitura (observação), como Pessoas/Timeline. Física honesta (topdown.ts): a
// tag não vira ponto — anel por beacon + o MAIS PRÓXIMO destacado.
import { useMemo } from "react";
import { EmptyState } from "../../ui";
import { useTopdownView } from "../useTopdownView";
import { TopdownCanvas } from "../TopdownCanvas";

const fmtD = (d: number) => (d < 10 ? d.toFixed(1) : String(Math.round(d)));

export function Vista2DTab({ cameraId }: { cameraId: string }) {
  const { view, hasCal } = useTopdownView(cameraId, true); // a aba só monta quando visível → poll só aqui
  const beaconLabel = useMemo(
    () => new Map(view.beacons.map((b) => [b.id, b.label] as const)),
    [view.beacons],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {!hasCal ? (
        <EmptyState>
          Calibre a câmera primeiro (o retângulo do chão e o ponto de cada estação BLE) para ter a
          vista de topo. Sem calibração não há a geometria do chão para plotar. Para o mapa em tela
          cheia, use o botão “Mapa 2D” no cabeçalho.
        </EmptyState>
      ) : (
        <>
          <TopdownCanvas
            view={view}
            className="relative min-h-[220px] flex-1 overflow-hidden rounded-sm border border-border bg-panel"
            ariaLabel="Vista superior 2D do chão — beacons e tags por proximidade"
          />
          {/* O que o dono lê no teste sem câmera: por tag, o beacon MAIS PRÓXIMO + a distância. */}
          <ul className="flex flex-col gap-1 text-sec" aria-label="Tags e o beacon mais próximo">
            {view.tags.length === 0 ? (
              <li className="text-text-muted">Nenhuma tag sendo ouvida por um beacon vivo agora.</li>
            ) : (
              view.tags.map((t) => (
                <li key={t.mac} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-text">{t.label}</span>
                  {t.nearest ? (
                    <span className="text-text-muted">
                      → mais próximo: {beaconLabel.get(t.nearest.beaconId) ?? t.nearest.beaconId} ·
                      d≈{fmtD(t.nearest.distM)} m
                    </span>
                  ) : (
                    <span className="text-text-dim">sem beacon vivo ouvindo</span>
                  )}
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}
