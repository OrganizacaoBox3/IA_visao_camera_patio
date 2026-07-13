// ── EXIBIÇÃO — o controle ÚNICO de "o que mostrar sobre o vídeo" (spec-tela-camera §3-C, F3) ───────
// A config-de-exibição vivia PARTIDA em dois lugares — a MESMA natureza em dois sítios, o oposto de
// "tudo num lugar só": os toggles de operação (HUD/Malha/Anéis) na barra de KPIs (rodapé) e os de
// overlay/detecção (Caixas/Máscara/Zonas/Heatmap/Confiança/Preset/Longo alcance) na aba "Camadas" do
// drawer. A F3 os une num POPOVER leve na toolbar do palco (padrão Figma layers / Verkada toggles).
//
// Invariantes:
//  · ADR-007 — a casca fullscreen NÃO vira Dialog; o Popover é NÃO-MODAL (sem scroll-lock que remonte
//    o <canvas>). Ver src/ui/Popover.tsx. O trap de foco manual defere ao Radix enquanto aberto
//    (o pai propaga `open` para o cfgOpenRef via onOpenChange).
//  · ADR-003 — a imagem é soberana: o popover FLUTUA, não empurra o vídeo.
//  · Going-gray — cada toggle carrega o estado em TEXTO + Switch (nunca só-por-cor). "Anéis" nasce
//    DESLIGADO por padrão (dado de conferência, não a vista do cliente): a origem OFF vive no pai
//    (APP_CONFIG.overlay.floorTagsOn) — este componente só reflete.
// JSX PURO: recebe estado/handlers já resolvidos; não toca canvas/rAF/refs.
import { type Dispatch, type SetStateAction } from "react";
import { Layers, RotateCcw } from "lucide-react";
import {
  Badge,
  Button,
  Field,
  HelpTip,
  Popover,
  SectionTitle,
  Slider,
  Switch,
  ToggleRow,
  Tooltip,
} from "../ui";
import { MODE_TONE } from "./tabs/tone";
import { MODE_PRESETS, type ModeKey, type OverlayLayers } from "../config";

// Grupos coesos: a camada só existe quando a fonte existe (calibração · leituras BLE); `floor.on`
// nasce OFF por padrão. `preset.dirty` (ajuste manual sobre o preset) é computado no pai (fonte
// única, junto do badge do header); `def` deriva de `active` aqui.
type LayersProps = {
  hud: boolean;
  setHud: (v: boolean) => void;
  calib: { hasCalibration: boolean; on: boolean; setOn: (v: boolean) => void };
  floor: { available: boolean; on: boolean; setOn: (v: boolean) => void };
  layers: OverlayLayers;
  setLayers: Dispatch<SetStateAction<OverlayLayers>>;
  conf: number;
  setConf: (n: number) => void;
  preset: { active: ModeKey | null; dirty: boolean; apply: (mode: ModeKey) => void };
  canConfigure: boolean;
  longRange: boolean;
  onLongRangeChange: (on: boolean) => void;
};

type Props = LayersProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// A CASCA: o Popover não-modal + o gatilho na toolbar. `open` propaga ao pai (cfgOpenRef). O CORPO
// (ExibicaoLayers) é um componente à parte para ser testável por SSR (o conteúdo do Popover portala,
// então SSR do popover inteiro não o captura — o negativo "os toggles vivem aqui" testa o CORPO).
export function ExibicaoPopover({ open, onOpenChange, ...layers }: Props) {
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Exibição — o que mostrar sobre o vídeo"
      trigger={
        // Gatilho na toolbar: Button com contorno `active` quando aberto (estado nunca só-por-cor —
        // o rótulo "Exibição" é texto visível). NÃO é um Toggle de MODO: abre um painel de config.
        <Button active={open} aria-label="Exibição">
          <Layers size={16} strokeWidth={1.75} aria-hidden /> Exibição
        </Button>
      }
    >
      <ExibicaoLayers {...layers} />
    </Popover>
  );
}

// O CORPO — os toggles/config agrupados por sentido. Exportado p/ o teste de controle negativo (SSR):
// prova que HUD/Malha/Anéis/Caixas/… vivem AQUI (no popover), não numa aba do drawer.
export function ExibicaoLayers({
  hud,
  setHud,
  calib,
  floor,
  layers,
  setLayers,
  conf,
  setConf,
  preset,
  canConfigure,
  longRange,
  onLongRangeChange,
}: LayersProps) {
  const activePresetDef = preset.active ? MODE_PRESETS[preset.active] : null;
  return (
    <>
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
      {/* HUD de telemetria — going-gray: régua de medição, não anormalidade. */}
      <ToggleRow
        label="HUD (telemetria)"
        hint="FPS exibido, ms/frame, pipeline (hub/local), idade do overlay e latência por estágio."
        checked={hud}
        onCheckedChange={setHud}
      />
      {/* Malha da calibração: some quando a câmera nunca foi calibrada. */}
      {calib.hasCalibration && (
        <ToggleRow
          label="Malha da calibração"
          hint="Grade do chão (via homografia) + os pontos cadastrados — confere o posicionamento no piso."
          checked={calib.on}
          onCheckedChange={calib.setOn}
        />
      )}
      {/* Anéis das antenas (BLE): default DESLIGADO; some sem calibração/leituras. O anel é DISTÂNCIA
          (RSSI), não posição. */}
      {floor.available && (
        <ToggleRow
          label="Anéis das antenas"
          hint="Âncoras dos cantos, a estação e um anel tracejado de distância por tag ainda não associada. Desligado por padrão."
          checked={floor.on}
          onCheckedChange={floor.setOn}
        />
      )}

      <div className="mt-sp3">
        <SectionTitle>Detecção</SectionTitle>
        {activePresetDef && preset.active && (
          <div className="preset-head">
            <span className="muted">Preset ativo</span>
            <Badge tone={MODE_TONE[preset.active]}>{activePresetDef.label}</Badge>
            {preset.dirty && <span className="preset-dirty">· ajustado</span>}
          </div>
        )}
        {preset.dirty && preset.active && (
          <div className="mt-sp2">
            <Tooltip content="Restaura camadas e confiança do preset deste modo.">
              <Button size="sm" onClick={() => preset.apply(preset.active!)}>
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Reaplicar preset
              </Button>
            </Tooltip>
          </div>
        )}
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
        <p className="empty-note mt-sp2">
          Ajustes de camadas e confiança valem só nesta sessão.{" "}
          <HelpTip label="Ajuda das camadas">
            Cada modo aplica um preset de camadas e confiança; ajustes manuais sobrepõem o preset
            até fechar a câmera. O heatmap acumula a presença de pessoas.
          </HelpTip>
        </p>
        {/* Perfil de detecção da CÂMERA (persiste no backend) — só engenharia edita. */}
        {canConfigure && (
          <div className="lr-head mt-sp2">
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
        )}
      </div>
    </>
  );
}
