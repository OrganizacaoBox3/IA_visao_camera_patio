import { describe, expect, it } from "vitest";
import type { Dvr } from "./types";
import {
  agruparPorCliente,
  descricaoDvr,
  dvrTemSessaoAtiva,
  dvrUrl,
  enderecoDvr,
  rotuloAcao,
} from "./dvrLogic";

function dvr(over: Partial<Dvr> & Pick<Dvr, "id" | "cliente_id" | "cliente_nome">): Dvr {
  return {
    coletor_id: "col1",
    coletor_nome: "Coletor",
    empresa_id_box3: "emp1",
    coletor_revogado: false,
    partner_id: "p1",
    marca: null,
    modelo: null,
    ip: null,
    porta: null,
    criado_em: 1,
    atualizado_em: null,
    sessao: null,
    ...over,
  };
}

describe("dvrTemSessaoAtiva", () => {
  it("null → false", () => {
    expect(dvrTemSessaoAtiva({ sessao: null })).toBe(false);
  });
  it("sessão ativa → true", () => {
    expect(
      dvrTemSessaoAtiva({
        sessao: { sessaoId: "s1", status: "ativa", remotePort: 20000, hostPublico: "h", aberta_em: 1, ultima_atividade: null },
      }),
    ).toBe(true);
  });
  it("sessão encerrada → false", () => {
    expect(
      dvrTemSessaoAtiva({
        sessao: { sessaoId: "s1", status: "encerrada", remotePort: 20000, hostPublico: "h", aberta_em: 1, ultima_atividade: null },
      }),
    ).toBe(false);
  });
});

describe("dvrUrl", () => {
  it("host → https:// (nova aba)", () => {
    expect(dvrUrl("cliente-abc123.dvr.box3.software")).toBe("https://cliente-abc123.dvr.box3.software");
  });
  it("vazio/null → string vazia (a UI não linka)", () => {
    expect(dvrUrl("")).toBe("");
    expect(dvrUrl(null)).toBe("");
    expect(dvrUrl(undefined)).toBe("");
  });
});

describe("agruparPorCliente", () => {
  it("agrupa preservando a ordem de chegada", () => {
    const rows = [
      dvr({ id: "d1", cliente_id: "cA", cliente_nome: "Cliente A" }),
      dvr({ id: "d2", cliente_id: "cB", cliente_nome: "Cliente B" }),
      dvr({ id: "d3", cliente_id: "cA", cliente_nome: "Cliente A" }),
    ];
    const g = agruparPorCliente(rows);
    expect(g.map((x) => x.clienteId)).toEqual(["cA", "cB"]);
    expect(g[0].dvrs.map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(g[1].dvrs.map((d) => d.id)).toEqual(["d2"]);
  });
  it("lista vazia → []", () => {
    expect(agruparPorCliente([])).toEqual([]);
  });
});

describe("rotuloAcao", () => {
  it("traduz ações conhecidas", () => {
    expect(rotuloAcao("sessao.abrir")).toBe("Sessão aberta");
    expect(rotuloAcao("acesso.tecnico")).toBe("Acesso do técnico");
  });
  it("ação desconhecida cai para o próprio código", () => {
    expect(rotuloAcao("acao.nova")).toBe("acao.nova");
  });
});

describe("descricaoDvr / enderecoDvr", () => {
  it("junta marca+modelo; vazio → —", () => {
    expect(descricaoDvr({ marca: "Intelbras", modelo: "MHDX 1108" })).toBe("Intelbras MHDX 1108");
    expect(descricaoDvr({ marca: null, modelo: null })).toBe("—");
  });
  it("ip:porta; sem porta → ip; sem ip → —", () => {
    expect(enderecoDvr({ ip: "192.168.1.108", porta: 80 })).toBe("192.168.1.108:80");
    expect(enderecoDvr({ ip: "192.168.1.108", porta: null })).toBe("192.168.1.108");
    expect(enderecoDvr({ ip: null, porta: 80 })).toBe("—");
  });
});
