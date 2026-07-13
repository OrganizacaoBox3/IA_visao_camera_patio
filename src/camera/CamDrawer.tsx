// PAINEL LATERAL da câmera aberta (o "chrome" do palco) — JSX PURO: as abas + o roteamento de cada
// uma para o seu componente. Nenhum canvas/rAF/ref de desenho vive aqui (ADR-007 intacta: a casca
// fullscreen NÃO vira Dialog e o <canvas> não é remontado por nada disto).
//
// POR QUE EXISTE (ratchet de tamanho, 4ª vez): a aba "Por quê" precisava entrar no CameraWorkspace,
// que estava a 4 linhas do teto (1686/1690). Em vez de SUBIR o teto, saiu uma responsabilidade — a
// mesma receita do CamHeader/CineBar/CamKpiBar. O god-file volta a cuidar só do PALCO (frames,
// rAF, editores); o painel — que é 100% apresentação — passa a ter dono próprio.
import { Tabs, TabsContent, ScrollArea } from "../ui";
import { MODE_TONE } from "./tabs/tone";
import { ZonasTab } from "./tabs/ZonasTab";
import { LinhasTab } from "./tabs/LinhasTab";
import { CamadasTab } from "./tabs/CamadasTab";
import { TimelineTab, type TimelineItem } from "./tabs/TimelineTab";
import { PresencaTab } from "./tabs/PresencaTab";
import { CalibracaoTab } from "./tabs/CalibracaoTab";
import { PorQueTab } from "./tabs/PorQueTab";
import type { ComponentProps } from "react";
import type { CalibrationEditor } from "./useCalibrationEditor";
import type { StageMode } from "./useStageModes";
import type { FunnelDiagnosis } from "../fusion/useFunnelDiagnosis";

/** Abas de OBSERVAÇÃO do drawer (só-leitura, convivem com o vídeo). Zona/Linha/Calibrar NÃO são
 *  abas: são MODOS do palco (spec-tela-camera-arquitetura §3-A) — entra-se por toggle no CamHeader,
 *  e o painel vira O painel contextual daquele modo (ramo `mode` abaixo), não uma aba espremida no
 *  meio. Fim da duplicação header×aba. "porque" entrou com a TELA DO PORQUÊ (bug B8 do laudo de
 *  2026-07-13: o diagnóstico do silêncio existia e não tinha consumidor de UI). A fusão destas 4
 *  numa superfície única é a F2 — POR ORA seguem como abas. */
export type DrawerTab = "timeline" | "presenca" | "porque" | "camadas";

type Props = {
  /** Modo de edição ARMADO no palco (activeStageMode) — governa QUAL painel contextual mostrar;
   *  `null` = nenhum modo → as abas de observação. */
  mode: StageMode;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  zonas: ComponentProps<typeof ZonasTab>;
  linhas: ComponentProps<typeof LinhasTab>;
  camadas: Omit<ComponentProps<typeof CamadasTab>, "presetTone">;
  timeline: TimelineItem[];
  presence: { now: number; peak: number; dwell: number };
  paused: boolean;
  cal: CalibrationEditor;
  onCalibrate: () => void;
  /** Diagnóstico do funil (fusion/useFunnelDiagnosis) — por que a pessoa em cena não virou nome. */
  diag: FunnelDiagnosis;
};

export function CamDrawer({
  mode,
  tab,
  onTab,
  zonas,
  linhas,
  camadas,
  timeline,
  presence,
  paused,
  cal,
  onCalibrate,
  diag,
}: Props) {
  // MODO ATIVO → o painel INTEIRO se reconfigura (spec §3-A, o molde do Calibrar GENERALIZADO): UM
  // mecanismo escolhe o painel contextual do modo armado — Calibrar → passo-a-passo · Área → zonas
  // · Linha → linhas —, não três `if` especiais. Sair do modo (ESC/toggle) volta às abas. É o
  // padrão do mercado (Figma Dev Mode troca o painel inteiro, Milestone Setup substitui a operação):
  // não misturar os vocabulários de dois modos ao mesmo tempo (NN/g).
  if (mode) {
    const ctx =
      mode === "calibrar"
        ? { aria: "calibração", body: <CalibracaoTab cal={cal} onActivate={onCalibrate} /> }
        : mode === "area"
          ? { aria: "zonas", body: <ZonasTab {...zonas} /> }
          : { aria: "linhas", body: <LinhasTab {...linhas} /> };
    return (
      <aside className="cam-drawer" aria-label={`Painel da câmera — ${ctx.aria}`}>
        <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
          {ctx.body}
        </ScrollArea>
      </aside>
    );
  }

  return (
    /* Painel lateral: cor/espaçamento por TOKEN em cine.css (.cam-drawer), não style inline. */
    <aside className="cam-drawer" aria-label="Painel da câmera">
      <Tabs
        className="drawer-tabs"
        value={tab}
        onValueChange={(v) => onTab(v as DrawerTab)}
        ariaLabel="Aba do painel"
        // Só as abas de OBSERVAÇÃO — Zona/Linha/Calibrar saíram (viraram modos do palco; ramo `mode`
        // acima). Rótulos curtos distribuídos por flex (fix #14: "Presença"→"Pessoas").
        items={[
          { value: "camadas", label: "Camadas" },
          { value: "timeline", label: "Timeline" },
          { value: "presenca", label: "Pessoas" },
          // A aba do PORQUÊ: quando o sistema não identifica alguém, ele deixa de CALAR e diz qual
          // elo barrou (rádio · movimento · evidência · âncora). O produto não é só acertar.
          { value: "porque", label: "Por quê" },
        ]}
      >
        <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
          <TabsContent value="timeline">
            <TimelineTab timeline={timeline} />
          </TabsContent>

          <TabsContent value="presenca">
            <PresencaTab presence={presence} paused={paused} />
          </TabsContent>

          <TabsContent value="porque">
            <PorQueTab diag={diag} />
          </TabsContent>

          <TabsContent value="camadas">
            <CamadasTab
              {...camadas}
              presetTone={camadas.activePreset ? MODE_TONE[camadas.activePreset] : "info"}
            />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}
