// ── TABELA DE VÉRTICES (spec-zona-unificada F4) ──────────────────────────────
// O caminho de TECLADO do polígono — e a precisão fina sem zoom. A varredura de mercado
// (ONVIF, Axis, Frigate, Hanwha, Dahua, Verkada, Milestone, Avigilon) não achou UM VMS que
// permita editar polígono sem mouse; quem resolveu foi o ArcGIS Pro, com uma tabela onde se
// DIGITA a coordenada. É isto. Barato porque o dado (`points`) já existe e já é validado.
//
// TRÊS REGRAS QUE NÃO SE NEGOCIAM AQUI:
// 1. `points` é a FONTE DA VERDADE; `x/y/w/h` é CACHE da envolvente — derivado no call-site
//    (ConfigZonaDialog faz `...polygonBBox(pts)` no patch), NUNCA autorado.
// 2. A validação é a MESMA do palco: `sanitizeZonePoints` (clamp 0..1 + POLÍGONO SIMPLES, o
//    `isSimplePolygon` do ONVIF). Reusada, não reimplementada — senão a tabela vira a porta dos
//    fundos que o palco tranca (auto-interseção entrando por trás).
// 3. Tablet (P7): nada aqui depende de clique-direito. Botão + teclado, ponto.
import { useId, useState, type KeyboardEvent } from "react";
import { Info, Trash2 } from "lucide-react";
import { Alert, Button, EmptyState, Field, IconButton, Input, SectionTitle } from "../ui";
import { POLYGON_MIN_POINTS, sanitizeZonePoints, zonePolygon, type ZonePoint } from "../zones";

// Passo do nudge — o idioma do Figma/Illustrator (seta = fino; Shift = grosso, 10×). Em coords
// NORMALIZADAS: 0,005 ≈ 6 px num frame de 1280 (o ajuste que no palco exigiria zoom que não temos).
export const NUDGE_FINE = 0.005;
export const NUDGE_COARSE = 0.05;

// Mensagens (going-gray: informação NUNCA só-por-cor — o Alert leva o texto, não só o vermelho).
export const MSG_CROSS_MOVE = "As arestas se cruzariam — o vértice não foi movido.";
export const MSG_CROSS_REMOVE = "As arestas se cruzariam — o vértice não foi removido.";
export const MSG_MIN_POINTS = `Um polígono precisa de pelo menos ${POLYGON_MIN_POINTS} vértices.`;
export const MSG_BAD_COORD = "Coordenada inválida — use um número entre 0 e 1.";

// Seta → deslocamento normalizado. y cresce para BAIXO na imagem: ArrowUp = −y (o vértice sobe
// na tela, que é o que o operador espera). Puro → testável sem DOM.
export function nudgeDelta(key: string, shift: boolean): { dx: number; dy: number } | null {
  const s = shift ? NUDGE_COARSE : NUDGE_FINE;
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

// Resultado de uma edição: ou o polígono NOVO (já saneado), ou o motivo da recusa. Nunca um
// polígono inválido, nunca uma recusa muda.
export type EditResult = { ok: true; points: ZonePoint[] } | { ok: false; reason: string };

// Texto → coordenada. Aceita vírgula decimal (o operador é BR e o teclado numérico dele tem `,`).
export function parseCoord(text: string): number {
  const t = text.trim().replace(",", ".");
  return t === "" ? NaN : Number(t);
}

// O que foi digitado é IGUAL ao que já está lá? Blur sem edição NÃO é edição: o patchZone é
// write-through (persiste no hub), então commitar um no-op mandaria um PUT de zona a cada Tab.
export function isNoOpEdit(tx: string, ty: string, p: ZonePoint): boolean {
  return parseCoord(tx) === p.x && parseCoord(ty) === p.y;
}

// Move o vértice `i` para (x,y). O clamp 0..1 e o teste de polígono SIMPLES saem do MESMO
// sanitizeZonePoints que o backend e o palco usam (regra 2 do cabeçalho).
export function movePoint(pts: ZonePoint[], i: number, x: number, y: number): EditResult {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: MSG_BAD_COORD };
  const cand = pts.map((p, k) => (k === i ? { x, y } : p));
  const safe = sanitizeZonePoints(cand);
  return safe ? { ok: true, points: safe } : { ok: false, reason: MSG_CROSS_MOVE };
}

// Remove o vértice `i`. Piso de 3 (o mínimo do contrato) — e a remoção também pode CRUZAR arestas
// (a corda que substitui as duas arestas do vértice pode atravessar o polígono): mesma validação.
export function removePoint(pts: ZonePoint[], i: number): EditResult {
  if (pts.length <= POLYGON_MIN_POINTS) return { ok: false, reason: MSG_MIN_POINTS };
  const safe = sanitizeZonePoints(pts.filter((_, k) => k !== i));
  return safe ? { ok: true, points: safe } : { ok: false, reason: MSG_CROSS_REMOVE };
}

const fmt = (v: number) => v.toFixed(3);

type Props = {
  /** polígono da zona (undefined/curto = zona legada, sem vértices para editar) */
  points?: ZonePoint[];
  /** commit do polígono JÁ saneado — o chamador deriva a bbox (points é a fonte da verdade) */
  onChange: (points: ZonePoint[]) => void;
};

export function VertexTable({ points, onChange }: Props) {
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const uid = useId();
  const hintId = `${uid}-hint`;
  const pts = zonePolygon({ points });

  // Zona LEGADA (máscara de pincel / sem points): tabela vazia seria mentira — o honesto é dizer
  // o que ela é e como sair disso.
  if (!pts)
    return (
      <section className="flex flex-col gap-2">
        <SectionTitle flush>Vértices</SectionTitle>
        <EmptyState>
          <span className="text-sec">
            Esta zona usa a máscara legada (pincel) e não tem vértices. Redesenhe-a como polígono
            para editar ponto a ponto.
          </span>
        </EmptyState>
      </section>
    );

  const selIdx = Math.min(sel, pts.length - 1);
  const atMin = pts.length <= POLYGON_MIN_POINTS;

  function apply(r: EditResult) {
    if (r.ok) {
      setErr(null);
      onChange(r.points);
    } else {
      setErr(r.reason);
    }
  }

  // Teclado do vértice focado: setas movem (Shift = passo grosso), Delete/Backspace remove.
  // preventDefault para a seta não rolar o corpo do diálogo por baixo da edição.
  // Arrow function (não `function`): declaração hoistada perderia o narrowing de `pts` acima.
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = nudgeDelta(e.key, e.shiftKey);
    if (d) {
      e.preventDefault();
      setSel(i);
      apply(movePoint(pts, i, pts[i].x + d.dx, pts[i].y + d.dy));
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setSel(i);
      apply(removePoint(pts, i));
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle flush>Vértices ({pts.length})</SectionTitle>
      <p id={hintId} className="m-0 text-sec text-text-muted">
        Escolha um vértice e use as <b>setas</b> do teclado para movê-lo (<b>Shift</b> = passo
        grosso); <b>Delete</b> remove. As coordenadas vão de 0 a 1 (fração da imagem) — x da
        esquerda para a direita, y de cima para baixo.
      </p>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {pts.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <Button
              size="sm"
              variant={i === selIdx ? "primary" : "ghost"}
              aria-pressed={i === selIdx}
              aria-describedby={hintId}
              // O rótulo acessível soletra a coordenada (o texto visível usa mono e parênteses,
              // que o leitor de tela lê mal) e diz o que as setas fazem.
              aria-label={`Vértice ${i + 1}: x ${fmt(p.x)}, y ${fmt(p.y)}`}
              onClick={() => {
                setSel(i);
                setErr(null);
              }}
              onKeyDown={(e) => onKey(e, i)}
              className="grow justify-start"
            >
              <span className="[font-family:var(--mono)]" aria-hidden>
                #{i + 1} ({fmt(p.x)}, {fmt(p.y)})
              </span>
            </Button>
            <IconButton
              label={
                atMin
                  ? `Remover vértice ${i + 1} — indisponível: ${MSG_MIN_POINTS}`
                  : `Remover vértice ${i + 1}`
              }
              disabled={atMin}
              onClick={() => apply(removePoint(pts, i))}
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>

      {/* Botão desabilitado NUNCA é mudo: o porquê fica visível ao lado dele (ícone + texto). */}
      {atMin && (
        <p className="m-0 flex items-center gap-1 text-sec text-text-muted">
          <Info size={12} strokeWidth={1.75} aria-hidden />
          Remover está indisponível: {MSG_MIN_POINTS}
        </p>
      )}

      {/* ArcGIS: DIGITAR a coordenada. Edita o vértice SELECIONADO (um par de campos, não 20). */}
      <CoordEditor
        index={selIdx}
        p={pts[selIdx]}
        uid={uid}
        onCommit={(x, y) => apply(movePoint(pts, selIdx, x, y))}
      />

      {err && <Alert tone="alert">{err}</Alert>}
    </section>
  );
}

// Campos numéricos do vértice selecionado. O texto digitado é RASCUNHO até o commit (blur/Enter):
// commit direto no onChange brigaria com o operador enquanto ele digita ("0," ainda não é número).
// O rascunho re-sincroniza com o ponto SEMPRE que ele muda por fora (nudge/arraste no palco) e
// SEMPRE que se comita — assim o campo mostra o valor REAL (já clampeado) e nunca uma mentira que
// o polígono recusou. Padrão "ajustar estado durante o render" do React (sem efeito, sem remount:
// o foco fica onde está).
function CoordEditor({
  index,
  p,
  uid,
  onCommit,
}: {
  index: number;
  p: ZonePoint;
  uid: string;
  onCommit: (x: number, y: number) => void;
}) {
  const sync = () => ({ i: index, x: p.x, y: p.y, tx: fmt(p.x), ty: fmt(p.y) });
  const [snap, setSnap] = useState(sync);
  // Re-sincroniza quando MUDA O VÉRTICE (outra seleção) ou quando o ponto muda POR FORA (nudge de
  // teclado, arraste no palco). O `i` não é decorativo: dois vértices podem ter a MESMA coordenada
  // (o degenerado passa na validação — ver zones.ts), e sem ele a troca de seleção não resetaria.
  if (snap.i !== index || snap.x !== p.x || snap.y !== p.y) setSnap(sync);

  const idX = `${uid}-x`;
  const idY = `${uid}-y`;
  function commit() {
    // Blur SEM edição não é edição (senão cada Tab viraria um PUT de zona no hub).
    if (isNoOpEdit(snap.tx, snap.ty, p)) return;
    onCommit(parseCoord(snap.tx), parseCoord(snap.ty));
    // Volta ao valor CORRENTE: se o pai aceitou (e clampeou), o ajuste-no-render acima corrige
    // para o novo ponto; se recusou, o campo já volta a dizer a verdade.
    setSnap(sync);
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={`X do vértice #${index + 1}`} htmlFor={idX} className="w-28">
        <Input
          id={idX}
          type="number"
          inputMode="decimal"
          step="0.005"
          min="0"
          max="1"
          value={snap.tx}
          onChange={(e) => setSnap({ ...snap, tx: e.target.value })}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </Field>
      <Field label={`Y do vértice #${index + 1}`} htmlFor={idY} className="w-28">
        <Input
          id={idY}
          type="number"
          inputMode="decimal"
          step="0.005"
          min="0"
          max="1"
          value={snap.ty}
          onChange={(e) => setSnap({ ...snap, ty: e.target.value })}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </Field>
    </div>
  );
}
