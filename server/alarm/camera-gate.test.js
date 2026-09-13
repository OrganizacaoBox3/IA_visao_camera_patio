// Gate de ESTADO OPERACIONAL: câmera em teste/manutenção/desativada não notifica ninguém.
//
// O QUE ESTES TESTES PROTEGEM, em ordem de gravidade:
//   1. FAIL-OPEN. Toda borda desconhecida (sem cameraId, sem cadastro, cadastro que explode,
//      estado escrito errado) tem de DEIXAR PASSAR. Errar para o lado do ruído custa uma
//      mensagem; errar para o lado do silêncio custa o incidente que ninguém viu.
//   2. SÓ PRODUÇÃO NOTIFICA — e o gate vale para QUALQUER tipo de alarme daquela câmera, não
//      só para os de saúde: a câmera desparafusada também gera presença fantasma e lotação
//      absurda, que é o "falso alerta" que o dono pediu para matar.
//   3. QUEM CALA, MOSTRA QUE CALOU: cada supressão é contada e quebrada por estado.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cameraGate, suppressedByCameraState, cameraStateMetrics, _resetMetrics } =
  require("./camera-gate");

const cadastro = (estado) => ({ getCamera: () => ({ id: "cam-1", label: "Doca", estado }) });
const NOW = 1_700_000_000_000;

beforeEach(() => _resetMetrics());

describe("cameraGate — quem passa e quem é calado", () => {
  it("produção PASSA (é a única que notifica)", () => {
    expect(cameraGate({ cameraId: "cam-1" }, cadastro("producao"))).toBeNull();
  });

  it("teste, manutenção e desativada são CALADAS — e o motivo vem junto", () => {
    for (const estado of ["teste", "manutencao", "desativada"])
      expect(cameraGate({ cameraId: "cam-1" }, cadastro(estado))).toEqual({ estado });
  });

  it("vale para QUALQUER tipo de alarme, não só saúde", () => {
    // A câmera em manutenção gera presença fantasma (técnico passando na frente) e lotação
    // absurda (mira mudou). Se o gate só pegasse "saude", esses dois continuariam alarmando.
    for (const tipo of ["saude", "presenca", "atividade", "fadiga", "leitura", "objetos"])
      expect(cameraGate({ cameraId: "cam-1", tipo }, cadastro("manutencao"))).toEqual({
        estado: "manutencao",
      });
  });
});

describe("cameraGate — fail-open em toda borda", () => {
  it("sem cameraId, ou com a sentinela '_' de não-identificada, PASSA", () => {
    expect(cameraGate({}, cadastro("desativada"))).toBeNull();
    expect(cameraGate({ cameraId: "" }, cadastro("desativada"))).toBeNull();
    expect(cameraGate({ cameraId: "_" }, cadastro("desativada"))).toBeNull();
  });

  it("câmera fora do cadastro dinâmico PASSA (nó do navegador / fonte RTSP legada)", () => {
    expect(cameraGate({ cameraId: "cam-x" }, { getCamera: () => null })).toBeNull();
  });

  it("cadastro que LANÇA não derruba nem cala o alarme", () => {
    const explode = {
      getCamera: () => {
        throw new Error("disco fora");
      },
    };
    expect(cameraGate({ cameraId: "cam-1" }, explode)).toBeNull();
  });

  it("estado desconhecido no arquivo é tratado como produção (passa)", () => {
    expect(cameraGate({ cameraId: "cam-1" }, cadastro("qualquer-coisa"))).toBeNull();
  });

  it("registro LEGADO só com `enabled` é migrado: false = desativada, true = produção", () => {
    const legado = (enabled) => ({ getCamera: () => ({ id: "cam-1", enabled }) });
    expect(cameraGate({ cameraId: "cam-1" }, legado(false))).toEqual({ estado: "desativada" });
    expect(cameraGate({ cameraId: "cam-1" }, legado(true))).toBeNull();
  });
});

describe("cameraStateMetrics — a supressão é contada e quebrada por estado", () => {
  it("conta total, última hora e a quebra por estado", () => {
    suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("manutencao"));
    suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("manutencao"));
    suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("teste"));
    suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("producao")); // passou
    const m = cameraStateMetrics(NOW);
    expect(m.total).toBe(3);
    expect(m.lastHour).toBe(3);
    expect(m.byEstado).toEqual({ manutencao: 2, teste: 1 });
  });

  it("a janela de 1h ROLA: o que é velho sai de lastHour mas não do total acumulado", () => {
    suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("teste"));
    const m = cameraStateMetrics(NOW + 3_600_001);
    expect(m.total).toBe(1); // acumulado desde o boot
    expect(m.lastHour).toBe(0); // "está calando AGORA?" → não
    expect(m.byEstado).toEqual({});
  });

  it("devolve false (não suprimiu) para câmera em produção — e não conta nada", () => {
    expect(suppressedByCameraState({ cameraId: "cam-1" }, NOW, cadastro("producao"))).toBe(false);
    expect(cameraStateMetrics(NOW).total).toBe(0);
  });
});
