// Aba "Camadas" do drawer da câmera — preset ativo, toggles de overlay, slider de confiança
// e perfil de detecção (longo alcance). Componente puro: recebe estado/handlers já resolvidos.
import { type Dispatch, type SetStateAction } from "react";
import { RotateCcw } from "lucide-react";
import {
  Badge,
  Button,
  HelpTip,
  SectionTitle,
  Tooltip,
  ToggleRow,
  Field,
  Slider,
  Switch,
  type Tone,
} from "../../ui";
import { type ModeKey, type ModePreset, type OverlayLayers } from "../../config";

type Props = {
  activePresetDef: ModePreset | null;
  activePreset: ModeKey | null;
  presetTone: Tone;
  presetDirty: boolean;
  applyPreset: (mode: ModeKey) => void;
  layers: OverlayLayers;
  setLayers: Dispatch<SetStateAction<OverlayLayers>>;
  conf: number;
  setConf: (n: number) => void;
  canConfigure: boolean;
  longRange: boolean;
  onLongRangeChange: (on: boolean) => void;
};

export function CamadasTab({
  activePresetDef,
  activePreset,
  presetTone,
  presetDirty,
  applyPreset,
  layers,
  setLayers,
  conf,
  setConf,
  canConfigure,
  longRange,
  onLongRangeChange,
}: Props) {
  return (
    <>
      {activePresetDef && activePreset && (
        <div className="preset-card">
          <div className="preset-head">
            {/* heading SEMÂNTICO (<h2>) preservando o visual da classe legada (CSS de página
                unlayered vence a utility do átomo) — as seções deixam de ser <div> mudas. */}
            <SectionTitle flush className="preset-eyebrow">
              Preset ativo
            </SectionTitle>
            <Badge tone={presetTone}>{activePresetDef.label}</Badge>
            {presetDirty && <span className="preset-dirty">· ajustado</span>}
          </div>
          <div className="preset-desc">{activePresetDef.description}</div>
          <div className="preset-metrics">
            {activePresetDef.metrics.map((m) => (
              <span key={m.key} className="preset-metric">
                {m.label}
              </span>
            ))}
          </div>
          {presetDirty && (
            <div className="mt-sp2">
              <Tooltip content="Restaura camadas e confiança do preset deste modo.">
                <Button size="sm" onClick={() => applyPreset(activePreset)}>
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Reaplicar preset
                </Button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
      <SectionTitle>Camadas do overlay</SectionTitle>
      {(
        [
          ["boxes", "Caixas / detecções"],
          ["mask", "Máscara (área pintada)"],
          ["zones", "Zonas (retângulos)"],
          ["heatmap", "Heatmap de ocupação"],
        ] as [keyof OverlayLayers, string][]
      ).map(([k, lbl]) => (
        <ToggleRow
          key={k}
          label={lbl}
          checked={layers[k]}
          onCheckedChange={(v) => setLayers((s) => ({ ...s, [k]: v }))}
        />
      ))}
      <div className="mt-sp3">
        <Field
          label={`Confiança mínima · ${Math.round(conf * 100)}%`}
          hint="Filtra/atenua detecções abaixo do limiar sobre o vídeo (em tempo real)."
        >
          <div className="cfg-slider">
            <span className="ss-end">0</span>
            <Slider
              value={Math.round(conf * 100)}
              min={0}
              max={100}
              step={5}
              onChange={(v) => setConf(v / 100)}
              ariaLabel="Confiança mínima"
            />
            <span className="ss-end">100</span>
          </div>
        </Field>
      </div>
      {/* Jargão de código (APP_CONFIG/MODE_PRESETS) NUNCA renderiza (#7); detalhe vira "?". */}
      <p className="empty-note mt-sp2">
        Ajustes de camadas e confiança valem só nesta sessão.{" "}
        <HelpTip label="Ajuda das camadas">
          Cada modo aplica um preset de camadas e confiança; ajustes manuais sobrepõem o preset até
          fechar a câmera. O heatmap acumula a presença de pessoas.
        </HelpTip>
      </p>

      {/* Perfil de detecção da CÂMERA (persiste no backend) — só engenharia edita. */}
      {canConfigure && (
        <div className="lr-card">
          <SectionTitle>Perfil de detecção</SectionTitle>
          <div className="lr-head">
            <span>
              Longo alcance / Panorâmica{" "}
              <HelpTip label="Ajuda do longo alcance">
                Para câmeras panorâmicas ou de longo alcance (ex.: rua vista de cima): detecta
                objetos pequenos/distantes com mais tiles e limiares menores; usa mais CPU.
              </HelpTip>
            </span>
            <Switch
              checked={longRange}
              onCheckedChange={onLongRangeChange}
              ariaLabel="Longo alcance / Panorâmica"
            />
          </div>
        </div>
      )}
    </>
  );
}
