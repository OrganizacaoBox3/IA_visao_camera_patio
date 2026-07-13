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
import type { FunnelDiagnosis } from "../fusion/useFunnelDiagnosis";

/** Abas do drawer da câmera aberta. "calibracao" entrou na spec-arquitetura-informacao §1 (a rota
 *  /calibracao virou MODO do palco); "porque" entrou com a TELA DO PORQUÊ (bug B8 do laudo de
 *  2026-07-13: o diagnóstico do silêncio existia e não tinha consumidor de UI). */
export type DrawerTab =
  "zonas" | "linhas" | "timeline" | "presenca" | "porque" | "camadas" | "calibracao";

type Props = {
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
  return (
    /* Painel lateral: cor/espaçamento por TOKEN em cine.css (.cam-drawer), não style inline. */
    <aside className="cam-drawer" aria-label="Painel da câmera">
      <Tabs
        className="drawer-tabs"
        value={tab}
        onValueChange={(v) => onTab(v as DrawerTab)}
        ariaLabel="Aba do painel"
        // Contagens em chip compacto (.dt-n, cine.css) p/ as abas caberem em 1 linha — triggers
        // distribuem por flex + rótulos curtos (fix #14: "Presença"→"Pessoas"; valores internos
        // INTACTOS). Nome acessível continua "Zonas N" / "Linhas N".
        items={[
          {
            value: "zonas",
            label: (
              <>
                Zonas <i className="dt-n">{zonas.zones.length}</i>
              </>
            ),
          },
          {
            value: "linhas",
            label: (
              <>
                Linhas <i className="dt-n">{linhas.tripwires.length}</i>
              </>
            ),
          },
          { value: "camadas", label: "Camadas" },
          { value: "timeline", label: "Timeline" },
          { value: "presenca", label: "Pessoas" },
          // A aba do PORQUÊ: quando o sistema não identifica alguém, ele deixa de CALAR e diz qual
          // elo barrou (rádio · movimento · evidência · âncora). O produto não é só acertar.
          { value: "porque", label: "Por quê" },
          // A 6ª aba (spec §1): a calibração deixou de ser uma ROTA e virou o chrome do modo do
          // palco. Visível para TODOS — o operador não calibra, mas MEDE distância aqui.
          { value: "calibracao", label: "Calibrar" },
        ]}
      >
        <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
          <TabsContent value="zonas">
            <ZonasTab {...zonas} />
          </TabsContent>

          <TabsContent value="linhas">
            <LinhasTab {...linhas} />
          </TabsContent>

          <TabsContent value="timeline">
            <TimelineTab timeline={timeline} />
          </TabsContent>

          <TabsContent value="presenca">
            <PresencaTab presence={presence} paused={paused} />
          </TabsContent>

          <TabsContent value="porque">
            <PorQueTab diag={diag} />
          </TabsContent>

          <TabsContent value="calibracao">
            <CalibracaoTab cal={cal} onActivate={onCalibrate} />
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
