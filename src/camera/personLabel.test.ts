// GATE DA INVARIANTE "a caixa da pessoa NUNCA exibe número" — nos DOIS caminhos de render.
//
// Por que este arquivo existe (e não só drawTracks.test.ts): a caixa de pessoa é desenhada por DOIS
// caminhos independentes — drawTracks (câmera aberta / MJPEG, em draw.ts) e TrackOverlay (tile
// WebRTC da grade, em routes/dashboard/TrackOverlay.tsx). Eles DIVERGIRAM: o MJPEG foi consertado
// para "Pessoa", o WebRTC ficou em `Pessoa ${id}`, e o dono via "Pessoa 1" no tile — porque o gate
// antigo só cobria o MJPEG. A correção durável foi extrair personLabel() como FONTE ÚNICA que os
// dois consomem; este gate trava (a) a função e (b) a REGRESSÃO do template em qualquer um dos dois
// arquivos de render — para um terceiro caminho não reintroduzir o número sem passar por personLabel.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { personLabel } from "./draw";

describe("personLabel — a caixa da pessoa NUNCA carrega número (fonte única dos 2 caminhos)", () => {
  it("sem labelFor (feature desligada): genérico 'Pessoa', nunca 'Pessoa <id>'", () => {
    for (const id of [1, 7, 42, 1234]) {
      expect(personLabel(undefined, id)).toBe("Pessoa");
      expect(personLabel(undefined, id)).not.toMatch(/\d/);
    }
  });

  it("labelFor devolve null (não associou): cai no genérico 'Pessoa', sem dígito", () => {
    for (const id of [1, 9, 300]) {
      expect(personLabel(() => null, id)).toBe("Pessoa");
      expect(personLabel(() => null, id)).not.toMatch(/\d/);
    }
  });

  it("labelFor devolve o NOME da tag: mostra o nome (o que o operador entende)", () => {
    expect(personLabel((id) => (id === 7 ? "João" : null), 7)).toBe("João");
  });

  it("nome vazio degrada para o genérico (|| pega string vazia)", () => {
    expect(personLabel(() => "", 5)).toBe("Pessoa");
  });
});

// Gate de CÓDIGO-FONTE: nenhum caminho de render pode voltar a interpolar o id no rótulo de pessoa.
// Pega a regressão EXATA que causou o "Pessoa 1" (um template `Pessoa ${...}`) mesmo que alguém a
// reintroduza SEM passar por personLabel — o que o teste da função sozinho não veria.
describe("nenhum arquivo de render interpola o id no rótulo de pessoa (a regressão do 'Pessoa 1')", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const RENDER_FILES = [
    path.join(here, "draw.ts"),
    path.join(here, "..", "routes", "dashboard", "TrackOverlay.tsx"),
  ];
  for (const file of RENDER_FILES) {
    it(`${path.basename(file)} não tem \`Pessoa \${...}\` em código`, () => {
      const src = readFileSync(file, "utf8");
      // Remove o texto DENTRO de comentários de linha (os comentários citam o bug de propósito).
      const codeOnly = src
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(codeOnly).not.toMatch(/`Pessoa \$\{/);
    });
  }
});
