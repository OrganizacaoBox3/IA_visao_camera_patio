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
import { Alert, Badge, Button, Field, HelpTip, Input, Loading, SegmentedControl } from "../../ui";
import { CORNER_HINT, type CalMode, type CalibrationEditor } from "../useCalibrationEditor";

type Props = {
  cal: CalibrationEditor;
  /** liga o modo no PALCO (exclusivo com zona/polígono/linha/pincel) — fiação no CameraWorkspace */
  onActivate: () => void;
};

export function CalibracaoTab({ cal, onActivate }: Props) {
  const { active, canConfigure, mode, corners } = cal;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Ruler size={16} strokeWidth={1.75} aria-hidden />
        <b className="text-body">Calibração de distância</b>
        <HelpTip label="Como calibrar">
          Marque os 4 CANTOS de um retângulo real no chão (área demarcada, pallet, ladrilhos) em
          ORDEM e informe a Largura (lado 1→2) e o Comprimento (lado 2→3) em metros — a homografia
          sai daí; arraste um canto para ajustar. A grade de conferência (1 m/linha) deve assentar
          no chão.
        </HelpTip>
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
          {!canConfigure && (
            <p className="m-0 text-sec text-text-muted">
              A calibração requer perfil de engenharia. Você pode usar o modo Medir.
            </p>
          )}
          {canConfigure && (
            <>
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
                {corners.length < 4
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
