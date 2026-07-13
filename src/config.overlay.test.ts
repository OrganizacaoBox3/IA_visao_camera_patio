// GATE do default dos ANÉIS DAS ANTENAS (BLE) sobre o vídeo (decisão do dono, 2026-07-13).
//
// POR QUE ESTE TESTE EXISTE: os anéis (drawFloorTags — âncoras + estação + anéis de distância) são
// dado de CONFERÊNCIA/diagnóstico, não a vista do cliente final. Ligados por padrão, poluíam a tela
// de quem só quer ver a câmera. A regra é: NÃO desenhar por padrão; o operador LIGA quando quer ver
// (toggle "Anéis das antenas" no CamKpiBar). Este default alimenta o useState/useRef do `floorOn` no
// CameraWorkspace — se alguém o virar `true` de novo, os anéis voltam a poluir a tela por padrão.
//
// CONTROLE NEGATIVO: forçar `floorTagsOn: true` no config deixa este teste VERMELHO (provado).
import { describe, expect, it } from "vitest";
import { APP_CONFIG } from "./config";

describe("overlay.floorTagsOn — anéis das antenas OFF por padrão (não poluir a vista do cliente)", () => {
  it("o default é DESLIGADO (o operador liga quando quer ver; a capacidade não some)", () => {
    expect(APP_CONFIG.overlay.floorTagsOn).toBe(false);
  });
});
