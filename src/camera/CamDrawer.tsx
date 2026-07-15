// PAINEL LATERAL da câmera aberta (o "chrome" do palco) — JSX PURO: as abas + o roteamento de cada
// uma para o seu componente. Nenhum canvas/rAF/ref de desenho vive aqui (ADR-007 intacta: a casca
// fullscreen NÃO vira Dialog e o <canvas> não é remontado por nada disto).
//
// POR QUE EXISTE (ratchet de tamanho, 4ª vez): a aba "Por quê" precisava entrar no CameraWorkspace,
// que estava a 4 linhas do teto (1686/1690). Em vez de SUBIR o teto, saiu uma responsabilidade — a
// mesma receita do CamHeader/CineBar/CamKpiBar. O god-file volta a cuidar só do PALCO (frames,
// rAF, editores); o painel — que é 100% apresentação — passa a ter dono próprio.
//
// F2 (spec-tela-camera-arquitetura §3-B) — O PAINEL DE OBSERVAÇÃO: Pessoas · Por quê · Timeline são
// a MESMA natureza (só-leitura, a vista diária do operador; ADR-003: observação no painel, nunca
// sobre o vídeo). Viram SUB-ABAS de um painel único (decisão do dono: sub-abas, não empilhado).
//
// F3 (spec §3-C) — A ABA "CAMADAS" SAIU. Ela era config-de-exibição (natureza DIFERENTE da
// observação) e foi consolidada, junto com os toggles da barra de KPIs, no popover "Exibição" da
// toolbar (./ExibicaoPopover). Sem ela, o nível de cima "Observação × Camadas" que a F2 deixou
// provisório SOME: sem modo de edição ativo, o drawer mostra DIRETO as sub-abas de observação.
import { Tabs, TabsContent, ScrollArea } from "../ui";
import { ZonasTab } from "./tabs/ZonasTab";
import { LinhasTab } from "./tabs/LinhasTab";
import { TimelineTab, type TimelineItem } from "./tabs/TimelineTab";
import { PresencaTab } from "./tabs/PresencaTab";
import { CalibracaoTab } from "./tabs/CalibracaoTab";
import { PorQueTab } from "./tabs/PorQueTab";
import { Vista2DTab } from "./tabs/Vista2DTab";
import type { ComponentProps } from "react";
import type { CalibrationEditor } from "./useCalibrationEditor";
import type { StageMode } from "./useStageModes";
import type { FunnelDiagnosis } from "../fusion/useFunnelDiagnosis";

/** Seções de OBSERVAÇÃO do drawer (só-leitura), sub-abas de um painel único. Zona/Linha/Calibrar NÃO
 *  são abas: são MODOS do palco (spec §3-A) — entra-se por toggle no CamHeader, e o painel vira O
 *  painel contextual daquele modo (ramo `mode` abaixo). Config-de-exibição vive no popover "Exibição"
 *  (spec §3-C), não aqui. */
export type DrawerTab = "timeline" | "presenca" | "porque" | "vista2d";

type Props = {
  /** Modo de edição ARMADO no palco (activeStageMode) — governa QUAL painel contextual mostrar;
   *  `null` = nenhum modo → o painel de observação. */
  mode: StageMode;
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  /** Id da câmera — a aba "Vista 2D" carrega a própria calibração/BLE por ele. */
  cameraId: string;
  zonas: ComponentProps<typeof ZonasTab>;
  linhas: ComponentProps<typeof LinhasTab>;
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
  cameraId,
  zonas,
  linhas,
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

  // Sem modo de edição: o PAINEL DE OBSERVAÇÃO direto (sub-abas leves, só-leitura). Convive com o
  // vídeo (ADR-003). O flex/min-h-0 deixam o ScrollArea interno crescer dentro do painel.
  return (
    /* Painel lateral: cor/espaçamento por TOKEN em cine.css (.cam-drawer), não style inline. */
    <aside className="cam-drawer" aria-label="Painel da câmera">
      <Tabs
        className="drawer-tabs drawer-subtabs flex min-h-0 flex-1 flex-col"
        value={tab}
        onValueChange={(v) => onTab(v as DrawerTab)}
        ariaLabel="Seção de observação"
        items={[
          { value: "presenca", label: "Pessoas" },
          // A seção do PORQUÊ: quando o sistema não identifica alguém, ele deixa de CALAR e diz
          // qual elo barrou (rádio · movimento · evidência · âncora). O produto não é só acertar.
          { value: "porque", label: "Por quê" },
          { value: "timeline", label: "Timeline" },
          // Vista superior 2D (top-down) do chão + beacons — para o teste só-Bluetooth, sem câmera.
          { value: "vista2d", label: "Vista 2D" },
        ]}
      >
        <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
          <TabsContent value="presenca">
            <PresencaTab presence={presence} paused={paused} />
          </TabsContent>

          <TabsContent value="porque">
            <PorQueTab diag={diag} />
          </TabsContent>

          <TabsContent value="timeline">
            <TimelineTab timeline={timeline} />
          </TabsContent>

          <TabsContent value="vista2d">
            <Vista2DTab cameraId={cameraId} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}
