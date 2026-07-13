import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstacoesList, estacaoViva, haQuantoTempo, STALE_MS } from "./EstacoesList";
import type { BtStation } from "../../api";

// GATE DE RBAC DA TELA BLE (spec-arquitetura-informacao §3).
//
// POR QUE ESTE TESTE EXISTE: até aqui, quem barrava o operador na tela de Estações era a ROTA
// (/estacoes só aparecia no menu de Administração, sob canConfigure). A unificação MATA a rota — as
// Estações viram uma ABA de /tags-ble, que TODO autenticado abre. O gate desceu para dentro do
// componente, e um gate de UI que ninguém asserta é um gate que uma refatoração apaga em silêncio.
// Aqui ele vira asserção: se um controle de ESCRITA (nomear/renomear, ativar, remover) vazar para
// quem não tem `canConfigure`, o build quebra.
//
// Mesmo molde de src/ui/Panel.test.tsx: renderToStaticMarkup (sem jsdom, sem contexto, sem rede) —
// possível justamente porque a apresentação foi separada do container (EstacoesTab faz a rede).

const AGORA = 1_700_000_000_000;

const ROWS: BtStation[] = [
  {
    id: "tc22-a1b2",
    nome: "Doca 3", // já batizada
    ativo: true,
    primeiraVezEm: AGORA - 86_400_000,
    ultimaVezEm: AGORA - 2_000, // viva
  },
  {
    id: "tc22-c3d4",
    nome: "tc22-c3d4", // pendente de batismo (nome == id)
    ativo: false,
    primeiraVezEm: AGORA - 3_600_000,
    ultimaVezEm: AGORA - 60_000, // sem sinal
  },
];

const noop = () => {};
const naoGrava = async () => false;

function render(canConfigure: boolean, rows: BtStation[] = ROWS) {
  return renderToStaticMarkup(
    <EstacoesList
      rows={rows}
      agora={AGORA}
      canConfigure={canConfigure}
      onRename={naoGrava}
      onToggleAtivo={noop}
      onRemove={noop}
    />,
  );
}

describe("EstacoesList — o gate de configuração mora na TELA (a rota morreu)", () => {
  it("SEM canConfigure: nenhum controle de escrita é renderizado", () => {
    const html = render(false);
    // Ações de escrita: os três botões e o Switch de ativa/inativa. A asserção é no BOTÃO
    // (`>remover<`), não na palavra: o aviso de somente-leitura CITA "remover" no texto — checar a
    // palavra solta daria um verde falso na direção oposta (passaria a achar botão onde não há).
    expect(html).not.toContain(">remover<");
    expect(html).not.toContain(">renomear<");
    expect(html).not.toContain(">nomear<");
    expect(html).not.toContain('role="switch"');
    // As colunas de escrita também somem (senão sobram <th> vazios sobre células que não existem).
    expect(html).not.toContain(">Ativa<");
    expect(html).not.toContain(">Ações<");
    expect(html.match(/<th\b/g)).toHaveLength(4); // Estação · Status · Última leitura · Primeira vez
  });

  it("SEM canConfigure: a tela DIZ que está em somente-leitura (ausência de botão não é bug)", () => {
    const html = render(false);
    expect(html).toContain("somente-leitura");
    expect(html).toContain("engenheiro/superadmin");
  });

  it("SEM canConfigure: a LEITURA continua inteira (é diagnóstico, não configuração)", () => {
    const html = render(false);
    expect(html).toContain("Doca 3"); // o nome amigável
    expect(html).toContain("tc22-a1b2"); // o id técnico (suporte)
    expect(html).toContain("viva"); // saúde da estação — o "por que a tag sumiu?"
    expect(html).toContain("sem sinal");
    expect(html).toContain("há 2 s"); // última leitura em texto (going-gray: nunca só cor)
  });

  it("COM canConfigure: os controles de escrita voltam", () => {
    const html = render(true);
    expect(html).toContain(">remover<");
    expect(html).toContain(">renomear<"); // estação já batizada
    expect(html).toContain(">nomear<"); // estação pendente (nome == id)
    expect(html).toContain('role="switch"');
    expect(html).toContain(">Ativa<");
    expect(html).toContain(">Ações<");
    expect(html.match(/<th\b/g)).toHaveLength(6);
    // E aí o aviso de somente-leitura NÃO aparece (senão o gate estaria mentindo).
    expect(html).not.toContain("somente-leitura");
  });

  it("sem estações: o vazio explica a auto-descoberta (e não mostra tabela)", () => {
    const html = render(true, []);
    expect(html).toContain("aparece aqui");
    expect(html).not.toContain("<table");
  });
});

describe("EstacoesList — derivações puras", () => {
  it("estacaoViva: a janela é a MESMA do hub (STALE_MS de server/bt/bt-readings.js)", () => {
    const base = { id: "x", nome: "x", ativo: true, primeiraVezEm: 0 };
    expect(estacaoViva({ ...base, ultimaVezEm: AGORA - STALE_MS }, AGORA)).toBe(true); // no limite
    expect(estacaoViva({ ...base, ultimaVezEm: AGORA - STALE_MS - 1 }, AGORA)).toBe(false);
  });

  it("haQuantoTempo: segundos → minutos → horas; sem carimbo vira travessão", () => {
    expect(haQuantoTempo(AGORA - 3_000, AGORA)).toBe("há 3 s");
    expect(haQuantoTempo(AGORA - 240_000, AGORA)).toBe("há 4 min");
    expect(haQuantoTempo(AGORA - 7_200_000, AGORA)).toBe("há 2 h");
    expect(haQuantoTempo(0, AGORA)).toBe("—");
  });
});
