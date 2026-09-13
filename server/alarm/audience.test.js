// NOTIFICAÇÃO DO CLIENTE — o que NÃO pode sair daqui.
//
// A mensagem do cliente vai para um WhatsApp que não controlamos, de quem CONTRATA o
// monitoramento. Três coisas não podem viajar nela, e cada uma tem seu bloco abaixo:
//   1. INTERNO NOSSO — id de câmera gerado, caminho de API, ms/fps/worker/pool. É detalhe de
//      implementação vazando para fora, e ninguém do lado de lá pode fazer nada com isso.
//   2. JARGÃO DE ALARME — "CRÍTICO", "rajada", "causa provável ÚNICA". Vocabulário de quem
//      opera um sistema de alarme, não de quem recebe o serviço.
//   3. RUÍDO SEM AÇÃO — informativo e resumo de rajada. Mensagem que não muda a ação de quem
//      lê treina a pessoa a ignorar o canal, e aí ela ignora também a que importava.
//
// O contrapeso, testado junto: a limpeza é CONSERVADORA. Comer o conteúdo da mensagem é pior
// que deixar passar um resíduo técnico — um alarme que chega sem dizer o que aconteceu é um
// alarme perdido.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { perfilDe, clienteRecebe, limparParaCliente, localParaCliente } = require("./audience");

describe("perfilDe — quem é cliente", () => {
  it("só o papel 'cliente' recebe a redação curta", () => {
    expect(perfilDe("cliente")).toBe("cliente");
    expect(perfilDe("CLIENTE")).toBe("cliente");
    for (const p of ["superadmin", "engenheiro", "usuario", "", null, undefined])
      expect(perfilDe(p)).toBe("equipe");
  });
});

describe("clienteRecebe — o cliente recebe MENOS, de propósito", () => {
  it("crítico e atenção passam", () => {
    expect(clienteRecebe({ priority: "critical" })).toBe(true);
    expect(clienteRecebe({ priority: "high" })).toBe(true);
  });

  it("INFORMATIVO não passa — é contexto de quem opera o sistema", () => {
    // "Incidente fechado", "taxa de leitura 95%", "linha sem cadência": nada disso muda a ação
    // de quem contrata o monitoramento.
    expect(clienteRecebe({ priority: "advisory" })).toBe(false);
  });

  it("resumo de RAJADA não passa nem quando é crítico", () => {
    // O resumo é sintoma de infraestrutura ("possível queda de feed"); o alarme-raiz já saiu
    // com a própria gravidade. Mandar os dois é contar o mesmo problema duas vezes.
    expect(clienteRecebe({ priority: "critical", summary: true })).toBe(false);
  });

  it("FAIL-OPEN: prioridade ausente PASSA — silêncio por omissão é o pior modo de falha", () => {
    // Só um "advisory" DECLARADO segura a mensagem. Um chamador legado que esqueça a
    // prioridade não pode calar o canal do cliente sem deixar rastro: errar para o lado do
    // ruído custa uma mensagem; para o lado do silêncio, custa o incidente que ninguém viu.
    expect(clienteRecebe({})).toBe(true);
    expect(clienteRecebe(null)).toBe(true);
    expect(clienteRecebe({ tipo: "atividade" })).toBe(true);
  });
});

describe("limparParaCliente — o que some do texto", () => {
  it("id de câmera gerado vira 'a câmera'", () => {
    expect(limparParaCliente("sem vídeo em cam-6a8914b424 desde as 14h")).not.toMatch(/cam-[0-9a-f]/);
  });

  it("caminho de API some inteiro", () => {
    const t = limparParaCliente("16 câmeras com análise atrasada. Ver /api/analysis/status");
    expect(t).not.toContain("/api/");
    expect(t).toContain("16 câmeras");
  });

  it("medida de engenharia entre parênteses some (ms, fps, p50, worker, pool)", () => {
    for (const tec of ["(frameAgeP50 4200ms)", "(0.2 fps)", "(worker#3)", "(pool saturado)"]) {
      const t = limparParaCliente(`análise atrasada ${tec}`);
      expect(t).toBe("Análise atrasada.");
    }
  });

  it("jargão de causa técnica some", () => {
    const t = limparParaCliente("16 câmeras sem vídeo — causa provável ÚNICA (capacidade)");
    expect(t).not.toMatch(/causa prov/i);
    expect(t).toContain("16 câmeras sem vídeo");
  });

  it("o marcador ⚠ some (o emoji do cabeçalho já diz a urgência)", () => {
    expect(limparParaCliente("⚠ presença detectada")).toBe("Presença detectada.");
  });

  it("não repete o local que já está no cabeçalho", () => {
    // O texto interno é escrito para log ("Doca 2: Doca 2 sem movimentação"); na mensagem
    // curta a duplicata fica gritante.
    expect(limparParaCliente("Doca 2 sem movimentação há 15 min.", "Doca 2")).toBe(
      "Sem movimentação há 15 min.",
    );
    expect(limparParaCliente("Doca 2 · sem movimentação", "Doca 2")).toBe("Sem movimentação.");
  });

  it("local com caractere especial de regex não quebra a limpeza", () => {
    expect(limparParaCliente("Doca (1) parada", "Doca (1)")).toBe("Parada.");
  });

  it("vira frase de gente: inicial maiúscula e ponto final", () => {
    expect(limparParaCliente("presença em área proibida")).toBe("Presença em área proibida.");
    expect(limparParaCliente("Parou!")).toBe("Parou!"); // pontuação existente é respeitada
  });
});

describe("limparParaCliente — CONSERVADORA: não come o conteúdo", () => {
  it("preserva o que o cliente precisa: onde, quanto, há quanto tempo", () => {
    const t = limparParaCliente("presença em área proibida (Cofre) há 30s");
    expect(t).toContain("Cofre"); // o nome da zona é DELE, não é interno nosso
    expect(t).toContain("30s");
  });

  it("preserva números de operação (pessoas, caixas, percentuais)", () => {
    const t = limparParaCliente("lotação acima do esperado — 12 pessoa(s) (esperado 6)");
    expect(t).toContain("12 pessoa(s)");
    expect(t).toContain("esperado 6"); // parêntese SEM termo técnico fica
  });

  it("texto vazio ou só resíduo devolve string vazia (quem chama põe o fallback)", () => {
    expect(limparParaCliente("")).toBe("");
    expect(limparParaCliente("   ")).toBe("");
    expect(limparParaCliente("/api/analysis/status")).toBe("");
  });
});

describe("localParaCliente — id interno não vira endereço", () => {
  it("id cru sozinho vira vazio (melhor sem local do que com um id)", () => {
    expect(localParaCliente("cam-6a8914b424")).toBe("");
  });

  it("id + zona mantém a zona", () => {
    expect(localParaCliente("cam-ab12cd34 · Expedição")).toBe("Expedição");
  });

  it("rótulo humano passa intocado", () => {
    expect(localParaCliente("Doca 1")).toBe("Doca 1");
    expect(localParaCliente("Câmera Frente · Posto 1")).toBe("Câmera Frente · Posto 1");
  });

  it("vazio continua vazio", () => {
    expect(localParaCliente("")).toBe("");
    expect(localParaCliente(null)).toBe("");
  });
});
