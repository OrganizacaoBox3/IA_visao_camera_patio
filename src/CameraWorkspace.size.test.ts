// CameraWorkspace.size.test.ts — RATCHET anti-reengorda do god-component.
//
// POR QUÊ: o retrofit-2 declarou o teto ≤1850, mas o arquivo reengordou 1822→1889 SEM
// nenhum sensor que barrasse (auditoria docs/analises/saude/01-auditoria-doutrina-2026-07.md).
// A meta virou TEXTO, não gate. Este teste é o BACKSTOP: crescer vira uma DECISÃO
// consciente (o teste fica vermelho; subir o teto exige justificativa + nota de residual
// no PR), não uma deriva silenciosa.
//
// HONESTIDADE (lição 06.2): o anti-reengorda REAL não é meta de linhas — é fronteira de
// módulo com dono+teste.
//
// RESIDUAL RESOLVIDO (2026-07-13, spec-arquitetura-informacao §1): o residual acima dizia que os
// handlers de ponteiro NÃO eram seam limpo porque MULTIPLEXAVAM 3 editores. A calibração-como-modo
// forçou a questão (o 5º editor não cabia nos 3 de folga) e mostrou que o multiplexador ERA a
// unidade: ./camera/useStageModes.ts tem UMA responsabilidade — traduzir o ponteiro do palco para o
// editor ativo, na ORDEM certa — e essa ordem virou função PURA com teste (stageTarget), porque é
// nela que mora o RBAC (o operador MEDE distância; não desenha zona). Os editores com dono próprio
// (linha/polígono/calibração) são delegados; o rascunho do retângulo e o pincel, que não tinham
// dono, passaram a ter. O que continua sem seam limpo: zones/zonesRef/setZones (render + pipeline +
// summary) e removeZone (toca os holders de processamento) — esses seguem no god-file, declarados.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// APERTADO na varredura F3 (UI dos consoles), 2000 → 1760: o ratchet fez o que devia — o diff
// PRECISAVA crescer (o modo POLÍGONO não tinha nenhum botão: usePolygonEditor existia com
// start/undo/close SEM consumidor, inalcançável por mouse ou teclado) e, em vez de subir o teto,
// a barra de ferramentas saiu do god-component. Extraídos 3 subcomponentes de JSX PURO — nenhum
// deles ancestral do <canvas>, nenhum toca rAF/refs (ADR-007 intacta):
//   ./camera/CamHeader.tsx  — identidade + ferramentas do palco (zona · polígono · linha · cine)
//   ./camera/CineBar.tsx    — controles da revisão (cine-loop)
//   ./camera/CamKpiBar.tsx  — barra de KPIs do rodapé ("a imagem é soberana": número no painel)
// Contabilidade REAL (método deste teste, que conta linhas vazias): 1994 → 1762 (teto 1765
// mantém a folga mínima da convenção, ≈3). NÃO medir com `Measure-Object -Line`.
//
// APERTADO de novo na CALIBRAÇÃO-COMO-MODO (jul/13), 1765 → 1725: o ratchet fez o que devia pela
// SEGUNDA vez. O diff PRECISAVA crescer (a rota /calibracao morre e vira o 5º modo do palco: hook +
// aba + camada SVG) e havia 3 linhas de folga. Em vez de subir o teto, saiu uma responsabilidade:
//   ./camera/useStageModes.ts — o multiplexador de PONTEIRO do palco (+ rascunho do retângulo e
//   pincel, que não tinham dono) e a ordem de precedência dos modos, PURA e testada (stageTarget).
// Contabilidade REAL (método deste teste, que conta linhas vazias): 1762 → 1722 — a fiação da
// calibração ENTROU e o arquivo ainda ENCOLHEU 40 linhas. NÃO medir com `Measure-Object -Line`.
//
// APERTADO de novo na ZONA UNIFICADA (jul/13), 1725 → 1690: a 3ª vez, e a mais barata — não foi
// extração, foi PODA. A spec-zona-unificada mostrou que o palco carregava TRÊS primitivas de zona
// (retângulo · pincel · polígono) quando sempre houve UMA (`points` — um retângulo é um polígono de
// 4 vértices). Saíram do god-file o estado do PINCEL (paintZoneId/startPaint/clearActive/paintZone),
// o toggleDrawMode e a grade de pintura; ENTROU o editor de verdade (mover a forma · inserir vértice
// pelo midpoint · remover por Delete/Alt+clique · aviso de auto-interseção), todo ele em
// ./camera/usePolygonEditor + ./camera/draw. Contabilidade REAL (método deste teste, que conta
// linhas vazias): 1722 → 1687 — o EDITOR que faltava entrou e o arquivo ainda ENCOLHEU 35 linhas.
// NÃO medir com `Measure-Object -Line`.
//
// APERTADO de novo na EXIBIÇÃO-COMO-POPOVER (F3, spec-tela-camera §3-C, jul/13), 1690 → 1689: a
// config-de-exibição estava PARTIDA em dois lugares (toggles HUD/Malha/Anéis na barra de KPIs +
// Caixas/Máscara/Zonas/Heatmap/Confiança/Preset/Longo alcance na aba "Camadas"). A F3 os consolidou
// num POPOVER único na toolbar (./camera/ExibicaoPopover + o wrapper ./ui/Popover), a aba "Camadas"
// (e o CamadasTab.tsx, DELETADO) saiu do drawer, e o nível "Observação × Camadas" sumiu (o drawer
// mostra as sub-abas de observação direto). O god-file é quase NEUTRO por natureza (consolidar MOVE
// os mesmos props de dois sítios para um), mas ainda ENCOLHEU 1 linha — quem encolheu de verdade foi
// CamKpiBar/CamDrawer + o arquivo extinto. NÃO medir com `Measure-Object -Line`.
//
// Teto ATUAL (não-ideal). BAIXE ao extrair uma responsabilidade; SUBIR exige justificativa.
// 1910→1920 (jul/09): rótulo da TAG BLE na câmera ABERTA (identidade aumentada, caminho C). O GROSSO
// (carga da homografia + fusão tag↔pessoa) foi EXTRAÍDO p/ src/fusion/useCameraTagLabels.ts — aqui
// sobrou só a fiação mínima (prop getReadings + 1 chamada de hook + o labelFor no drawTracks).
// 1920→1950 (jul/09): toggle "malha da calibração" (grade do chão via homografia + pontos cadastrados)
// na câmera ABERTA. O GROSSO (carga da calibração + estado/ref do toggle) foi EXTRAÍDO p/
// src/camera/useCalibrationOverlay.ts; aqui sobrou a fiação (1 hook + 1 draw call + o Toggle no rodapé).
// 1950→1960 (jul/10): sync AO VIVO da calibração (fix de staleness — H/station não atualizavam até
// remontar). O GROSSO (rev por câmera no socket + re-fetch) vive em useDashboardSocket/
// useCameraTagLabels; aqui entrou SÓ a fiação da prop `calibrationRev` (doc + destructure + 1 arg).
// 1960→2000 (jul/10): TAGS NO CHÃO na câmera aberta (âncoras exatas + estação + anéis de distância
// BLE). O GROSSO foi EXTRAÍDO: dados/EMA/derivação em src/fusion/useFloorTags.ts (puro testado) e o
// desenho em camera/draw.ts (drawFloorTags, folha); aqui sobrou fiação (1 hook + setter único do
// toggle default-ON + 1 draw call no rAF + 1 Toggle "Tags" no rodapé, mesmo idioma da "Malha").
// Contabilidade REAL (método deste teste, que conta linhas vazias): 1952 → 1995; teto 2000 mantém
// a folga mínima da convenção (≈5, como 1952/1960). NÃO medir com `Measure-Object -Line` (ignora
// vazias e já induziu um falso "coube em 1930" numa revisão).
// 1689→1690 (jul/14): aba "Vista 2D" (vista superior top-down do chão + o beacon MAIS PRÓXIMO por
// tag, para o teste SÓ-Bluetooth sem câmera). O GROSSO foi EXTRAÍDO — geometria de mundo em
// src/fusion/topdown.ts (pura, testada), o desenho em src/camera/drawTopdown.ts (folha), e a aba em
// src/camera/tabs/Vista2DTab.tsx (carrega a própria calibração/BLE); aqui sobrou 1 LINHA de fiação:
// o prop cameraId ao CamDrawer (a nova aba resolve a própria calibração por ele). NÃO medir com
// `Measure-Object -Line`.
// 1690→1700 (jul/14): a Vista 2D vira "Mapa 2D" em TELA CHEIA (decisão do dono: botão no cabeçalho →
// o mapa cobre o palco+drawer; o vídeo NÃO é substituído, o Sair volta). O GROSSO foi EXTRAÍDO —
// camera/Vista2DStage.tsx (a tela cheia), camera/useTopdownView.ts (a fiação de dados) e
// camera/TopdownCanvas.tsx (o canvas responsivo), TODOS compartilhados com a aba pequena (DRY). Aqui
// sobrou só a fiação: estado mapaOpen + 2 props ao CamHeader (o toggle) + o overlay condicional na
// cam-body (que virou `relative`). ~9 linhas de wiring, zero lógica. NÃO medir com `Measure-Object -Line`.
// 1700→1620 (jul/16, ADR-018 — separação de domínios): TODA a fiação de fusão BLE saiu do palco
// (useCameraTagLabels/useFloorTags/useFunnelDiagnosis, prop getReadings, anéis no drawScene,
// Mapa 2D/Vista2DStage, aba "Por quê"). O código vive no repo mvp_trilateracao_BLE; o rótulo da
// pessoa volta ao genérico "Pessoa" (personLabel sem labelFor — o gate anti-número FICA).
// Contabilidade REAL: 1700 → 1614; teto 1620 mantém a folga mínima da convenção (≈5).
// NÃO medir com `Measure-Object -Line`.
// 1620→1632 (jul/25, spec-overlay-tempo-real Onda 0): réguas de LATÊNCIA no HUD da câmera aberta
// (vid/trk/hub — a medição que autoriza a Onda 2). O GROSSO foi EXTRAÍDO — medidor de cadência em
// camera/cadence.ts (puro, testado) e as linhas novas em drawTelemetryHud (folha, camera/draw.ts);
// aqui sobrou fiação: 1 import + 2 refs + observe/latency no ramo hub + 3 props ao drawTelemetryHud.
// Contabilidade REAL: 1614 → 1626; teto 1632 mantém a folga mínima da convenção (≈5).
// NÃO medir com `Measure-Object -Line`.
// 1632→1638 (lotação do modo Objetos): alerta quando a contagem de pessoas do setor sai do alvo
// configurado por tempo demais. O GROSSO foi EXTRAÍDO — histerese/estado em
// processors/objetos.ts (ObjetosProcessor, puro, testado); aqui sobrou fiação: 2 props
// (targetOccupancy/occupancyToleranceMs) no setor passado ao processador + 1 forEach formatando
// e roteando `r.occupancyAlerts` pro mesmo canal de alarme do fadiga (prefixo "⚠" + label · zona).
// Teto 1643 mantém a folga mínima da convenção (≈5). NÃO medir com `Measure-Object -Line`.
// 1643→1662 (sync ao vivo de zonas): zona editada por API/outro posto não repropagava pra uma
// tab já aberta (só a carga inicial buscava) — bug real medido em produção. Prop `zonesRev`
// (mesmo idioma de tripwiresRev/calibrationRev) + 1 efeito extra que só re-busca a lista
// (sem resetar preset/layers da sessão). Contabilidade REAL: 1638 → 1657; teto 1662 mantém a
// folga mínima da convenção (≈5). NÃO medir com `Measure-Object -Line`.
// 1662→1680 (contagem de PESSOA em zona Objetos passa a vir do hub/D-FINE, não do OWL-ViT — mesmo
// motor confiável que a Atividade já usa): 1 flag (hubCoversPeople) + omite targetOccupancy do
// processador local quando o hub cobre (evita alarme duplicado) + 1 leitura de getHubAnalysis()
// pra achar a zona por id + merge no `counts`/`total`. O GROSSO (resolveZoneByOverlap, perZoneObj,
// merge na observação de lotação) foi pro servidor (server/analysis/{zones,pipeline,engine}.js).
// Contabilidade REAL: 1657 → 1672; teto 1680 mantém a folga mínima da convenção (≈5).
// NÃO medir com `Measure-Object -Line`.
// 1680→1698 (MEDIDO em produção: "detecta mas não mantém" — câmera focada em ~0,2fps real
// zerava a contagem de pessoa vinda do hub numa rodada esparsa em que o track não sobrepôs a
// zona, mesmo a pessoa não tendo saído): hubPeopleHoldRef segura o último valor >0 por
// HUB_PEOPLE_HOLD_MS antes de aceitar 0. Contabilidade REAL: 1672 → 1693; teto 1698 mantém a
// folga mínima da convenção (≈5). NÃO medir com `Measure-Object -Line`.
const MAX_LINES = 1698;

describe("CameraWorkspace — ratchet de tamanho (anti-reengorda)", () => {
  it(`não cresce além de ${MAX_LINES} linhas sem decisão consciente`, () => {
    const p = fileURLToPath(new URL("./CameraWorkspace.tsx", import.meta.url));
    const lines = readFileSync(p, "utf8").split(/\r?\n/).length;
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});
