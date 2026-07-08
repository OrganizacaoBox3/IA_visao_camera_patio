// CameraWorkspace.size.test.ts — RATCHET anti-reengorda do god-component.
//
// POR QUÊ: o retrofit-2 declarou o teto ≤1850, mas o arquivo reengordou 1822→1889 SEM
// nenhum sensor que barrasse (auditoria analises/saude/01-auditoria-doutrina-2026-07.md).
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

// Teto ATUAL (não-ideal). BAIXE ao extrair uma responsabilidade; SUBIR exige justificativa.
const MAX_LINES = 1910;

describe("CameraWorkspace — ratchet de tamanho (anti-reengorda)", () => {
  it(`não cresce além de ${MAX_LINES} linhas sem decisão consciente`, () => {
    const p = fileURLToPath(new URL("./CameraWorkspace.tsx", import.meta.url));
    const lines = readFileSync(p, "utf8").split(/\r?\n/).length;
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});
