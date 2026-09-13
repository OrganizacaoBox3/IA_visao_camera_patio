// ROTEAMENTO POR PÚBLICO — o teste de que a diferenciação chega ao envio, não só ao formatador.
//
// O risco que este arquivo cobre não é o texto (audience.test.js já trava a redação): é a
// FIAÇÃO. Uma mensagem só era montada e enviada a todos; agora são duas, escolhidas pelo papel
// do dono de cada número. Se a fiação errar, o cliente volta a receber o texto da equipe — e o
// vazamento é silencioso, porque o envio não falha, só chega errado do outro lado.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dispatch = require("./dispatch");
const users = require("./users");
const recipients = require("./recipients");
const whatsapp = require("./whatsapp");

const TS = new Date("2026-09-13T14:32:00-03:00").getTime();

/** Monta um cadastro fake: um número da equipe e um do cliente, ambos aptos a receber. */
function cenario({ clienteVeCamera = true } = {}) {
  const enviados = [];
  vi.spyOn(whatsapp, "enabled").mockReturnValue(true);
  vi.spyOn(whatsapp, "status").mockReturnValue({ enabled: true, connected: true, qr: null });
  vi.spyOn(whatsapp, "sendText").mockImplementation(async (numero, msg) => {
    enviados.push({ numero, msg });
  });
  vi.spyOn(recipients, "all").mockReturnValue([
    {
      id: "r-eq",
      nome: "Plantão",
      numero: "5511900000001",
      ativo: true,
      optInEm: 1,
      userId: "u-eq",
      somenteCriticos: false,
      tipos: [],
    },
    {
      id: "r-cli",
      nome: "Cliente",
      numero: "5511900000002",
      ativo: true,
      optInEm: 1,
      userId: "u-cli",
      somenteCriticos: false,
      tipos: [],
    },
  ]);
  vi.spyOn(users, "getById").mockImplementation((id) =>
    id === "u-eq"
      ? { id, papel: "engenheiro", ativo: true }
      : { id, papel: "cliente", ativo: true, cameraIds: ["cam-1"] },
  );
  vi.spyOn(users, "canSeeCamera").mockReturnValue(clienteVeCamera);
  const daEquipe = () => enviados.find((e) => e.numero.endsWith("1"));
  const doCliente = () => enviados.find((e) => e.numero.endsWith("2"));
  return { enviados, daEquipe, doCliente };
}

beforeEach(() => vi.restoreAllMocks());

describe("dispatchAlert — cada público recebe a SUA mensagem", () => {
  it("mesmo alarme, dois textos diferentes: completo p/ equipe, curto p/ cliente", () => {
    const c = cenario();
    dispatch.dispatchAlert(
      "⚠ Doca 1: presença em área proibida (Cofre) há 30s",
      TS,
      "critical",
      "cam-1",
    );
    expect(c.enviados).toHaveLength(2);
    // Equipe: vocabulário de alarme, local em linha própria, rodapé "notificação automática".
    expect(c.daEquipe().msg).toContain("CRÍTICO");
    expect(c.daEquipe().msg).toContain("📍 Doca 1");
    expect(c.daEquipe().msg).toContain("notificação automática");
    // Cliente: sem jargão de gravidade, e curto (3 linhas).
    expect(c.doCliente().msg).not.toContain("CRÍTICO");
    expect(c.doCliente().msg).not.toContain("📍");
    expect(c.doCliente().msg.split("\n").filter(Boolean)).toHaveLength(3);
    // Mas a INFORMAÇÃO do evento continua lá — limpar não é esvaziar.
    expect(c.doCliente().msg).toContain("Cofre");
    expect(c.doCliente().msg).toContain("Doca 1");
  });

  it("interno NÃO vaza para o cliente (id de câmera, endpoint, jargão de causa)", () => {
    const c = cenario();
    dispatch.dispatchAlert(
      "⚠ cam-6a8914b424: análise atrasada (frameAgeP50 4200ms) — causa provável ÚNICA. Ver /api/analysis/status",
      TS,
      "high",
      "cam-1",
    );
    const msg = c.doCliente().msg;
    expect(msg).not.toMatch(/cam-[0-9a-f]{6,}/);
    expect(msg).not.toContain("/api/");
    expect(msg).not.toMatch(/frameAgeP50|4200ms/);
    expect(msg).not.toMatch(/causa prov/i);
    // A equipe continua recebendo tudo — é ela que vai agir sobre esses números.
    expect(c.daEquipe().msg).toContain("/api/analysis/status");
  });

  it("INFORMATIVO vai só para a equipe", () => {
    const c = cenario();
    dispatch.dispatchAlert("Doca 1: normalizada — sem vídeo resolvido", TS, "advisory", "cam-1");
    expect(c.daEquipe()).toBeTruthy();
    expect(c.doCliente()).toBeUndefined();
  });

  it("o cliente segue recebendo ATENÇÃO (não é 'só crítico')", () => {
    const c = cenario();
    dispatch.dispatchAlert("⚠ Doca 1: Doca 1 sem movimentação há 15 min.", TS, "high", "cam-1");
    expect(c.doCliente()).toBeTruthy();
    expect(c.doCliente().msg).toContain("Sem movimentação há 15 min.");
  });

  it("o escopo de câmera do cliente continua valendo (RBAC intocado)", () => {
    const c = cenario({ clienteVeCamera: false });
    dispatch.dispatchAlert("⚠ Doca 9: presença em área proibida", TS, "critical", "cam-99");
    expect(c.daEquipe()).toBeTruthy();
    expect(c.doCliente()).toBeUndefined();
  });
});

describe("targets — o perfil viaja junto com o destino", () => {
  it("cada número sai rotulado com o perfil do dono", () => {
    cenario();
    const t = dispatch.targets({ tipo: "presenca", priority: "critical" }, "cam-1");
    expect(t.find((x) => x.numero.endsWith("1")).perfil).toBe("equipe");
    expect(t.find((x) => x.numero.endsWith("2")).perfil).toBe("cliente");
  });
});
