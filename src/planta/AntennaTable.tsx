// AntennaTable — o caminho de TECLADO/DIGITAÇÃO da edição da planta, ao lado do canvas: uma linha
// por antena (nome + bolinha viva/sem-sinal + X(m) + Y(m) + remover), e o botão "colocar no mapa"
// para a que ainda não tem posição. É o "DIGITA" que coexiste com o "ARRASTA" — o mesmo par que a
// VertexTable dá ao polígono (arrasta no palco OU digita a coordenada). Aqui em METROS, grampeado à
// caixa do galpão [0,widthM]×[0,heightM]; sem polígono, sem teste de auto-interseção.
//
// PADRÃO herdado da VertexTable (adaptado do 0..1 normalizado para metros): o texto digitado é
// RASCUNHO até o commit (blur/Enter) — commit direto no onChange brigaria com quem digita ("0," ainda
// não é número); o rascunho re-sincroniza quando o ponto muda POR FORA (arraste no mapa); parse
// tolerante a vírgula decimal (o operador é BR); setas do teclado dão o nudge fino (Shift = grosso).
import { useState, type KeyboardEvent } from "react";
import { MapPin, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Input, StatusDot } from "../ui";
import type { Vec2 } from "../api";
import type { FloorplanSetupRow } from "./useFloorplanMap";

// Passo do nudge em METROS — o idioma do Figma/Illustrator (seta = fino; Shift = grosso, 10×). 0,1 m
// é o ajuste fino de uma antena; 1 m o grosso.
export const NUDGE_FINE_M = 0.1;
export const NUDGE_COARSE_M = 1;

/** Parse tolerante a vírgula decimal; NaN quando não é número finito (campo vazio/lixo). */
export function parseMeters(text: string): number {
  const t = text.trim().replace(",", ".");
  return t === "" ? NaN : Number(t);
}

/** Seta → deslocamento em metros. Puro → testável sem DOM. Y cresce para BAIXO (como na planta). */
export function nudgeMeters(key: string, shift: boolean): { dx: number; dy: number } | null {
  const s = shift ? NUDGE_COARSE_M : NUDGE_FINE_M;
  switch (key) {
    case "ArrowLeft":
      return { dx: -s, dy: 0 };
    case "ArrowRight":
      return { dx: s, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -s };
    case "ArrowDown":
      return { dx: 0, dy: s };
    default:
      return null;
  }
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

type Props = {
  rows: FloorplanSetupRow[];
  /** Posições EM EDIÇÃO (metros) por id — a fonte da verdade da tabela (espelha o mapa). */
  pos: Record<string, Vec2>;
  onSetCoord: (id: string, x: number, y: number) => void;
  onPlace: (id: string) => void;
  onRemove: (id: string) => void;
};

export function AntennaTable({ rows, pos, onSetCoord, onPlace, onRemove }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-text-dim">Antenas (posição em metros)</span>
      {rows.length === 0 ? (
        <p className="text-[12px] text-text-muted">
          Nenhuma estação conhecida ainda. Ligue uma estação BLE para posicioná-la aqui.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((r) => {
            const p = pos[r.id];
            return (
              <li
                key={r.id}
                className="flex flex-col gap-1.5 rounded-sm border border-border bg-panel px-2 py-1.5"
              >
                <span className="flex items-center gap-2">
                  <StatusDot
                    tone={r.live ? "info" : "neutral"}
                    label={r.live ? "estação viva" : "estação sem sinal"}
                  />
                  <span className="truncate text-[13px] font-medium text-text">{r.label}</span>
                  {p ? (
                    <IconButton
                      label={`Remover ${r.label} do mapa`}
                      className="ml-auto"
                      onClick={() => onRemove(r.id)}
                    >
                      <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                    </IconButton>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => onPlace(r.id)}
                    >
                      <MapPin size={14} strokeWidth={1.75} aria-hidden /> Colocar no mapa
                    </Button>
                  )}
                </span>
                {p && (
                  <AntennaCoord
                    id={r.id}
                    label={r.label}
                    p={p}
                    onCommit={(x, y) => onSetCoord(r.id, x, y)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Campos X/Y de UMA antena. Rascunho-string até o commit (blur/Enter); re-sincroniza quando a posição
// muda por fora (arraste no mapa) — o padrão "ajustar estado durante o render" do CoordEditor, sem
// efeito e sem remount (o foco fica onde está). Setas do teclado dão o nudge (commit imediato).
function AntennaCoord({
  id,
  label,
  p,
  onCommit,
}: {
  id: string;
  label: string;
  p: Vec2;
  onCommit: (x: number, y: number) => void;
}) {
  const sync = () => ({ id, x: p.x, y: p.y, tx: fmt(p.x), ty: fmt(p.y) });
  const [snap, setSnap] = useState(sync);
  // Re-sincroniza ao trocar de antena (id) ou quando o ponto muda POR FORA (arraste no mapa).
  if (snap.id !== id || snap.x !== p.x || snap.y !== p.y) setSnap(sync);

  function commit() {
    const nx = parseMeters(snap.tx);
    const ny = parseMeters(snap.ty);
    // Blur SEM edição não é edição (senão cada Tab viraria um PUT de planta no hub).
    if (nx === p.x && ny === p.y) return;
    if (Number.isFinite(nx) && Number.isFinite(ny)) onCommit(nx, ny);
    setSnap(sync); // volta ao valor CORRENTE (o pai clampou/recusou → o campo diz a verdade)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    const d = nudgeMeters(e.key, e.shiftKey);
    if (d) {
      e.preventDefault();
      onCommit(p.x + d.dx, p.y + d.dy); // nudge age no ponto REAL, não no rascunho
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={`X de ${label} (m)`} htmlFor={`ant-${id}-x`} className="w-24">
        <Input
          id={`ant-${id}-x`}
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={snap.tx}
          onChange={(e) => setSnap({ ...snap, tx: e.target.value })}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </Field>
      <Field label={`Y de ${label} (m)`} htmlFor={`ant-${id}-y`} className="w-24">
        <Input
          id={`ant-${id}-y`}
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={snap.ty}
          onChange={(e) => setSnap({ ...snap, ty: e.target.value })}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </Field>
    </div>
  );
}
