import { useCallback, useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import { useAuth } from "../../auth";
import { Alert, Badge, Button, Spinner, useConfirm } from "../../ui";
import { getBtStations, updateBtStation, deleteBtStation, type BtStation } from "../../api";
import { EstacoesList, estacaoViva } from "./EstacoesList";

// Aba ESTAÇÕES da tela BLE (spec-arquitetura-informacao §3, desenho C) — era a rota /estacoes.
// Cadastro das ESTAÇÕES BLE (os celulares/coletores que varrem o BLE e postam as leituras que a aba
// Tags mostra). A estação NÃO nasce de um formulário: ela se AUTO-DESCOBRE no hub
// (server/bt/stations.js → seen) no primeiro POST /api/bt/reading, com o id técnico como nome
// ("pendente"). Aqui o operador a BATIZA ("Doca 3"), (des)ativa e remove — e vê se ela está VIVA.
//
// A REGRA DE NEGÓCIO mora no SERVIDOR (formato do id, nome ≤ 60, ativo booleano): a tela envia e
// exibe o erro do 400. LGPD: só metadados de config.
//
// RBAC — o gate que a ROTA fazia agora é DAQUI (a /estacoes morreu; o item de menu que a escondia,
// também). Decisão registrada: a aba aparece para TODO autenticado, em modo SOMENTE-LEITURA quando
// falta `canConfigure`, e os controles de escrita não são renderizados (EstacoesList + gate em
// EstacoesList.test.tsx). Por quê ler é livre:
//   • o BACK já serve GET /api/bt-stations a qualquer autenticado (é o que dá nome à estação na aba
//     Tags, na saúde e na calibração) — esconder a aba não fecharia NADA no servidor, só cegaria o
//     operador;
//   • "a estação está viva?" é a resposta para "por que a tag sumiu?" — é diagnóstico, não
//     configuração, e é exatamente a costura que a tela unificada existe para permitir;
//   • esconder a aba reintroduziria a pergunta "onde vejo isso?", que é o custo que a spec mata.
// A ESCRITA (PATCH/DELETE) segue barrada no servidor de qualquer jeito — o gate da tela é sobre não
// oferecer a ação, não sobre confiar no cliente.

const REFRESH_MS = 5000; // repesca o registro (ultimaVezEm é carimbado a cada POST da estação)

export function EstacoesTab() {
  const { canConfigure } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<BtStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Tick do relógio: o status VIVA/SEM SINAL é derivado de `ultimaVezEm` — sem re-render periódico
  // uma estação que morre ficaria "viva" na tela até o próximo poll.
  const [agora, setAgora] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setRows(await getBtStations());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao carregar as estações");
    }
    setAgora(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Devolve `true` quando gravou — só então o editor da linha fecha (a lista é quem o controla).
  async function renomear(s: BtStation, nome: string): Promise<boolean> {
    setErr(null);
    try {
      await updateBtStation(s.id, { nome });
      await refresh();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao renomear a estação");
      return false;
    }
  }

  async function alternarAtivo(s: BtStation, ativo: boolean) {
    setErr(null);
    try {
      await updateBtStation(s.id, { ativo });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao atualizar a estação");
    }
  }

  async function remover(s: BtStation) {
    const ok = await confirm({
      title: `Remover a estação "${s.nome}"?`,
      description:
        "O registro (nome amigável) é apagado. Se o celular voltar a postar, a estação reaparece aqui com o id técnico, pendente de nome.",
      confirmLabel: "Remover",
      variant: "danger",
    });
    if (!ok) return;
    setErr(null);
    try {
      await deleteBtStation(s.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "falha ao remover a estação");
    }
  }

  const vivas = rows.filter((s) => estacaoViva(s, agora)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {/* Faixa de status do painel (o Badge que morava no PageHeader — a tela unificada tem UM
          header só, e ele não pode falar por duas abas). */}
      <div className="flex flex-wrap items-center gap-3 text-sec text-text-muted">
        <Badge tone={vivas > 0 ? "ok" : "warn"}>
          <RadioTower size={12} strokeWidth={1.75} aria-hidden />
          {rows.length > 0
            ? `${vivas} de ${rows.length} viva${vivas === 1 ? "" : "s"}`
            : "sem estações"}
        </Badge>
        {rows.length > 0 && (
          <span>as leituras destas estações são as tags da aba ao lado</span>
        )}
      </div>

      {err && (
        <Alert tone="alert">
          <span className="flex-1">{err}</span>
          <Button size="sm" onClick={refresh}>
            Tentar novamente
          </Button>
        </Alert>
      )}

      {loading ? (
        <div
          className="flex items-center gap-2 text-body text-text-muted"
          aria-busy="true"
          aria-label="Carregando estações"
        >
          <Spinner /> Carregando estações…
        </div>
      ) : (
        <EstacoesList
          rows={rows}
          agora={agora}
          canConfigure={canConfigure}
          onRename={renomear}
          onToggleAtivo={alternarAtivo}
          onRemove={remover}
        />
      )}
    </div>
  );
}
