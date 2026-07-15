// Planta BLE — a tela de MAPA 2D do local por Bluetooth, SEM câmera: onde cada tag está (ponto X,Y)
// em relação às antenas. É a tela de apresentação — a fábrica ainda não tem câmeras; o operador
// espalha tags e vê tudo aqui. Leitura livre (qualquer autenticado vê o mapa); a EDIÇÃO do setup
// (dimensões + posição das antenas) é gateada por canConfigure.
//
// HONESTIDADE (inegociável, herdada de fusion/floorplan.ts): o ponto X,Y é ESTIMATIVA por rádio
// (RSSI), não medição de fita métrica. O banner diz isso na cara; o selo `fix` gradua a confiança;
// fix "none" (1 antena) não vira ponto — cai no fallback textual "só distância → antena".
import { useState } from "react";
import { MapPin } from "lucide-react";
import { useAuth } from "../auth";
import { Alert, Badge, Button, EmptyState, Loading, PageHeader } from "../ui";
import { useFloorplanMap } from "../planta/useFloorplanMap";
import { FloorplanCanvas } from "../planta/FloorplanCanvas";
import { SetupPanel } from "../planta/SetupPanel";
import type { FloorplanTag } from "../fusion/floorplan";

/** Distância curta e legível: 1 casa abaixo de 10 m, inteiro acima (evita "12.3 m" com falsa precisão). */
const distLabel = (d: number): string => (d < 10 ? d.toFixed(1) : String(Math.round(d)));

/** Selo de confiança do fix (cor = informação): ok = firme (info), weak = fraco (warn). */
function FixBadge({ tag }: { tag: FloorplanTag }) {
  if (tag.fix === "ok") return <Badge tone="info">≥3 antenas</Badge>;
  if (tag.fix === "weak") return <Badge tone="warn">2 antenas · fraco</Badge>;
  return <Badge>1 antena · só distância</Badge>;
}

export function PlantaBlePage() {
  const { canConfigure } = useAuth();
  const fp = useFloorplanMap(true);
  const [setupOpen, setSetupOpen] = useState(false);

  // Rótulo amigável da antena por id — para o fallback textual do fix "none" (só distância).
  const stationLabel = new Map(fp.view.stations.map((s) => [s.id, s.label] as const));

  return (
    <div className="page">
      <PageHeader
        title="Planta BLE"
        subtitle="Vista 2D do local por Bluetooth — onde cada tag está em relação às antenas (estimativa)"
      >
        {canConfigure && fp.hasSetup && (
          <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>
            <MapPin size={15} strokeWidth={1.75} aria-hidden /> Configurar planta
          </Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Banner de honestidade — não esconder que é estimativa por rádio. */}
        <Alert tone="info">
          Estimativa por rádio (RSSI): o ponto oscila e não é medição de fita métrica. ≥3 antenas =
          firme; 2 = fraco; 1 = só distância.
        </Alert>

        {fp.loading ? (
          <Loading label="Carregando planta" />
        ) : !fp.hasSetup ? (
          <EmptyState>
            <MapPin size={22} strokeWidth={1.5} aria-hidden />
            Defina as dimensões do local e a posição de cada antena para montar a planta.
            {canConfigure && (
              <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>
                <MapPin size={15} strokeWidth={1.75} aria-hidden /> Configurar planta
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            {/* O CANVAS é dominante — ocupa o máximo. */}
            <FloorplanCanvas
              view={fp.view}
              ariaLabel="Planta baixa 2D das tags e antenas Bluetooth"
              className="relative min-h-[280px] flex-1 overflow-hidden rounded-sm border border-border bg-panel"
            />
            {/* Lista textual das tags (coordenada + selo do fix; fallback honesto no "none"). */}
            <aside className="flex shrink-0 flex-col gap-2 overflow-y-auto rounded-sm border border-border bg-panel-2 p-3 lg:w-80">
              <span className="text-[12px] text-text-dim">
                Tags ({fp.view.tags.length})
              </span>
              {fp.view.tags.length === 0 ? (
                <p className="text-[12px] text-text-muted">
                  Nenhuma tag ouvida por uma antena viva no momento.
                </p>
              ) : (
                <ul className="flex flex-col gap-2" aria-label="Tags detectadas">
                  {fp.view.tags.map((t) => (
                    <li
                      key={t.mac}
                      className="flex flex-col gap-1 rounded-sm border border-border bg-panel px-2 py-1.5"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-text">
                          {t.label}
                        </span>
                        <FixBadge tag={t} />
                      </span>
                      <span className="text-[12px] text-text-muted">
                        {t.pos ? (
                          <>
                            ({t.pos.x.toFixed(1)}, {t.pos.y.toFixed(1)}) m
                          </>
                        ) : t.nearest ? (
                          <>
                            só distância → {stationLabel.get(t.nearest.stationId) ?? t.nearest.stationId}{" "}
                            d≈{distLabel(t.nearest.distM)} m
                          </>
                        ) : (
                          "sem sinal"
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        )}
      </div>

      {setupOpen && (
        <SetupPanel
          widthM={fp.widthM}
          heightM={fp.heightM}
          rows={fp.rows}
          saving={fp.saving}
          onSave={fp.save}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}
