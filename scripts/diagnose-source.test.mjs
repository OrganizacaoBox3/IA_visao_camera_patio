// Testes da lógica PURA do diagnose-source: ela decide o código de saída (1 = fila detectada),
// e o valor do instrumento depende de ele não gritar "fila" onde não há — um diagnóstico que
// acusa errado manda investigar a rede quando o problema é outro.
//
// O módulo é importado aqui de propósito: isso também trava o invariante de que ele NÃO tem
// efeito colateral no topo (o `process.exit` do parse de argumentos vive dentro do guard de
// execução direta — se alguém o mover para fora, este arquivo derruba a suíte inteira).
import { describe, expect, it } from "vitest";
import { montarArgs, parseArgs, percentil, vereditoFila } from "./diagnose-source.mjs";

describe("parseArgs", () => {
  it("lê fonte, janela e flags", () => {
    const a = parseArgs(["rtsp://cam/1", "12", "--work-ms", "30", "--queue"]);
    expect(a).toMatchObject({ fonte: "rtsp://cam/1", segundos: 12, workMs: 30, enfileira: true });
  });

  it("defaults: 8s de janela e 64ms de custo (o D-FINE-S medido)", () => {
    const a = parseArgs(["rtsp://cam/1"]);
    expect(a).toMatchObject({ segundos: 8, workMs: 64, enfileira: false });
  });

  it("janela inválida cai no default em vez de virar NaN", () => {
    expect(parseArgs(["x", "abc"]).segundos).toBe(8);
    expect(parseArgs(["x", "-5"]).segundos).toBe(8);
  });
});

describe("montarArgs", () => {
  // O nome da opção mudou no ffmpeg 6 e o antigo foi REMOVIDO — passar o errado aborta o
  // processo por opção desconhecida, e o sintoma vira "a câmera não abre".
  it("RTSP no ffmpeg 6+ usa -timeout; antes disso, -stimeout", () => {
    expect(montarArgs("rtsp://cam/1", 8)).toContain("-timeout");
    expect(montarArgs("rtsp://cam/1", 8)).not.toContain("-stimeout");
    expect(montarArgs("rtsp://cam/1", 5)).toContain("-stimeout");
  });

  it("RTSP força TCP (UDP corrompe bloco sob perda e vira medição corrompida calada)", () => {
    const a = montarArgs("rtsp://cam/1", 8);
    expect(a[a.indexOf("-rtsp_transport") + 1]).toBe("tcp");
  });

  it("HTTP/arquivo não recebe opção de RTSP nenhuma", () => {
    const a = montarArgs("https://exemplo/x.m3u8", 8);
    expect(a).not.toContain("-rtsp_transport");
    expect(a).not.toContain("-timeout");
  });

  it("sempre pede baixa latência na entrada e MJPEG no stdout", () => {
    const a = montarArgs("https://exemplo/x.m3u8", 8);
    expect(a).toContain("nobuffer");
    expect(a).toContain("low_delay");
    expect(a.slice(-3)).toEqual(["-q:v", "5", "pipe:1"]);
  });
});

describe("percentil", () => {
  it("mediana e p90 de uma série conhecida", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentil(v, 50)).toBe(5);
    expect(percentil(v, 90)).toBe(9);
  });
  it("série vazia devolve 0 em vez de NaN", () => {
    expect(percentil([], 50)).toBe(0);
  });
  it("não depende da ordem de entrada", () => {
    expect(percentil([9, 1, 5, 3, 7], 50)).toBe(5);
  });
});

describe("vereditoFila", () => {
  // Fila é fenômeno CUMULATIVO: não aparece na mediana (a 1ª metade a segura), aparece na
  // TENDÊNCIA. Por isso o critério é crescimento, não valor absoluto.
  it("idade crescendo ao longo da janela = FILA", () => {
    const idades = [50, 60, 70, 80, 900, 1400, 2000, 2600, 3200, 3800];
    expect(vereditoFila(idades).fila).toBe(true);
  });

  it("idade alta mas ESTÁVEL não é fila (é latência constante, outro problema)", () => {
    const idades = [800, 810, 790, 805, 795, 800, 810, 790, 800, 805];
    expect(vereditoFila(idades).fila).toBe(false);
  });

  it("idade baixa e estável (regime último-vence) não é fila", () => {
    const idades = [3, 4, 5, 3, 6, 4, 5, 3, 4, 5];
    expect(vereditoFila(idades).fila).toBe(false);
  });

  // Crescer 10ms → 30ms triplica, mas 20ms de atraso não é problema operacional nenhum: sem o
  // piso absoluto o instrumento acusaria fila em ruído de agendamento.
  it("crescimento proporcional mas irrelevante em absoluto NÃO é fila", () => {
    const idades = [8, 9, 10, 11, 25, 27, 29, 30, 31, 33];
    expect(vereditoFila(idades).fila).toBe(false);
  });

  it("amostras insuficientes não arriscam veredito", () => {
    const v = vereditoFila([10, 5000]);
    expect(v.fila).toBe(false);
    expect(v.motivo).toMatch(/insuficient/i);
  });
});
