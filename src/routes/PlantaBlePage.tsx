// Planta BLE — a tela de MAPA 2D do local por Bluetooth, SEM câmera: onde cada tag está (ponto X,Y)
// em relação às antenas. É a tela de apresentação — a fábrica ainda não tem câmeras; o operador
// espalha tags e vê tudo aqui. Leitura livre (qualquer autenticado vê o mapa); a EDIÇÃO do setup
// (dimensões + posição das antenas) é gateada por canConfigure.
//
// A CONFIGURAÇÃO É UM MODO DA PRÓPRIA TELA, não um modal (o dono reclamou do "modalzinho de
// posições"): entra-se em edição pelo botão do header; as DIMENSÕES viram dois campos inline numa
// barra acima do canvas; as POSIÇÕES se ARRASTAM no mapa (FloorplanEditLayer sobre o canvas, mesmo
// transform) OU se DIGITAM na AntennaTable ao lado — o mesmo idioma "arrasta OU digita" da
// calibração da câmera (useCalibrationEditor + VertexTable). Persiste ao soltar/commitar (fp.save).
//
// HONESTIDADE (inegociável, herdada de fusion/floorplan.ts): o ponto X,Y é ESTIMATIVA por rádio
// (RSSI), não medição de fita métrica. O banner diz isso na cara; o selo `fix` gradua a confiança;
// fix "none" (1 antena) não vira ponto — cai no fallback textual "só distância → antena".
import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useAuth } from "../auth";
import { Alert, Badge, Button, EmptyState, Field, Input, Loading, PageHeader } from "../ui";
import { useFloorplanMap } from "../planta/useFloorplanMap";
import { FloorplanCanvas } from "../planta/FloorplanCanvas";
import { FloorplanEditLayer } from "../planta/FloorplanEditLayer";
import { AntennaTable, parseMeters } from "../planta/AntennaTable";
import { useFloorplanEditor } from "../planta/useFloorplanEditor";
import { useFingerprints } from "../planta/useFingerprints";
import { ZoneCalibration } from "../planta/ZoneCalibration";
import type { TopdownTransform } from "../fusion/topdown";
import type { Vec2 } from "../api";
import type { FloorplanTag } from "../fusion/floorplan";

/** Distância curta e legível: 1 casa abaixo de 10 m, inteiro acima (evita "12.3 m" com falsa precisão). */
const distLabel = (d: number): string => (d < 10 ? d.toFixed(1) : String(Math.round(d)));

/** Cor da confiança da ZONA (fingerprinting): alta=ok, média=warn, baixa/nenhuma=neutro. */
const confColor = (c: string): string =>
  c === "alta" ? "var(--state-ok)" : c === "media" ? "var(--state-warn)" : "var(--state-neutral)";

/** Selo de confiança do fix (cor = informação): ok = firme (info), weak = fraco (warn). */
function FixBadge({ tag }: { tag: FloorplanTag }) {
  if (tag.fix === "ok") return <Badge tone="info">≥3 antenas</Badge>;
  if (tag.fix === "weak") return <Badge tone="warn">2 antenas · fraco</Badge>;
  return <Badge>1 antena · só distância</Badge>;
}

export function PlantaBlePage() {
  const { canConfigure } = useAuth();
  const fp = useFloorplanMap(true);
  const [editando, setEditando] = useState(false);
  // Transform ATUAL publicado pelo canvas (o MESMO que desenha) — repassado à SVG e ao hook de edição.
  const [tf, setTf] = useState<{ transform: TopdownTransform; size: { w: number; h: number } } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Dimensões CRUAS (string) — inline na barra de edição; comitam no blur/Enter (a validação de
  // negócio é do servidor, mesma doutrina do antigo SetupPanel; guarda-mínima local: > 0).
  const [wStr, setWStr] = useState("");
  const [hStr, setHStr] = useState("");

  // Rótulo amigável da antena por id — para o fallback textual do fix "none" (só distância).
  const stationLabel = new Map(fp.view.stations.map((s) => [s.id, s.label] as const));

  // O commit das POSIÇÕES: persiste o conjunto inteiro com as dimensões SALVAS (as dimensões têm o
  // seu próprio commit inline). fp.save espelha de volta em fp.rows → o hook re-semeia sem ruído.
  const commitStations = useCallback(
    (stations: Record<string, Vec2>) => {
      void fp.save({ widthM: fp.widthM, heightM: fp.heightM, stations });
    },
    [fp],
  );

  const editor = useFloorplanEditor({
    widthM: fp.widthM,
    heightM: fp.heightM,
    rows: fp.rows,
    transform: tf?.transform ?? null,
    containerRef,
    onCommit: commitStations,
  });

  // Fingerprinting: survey + classificação ao vivo de cada tag para a ZONA mais parecida (o sinal
  // confiável — a zona não oscila; o X,Y por rádio sim). A captura ("Calibrar") vive no modo config.
  const fpz = useFingerprints(true);

  // Semeia os campos de dimensão ao ENTRAR em edição (não a cada save, para não atropelar quem digita).
  useEffect(() => {
    if (!editando) return;
    setWStr(fp.widthM > 0 ? String(fp.widthM) : "");
    setHStr(fp.heightM > 0 ? String(fp.heightM) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editando]);

  // Commit das DIMENSÕES (blur/Enter): guarda-mínima (> 0) + no-op se nada mudou; leva as posições
  // correntes junto (fp.save quer a planta inteira). O servidor valida o resto.
  const saveDims = useCallback(() => {
    const w = parseMeters(wStr);
    const h = parseMeters(hStr);
    if (!(w > 0) || !(h > 0)) return;
    if (w === fp.widthM && h === fp.heightM) return;
    void fp.save({ widthM: w, heightM: h, stations: editor.pos });
  }, [wStr, hStr, fp, editor.pos]);

  const enterEdit = () => setEditando(true);

  return (
    <div className="page">
      <PageHeader
        title="Planta BLE"
        subtitle="Vista 2D do local por Bluetooth — onde cada tag está em relação às antenas (estimativa)"
      >
        {canConfigure &&
          (editando ? (
            <Button variant="ghost" size="sm" onClick={() => setEditando(false)}>
              Concluir
            </Button>
          ) : (
            fp.hasSetup && (
              <Button variant="primary" size="sm" onClick={enterEdit}>
                <MapPin size={15} strokeWidth={1.75} aria-hidden /> Configurar planta
              </Button>
            )
          ))}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* Banner de honestidade — não esconder que é estimativa por rádio. */}
        <Alert tone="info">
          Estimativa por rádio (RSSI): o ponto oscila e não é medição de fita métrica. ≥3 antenas =
          firme; 2 = fraco; 1 = só distância.
        </Alert>

        {editando ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Barra de DIMENSÕES inline (não é mais um modal) — comita no blur/Enter. */}
            <div className="flex flex-wrap items-end gap-3 rounded-sm border border-border bg-panel-2 p-3">
              <Field label="Largura (m)" htmlFor="fp-w" className="w-32">
                <Input
                  id="fp-w"
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  value={wStr}
                  onChange={(e) => setWStr(e.target.value)}
                  onBlur={saveDims}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveDims();
                    }
                  }}
                />
              </Field>
              <Field label="Comprimento (m)" htmlFor="fp-h" className="w-32">
                <Input
                  id="fp-h"
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  value={hStr}
                  onChange={(e) => setHStr(e.target.value)}
                  onBlur={saveDims}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveDims();
                    }
                  }}
                />
              </Field>
              <p className="text-[12px] text-text-muted">
                Arraste as antenas no mapa ou digite X/Y ao lado. {fp.saving ? "Salvando…" : ""}
              </p>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              {/* Canvas = PALCO: desenho no <canvas>, handles arrastáveis na SVG (mesmo transform). Os
                  ponteiros vão ao contêiner e o hook cuida do hit-test/arraste (setPointerCapture). */}
              <FloorplanCanvas
                view={fp.view}
                ariaLabel="Planta baixa 2D — edição das antenas Bluetooth"
                className="relative min-h-[280px] flex-1 touch-none overflow-hidden rounded-sm border border-border bg-panel"
                containerRef={containerRef}
                onTransform={(transform, size) => setTf({ transform, size })}
                onPointerDown={editor.onDown}
                onPointerMove={editor.onMove}
                onPointerUp={editor.onUp}
                onPointerLeave={editor.onUp}
              >
                <FloorplanEditLayer
                  transform={tf?.transform ?? null}
                  size={tf?.size ?? null}
                  pos={editor.pos}
                  rows={fp.rows}
                  hoverId={editor.hoverId}
                  draggingId={editor.draggingId}
                />
              </FloorplanCanvas>
              {/* Tabela: DIGITA a coordenada (coexiste com o arraste), coloca/remove antena. */}
              <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto lg:w-80">
                <div className="rounded-sm border border-border bg-panel-2 p-3">
                  <AntennaTable
                    rows={fp.rows}
                    pos={editor.pos}
                    onSetCoord={editor.setCoord}
                    onPlace={editor.place}
                    onRemove={editor.remove}
                  />
                </div>
                {/* Calibração de zonas (fingerprinting): encoste as tags em cima da antena e Calibrar. */}
                <ZoneCalibration
                  rows={fp.rows}
                  fingerprints={fpz.fingerprints}
                  capturing={fpz.capturing}
                  onCapture={fpz.capture}
                  onRemove={fpz.remove}
                />
              </aside>
            </div>
          </div>
        ) : fp.loading ? (
          <Loading label="Carregando planta" />
        ) : !fp.hasSetup ? (
          <EmptyState>
            <MapPin size={22} strokeWidth={1.5} aria-hidden />
            Defina as dimensões do local e a posição de cada antena para montar a planta.
            {canConfigure && (
              <Button variant="primary" size="sm" onClick={enterEdit}>
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
              <span className="text-[12px] text-text-dim">Tags ({fp.view.tags.length})</span>
              {fp.view.tags.length === 0 ? (
                <p className="text-[12px] text-text-muted">
                  Nenhuma tag ouvida por uma antena viva no momento.
                </p>
              ) : (
                <ul className="flex flex-col gap-2" aria-label="Tags detectadas">
                  {fp.view.tags.map((t) => {
                    // Zona = fingerprinting (o sinal confiável). Só aparece se há survey calibrado.
                    const zona = fpz.liveByMac.get(t.mac)?.best ? fpz.liveByMac.get(t.mac) : null;
                    return (
                      <li
                        key={t.mac}
                        className="flex flex-col gap-1 rounded-sm border border-border bg-panel px-2 py-1.5"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-text">{t.label}</span>
                          <FixBadge tag={t} />
                        </span>
                        {zona?.best && (
                          <span className="text-[12px] font-medium" style={{ color: confColor(zona.confidence) }}>
                            📍 {zona.best.label} · {zona.confidence}
                          </span>
                        )}
                        {/* X,Y por rádio: estimativa secundária (oscila; a ZONA acima é o confiável). */}
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
                    );
                  })}
                </ul>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
