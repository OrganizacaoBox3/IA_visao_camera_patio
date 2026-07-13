// COSTURA do cadastro de estações (server/bt/stations.js → GET /api/bt-stations) com a interface:
// o operador batiza a estação em /estacoes ("Doca 3") e é ESTE módulo que faz o nome chegar em todo
// lugar onde antes aparecia o ID TÉCNICO cru ("tc22-a1b2" — o que o app do celular carimba nas
// leituras). Responsabilidade única: resolver id → nome. Não desenha, não decide, não persiste.
//
// A REGRA mora no BACK (formato do id, nome ≤ 60, auto-descoberta): aqui só se LÊ o registro.
//
// CADÊNCIA (decisão registrada): 1 fetch no mount + POLL LEVE de 30 s enquanto habilitado.
//  • O registro muda RARO (batismo/desativação manual) — invalidar por evento pediria um contrato de
//    socket novo para um payload de 3 campos: ruído (filtro Signal×Noise da doutrina).
//  • Mas ele muda SOZINHO: a estação NASCE por auto-descoberta ao postar a 1ª leitura. Sem poll, o
//    operador ficaria olhando o id cru até dar F5. 30 s é barato (lista de dezenas de linhas, sem
//    imagem) e fecha esse buraco.
//
// FALLBACK — degradação segura (nunca deixa a UI vazia): hub antigo (404), erro de rede, estação
// ainda não registrada ou nome em branco ⇒ `nameOf` devolve o PRÓPRIO id. Um erro de poll preserva
// a última lista boa (não pisca de volta para o id).
//
// LGPD: só metadados de configuração (id/nome/ativo). Nenhuma leitura de RSSI trafega aqui.
import { useCallback, useEffect, useState } from "react";
import { getBtStations, type BtStation } from "../api";

const REFRESH_MS = 30_000; // poll leve do registro (ver "CADÊNCIA" acima)

/** Rótulo completo de uma estação: o NOME (o que o operador lê) + o id TÉCNICO (o que ele digita
 *  no app do celular — segue visível, mas discreto). `nome === id` ⇒ estação ainda pendente de
 *  batismo em /estacoes (o back semeia o nome com o próprio id). */
export type StationLabel = { id: string; nome: string };

/**
 * PURO (testável sem React): nome amigável de uma estação.
 * Fallback SEMPRE: id desconhecido no registro, registro vazio (hub antigo/fetch falhou) ou nome em
 * branco → devolve o próprio id. Id vazio ("" = fonte única implícita, retrocompat) → "" — quem
 * chama decide o texto de ausência ("Estação", "sem id").
 */
export function stationNameOf(stations: readonly BtStation[], id: string): string {
  const key = String(id ?? "");
  if (!key) return "";
  const s = stations.find((x) => x.id === key);
  return s?.nome?.trim() || key;
}

/** PURO: o par {id, nome} que os componentes exibem (nome em 1º plano, id discreto). */
export function stationLabelOf(stations: readonly BtStation[], id: string): StationLabel {
  return { id: String(id ?? ""), nome: stationNameOf(stations, id) };
}

/**
 * Registro de estações + o resolvedor id→nome. `enabled=false` não faz rede (e mantém a lista vazia
 * ⇒ nameOf devolve o id: a UI degrada para o comportamento antigo, nunca para o vazio).
 */
export function useStationNames(enabled = true): {
  stations: BtStation[];
  nameOf: (id: string) => string;
  labelOf: (id: string) => StationLabel;
} {
  const [stations, setStations] = useState<BtStation[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => {
      getBtStations()
        .then((rows) => {
          if (alive && Array.isArray(rows)) setStations(rows);
        })
        .catch(() => {
          /* hub antigo / sem rede / sem permissão: preserva o último registro; nameOf cai no id */
        });
    };
    load(); // primeira carga imediata (não espera o primeiro tick)
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [enabled]);

  const nameOf = useCallback((id: string) => stationNameOf(stations, id), [stations]);
  const labelOf = useCallback((id: string) => stationLabelOf(stations, id), [stations]);
  return { stations, nameOf, labelOf };
}
