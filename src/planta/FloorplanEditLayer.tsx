// ── Camada de EDIÇÃO da Planta BLE — SVG IRMÃO do <canvas> (nunca ancestral) ───────────────────
// POR QUE SVG e não desenhar no canvas: o mesmo motivo da CalibrationLayer — os HANDLES arrastáveis
// são estado de React (posição em edição, realce de hover/drag), repintados a cada gesto sem tocar o
// laço de desenho do canvas (que só repinta na `view` do BLE ~2 s). O galpão, a grade e os eixos
// continuam no CANVAS (drawFloorplan); aqui só os marcadores de antena ARRASTÁVEIS por cima.
//
// GEOMETRIA: a SVG cobre o MESMO contêiner do canvas (inset-0) e usa o MESMO `transform` que o
// desenho — assim `transform.project(pos)` casa handle↔desenho ao pixel. Sem transform (antes do
// primeiro layout) → não desenha nada.
//
// pointer-events: none — os cliques são do CONTÊINER (que chama onDown/onMove/onUp do hook, com
// setPointerCapture para o arraste seguir fora do canvas), como a .cam-stage delega ao editor de
// calibração. Esta camada só MOSTRA (o marcador anel+ponto+nome é o da estação da CalibrationLayer).
import type { Vec2 } from "../api";
import type { TopdownTransform } from "../fusion/topdown";
import type { FloorplanSetupRow } from "./useFloorplanMap";

type Props = {
  transform: TopdownTransform | null;
  size: { w: number; h: number } | null;
  /** Posições EM EDIÇÃO (metros) por id — o que o hook está mostrando/arrastando. */
  pos: Record<string, Vec2>;
  /** Toda antena conhecida — para o NOME e o estado vivo/sem-sinal do marcador. */
  rows: FloorplanSetupRow[];
  hoverId: string | null;
  draggingId: string | null;
};

export function FloorplanEditLayer({ transform, size, pos, rows, hoverId, draggingId }: Props) {
  if (!transform || !size) return null;
  const labelOf = new Map(rows.map((r) => [r.id, r] as const));

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={size.w}
      height={size.h}
      aria-hidden
    >
      {Object.entries(pos).map(([id, p]) => {
        const c = transform.project(p);
        const row = labelOf.get(id);
        const name = row?.label ?? id;
        const live = row?.live ?? false;
        const active = id === hoverId || id === draggingId;
        // Cor = informação (going-gray): antena viva = info; sem sinal = neutra. O foco (hover/drag)
        // cresce; as demais ficam no tamanho base.
        const col = live ? "var(--state-info)" : "var(--state-neutral)";
        return (
          <g key={id} opacity={live ? 1 : 0.7}>
            {/* Anel radiante — cresce no realce (o análogo do handle de estação da calibração). */}
            <circle
              cx={c.x}
              cy={c.y}
              r={active ? 13 : 10}
              fill="none"
              stroke={col}
              strokeWidth={1.5}
              opacity={0.6}
            />
            {/* Ponto central — o pega-arraste. */}
            <circle
              cx={c.x}
              cy={c.y}
              r={active ? 6 : 5}
              fill={col}
              stroke="var(--bg)"
              strokeWidth={2}
            />
            <text x={c.x + 13} y={c.y + 4} fontSize={12} fill={col}>
              {live ? name : `${name} · sem sinal`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
