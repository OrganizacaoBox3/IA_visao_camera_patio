// Testes da lógica PURA de CameraAllocationField.tsx: quem é dono de uma câmera e o predicado
// de busca/filtro. Espelha server/users.cameras.test.js do lado do front — a MESMA regra de
// exclusividade (uma câmera, um cliente por vez), sem round-trip de rede.
import { describe, it, expect } from "vitest";
import { ownerOf, matchesFiltro, linhasDeCameras, FILTRO_DEFAULT, type Filtro } from "./cameraAllocation";
import type { AdminUser } from "../../api";
import type { ConnectedCamera } from "../../api";

function user(over: Partial<AdminUser> & { id: string }): AdminUser {
  return { usuario: over.id, papel: "cliente", ativo: true, cameraIds: [], ...over };
}
function cam(over: Partial<ConnectedCamera> & { id: string }): ConnectedCamera {
  return { label: over.id, online: true, ...over };
}

describe("ownerOf — quem tem a câmera agora (espelho de server/users.js cameraOwner)", () => {
  it("null quando nenhum cliente tem", () => {
    expect(ownerOf("cam-1", [], null)).toBeNull();
    expect(ownerOf("cam-1", [user({ id: "u1", cameraIds: ["cam-2"] })], null)).toBeNull();
  });

  it("acha o dono entre os clientes", () => {
    const dono = user({ id: "u1", usuario: "Cliente A", cameraIds: ["cam-1"] });
    expect(ownerOf("cam-1", [dono], null)).toBe(dono);
  });

  it("excludeUserId deixa o PRÓPRIO dono passar (edição não se autobloqueia)", () => {
    const dono = user({ id: "u1", cameraIds: ["cam-1"] });
    expect(ownerOf("cam-1", [dono], "u1")).toBeNull();
  });

  it("cliente INATIVO não conta como dono", () => {
    const inativo = user({ id: "u1", ativo: false, cameraIds: ["cam-1"] });
    expect(ownerOf("cam-1", [inativo], null)).toBeNull();
  });

  it("papel que não é 'cliente' nunca é dono, mesmo com o id na lista", () => {
    const eng = user({ id: "u1", papel: "engenheiro", cameraIds: ["cam-1"] });
    expect(ownerOf("cam-1", [eng], null)).toBeNull();
  });
});

describe("matchesFiltro — busca por nome", () => {
  const linha = { cam: cam({ id: "cam-doca", label: "Doca 1", online: true }), estado: "producao" as const, own: false, dono: null };

  it("sem busca, tudo passa", () => {
    expect(matchesFiltro(linha, FILTRO_DEFAULT)).toBe(true);
  });

  it("casa por LABEL, case-insensitive", () => {
    expect(matchesFiltro(linha, { ...FILTRO_DEFAULT, busca: "doca" })).toBe(true);
    expect(matchesFiltro(linha, { ...FILTRO_DEFAULT, busca: "DOCA" })).toBe(true);
  });

  it("casa por ID quando o label não bate", () => {
    expect(matchesFiltro(linha, { ...FILTRO_DEFAULT, busca: "cam-doca" })).toBe(true);
  });

  it("não casa nada → fora", () => {
    expect(matchesFiltro(linha, { ...FILTRO_DEFAULT, busca: "portaria" })).toBe(false);
  });
});

describe("matchesFiltro — estado (ativa/parada + literais do enum)", () => {
  const base = { cam: cam({ id: "c" }), own: false, dono: null };

  it("'ativa' aceita qualquer estado exceto desativada", () => {
    for (const estado of ["producao", "teste", "manutencao"] as const) {
      expect(matchesFiltro({ ...base, estado }, { ...FILTRO_DEFAULT, estado: "ativa" })).toBe(true);
    }
    expect(matchesFiltro({ ...base, estado: "desativada" }, { ...FILTRO_DEFAULT, estado: "ativa" })).toBe(
      false,
    );
  });

  it("'parada' só aceita desativada", () => {
    expect(matchesFiltro({ ...base, estado: "desativada" }, { ...FILTRO_DEFAULT, estado: "parada" })).toBe(
      true,
    );
    expect(matchesFiltro({ ...base, estado: "producao" }, { ...FILTRO_DEFAULT, estado: "parada" })).toBe(
      false,
    );
  });

  it("literal do enum (produção/teste/manutenção) filtra exatamente aquele estado", () => {
    expect(matchesFiltro({ ...base, estado: "teste" }, { ...FILTRO_DEFAULT, estado: "teste" })).toBe(true);
    expect(matchesFiltro({ ...base, estado: "producao" }, { ...FILTRO_DEFAULT, estado: "teste" })).toBe(
      false,
    );
  });
});

describe("matchesFiltro — conectividade", () => {
  const linhaOnline = { cam: cam({ id: "c", online: true }), estado: "producao" as const, own: false, dono: null };
  const linhaOffline = { cam: cam({ id: "c", online: false }), estado: "producao" as const, own: false, dono: null };

  it("filtro 'online' só deixa passar online:true", () => {
    expect(matchesFiltro(linhaOnline, { ...FILTRO_DEFAULT, conectividade: "online" })).toBe(true);
    expect(matchesFiltro(linhaOffline, { ...FILTRO_DEFAULT, conectividade: "online" })).toBe(false);
  });

  it("filtro 'offline' só deixa passar online:false", () => {
    expect(matchesFiltro(linhaOffline, { ...FILTRO_DEFAULT, conectividade: "offline" })).toBe(true);
    expect(matchesFiltro(linhaOnline, { ...FILTRO_DEFAULT, conectividade: "offline" })).toBe(false);
  });
});

describe("matchesFiltro — alocação (disponível / deste / de outro)", () => {
  const outro = user({ id: "u-outro", usuario: "Outro Cliente" });
  const disponivel = { cam: cam({ id: "c1" }), estado: "producao" as const, own: false, dono: null };
  const deste = { cam: cam({ id: "c2" }), estado: "producao" as const, own: true, dono: null };
  const deOutro = { cam: cam({ id: "c3" }), estado: "producao" as const, own: false, dono: outro };

  it("'disponivel' só deixa passar quem não tem dono nenhum", () => {
    const f: Filtro = { ...FILTRO_DEFAULT, alocacao: "disponivel" };
    expect(matchesFiltro(disponivel, f)).toBe(true);
    expect(matchesFiltro(deste, f)).toBe(false);
    expect(matchesFiltro(deOutro, f)).toBe(false);
  });

  it("'deste' só deixa passar as do próprio cliente sendo editado", () => {
    const f: Filtro = { ...FILTRO_DEFAULT, alocacao: "deste" };
    expect(matchesFiltro(deste, f)).toBe(true);
    expect(matchesFiltro(disponivel, f)).toBe(false);
    expect(matchesFiltro(deOutro, f)).toBe(false);
  });

  it("'deOutro' só deixa passar as vinculadas a OUTRO cliente", () => {
    const f: Filtro = { ...FILTRO_DEFAULT, alocacao: "deOutro" };
    expect(matchesFiltro(deOutro, f)).toBe(true);
    expect(matchesFiltro(disponivel, f)).toBe(false);
    expect(matchesFiltro(deste, f)).toBe(false);
  });
});

describe("linhasDeCameras — monta a linha (estado normalizado + dono) por câmera", () => {
  it("marca own=true quando o id está em `value`", () => {
    const cams = [cam({ id: "c1" })];
    const linhas = linhasDeCameras(cams, [], null, ["c1"]);
    expect(linhas[0].own).toBe(true);
    expect(linhas[0].dono).toBeNull(); // own vence: não procura dono de câmera que já é MINHA
  });

  it("resolve o dono quando a câmera NÃO é minha", () => {
    const dono = user({ id: "u1", cameraIds: ["c1"] });
    const linhas = linhasDeCameras([cam({ id: "c1" })], [dono], "u2", []);
    expect(linhas[0].own).toBe(false);
    expect(linhas[0].dono).toBe(dono);
  });

  it("estado ausente (hub anterior à migração) normaliza para 'producao' (fail-open)", () => {
    const linhas = linhasDeCameras([cam({ id: "c1", estado: undefined })], [], null, []);
    expect(linhas[0].estado).toBe("producao");
  });
});
