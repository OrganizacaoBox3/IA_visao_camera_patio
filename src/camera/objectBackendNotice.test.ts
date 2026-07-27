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
