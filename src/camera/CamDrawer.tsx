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
// sobre o vídeo). Antes competiam como abas irmãs de Camadas — que é natureza DIFERENTE
// (config-de-exibição). Agora as 3 de observação viram SUB-ABAS de um painel único (decisão do dono:
// sub-abas, não empilhado em rolagem), e Camadas fica como aba À PARTE no nível de cima (a F3 a
// levará para um popover na toolbar — spec §3-C; por ora segue aqui). O nível de cima é
// Observação × Camadas; dentro de Observação, as 3 seções.
import { useRef } from "react";
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

/** Seções do drawer (só-leitura). As 3 de OBSERVAÇÃO (presenca/porque/timeline) são sub-abas de um
 *  painel único; "camadas" é a aba de config-de-exibição à parte (F2). Zona/Linha/Calibrar NÃO são
 *  abas: são MODOS do palco (spec §3-A) — entra-se por toggle no CamHeader, e o painel vira O painel
 *  contextual daquele modo (ramo `mode` abaixo). Fim da duplicação header×aba. */
export type DrawerTab = "timeline" | "presenca" | "porque" | "camadas";

type Props = {
  /** Modo de edição ARMADO no palco (activeStageMode) — governa QUAL painel contextual mostrar;
   *  `null` = nenhum modo → o painel de observação + Camadas. */
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
  // Última sub-aba de OBSERVAÇÃO visitada — p/ restaurar a posição ao voltar de Camadas (sair de
  // Camadas não deve jogar o operador de volta em "Pessoas" à força). Ref: derivação de render, não
  // dispara re-render; o estado da seção segue vivendo no `tab` (fonte única em CameraWorkspace).
  const lastObsRef = useRef<DrawerTab>("presenca");
  if (tab !== "camadas") lastObsRef.current = tab;

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

  // Nível de cima: Observação (as 3 sub-abas) × Camadas (config-de-exibição à parte). Uma seção de
  // observação ativa → o topo mostra "Observação"; "Camadas" → só quando `tab === "camadas"`.
  const topValue = tab === "camadas" ? "camadas" : "observacao";
  const obsValue: DrawerTab = tab === "camadas" ? lastObsRef.current : tab;

  return (
    /* Painel lateral: cor/espaçamento por TOKEN em cine.css (.cam-drawer), não style inline. */
    <aside className="cam-drawer" aria-label="Painel da câmera">
      <Tabs
        className="drawer-tabs"
        value={topValue}
        // "Observação" restaura a última seção visitada; "Camadas" é a aba à parte.
        onValueChange={(v) => onTab(v === "camadas" ? "camadas" : lastObsRef.current)}
        ariaLabel="Aba do painel"
        items={[
          { value: "observacao", label: "Observação" },
          { value: "camadas", label: "Camadas" },
        ]}
      >
        {/* PAINEL DE OBSERVAÇÃO: superfície única, só-leitura, com sub-abas leves. Convive com o
            vídeo e com qualquer modo de edição (ADR-003). O flex/min-h-0 deixam o ScrollArea interno
            crescer dentro do TabsContent (o painel do drawer é flex column de altura definida). */}
        <TabsContent value="observacao" className="flex min-h-0 flex-1 flex-col">
          <Tabs
            className="drawer-tabs drawer-subtabs flex-1"
            value={obsValue}
            onValueChange={(v) => onTab(v as DrawerTab)}
            ariaLabel="Seção de observação"
            items={[
              { value: "presenca", label: "Pessoas" },
              // A seção do PORQUÊ: quando o sistema não identifica alguém, ele deixa de CALAR e diz
              // qual elo barrou (rádio · movimento · evidência · âncora). O produto não é só acertar.
              { value: "porque", label: "Por quê" },
              { value: "timeline", label: "Timeline" },
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
            </ScrollArea>
          </Tabs>
        </TabsContent>

        <TabsContent value="camadas" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
            <CamadasTab
              {...camadas}
              presetTone={camadas.activePreset ? MODE_TONE[camadas.activePreset] : "info"}
            />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
