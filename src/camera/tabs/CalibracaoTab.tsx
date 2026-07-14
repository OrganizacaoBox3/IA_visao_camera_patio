// Aba "Calibrar" do drawer da câmera — o CHROME do antigo CalibrationPanel MENOS o palco.
// (spec-arquitetura-informacao §1: "capacidade não é lugar" — calibrar é uma coisa que se faz NA
// câmera; a rota /calibracao morre.)
//
// Componente PURO de apresentação: todo o estado/matemática vive em ../useCalibrationEditor (o
// molde do usePolygonEditor). Aqui só os controles — Radix via src/ui, tipografia pelos 7 papéis
// (text-sec/text-label/text-body…, nunca px cru), cor de estado por token (nunca hex). O painel
// antigo carregava 16 fugas de tipografia catalogadas na baseline do lint-tokens: nascem ZERADAS.
//
// Método (o mesmo de sempre, de mercado): o operador marca os 4 CANTOS de um retângulo real no
// chão, em ordem, e informa Largura×Comprimento. A homografia sai daí, e a GRADE métrica projetada
// de volta no palco diz se a calibração "assenta" no chão. Medir = 2 cliques → metros.
import { Grid3x3, Ruler, Save, Undo2 } from "lucide-react";
import { Alert, Badge, Button, Field, Input, Loading, SegmentedControl } from "../../ui";
import { StationHealthChip } from "../../fusion/StationHealthChip";
import { TagPicker } from "../TagPicker";
import { takenTags } from "../takenTags";
import {
  CORNER_HINT,
  type CalMode,
  type CalStep,
  type CalibrationEditor,
} from "../useCalibrationEditor";

type Props = {
  cal: CalibrationEditor;
  /** liga o modo no PALCO (exclusivo com zona/polígono/linha/pincel) — fiação no CameraWorkspace */
  onActivate: () => void;
};

export function CalibracaoTab({ cal, onActivate }: Props) {
  const {
    active,
    canConfigure,
    mode,
    calStep,
    corners,
    cornerMacs,
    anchorCorner,
    refTag,
    sel,
    selPx,
    stations,
    stationIds,
    principalId,
    nameOf,
    labelOf,
  } = cal;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Ruler size={16} strokeWidth={1.75} aria-hidden />
        <b className="text-body">Calibração de distância</b>
        {cal.savedH && <Badge tone="ok">calibrada</Badge>}
      </div>

      {/* O painel é legível sempre; o PALCO só aceita clique com o modo ligado. Sem estado
          escondido: quem não ligou pelo botão da barra liga por aqui. */}
      {!active && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sec text-text-muted">
            O modo está desligado — os cliques no palco desenham zonas. Ative para marcar os pontos
            sobre o vídeo.
          </p>
          <div>
            <Button size="sm" variant="primary" onClick={onActivate}>
              <Ruler size={14} strokeWidth={1.75} aria-hidden /> Ativar modo Calibrar
            </Button>
          </div>
        </div>
      )}

      <SegmentedControl<CalMode>
        value={mode}
        onChange={cal.setMode}
        ariaLabel="Modo da calibração"
        options={[
          { value: "calibrar", label: "Calibrar" },
          { value: "medir", label: "Medir" },
        ]}
      />

      {mode === "calibrar" ? (
        <>
          <p className="m-0 text-sec text-text-muted">
            {canConfigure
              ? "Escolha um RETÂNGULO no chão (área demarcada, pallet, ladrilhos) e clique os 4 cantos EM ORDEM — arraste um canto para ajustar. Depois informe a Largura (lado 1→2) e o Comprimento (lado 2→3) em metros."
              : "A calibração requer perfil de engenharia. Você pode usar o modo Medir."}
          </p>
          {canConfigure && (
            <>
              <SegmentedControl<CalStep>
                value={calStep}
                onChange={cal.setCalStep}
                ariaLabel="O que marcar no chão"
                options={[
                  { value: "cantos", label: "Cantos" },
                  { value: "ancoras", label: "Âncoras" },
                  { value: "estacao", label: "Estação BLE" },
                  { value: "referencia", label: "Tag de referência" },
                ]}
              />
              {/* htmlFor/id: o painel ANTIGO não ligava o <label> ao <input> — os dois campos que
                  DEFINEM a escala do mundo (L×C) não tinham nome acessível. Passava despercebido
                  porque a rota /calibracao estava FORA do gate de axe; aqui dentro da câmera ela
                  está DENTRO (a11y é contrato, regra 15). Corrigido na mudança de lugar. */}
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Largura 1→2 (m)" htmlFor="cal-largura" className="w-32">
                  <Input
                    id="cal-largura"
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={cal.width}
                    onChange={(ev) => cal.setWidth(ev.target.value)}
                  />
                </Field>
                <Field label="Comprimento 2→3 (m)" htmlFor="cal-comprimento" className="w-36">
                  <Input
                    id="cal-comprimento"
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={cal.length}
                    onChange={(ev) => cal.setLength(ev.target.value)}
                  />
                </Field>
              </div>
              <span className="text-sec text-text-muted">
                {calStep === "estacao"
                  ? selPx
                    ? `${sel ? nameOf(sel) : "Estação"} marcada — arraste para ajustar`
                    : `Clique no chão onde fica ${sel ? `a estação ${nameOf(sel)}` : "a estação BLE"}`
                  : calStep === "referencia"
                    ? refTag?.px
                      ? "Tag de referência marcada — arraste para ajustar"
                      : "Escolha a tag na lista e clique no chão onde ela está fixada"
                    : corners.length < 4
                      ? `Clique o canto ${CORNER_HINT[corners.length]}`
                      : "4 cantos marcados"}
              </span>
              {corners.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={cal.undoCorner}>
                    <Undo2 size={14} strokeWidth={1.75} aria-hidden /> Desfazer
                  </Button>
                  <Button size="sm" variant="ghost" onClick={cal.resetCorners}>
                    Refazer
                  </Button>
                </div>
              )}
            </>
          )}

          {canConfigure && calStep === "estacao" && (
            <div className="flex flex-col gap-2">
              {/* N estações (multi-antena): escolha a estação e clique no chão onde ela está. Sem
                  estações no registro (nenhuma postou ainda) o passo segue como sempre — um ponto
                  único, o da principal. A estação NASCE por auto-descoberta no hub. */}
              {stationIds.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sec text-text-muted">Estação:</span>
                    {/* O botão é o NOME ("Doca 3"); o id técnico vira dica (title) — quem precisa
                        dele é o suporte, não o operador que marca o ponto no chão. */}
                    {stationIds.map((id) => (
                      <Button
                        key={id}
                        size="sm"
                        variant={sel === id ? "primary" : "ghost"}
                        aria-pressed={sel === id}
                        title={`id técnico: ${id}`}
                        onClick={() => cal.setSelStation(id)}
                      >
                        {nameOf(id)}
                        {stations[id] ? " ·" : ""}
                        {id === principalId ? " principal" : ""}
                      </Button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {sel && stations[sel] && sel !== principalId && (
                      <Button size="sm" variant="ghost" onClick={() => cal.makePrincipal(sel)}>
                        Definir {nameOf(sel)} como principal
                      </Button>
                    )}
                    {sel && stations[sel] && (
                      <Button size="sm" variant="ghost" onClick={() => cal.clearStationPoint(sel)}>
                        Remover ponto
                      </Button>
                    )}
                    <span className="text-sec text-text-muted">
                      {Object.keys(stations).length} de {stationIds.length} estação(ões) com ponto
                      marcado. A principal é a referência de distância quando só ela está calibrada.
                    </span>
                  </div>
                </>
              )}
              {/*
               * Dica de instalação (going-gray, sem alarme): MEDIDO no harness de replay que estação
               * JUNTO da câmera vs. distante vale +27 pontos de precisão (71,8% vs 44,5%) — ver
               * docs/cientifica/harness-associacao-indoor.md. Isso vale para o modo SEM homografia
               * calibrada; com a câmera calibrada, o ganho vem de marcar o ponto certo da estação
               * acima. Por isso o texto não generaliza.
               */}
              <Alert tone="info">
                Sempre que possível, fixe a estação BLE bem perto da câmera. Isso ajuda o sistema a
                reconhecer quem é quem enquanto esta câmera ainda não estiver calibrada.
              </Alert>
              {/* Guia de geometria da instalação: AVISO, nunca bloqueio (o save segue liberado). */}
              {cal.geomHints.map((h) => (
                <Alert key={h.code} tone="info">
                  {h.text}
                </Alert>
              ))}
            </div>
          )}

          {canConfigure && calStep === "referencia" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sec text-text-muted">Tags visíveis agora:</span>
                {/* 1 chip por estação viva; com uma só, o rótulo da fonte é omitido. O nome vem do
                    CADASTRO (labelOf → "Doca 3"); estação fora do registro degrada para o id. */}
                {cal.stationsHealth.map((s) => (
                  <StationHealthChip
                    key={s.stationId || "estacao"}
                    health={s}
                    station={
                      cal.stationsHealth.length > 1 && s.stationId
                        ? labelOf(s.stationId)
                        : undefined
                    }
                  />
                ))}
              </div>
              <TagPicker
                readings={cal.btReadings}
                selectedMac={refTag?.mac ?? null}
                onPick={cal.pickRefTag}
                taken={takenTags(cornerMacs, refTag?.mac ?? null, { step: "referencia" })}
              />
            </div>
          )}

          {canConfigure && calStep === "ancoras" && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sec text-text-muted">
                Associe uma tag BLE ÂNCORA (posição conhecida) a cada canto: selecione o canto,
                depois escolha a tag na lista abaixo.
              </p>
              {corners.length < 4 ? (
                <span className="text-sec text-text-muted">
                  Marque os 4 cantos primeiro (passo Cantos).
                </span>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sec text-text-muted">Canto:</span>
                    {corners.map((_, i) => (
                      <Button
                        key={`ac${i}`}
                        size="sm"
                        variant={anchorCorner === i ? "primary" : "ghost"}
                        aria-pressed={anchorCorner === i}
                        onClick={() => cal.setAnchorCorner(i)}
                      >
                        {i + 1}
                        {cornerMacs[i] ? ` · ${cal.macName(cornerMacs[i])}` : ""}
                      </Button>
                    ))}
                  </div>
                  <span className="text-sec text-text-muted">
                    Tag-âncora para o canto {anchorCorner + 1}:
                  </span>
                  <TagPicker
                    readings={cal.btReadings}
                    selectedMac={cornerMacs[anchorCorner] || null}
                    onPick={(mac) => cal.setCornerMac(anchorCorner, mac)}
                    taken={takenTags(cornerMacs, refTag?.mac ?? null, {
                      step: "ancoras",
                      corner: anchorCorner,
                    })}
                    leading={
                      cornerMacs[anchorCorner] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cal.setCornerMac(anchorCorner, "")}
                        >
                          Sem âncora
                        </Button>
                      ) : null
                    }
                  />
                </>
              )}
            </div>
          )}

          {/* Legenda da grade de conferência (só quando ela está em tela). */}
          {cal.grid && (
            <span className="inline-flex items-center gap-1 text-label text-text-muted">
              <Grid3x3 size={12} strokeWidth={1.75} aria-hidden /> Grade de conferência:{" "}
              {cal.grid.step} m por linha — deve assentar no chão.
            </span>
          )}

          {/* Estado da homografia + salvar. */}
          <div className="flex flex-col gap-2">
            {cal.loading && <Loading label="Carregando" />}
            {cal.liveH && !cal.liveH.ok && <Alert tone="warn">{cal.liveH.error}</Alert>}
            {cal.err && <Alert tone="alert">{cal.err}</Alert>}
            {cal.note && <Alert tone="ok">{cal.note}</Alert>}
            {canConfigure && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" disabled={!cal.canSave} onClick={cal.save}>
                  <Save size={14} strokeWidth={1.75} aria-hidden />{" "}
                  {cal.saving ? "Salvando…" : "Salvar calibração"}
                </Button>
                {corners.length < 4 && (
                  <span className="text-sec text-text-muted">
                    Faltam {4 - corners.length} canto(s).
                  </span>
                )}
                {corners.length === 4 && !cal.dimsOk && (
                  <span className="text-sec text-text-muted">
                    Informe Largura e Comprimento (&gt; 0).
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-sec text-text-muted">
            {cal.savedH || cal.liveH?.ok
              ? "Clique em 2 pontos do chão para medir a distância real entre eles — arraste para ajustar."
              : "Calibre a câmera primeiro (retângulo do chão) para poder medir em metros."}
          </p>
          {/* "A imagem é soberana" (ADR-003): o NÚMERO vive aqui no painel, nunca sobre o vídeo. */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-body">
              {cal.distance != null ? (
                <>
                  Distância: <b>{cal.distance.toFixed(2)} m</b>
                </>
              ) : (
                <span className="text-text-muted">Clique 2 pontos para medir.</span>
              )}
            </div>
            {cal.measurePts.length > 0 && (
              <Button size="sm" variant="ghost" onClick={cal.clearMeasure}>
                Limpar
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
