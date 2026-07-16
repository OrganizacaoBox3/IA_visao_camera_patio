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
// HONESTIDADE: o ponto X,Y é ESTIMATIVA por rádio, não medição de fita métrica. O fingerprint
// contínuo é a fonte primária; a multilateração só entra se passar pelos gates de residual/planta.
// Nenhuma fonte encaixa a tag numa zona ou área física.
//
// PRESENÇA NA MESA (spec-zona-trabalho-ble.md + pedido do dono 2026-07-15): o sinal PRIMÁRIO do
// painel é a leitura do usuário final — "o operador está na mesa X há N min" — derivada da posição
// publicada ∩ polígono da área física (ADR-017: reconhecer a mesa NUNCA move a tag), estabilizada
// pela histerese de fusion/zone-presence.ts (o rótulo é o label da área). A zona por fingerprint
// (nome de antena/ponto de treino) é detalhe técnico e vive no "Diagnóstico BLE". Pontos de treino
// ficam restritos à calibração; zona, X,Y e distância à área permanecem saídas independentes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useAuth } from "../auth";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  StatusDot,
  Tabs,
  TabsContent,
} from "../ui";
import { useFloorplanMap } from "../planta/useFloorplanMap";
import { FloorplanCanvas } from "../planta/FloorplanCanvas";
import { FloorplanEditLayer } from "../planta/FloorplanEditLayer";
import { AntennaTable, parseMeters } from "../planta/AntennaTable";
import { useFloorplanEditor } from "../planta/useFloorplanEditor";
import { useFingerprints } from "../planta/useFingerprints";
import { useContinuousFloorplan } from "../planta/useContinuousFloorplan";
import { ZoneCalibration } from "../planta/ZoneCalibration";
import { WorkAreaPanel } from "../planta/WorkAreaPanel";
import { useWorkAreaPolygonEditor } from "../planta/useWorkAreaPolygonEditor";
import {
  initZoneTrack,
  readZonePresence,
  updateZoneTrack,
  type ZonePresence,
  type ZoneTrackState,
} from "../fusion/zone-presence";
import type { WorkAreaMarker, ZoneMarker } from "../planta/drawFloorplan";
import type { TopdownTransform } from "../fusion/topdown";
import type { FloorplanWorkArea, Vec2 } from "../api";
import { distanceBandToWorkArea, isPointInsidePolygon } from "../fusion/work-area";

/** Poda trackers de presença sem observação há mais que isto (tag foi embora de vez). */
const PRESENCE_PRUNE_MS = 5 * 60_000;

/** "há N s/min/h" legível para permanência (sem falsa precisão de segundos em horas). */
const durLabel = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
};

/** Última permanência ENCERRADA numa mesa (para "esteve em X por N min" quando a pessoa sai). */
type LastStay = { label: string; duracaoMs: number; fimTs: number };

type ConfigTab = "planta" | "areas" | "zonas";
type SaveFeedback = { tone: "ok" | "alert"; text: string } | null;

export function PlantaBlePage() {
  const { canConfigure } = useAuth();
  const fpz = useFingerprints(true);
  const fp = useFloorplanMap(true, fpz.fingerprints);
  const operationalView = useContinuousFloorplan(fp.view, fpz.liveByMac);
  const saveFloorplan = fp.save;
  const savedWidthM = fp.widthM;
  const savedHeightM = fp.heightM;
  const [editando, setEditando] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>("planta");
  const [dimError, setDimError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(null);
  // Transform ATUAL publicado pelo canvas (o MESMO que desenha) — repassado à SVG e ao hook de edição.
  const [tf, setTf] = useState<{
    transform: TopdownTransform;
    size: { w: number; h: number };
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const areaContainerRef = useRef<HTMLDivElement | null>(null);
  const [areaTf, setAreaTf] = useState<TopdownTransform | null>(null);
  // Dimensões CRUAS (string) — inline na barra de edição; comitam no blur/Enter (a validação de
  // negócio é do servidor, mesma doutrina do antigo SetupPanel; guarda-mínima local: > 0).
  const [wStr, setWStr] = useState("");
  const [hStr, setHStr] = useState("");

  // O commit das POSIÇÕES: persiste o conjunto inteiro com as dimensões SALVAS (as dimensões têm o
  // seu próprio commit inline). fp.save espelha de volta em fp.rows → o hook re-semeia sem ruído.
  const commitStations = useCallback(
    (stations: Record<string, Vec2>) => {
      setSaveFeedback(null);
      void saveFloorplan({
        widthM: savedWidthM,
        heightM: savedHeightM,
        stations,
        workAreas: fp.workAreas,
      }).then((result) => {
        setSaveFeedback(
          result.ok
            ? { tone: "ok", text: "Alterações salvas." }
            : { tone: "alert", text: result.error ?? "Não foi possível salvar a planta." },
        );
      });
    },
    [saveFloorplan, savedWidthM, savedHeightM, fp.workAreas],
  );

  const editor = useFloorplanEditor({
    widthM: fp.widthM,
    heightM: fp.heightM,
    rows: fp.rows,
    transform: tf?.transform ?? null,
    containerRef,
    onCommit: commitStations,
  });

  const saveWorkAreas = useCallback(
    async (workAreas: FloorplanWorkArea[]) => {
      return saveFloorplan({
        widthM: fp.widthM,
        heightM: fp.heightM,
        stations: editor.pos,
        workAreas,
      });
    },
    [editor.pos, fp.heightM, fp.widthM, saveFloorplan],
  );

  const areaEditor = useWorkAreaPolygonEditor({
    widthM: fp.widthM,
    heightM: fp.heightM,
    areas: fp.workAreas,
    transform: areaTf,
    containerRef: areaContainerRef,
    onSave: saveWorkAreas,
  });

  // Fingerprinting mantém zona e X,Y como inferências separadas. operationalView usa o WKNN como
  // posição primária, geometria validada como fallback e nunca encaixa a tag no marcador da zona.

  // ── PRESENÇA DE ZONA com histerese (spec-zona-trabalho-ble.md): a classificação instantânea
  // acima oscila poll a poll; aqui ela vira a decisão ESTÁVEL "está/não está na zona" por tag
  // (entra após K polls qualificados, sai após K', "incerto" por TTL quando a tag cala). O estado
  // interno (por MAC) vive num ref; a leitura derivada re-renderiza a cada poll (~2 s). ──
  const zoneTrackRef = useRef<Map<string, ZoneTrackState>>(new Map());
  const [presenceByMac, setPresenceByMac] = useState<Map<string, ZonePresence>>(new Map());
  useEffect(() => {
    const now = Date.now();
    const tracks = zoneTrackRef.current;
    for (const [mac, cls] of fpz.liveByMac) {
      const measuredAt = cls.evidence.newestMeasuredAt ?? now;
      const prev = tracks.get(mac) ?? initZoneTrack(measuredAt - 1);
      tracks.set(
        mac,
        updateZoneTrack(prev, {
          ts: measuredAt,
          zona: cls.best?.label ?? null,
          confianca: cls.confidence,
        }),
      );
    }
    const out = new Map<string, ZonePresence>();
    for (const [mac, st] of tracks) {
      if (now - st.ultimaObsTs > PRESENCE_PRUNE_MS) {
        tracks.delete(mac); // tag foi embora de vez — não acumular tracker fantasma
        continue;
      }
      out.set(mac, readZonePresence(st, now));
    }
    setPresenceByMac(out);
  }, [fpz.liveByMac]);

  // ── PRESENÇA NA MESA (área física) — o que o usuário final quer ler: "o operador está na mesa X
  // há N min". É a relação posição publicada ∩ polígono cadastrado (ADR-017: reconhecer a mesa não
  // move a tag), estabilizada pela MESMA histerese da zona (o "rótulo" aqui é o label da área).
  // Observação qualificada = posição publicada com fonte confiável (alta/media) e movimento não
  // incerto; o ts é o da EVIDÊNCIA física (reamostragem de poll não infla a streak — Regra 8).
  // Sessão encerrada (saiu da mesa) fica guardada para o painel dizer "esteve em X por N min". ──
  const areaTrackRef = useRef<Map<string, ZoneTrackState>>(new Map());
  const lastStayRef = useRef<Map<string, LastStay>>(new Map());
  const [areaPresenceByMac, setAreaPresenceByMac] = useState<Map<string, ZonePresence>>(new Map());
  useEffect(() => {
    const now = Date.now();
    const tracks = areaTrackRef.current;
    for (const t of operationalView.tags) {
      const mac = t.mac.toUpperCase();
      const qualificada =
        !!t.pos &&
        t.motionState !== "incerto" &&
        (t.confidence === "alta" || t.confidence === "media");
      const areaLabel = qualificada
        ? (fp.workAreas.find(
            (a) => a.polygon.length >= 3 && isPointInsidePolygon(t.pos!, a.polygon),
          )?.label ?? null)
        : null;
      const ts = t.evidenceTs ?? now;
      const prev = tracks.get(mac) ?? initZoneTrack(ts - 1);
      const next = updateZoneTrack(prev, {
        ts,
        zona: areaLabel,
        confianca: qualificada ? t.confidence : "nenhuma",
      });
      if (prev.confirmada && next.confirmada !== prev.confirmada) {
        // Permanência encerrada: do início confirmado até o começo da sequência que confirmou a saída.
        lastStayRef.current.set(mac, {
          label: prev.confirmada,
          duracaoMs: Math.max(0, next.desde - prev.desde),
          fimTs: now,
        });
      }
      tracks.set(mac, next);
    }
    const out = new Map<string, ZonePresence>();
    for (const [mac, st] of tracks) {
      if (now - st.ultimaObsTs > PRESENCE_PRUNE_MS) {
        tracks.delete(mac);
        continue;
      }
      out.set(mac, readZonePresence(st, now));
    }
    setAreaPresenceByMac(out);
  }, [operationalView, fp.workAreas]);

  // Áreas com OCUPAÇÃO para o mapa operacional: quem tem presença confirmada em cada mesa.
  const occupiedWorkAreas = useMemo<WorkAreaMarker[]>(() => {
    const tagLabel = new Map(operationalView.tags.map((t) => [t.mac.toUpperCase(), t.label] as const));
    const byArea = new Map<string, string[]>();
    for (const [mac, p] of areaPresenceByMac) {
      if (p.estado !== "na-zona" || !p.zona) continue;
      const arr = byArea.get(p.zona) ?? [];
      arr.push(tagLabel.get(mac) ?? mac);
      byArea.set(p.zona, arr);
    }
    return fp.workAreas.map((a) => ({ ...a, ocupantes: byArea.get(a.label) ?? [] }));
  }, [fp.workAreas, areaPresenceByMac, operationalView.tags]);

  // Pontos de treino aparecem SOMENTE na aba de calibração e todos são mostrados. Eles não são
  // áreas nem posições vivas; por isso não entram no mapa operacional e nunca recebem ocupantes.
  const calibrationMarkers = useMemo<ZoneMarker[]>(() => {
    const totals = new Map<string, number>();
    for (const sample of fpz.fingerprints) {
      if (typeof sample.x === "number" && typeof sample.y === "number") {
        totals.set(sample.label, (totals.get(sample.label) ?? 0) + 1);
      }
    }
    const seen = new Map<string, number>();
    return fpz.fingerprints.flatMap((sample) => {
      if (typeof sample.x !== "number" || typeof sample.y !== "number") return [];
      const index = (seen.get(sample.label) ?? 0) + 1;
      seen.set(sample.label, index);
      const total = totals.get(sample.label) ?? 1;
      return [
        {
          label:
            total > 1 ? `${sample.label} · amostra ${index}/${total}` : `${sample.label} · amostra`,
          pos: { x: sample.x, y: sample.y },
          ocupantes: [],
        },
      ];
    });
  }, [fpz.fingerprints]);

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
    if (!(w > 0) || !(h > 0)) {
      setDimError("Informe medidas maiores que zero.");
      return;
    }
    setDimError(null);
    if (w === savedWidthM && h === savedHeightM) return;
    setSaveFeedback(null);
    void saveFloorplan({
      widthM: w,
      heightM: h,
      stations: editor.pos,
      workAreas: fp.workAreas,
    }).then((result) => {
      setSaveFeedback(
        result.ok
          ? { tone: "ok", text: "Dimensões salvas." }
          : { tone: "alert", text: result.error ?? "Não foi possível salvar as dimensões." },
      );
    });
  }, [wStr, hStr, saveFloorplan, savedWidthM, savedHeightM, editor.pos, fp.workAreas]);

  const enterEdit = () => {
    setConfigTab("planta");
    setDimError(null);
    setSaveFeedback(null);
    setEditando(true);
  };

  return (
    <div className="page">
      <PageHeader
        title="Planta BLE"
        subtitle="Posição estimada, zona provável e distância às áreas físicas."
      >
        {canConfigure &&
          (editando ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={fp.saving || !!fpz.capturing}
              onClick={() => {
                areaEditor.cancel();
                setEditando(false);
              }}
            >
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4 lg:overflow-hidden">
        {editando && (
          <div className="flex min-h-5 items-center justify-end text-sec text-text-dim">
            <span
              className={
                saveFeedback?.tone === "alert"
                  ? "ml-auto text-critical"
                  : saveFeedback?.tone === "ok"
                    ? "ml-auto text-ok"
                    : "ml-auto text-text-muted"
              }
              role={saveFeedback?.tone === "alert" ? "alert" : "status"}
              aria-live="polite"
            >
              {fp.saving ? "Salvando…" : (saveFeedback?.text ?? "")}
            </span>
          </div>
        )}

        {editando ? (
          <Tabs
            items={[
              { value: "planta", label: "Planta" },
              { value: "areas", label: "Áreas" },
              { value: "zonas", label: "Calibração BLE" },
            ]}
            value={configTab}
            onValueChange={(value) => {
              if (value !== "areas") areaEditor.cancel();
              setConfigTab(value as ConfigTab);
            }}
            ariaLabel="Configuração da planta BLE"
            className="min-h-0 flex-1"
          >
            <TabsContent value="planta" className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-start gap-3 rounded-sm border border-border bg-panel-2 p-3">
                <Field
                  label="Largura (m)"
                  htmlFor="fp-w"
                  className="w-32"
                  error={
                    dimError && !(parseMeters(wStr) > 0)
                      ? "Use um valor maior que zero."
                      : undefined
                  }
                >
                  <Input
                    id="fp-w"
                    type="number"
                    min="0.1"
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
                <Field
                  label="Comprimento (m)"
                  htmlFor="fp-h"
                  className="w-32"
                  error={
                    dimError && !(parseMeters(hStr) > 0)
                      ? "Use um valor maior que zero."
                      : undefined
                  }
                >
                  <Input
                    id="fp-h"
                    type="number"
                    min="0.1"
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
                <p className="m-0 self-center text-sec text-text-muted">
                  Arraste uma antena no mapa ou faça o ajuste preciso ao lado.
                </p>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
                <FloorplanCanvas
                  view={operationalView}
                  workAreas={fp.workAreas}
                  editing
                  ariaLabel="Planta baixa 2D — edição das antenas Bluetooth"
                  className="relative h-[340px] shrink-0 touch-none overflow-hidden rounded-sm border border-border bg-panel lg:h-auto lg:min-h-[280px] lg:flex-1"
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
                <aside className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:w-80 lg:overflow-y-auto">
                  <div className="rounded-sm border border-border bg-panel-2 p-3">
                    <AntennaTable
                      rows={fp.rows}
                      pos={editor.pos}
                      onSetCoord={editor.setCoord}
                      onPlace={editor.place}
                      onRemove={editor.remove}
                    />
                  </div>
                </aside>
              </div>
            </TabsContent>

            <TabsContent value="areas" className="mt-3 flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
                <FloorplanCanvas
                  view={operationalView}
                  workAreas={areaEditor.areas}
                  polygonEditor={areaEditor.polygonEditor}
                  editing
                  ariaLabel="Planta baixa 2D — edição das áreas físicas"
                  className="relative h-[360px] shrink-0 touch-none overflow-hidden rounded-sm border border-border bg-panel lg:h-auto lg:min-h-[300px] lg:flex-1"
                  containerRef={areaContainerRef}
                  onTransform={(transform) => setAreaTf(transform)}
                  onPointerDown={areaEditor.pointerHandlers.onPointerDown}
                  onPointerMove={areaEditor.pointerHandlers.onPointerMove}
                  onPointerUp={areaEditor.pointerHandlers.onPointerUp}
                  onPointerLeave={areaEditor.pointerHandlers.onPointerUp}
                />
                <aside className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:w-80 lg:overflow-y-auto">
                  <WorkAreaPanel
                    editor={areaEditor}
                    disabled={fp.saving || fpz.capturing !== null}
                  />
                </aside>
              </div>
            </TabsContent>

            <TabsContent value="zonas" className="mt-3 flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
                <FloorplanCanvas
                  view={operationalView}
                  zones={calibrationMarkers}
                  workAreas={fp.workAreas}
                  ariaLabel="Planta baixa 2D — amostras de calibração Bluetooth"
                  className="relative h-[340px] shrink-0 overflow-hidden rounded-sm border border-border bg-panel lg:h-auto lg:min-h-[280px] lg:flex-1"
                />
                <aside className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:w-96 lg:overflow-y-auto">
                  <ZoneCalibration
                    rows={fp.rows}
                    fingerprints={fpz.fingerprints}
                    capturing={fpz.capturing}
                    onCapture={fpz.capture}
                    onRemove={fpz.remove}
                  />
                </aside>
              </div>
            </TabsContent>
          </Tabs>
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
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Antena posicionada SEM SINAL degrada TODAS as posições ao mesmo tempo (o vetor de
                assinatura perde uma dimensão) — avisar torna a deriva coletiva explicável (C2). */}
            {(() => {
              const dead = operationalView.stations.filter((s) => !s.live);
              return dead.length > 0 ? (
                <Alert tone="warn">
                  {dead.length === 1
                    ? `Antena ${dead[0].label} sem sinal — as posições ficam menos precisas até ela voltar.`
                    : `${dead.length} antenas sem sinal (${dead.map((s) => s.label).join(", ")}) — as posições ficam menos precisas até voltarem.`}
                </Alert>
              ) : null;
            })()}
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            <FloorplanCanvas
              view={operationalView}
              workAreas={occupiedWorkAreas}
              ariaLabel="Planta baixa 2D das tags e antenas Bluetooth"
              className="relative h-[340px] shrink-0 overflow-hidden rounded-sm border border-border bg-panel lg:h-auto lg:min-h-[280px] lg:flex-1"
            />
            <aside className="flex shrink-0 flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 lg:min-h-0 lg:w-80 lg:overflow-y-auto">
              <span className="text-sec text-text-dim">Tags ({operationalView.tags.length})</span>
              {fp.workAreas.length === 0 && operationalView.tags.length > 0 && (
                <p className="text-micro text-text-muted">
                  Cadastre as áreas de trabalho (Configurar planta → Áreas) para ver presença e
                  tempo de permanência nas mesas.
                </p>
              )}
              {operationalView.tags.length === 0 ? (
                <p className="text-sec text-text-muted">
                  Nenhuma tag ouvida por uma antena viva no momento.
                </p>
              ) : (
                <ul className="flex flex-col gap-2" aria-label="Tags detectadas">
                  {operationalView.tags.map((t) => {
                    const macKey = t.mac.toUpperCase();
                    const pres =
                      fpz.fingerprints.length > 0 ? presenceByMac.get(macKey) : undefined;
                    const instant = fpz.liveByMac.get(macKey);
                    const agora = Date.now();
                    const nearestArea = t.pos
                      ? fp.workAreas
                          .map((area) => ({
                            area,
                            relation: distanceBandToWorkArea(t.pos!, t.uncertaintyM, area),
                          }))
                          .sort((a, b) => a.relation.distanceM - b.relation.distanceM)[0]
                      : undefined;
                    // ── STATUS PRIMÁRIO = a MESA (área física), a leitura do usuário final:
                    // "está na mesa X há N min". A zona por antena vira diagnóstico. ──
                    const areaPres = areaPresenceByMac.get(macKey);
                    const lastStay = lastStayRef.current.get(macKey);
                    const insideNow =
                      t.pos && nearestArea?.relation.inside ? nearestArea.area : undefined;
                    let tone: "neutral" | "ok" | "info" | "warn" = "neutral";
                    let status: string;
                    if (fp.workAreas.length > 0 && areaPres?.estado === "na-zona") {
                      tone = "ok";
                      status = `Na mesa ${areaPres.zona} · há ${durLabel(agora - areaPres.desde)}`;
                    } else if (areaPres?.estado === "incerto") {
                      tone = "warn";
                      status = areaPres.zona
                        ? `Localização incerta · última mesa: ${areaPres.zona}`
                        : "Localização incerta";
                    } else if (insideNow) {
                      tone = "info";
                      status = `Confirmando mesa ${insideNow.label}…`;
                    } else if (t.pos) {
                      status =
                        fp.workAreas.length > 0
                          ? "Fora das mesas"
                          : "Posição aproximada no mapa";
                    } else {
                      tone = "warn";
                      status = "Sinal insuficiente para localizar";
                    }
                    if (t.motionState === "incerto" && tone !== "warn") tone = "warn";
                    const stayLabel =
                      areaPres?.estado !== "na-zona" && lastStay
                        ? `Esteve na mesa ${lastStay.label} por ${durLabel(lastStay.duracaoMs)} (saiu há ${durLabel(agora - lastStay.fimTs)})`
                        : null;
                    const sourceLabel =
                      t.displaySource === "fingerprint"
                        ? "fingerprint contínuo"
                        : t.displaySource === "multilateration"
                          ? "multilateração validada"
                          : t.displaySource === "two-circle"
                            ? "duas antenas"
                            : "sem X,Y confiável";
                    // Distância só interessa quando FORA (dentro, o status primário já diz a mesa).
                    const distanceLabel =
                      nearestArea && !nearestArea.relation.inside
                        ? `${nearestArea.relation.distanceM.toFixed(1)} m de ${nearestArea.area.label} (faixa ${nearestArea.relation.minDistanceM.toFixed(1)}–${nearestArea.relation.maxDistanceM.toFixed(1)} m)`
                        : null;
                    const rejectionLabel =
                      !t.pos && t.quality === "invalid"
                        ? typeof t.residualM === "number" && typeof t.residualLimitM === "number"
                          ? `Raios incompatíveis: residual ${t.residualM.toFixed(1)} m > limite ${t.residualLimitM.toFixed(1)} m.`
                          : "Geometria das antenas incompatível com uma posição interna."
                        : null;
                    return (
                      <li
                        key={t.mac}
                        className="flex flex-col gap-1.5 rounded-sm border border-border bg-panel px-3 py-2"
                      >
                        <span className="truncate text-body font-medium text-text">{t.label}</span>
                        <span className="flex items-center gap-2 text-sec text-text-dim">
                          <StatusDot tone={tone} label={status} />
                          <span>{status}</span>
                        </span>
                        <span className="text-micro text-text-muted">
                          {stayLabel ??
                            distanceLabel ??
                            (t.pos
                              ? t.displaySource === "none"
                                ? "Última posição conhecida (sem sinal novo)"
                                : "Posição aproximada no mapa"
                              : "Sem posição no mapa")}
                          {t.motionState === "incerto" && t.displaySource !== "none"
                            ? " · sinal instável"
                            : ""}
                        </span>
                        <details className="text-micro text-text-muted">
                          <summary className="cursor-pointer select-none">Diagnóstico BLE</summary>
                          <span className="mt-1 block">
                            {t.pos
                              ? `${sourceLabel} · ${t.motionState} · halo ${t.uncertaintyM.toFixed(1)} m`
                              : sourceLabel}
                          </span>
                          {pres && (
                            <span className="mt-1 block">
                              zona por rádio:{" "}
                              {pres.estado === "na-zona"
                                ? `${pres.zona}`
                                : pres.estado === "incerto"
                                  ? `incerta${pres.zona ? ` (última: ${pres.zona})` : ""}`
                                  : "fora das zonas calibradas"}
                            </span>
                          )}
                          {instant && (
                            <span className="mt-1 block">
                              {instant.evidence.liveStations} antenas · confiança{" "}
                              {instant.confidence}
                              {typeof instant.evidence.newestMeasuredAt === "number"
                                ? ` · idade ${(
                                    Math.max(0, Date.now() - instant.evidence.newestMeasuredAt) /
                                    1000
                                  ).toFixed(1)} s`
                                : ""}
                              {typeof instant.evidence.skewMs === "number"
                                ? ` · janela ${(instant.evidence.skewMs / 1000).toFixed(1)} s`
                                : ""}
                            </span>
                          )}
                          {rejectionLabel && (
                            <span className="mt-1 block text-warn">{rejectionLabel}</span>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
