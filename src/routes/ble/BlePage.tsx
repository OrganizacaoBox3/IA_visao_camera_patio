import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader, Tabs, TabsContent } from "../../ui";
import { TagsTab } from "./TagsTab";
import { EstacoesTab } from "./EstacoesTab";

// TELA BLE — Tags + Estações num lugar só (spec-arquitetura-informacao §3, desenho C).
//
// ANTES: duas rotas, em dois GRUPOS de menu, com dois gates — "Tags BLE" (/tags-ble, Operação) e
// "Estações BLE" (/estacoes, Administração). Mesmo domínio, partido ao meio: a estação é o outro
// lado da tag (é ela quem produz a leitura), e o operador tinha de decidir "Tags ou Estações?"
// ANTES de decidir o que fazer. AGORA: uma tela, um h1, duas abas (Radix Tabs, wrapper de src/ui).
//
// PATH: segue /tags-ble (o e2e navega por ele; deep-links antigos continuam valendo). A aba entra
// na URL como `?aba=estacoes` — assim o F5 não perde o lugar e a /estacoes morta pode redirecionar
// para a aba certa em vez de para um lugar genérico.
//
// RBAC: a aba Estações vive em modo somente-leitura para quem não tem `canConfigure` — a decisão e o
// porquê estão em EstacoesTab.tsx; o gate é asserido em EstacoesList.test.tsx.

type Aba = "tags" | "estacoes";
const ABA_PADRAO: Aba = "tags";

export function BlePage() {
  const [params, setParams] = useSearchParams();
  const aba: Aba = params.get("aba") === "estacoes" ? "estacoes" : ABA_PADRAO;

  const irPara = useCallback(
    (v: string) => {
      const next = new URLSearchParams(params);
      // A aba padrão não suja a URL (/tags-ble continua sendo /tags-ble).
      if (v === ABA_PADRAO) next.delete("aba");
      else next.set("aba", v);
      // `replace`: trocar de aba não é navegação — o Voltar do browser deve sair da tela BLE,
      // não desfazer cliques de aba.
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  return (
    <div className="page">
      <PageHeader title="BLE" subtitle="As tags detectadas ao vivo e as estações que as varrem." />

      <Tabs
        className="min-h-0 flex-1"
        ariaLabel="Seção"
        value={aba}
        onValueChange={irPara}
        items={[
          { value: "tags", label: "Tags" },
          { value: "estacoes", label: "Estações" },
        ]}
      >
        <TabsContent value="tags" className="flex min-h-0 flex-1 flex-col">
          <TagsTab onVerEstacoes={() => irPara("estacoes")} />
        </TabsContent>
        <TabsContent value="estacoes" className="flex min-h-0 flex-1 flex-col">
          <EstacoesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
