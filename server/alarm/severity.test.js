// A REGRA DE OURO DESTE ARQUIVO: crítico é RESERVADO.
//
// Contexto medido (2026-09-13): a criticidade era decidida pelo caractere "⚠" no texto e todo
// emissor prefixa com ele — 10 de 12 textos reais saíam como `critical`, contra a meta de ≤5%
// que o próprio sistema exibe na tela de saúde. Um sistema em que tudo é crítico não tem nível
// crítico; é a inundação que a ISA-18.2 manda evitar.
//
// Estes testes travam três coisas:
//   1. o TEXTO não decide mais gravidade (nem o "⚠", nem a ausência dele);
//   2. o que é crítico é a lista curta e explícita — e o teste falha se ela crescer sozinha;
//   3. boa notícia (incidente fechado) nunca chega como emergência.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { severityOf, rebaixar, TABELA } = require("./severity");
const { priorityOf } = require("./priority");
const { classify } = require("./classify");

describe("severityOf — a gravidade vem do EVENTO, não do texto", () => {
  it("crítico é a lista CURTA: risco a pessoa e perda total de vigilância", () => {
    expect(severityOf({ tipo: "presenca" })).toBe("critical"); // alguém onde não podia
    expect(severityOf({ tipo: "saude", evento: "sem-video" })).toBe("critical"); // não vemos nada
    expect(severityOf({ tipo: "saude", evento: "frota" })).toBe("critical"); // em escala
  });

  it("degradação tratável dentro do turno é ATENÇÃO, não emergência", () => {
    for (const evento of ["video-instavel", "ia-parada", "ia-atrasada"])
      expect(severityOf({ tipo: "saude", evento })).toBe("high");
    expect(severityOf({ tipo: "atividade" })).toBe("high");
    expect(severityOf({ tipo: "objetos" })).toBe("high");
    expect(severityOf({ tipo: "fadiga" })).toBe("high");
  });

  it("contexto, calibração e boa notícia são INFORMATIVO", () => {
    expect(severityOf({ tipo: "leitura" })).toBe("advisory");
    expect(severityOf({ tipo: "saude", evento: "linha-sem-cadencia" })).toBe("advisory");
    // Incidente RESOLVIDO. Se isto virasse crítico, o operador receberia vermelho para saber
    // que o problema acabou — que é exatamente como se destrói a confiança no vermelho.
    expect(severityOf({ tipo: "saude", evento: "fechar" })).toBe("advisory");
  });

  it("o evento ESPECÍFICO vence o tipo geral", () => {
    expect(severityOf({ tipo: "atividade" })).toBe("high");
    expect(severityOf({ tipo: "atividade", evento: "rajada" })).toBe("high"); // sintoma, não causa
    expect(severityOf({ tipo: "saude", evento: "sem-video" })).toBe("critical");
    expect(severityOf({ tipo: "saude", evento: "fechar" })).toBe("advisory");
  });

  it("o emissor pode DECLARAR a severidade e ela vence a tabela", () => {
    expect(severityOf({ tipo: "leitura", severidade: "critical" })).toBe("critical");
    expect(severityOf({ tipo: "presenca", severidade: "advisory" })).toBe("advisory");
  });

  it("severidade inválida no payload é ignorada (payload externo não define vocabulário)", () => {
    expect(severityOf({ tipo: "presenca", severidade: "URGENTÍSSIMO" })).toBe("critical");
    expect(severityOf({ tipo: "presenca", severidade: 9 })).toBe("critical");
  });

  it("tipo desconhecido devolve null — a tabela CALA em vez de chutar", () => {
    expect(severityOf({ tipo: "tipo-que-nao-existe" })).toBeNull();
    expect(severityOf({})).toBeNull();
    expect(severityOf(null)).toBeNull();
  });

  it("GATE: a lista de críticos não cresce sem alguém decidir", () => {
    const criticos = Object.entries(TABELA)
      .filter(([, v]) => v === "critical")
      .map(([k]) => k)
      .sort();
    // Mudou esta lista? A mudança é de PRODUTO (o que acorda gente de madrugada), não de
    // refactor — atualize aqui de propósito, com o porquê no cabeçalho de severity.js.
    expect(criticos).toEqual(["presenca", "saude:frota", "saude:sem-video"]);
  });
});

describe("priorityOf — o '⚠' perdeu o poder de decidir emergência", () => {
  const comAviso = "⚠ Doca 1: alguma coisa aconteceu";

  it("o MESMO texto com '⚠' sai com gravidades diferentes conforme o evento", () => {
    expect(priorityOf(comAviso, classify(comAviso), { tipo: "presenca" })).toBe("critical");
    expect(priorityOf(comAviso, classify(comAviso), { tipo: "leitura" })).toBe("advisory");
    expect(priorityOf(comAviso, classify(comAviso), { tipo: "saude", evento: "fechar" })).toBe(
      "advisory",
    );
  });

  it("emissor LEGADO (tipo desconhecido) com '⚠' cai em ATENÇÃO, nunca em crítico", () => {
    const texto = "⚠ Sensor externo: algo estranho";
    expect(priorityOf(texto, { critico: true, tipo: "coisa-nova" }, { tipo: "coisa-nova" })).toBe(
      "high",
    );
  });

  it("a heurística de texto legada continua reconhecendo queda de feed como ATENÇÃO", () => {
    expect(priorityOf("cam-9: feed caiu", { critico: false, tipo: "x" }, { tipo: "x" })).toBe(
      "high",
    );
    expect(priorityOf("cam-9: tudo normal", { critico: false, tipo: "x" }, { tipo: "x" })).toBe(
      "advisory",
    );
  });

  it("sem payload nenhum (chamada legada de 2 argumentos) ainda devolve um nível válido", () => {
    expect(["advisory", "high", "critical"]).toContain(priorityOf("qualquer coisa", {}));
  });
});

describe("rebaixar — quem suprime contexto não apaga o registro, só tira a urgência", () => {
  it("desce um degrau por vez e trava no piso", () => {
    expect(rebaixar("critical")).toBe("high");
    expect(rebaixar("high")).toBe("advisory");
    expect(rebaixar("advisory")).toBe("advisory"); // piso
    expect(rebaixar("critical", 2)).toBe("advisory");
    expect(rebaixar("critical", 99)).toBe("advisory");
  });
});
