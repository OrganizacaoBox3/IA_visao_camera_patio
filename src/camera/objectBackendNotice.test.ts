// Gate do FALSO-OK do modo Objetos: "0 caixas" × "o modelo nunca carregou".
// O caminho SAUDÁVEL (owlvit → null) é testado com o mesmo rigor do aviso — é ele que impede o
// aviso de virar decoração permanente, e decoração permanente treina o operador a ignorá-lo.
import { describe, expect, it } from "vitest";
import { blindClasses, objectBackendNotice } from "./objectBackendNotice";

describe("objectBackendNotice — o detector conta o que NÃO consegue ver", () => {
  it("owlvit: nada a dizer (o aviso não é decoração)", () => {
    expect(objectBackendNotice("owlvit", ["caixa", "palete", "pessoa"])).toBeNull();
    expect(blindClasses("owlvit", ["caixa"])).toEqual([]);
  });

  it("coco + o DEFAULT da zona (['caixa']): a contagem é estruturalmente 0 → alerta nomeando a classe", () => {
    const n = objectBackendNotice("coco", ["caixa"]);
    expect(n).not.toBeNull();
    expect(n!.tone).toBe("alert");
    expect(n!.text).toContain("Caixa"); // o rótulo do catálogo, não a chave
    expect(n!.text).toContain("não detecta");
    // MEDIÇÃO × INFERÊNCIA: o texto tem de dizer de QUEM é o zero.
    expect(n!.text).toContain("do detector, não da cena");
  });

  it("coco: só as classes SEM equivalente COCO entram no aviso (pessoa o andaime enxerga)", () => {
    expect(blindClasses("coco", ["pessoa"])).toEqual([]);
    expect(blindClasses("coco", ["pessoa", "caixa", "palete"])).toEqual(["caixa", "palete"]);
    const n = objectBackendNotice("coco", ["pessoa", "caixa", "palete"]);
    expect(n!.text).toContain("Caixa");
    expect(n!.text).toContain("Palete");
    expect(n!.text).not.toContain("Pessoa");
  });

  it("coco + só pessoa: degradado, não cego → aviso mais fraco (warn), sem falar em contagem 0", () => {
    const n = objectBackendNotice("coco", ["pessoa"]);
    expect(n!.tone).toBe("warn");
    expect(n!.text).toContain("reserva");
  });

  it("indisponível: NENHUMA classe é observável, qualquer que seja a seleção", () => {
    const n = objectBackendNotice("indisponível", ["pessoa"]);
    expect(n!.tone).toBe("alert");
    expect(n!.text).toContain("indisponível");
    expect(blindClasses("indisponível", ["pessoa", "caixa"])).toEqual(["pessoa", "caixa"]);
  });

  it("carregando: informativo (ainda não é veredito) — nenhuma classe declarada cega", () => {
    const n = objectBackendNotice("carregando", ["caixa"]);
    expect(n!.tone).toBe("info");
    expect(blindClasses("carregando", ["caixa"])).toEqual([]);
  });

  it("toda mensagem traz o REMÉDIO quando o detector já falhou (recarregar: o latch é permanente)", () => {
    for (const b of ["coco", "indisponível"] as const)
      expect(objectBackendNotice(b, ["caixa"])!.help).toContain("recarregue a página");
  });
});

// PESSOA MEDIDA PELO SERVIDOR (D-FINE) — MEDIDO em cozinha real (2026-09-03): o OWL-ViT não
// detecta pessoa em cena interna/oclusa nem no piso 0.15, enquanto o D-FINE rastreia as mesmas
// pessoas de forma estável. Com a contagem de pessoa vindo do hub, o estado do detector do
// NAVEGADOR deixa de reger essa classe — e o operador tem de ver QUAL motor produziu o número.
describe("objectBackendNotice — contagem de pessoa vinda do motor do servidor", () => {
  it("hub + só pessoa: informa a fonte (não alarma) mesmo com o detector do navegador CAÍDO", () => {
    for (const b of ["coco", "indisponível", "carregando", "owlvit"] as const) {
      const n = objectBackendNotice(b, ["pessoa"], "hub");
      expect(n, b).not.toBeNull();
      expect(n!.tone, b).toBe("info");
      expect(n!.text, b).toContain("motor do servidor");
    }
  });

  it("hub: pessoa sai da conta de classes CEGAS (quem a mede é o servidor)", () => {
    expect(blindClasses("indisponível", ["pessoa"], "hub")).toEqual([]);
    expect(blindClasses("indisponível", ["pessoa", "caixa"], "hub")).toEqual(["caixa"]);
    expect(blindClasses("coco", ["pessoa", "caixa"], "hub")).toEqual(["caixa"]);
  });

  it("hub + pessoa E caixa com detector caído: o aviso fala da CAIXA, nunca da pessoa", () => {
    const n = objectBackendNotice("coco", ["pessoa", "caixa"], "hub");
    expect(n!.tone).toBe("alert");
    expect(n!.text).toContain("Caixa");
    expect(n!.text).not.toContain("Pessoa");
  });

  it("aguardando: diz que o 0 NÃO é cena vazia (o falso-OK que o fallback calado causava)", () => {
    const n = objectBackendNotice("owlvit", ["pessoa"], "aguardando");
    expect(n!.tone).toBe("info");
    expect(n!.text).toContain("não é cena vazia");
    expect(n!.help).toContain("falso-OK");
  });

  it("owlvit (default, sem hub): comportamento ANTERIOR intacto — caminho saudável segue null", () => {
    expect(objectBackendNotice("owlvit", ["pessoa"], "owlvit")).toBeNull();
    expect(objectBackendNotice("owlvit", ["pessoa"])).toBeNull(); // default do parâmetro
    expect(blindClasses("indisponível", ["pessoa"], "owlvit")).toEqual(["pessoa"]);
  });
});
