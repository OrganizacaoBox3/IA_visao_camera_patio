import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CEGA_MS, EstacoesList, estacaoCega, estacaoViva, haQuantoTempo, STALE_MS } from "./EstacoesList";
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
    ultimaVezEm: AGORA - 2_000, // viva…
    ultimaLeituraEm: AGORA - 2_000, // …e LENDO tags (senão seria CEGA, não viva)
    scanning: true,
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

// ESTAÇÃO CEGA (causa C1/bug B6 — 22 h postando `readings: []` sem alarme): viva pelo POST mas sem
// ler tags (scan morto pela tela apagada). O estado NÃO altera viva/sem sinal — é um TERCEIRO estado,
// e "sem sinal" segue soberano quando o POST parou. Going-gray: warn + o que fazer em TEXTO.
describe("EstacoesList — estação CEGA (posta, mas não lê)", () => {
  const base: BtStation = {
    id: "tc22-e5f6",
    nome: "Expedição",
    ativo: true,
    primeiraVezEm: AGORA - 86_400_000,
    ultimaVezEm: AGORA - 1_000, // viva pelo POST…
    ultimaLeituraEm: AGORA - 22 * 3_600_000, // …mas 22 h sem trazer UMA leitura (o caso real)
    scanning: null,
  };

  it("viva pelo POST + 22 h sem leitura → badge 'cega' (warn) com instrução em TEXTO", () => {
    const html = render(false, [base]);
    expect(html).toContain(">cega<");
    expect(html).toContain("sem ler tags há 22 h");
    expect(html).toContain("verifique a tela/scan do aparelho");
    expect(html).not.toContain(">viva<"); // cega NÃO se disfarça de viva (era o bug)
  });

  it("scanning === false → cega MESMO com leitura fresca (a palavra do app decide)", () => {
    const html = render(false, [{ ...base, ultimaLeituraEm: AGORA - 1_000, scanning: false }]);
    expect(html).toContain(">cega<");
    expect(html).toContain("scan desligado");
  });

  it("ultimaLeituraEm ausente (hub/registro antigo, nunca leu) → cega com texto próprio", () => {
    const html = render(false, [{ ...base, ultimaLeituraEm: undefined }]);
    expect(html).toContain(">cega<");
    expect(html).toContain("sem nenhuma leitura de tag");
  });

  it("estação MORTA nunca é cega — 'sem sinal' segue soberano", () => {
    const html = render(false, [{ ...base, ultimaVezEm: AGORA - 60_000, scanning: false }]);
    expect(html).toContain(">sem sinal<");
    expect(html).not.toContain(">cega<");
  });

  it("viva e LENDO → 'viva' de sempre (estado existente intacto)", () => {
    const html = render(false, [{ ...base, ultimaLeituraEm: AGORA - 1_000, scanning: true }]);
    expect(html).toContain(">viva<");
    expect(html).not.toContain(">cega<");
  });
});

describe("EstacoesList — derivações puras", () => {
  it("estacaoViva: a janela é a MESMA do hub (STALE_MS de server/bt/bt-readings.js)", () => {
    const base = { id: "x", nome: "x", ativo: true, primeiraVezEm: 0 };
    expect(estacaoViva({ ...base, ultimaVezEm: AGORA - STALE_MS }, AGORA)).toBe(true); // no limite
    expect(estacaoViva({ ...base, ultimaVezEm: AGORA - STALE_MS - 1 }, AGORA)).toBe(false);
  });

  it("estacaoCega: limite de CEGA_MS; nunca-leu conta; scanning false decide; morta nunca é cega", () => {
    const base = { id: "x", nome: "x", ativo: true, primeiraVezEm: 0, ultimaVezEm: AGORA };
    expect(estacaoCega({ ...base, ultimaLeituraEm: AGORA - CEGA_MS }, AGORA)).toBe(false); // no limite
    expect(estacaoCega({ ...base, ultimaLeituraEm: AGORA - CEGA_MS - 1 }, AGORA)).toBe(true);
    expect(estacaoCega({ ...base }, AGORA)).toBe(true); // nunca trouxe leitura (campo ausente)
    expect(estacaoCega({ ...base, ultimaLeituraEm: AGORA, scanning: false }, AGORA)).toBe(true); // app confessa
    expect(estacaoCega({ ...base, ultimaVezEm: AGORA - STALE_MS - 1, scanning: false }, AGORA)).toBe(false); // morta = sem sinal
  });

  it("haQuantoTempo: segundos → minutos → horas; sem carimbo vira travessão", () => {
    expect(haQuantoTempo(AGORA - 3_000, AGORA)).toBe("há 3 s");
    expect(haQuantoTempo(AGORA - 240_000, AGORA)).toBe("há 4 min");
    expect(haQuantoTempo(AGORA - 7_200_000, AGORA)).toBe("há 2 h");
    expect(haQuantoTempo(0, AGORA)).toBe("—");
  });
});
