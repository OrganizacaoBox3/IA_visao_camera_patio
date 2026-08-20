// PONTE DVR (F3 backend) — SESSÃO: helpers PUROS (C-be-5). RODA SEMPRE (sem banco).
// Prova: alocação de porta (menor livre / faixa esgotada); host público único por DVR;
// regra do timeout de inatividade; e o shape do relay (sem segredo no repo — default de dev).
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dvr = require("./dvr");

describe("sessão — alocação de remotePort (proximaPortaLivre)", () => {
  it("faixa vazia → a menor porta da faixa", () => {
    expect(dvr.proximaPortaLivre([], 20000, 20099)).toBe(20000);
  });
  it("pula as portas em uso e devolve a menor livre", () => {
    expect(dvr.proximaPortaLivre([20000, 20001, 20003], 20000, 20099)).toBe(20002);
  });
  it("faixa esgotada → null (o handler responde 'sem porta')", () => {
    expect(dvr.proximaPortaLivre([20000, 20001, 20002], 20000, 20002)).toBe(null);
  });
});

describe("sessão — host público (único por DVR, subdomínio seguro)", () => {
  it("slug do cliente + sufixo curto do dvrId + domínio", () => {
    const h = dvr.hostPublico("Acme Indústria", "dvr_abc123def456", undefined);
    expect(h).toMatch(/^acme-industria-[a-z0-9]{6}\.dvr\.box3\.software$/);
  });
  it("dois DVRs do MESMO cliente não colidem (sufixo do dvrId difere)", () => {
    const a = dvr.hostPublico("Cliente X", "dvr_aaaaaa111111");
    const b = dvr.hostPublico("Cliente X", "dvr_bbbbbb222222");
    expect(a).not.toBe(b);
  });
  it("slugify tira acento/espaço e nunca fica vazio", () => {
    expect(dvr.slugify("Ação & Cia!!")).toBe("acao-cia");
    expect(dvr.slugify("")).toBe("cliente");
  });
});

describe("sessão — regra do TIMEOUT de inatividade (sessaoOciosa)", () => {
  const agora = 1_000_000_000;
  it("ativa e além do idle → ociosa", () => {
    expect(dvr.sessaoOciosa({ status: "ativa", ultima_atividade: agora - 100 }, agora, 50)).toBe(true);
  });
  it("ativa e dentro do idle → NÃO ociosa", () => {
    expect(dvr.sessaoOciosa({ status: "ativa", ultima_atividade: agora - 10 }, agora, 50)).toBe(false);
  });
  it("já encerrada → nunca ociosa; cai para aberta_em se não há ultima_atividade", () => {
    expect(dvr.sessaoOciosa({ status: "encerrada", ultima_atividade: 0 }, agora, 50)).toBe(false);
    expect(dvr.sessaoOciosa({ status: "ativa", aberta_em: agora - 100 }, agora, 50)).toBe(true);
  });
});

describe("sessão — relayConfig (env; sem segredo no repo, invariante 6)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("default de dev quando as envs não estão setadas", () => {
    delete process.env.CP_RELAY_ADDR;
    delete process.env.CP_RELAY_PORT;
    delete process.env.CP_RELAY_TOKEN;
    expect(dvr.relayConfig()).toEqual({ serverAddr: "relay.box3.software", serverPort: 7000, token: "" });
  });
  it("respeita as envs quando setadas", () => {
    process.env.CP_RELAY_ADDR = "relay.exemplo";
    process.env.CP_RELAY_PORT = "7443";
    process.env.CP_RELAY_TOKEN = "tok";
    expect(dvr.relayConfig()).toEqual({ serverAddr: "relay.exemplo", serverPort: 7443, token: "tok" });
  });
});
