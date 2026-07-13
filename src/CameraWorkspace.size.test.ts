// CameraWorkspace.size.test.ts — RATCHET anti-reengorda do god-component.
//
// POR QUÊ: o retrofit-2 declarou o teto ≤1850, mas o arquivo reengordou 1822→1889 SEM
// nenhum sensor que barrasse (auditoria docs/analises/saude/01-auditoria-doutrina-2026-07.md).
// A meta virou TEXTO, não gate. Este teste é o BACKSTOP: crescer vira uma DECISÃO
// consciente (o teste fica vermelho; subir o teto exige justificativa + nota de residual
// no PR), não uma deriva silenciosa.
//
// HONESTIDADE (lição 06.2): o anti-reengorda REAL não é meta de linhas — é fronteira de
// módulo com dono+teste. RESIDUAL DECLARADO: a extração de useZoneEditor/useCameraPipeline
// NÃO é seam limpo hoje — os handlers de ponteiro (onDown/onMove/onUp) MULTIPLEXAM 3 editores
// (pintura + tripwire + retângulo), o estado zones/zonesRef/setZones é usado por toda a
// componente (render, pipeline, summary) e removeZone toca os holders de processamento.
// Extrair agora = pass-through com interface ≈ implementação (veto §C do retrofit-2).
// Precisa de esforço dedicado (spec + fase-1 1:1 com paridade provada), não squeeze oportunista.
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
const MAX_LINES = 1765;

describe("CameraWorkspace — ratchet de tamanho (anti-reengorda)", () => {
  it(`não cresce além de ${MAX_LINES} linhas sem decisão consciente`, () => {
    const p = fileURLToPath(new URL("./CameraWorkspace.tsx", import.meta.url));
    const lines = readFileSync(p, "utf8").split(/\r?\n/).length;
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});
