// ── Camada de MARCAÇÃO da calibração no palco — SVG IRMÃO do <canvas> (nunca ancestral) ────────
// POR QUE SVG e não o rAF (risco nº 1 da spec §1): com ⏸ Pausar / ❄ Congelar, o tick do palco
// RETORNA ANTES do drawScene — o canvas não é redesenhado. Um canto clicado com a imagem parada
// simplesmente NÃO APARECERIA. E parar a imagem é exatamente o que o operador faz para clicar com
// precisão. Esta camada é React puro: repinta com o estado, não com o frame. O rAF fica intocado
// (é o gate de frame; ADR-007).
//
// GEOMETRIA: o SVG é posicionado no CONTENT-RECT (o letterbox do vídeo, calculado por
// getContentRect — o MESMO do canvas/zonas/tracks). Assim as coordenadas internas em % mapeiam
// direto o 0..1 normalizado do frame — o sistema de sempre (zonas/tracks/pé) e o mesmo que o painel
// antigo usava sobre a <img>. Sem rect (vídeo ainda sem dimensão) → não desenha nada.
//
// pointer-events: none — os cliques são do palco (.cam-stage já trata onMouseDown/Move/Up e delega
// ao useCalibrationEditor). Esta camada só MOSTRA.
import type { CalibrationEditor } from "./useCalibrationEditor";

type Props = { cal: CalibrationEditor };

export function CalibrationLayer({ cal }: Props) {
  const { rect, mode, corners, hoverIdx } = cal;
  if (!rect || !cal.active) return null;
  const calibrando = mode === "calibrar";
  return (
    <svg
      className="cal-layer"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-hidden
    >
      {/* GRADE de conferência (métrica projetada de volta): some enquanto não há H válida. */}
      {calibrando &&
        cal.grid?.seg.map(([a, b], i) => (
          <line
            key={`g${i}`}
            x1={`${a.x * 100}%`}
            y1={`${a.y * 100}%`}
            x2={`${b.x * 100}%`}
            y2={`${b.y * 100}%`}
            stroke="var(--state-ok)"
            strokeWidth={1}
            opacity={0.5}
          />
        ))}

      {/* Contorno do retângulo (cantos na ordem) + marcadores numerados. Tracejado = incompleto. */}
      {calibrando && corners.length >= 2 && (
        <polygon
          points={corners.map((p) => `${p.x * 100}%,${p.y * 100}%`).join(" ")}
          fill="none"
          stroke="var(--state-info)"
          strokeWidth={2}
          strokeDasharray={corners.length < 4 ? "4 3" : undefined}
        />
      )}
      {calibrando &&
        corners.map((p, i) => (
          <g key={`c${i}`}>
            <circle
              cx={`${p.x * 100}%`}
              cy={`${p.y * 100}%`}
              r={hoverIdx === i ? 8 : 6}
              fill="var(--state-info)"
              stroke="var(--bg)"
              strokeWidth={2}
            />
            {/* O NÚMERO aqui é do CANTO do retângulo de calibração (geometria do chão), não de
                pessoa: a invariante "a caixa da PESSOA nunca exibe número" (ADR-003) segue de pé. */}
            <text
              x={`${p.x * 100}%`}
              y={`${p.y * 100}%`}
              dx={9}
              dy={4}
              fontSize={12}
              fill="var(--state-info)"
            >
              {i + 1}
            </text>
          </g>
        ))}

      {/* Modo medir: a linha + os 2 pontos (a leitura em metros vive no PAINEL, nunca sobre o
          vídeo — "a imagem é soberana", ADR-003). */}
      {!calibrando && cal.measurePts.length === 2 && (
        <line
          x1={`${cal.measurePts[0].x * 100}%`}
          y1={`${cal.measurePts[0].y * 100}%`}
          x2={`${cal.measurePts[1].x * 100}%`}
          y2={`${cal.measurePts[1].y * 100}%`}
          stroke="var(--state-warn)"
          strokeWidth={2}
        />
      )}
      {!calibrando &&
        cal.measurePts.map((p, i) => (
          <circle
            key={`m${i}`}
            cx={`${p.x * 100}%`}
            cy={`${p.y * 100}%`}
            r={hoverIdx === i ? 8 : 6}
            fill="var(--state-warn)"
            stroke="var(--bg)"
            strokeWidth={2}
          />
        ))}
    </svg>
  );
}
