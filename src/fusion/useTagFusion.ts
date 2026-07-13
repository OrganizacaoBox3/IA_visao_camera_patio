// Orquestra a fusão tag↔pessoa de UMA câmera: a cada ~500ms monta um FusionFrame (tracks do hub +
// leituras BLE + homografia da câmera) e roda o associador (associate.ts) → mapa trackId→rótulo. Devolve
// um `labelFor` estável p/ o overlay pintar. Responsabilidade única: o TIMING/estado; a matemática mora
// em associate.ts e frame.ts (puros/testados). Desligado (enabled=false / sem readings) → labelFor null.
import { useEffect, useMemo, useRef } from "react";
import { TagTrackAssociator, type FusionConfig } from "./associate";
import { buildFusionFrame, type RawReading, type StationPoints } from "./frame";
import type { Matrix3, Vec2 } from "../vision/homography";
import type { HubAnalysis } from "../types/analysis";

type Params = {
  getHubAnalysis?: () => HubAnalysis | null; // tracks (caixas) desta câmera
  // Leituras BLE (globais) — POOL multi-fonte: todas as estações vivas simultaneamente (merge por
  // fonte em useDashboardSocket/source-pool.ts, F4); com 1 estação é a varredura corrente, como
  // sempre. O elo fonte→motor (stationId→sourceId) é feito por buildFusionFrame (frame.ts).
  getReadings?: () => RawReading[] | null;
  H: Matrix3 | null; // homografia da câmera (null = fallback por tamanho de caixa)
  stationPx?: Vec2; // ponto do chão da estação PRINCIPAL (0..1); undefined = default do frame.ts
  /** Pontos de chão de TODAS as estações (`calibration.stations`, spec multi-antena F5) — dão a
   *  cada fonte a SUA geometria (distByStation), o que ataca o rival radialmente confundível.
   *  ADITIVO: ausente = mundo de 1 antena (toda fonte contra a distância à principal). */
  stationsPx?: StationPoints;
  /** MACs (MAIÚSCULOS) das tags-âncora CADASTRADAS — excluídas das leituras antes da fusão
   *  (âncora tem posição conhecida, jamais está numa pessoa; ver buildFusionFrame). ADITIVO. */
  excludeTags?: ReadonlySet<string>;
  enabled?: boolean;
};

const TICK_MS = 500; // a fusão roda a ~2Hz — a associação é por JANELA, não por frame

/** Nº de estações calibradas a partir do qual a fusão multi-fonte faria sentido geométrico. */
const MULTI_SOURCE_MIN_STATIONS = 2;

/**
 * VEREDITO DO TORNEIO (eval/multi-antena.mjs, 2026-07-13 — régua PINADA A PRIORI): **NÃO PROMOVER**.
 *
 * Medido (8 cenários × 2 regimes de cadência, simulador — cobertura CIRCULAR, declarada; motor de
 * 2026-07-13 já COM o gate de medições distintas):
 *  • regime otimista (sim a 1 Hz): R1 PASSA (precisão 62,8% da melhor individual → 71,1%), mas
 *    R2 FALHA (cobertura 18,6% contra os 23,1% exigidos = 1,5× a melhor individual — o ganho real
 *    é 1,21×, não 1,5×) e R3 FALHA (conflito SOBE, 51,5% → 59,4%; a régua pedia ≤ 30,9%).
 *  • regime da FÍSICA REAL (tag a ~2,5 s — o campo): R1 TAMBÉM FALHA. Ligar a 2ª antena PIORA a
 *    precisão (51,7% da melhor individual → 47,1%). Isso viola a invariante do dono — rótulo
 *    ERRADO é pior que rótulo NENHUM. O ganho do regime otimista VIRA PREJUÍZO na física medida.
 *    (Cobertura absoluta lá: 2,0% → 2,7%. Com o gate honesto de medições distintas, a tag de 2,5 s
 *    quase não entrega evidência numa janela de 8 s — é a aritmética do laudo, não um bug.)
 *
 * O que a 2ª antena NÃO resolve (medido, e é o achado que manda na onda): pessoa PARADA. O
 * cenário `parado` dá cobertura 0,0% em TODOS os braços — inclusive com 2 antenas, nos dois
 * regimes. O caminho de Fisher é CORRELAÇÃO, e correlação exige movimento POR FONTE
 * (`movementVetoed` roda por estação). Multilateração de tag parada exige a evidência de distância
 * ABSOLUTA (distM POR estação), que o motor não tem. A 2ª antena ataca o RIVAL RADIALMENTE
 * CONFUNDÍVEL — não o alvo imóvel, que é 41,9% do campo.
 *
 * REGRA 13 (medida antes de somar): concordância-no-erro entre A e B = 29,6% [15,9–48,5] n=27,
 * contra um teto model-free de 44,5% — 0,7×, ou seja, NO teto. PONTO CEGO DECLARADO: o simulador
 * sorteia um ε INDEPENDENTE por estação e não tem mecanismo de erro compartilhado além da
 * geometria — ele é ESTRUTURALMENTE INCAPAZ de reproduzir o 4,7×-acima-do-teto medido no CAMPO.
 * Este 0,7× é propriedade do SIM, não evidência de independência no campo. Só o campo decide.
 *
 * Por isso a config sai VAZIA: DEFAULTS puros ⇒ caminho BIT-A-BIT idêntico ao de hoje. O
 * `stationsPx` CONTINUA sendo passado ao frame (a geometria por fonte chega ao motor e fica
 * INERTE — `distByStation` só é lido pelo caminho multi-fonte): é o pré-requisito, ligado e
 * testado, esperando o motor ficar honesto. Virar `MULTI_SOURCE_FISHER_PROMOVIDO` para true é UMA
 * LINHA — mas só depois de o torneio passar.
 */
const MULTI_SOURCE_FISHER_PROMOVIDO = false;

/**
 * CONFIG DO MOTOR PARA ESTE CALL-SITE — a promoção do `multiSourceFisher` mora AQUI, não nos
 * DEFAULTS de associate.ts (que seguem sendo o mundo de pesquisa, byte-compat com os pinos).
 *
 * `promovido` (2º parâmetro) existe para o TESTE conseguir exercitar a forma da config promovida
 * sem esperar a flag virar — sem ele, o teste da promoção só poderia ser escrito no dia da
 * promoção, que é quando ninguém escreve teste.
 */
export function fusionConfigFor(
  stationsPx?: StationPoints,
  promovido: boolean = MULTI_SOURCE_FISHER_PROMOVIDO,
): FusionConfig {
  const n = stationsPx ? Object.keys(stationsPx).length : 0;
  return promovido && n >= MULTI_SOURCE_MIN_STATIONS ? { multiSourceFisher: true } : {};
}

export function useTagFusion({
  getHubAnalysis,
  getReadings,
  H,
  stationPx,
  stationsPx,
  excludeTags,
  enabled = true,
}: Params) {
  const labels = useRef<Map<number, string>>(new Map());
  // Espelho ADITIVO do mapa de rótulos: o CONJUNTO de tags já associadas a alguma pessoa
  // (chave rotulo||mac — a mesma do FusionFrame). Consumido pelo plot de tags no chão p/
  // SUPRIMIR o anel de quem já tem rótulo AR na caixa. Recomputado junto do mapa (2 Hz).
  const assigned = useRef<ReadonlySet<string>>(new Set());

  // A config depende da GEOMETRIA (quantas estações têm ponto calibrado) → o associador é
  // RECRIADO quando ela muda (o cfg é lido no construtor). Marcar a 2ª estação no painel de
  // calibração liga a fusão multi-fonte sem recarregar a página.
  const cfg = useMemo(() => fusionConfigFor(stationsPx), [stationsPx]);

  useEffect(() => {
    if (!enabled || !getHubAnalysis || !getReadings) {
      labels.current = new Map();
      assigned.current = new Set();
      return;
    }
    const a = new TagTrackAssociator(cfg); // novo motor por config/câmera — buffer começa vazio
    const id = window.setInterval(() => {
      const hd = getHubAnalysis();
      const readings = getReadings();
      if (!hd || !readings || !readings.length) return;
      const now = performance.now();
      a.push(buildFusionFrame(hd.tracks, readings, H, now, stationPx, excludeTags, stationsPx));
      const m = new Map<number, string>();
      for (const as of a.assign(now)) if (as.tag) m.set(as.trackId, as.tag);
      labels.current = m;
      assigned.current = new Set(m.values());
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [getHubAnalysis, getReadings, H, stationPx, stationsPx, excludeTags, enabled, cfg]);

  // Getters estáveis (leem os refs) → não quebram o React.memo de quem consome o overlay.
  return useMemo(
    () => ({
      labelFor: (trackId: number): string | null => labels.current.get(trackId) ?? null,
      /** Tags (chave rotulo||mac) ATUALMENTE associadas a alguma pessoa — aditivo. */
      assignedTags: (): ReadonlySet<string> => assigned.current,
    }),
    [],
  );
}
