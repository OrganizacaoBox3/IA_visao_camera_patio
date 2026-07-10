// Baseline por PERMUTAÇÃO (shuffle) da taxa de conflito de atribuição (identity-metrics.ts).
//
// PERGUNTA (pedido do especialista científico, docs/cientifica/): a `conflictRate` medida em
// identity-metrics.ts é alta mesmo com poucas tags (ex.: ~46,9% no canônico, ~90-98% na
// multidão) porque a ASSINATURA de cada pessoa é um único escalar ruidoso (distância radial à
// estação, 1-D) — colisão de assinatura é comum nesse espaço mesmo SEM confusão de identidade
// real. Quanto do conflito medido é "aritmética do acaso" (o próprio formato do problema, não a
// qualidade dos scores) vs. informação real que os scores carregam?
//
// MÉTODO: embaralhar a ATRIBUIÇÃO DE IDENTIDADE das séries de RSSI entre as tags — mantendo a
// FORMA/ruído de cada série intacta (a série ainda corresponde ao movimento real de alguém), só
// trocando QUAL NOME DE TAG é dono de qual série, por uma bijeção FIXA (a MESMA do início ao fim
// do cenário — não por tick, senão destrói a correlação temporal que faz o associador funcionar
// ou não). Rodar o MESMO associador sobre essa versão embaralhada e medir a taxa de conflito
// resultante.
//
// RESULTADO MEDIDO (2026-07-10, shuffle-baseline.test.ts) — E POR QUE ELE TINHA DE DAR ISSO:
// shuffleConflictRate(sc, seed) é EXATAMENTE (bit-a-bit) igual à conflictRate real, para TODO
// seed testado (≥6 seeds) e TODO cenário testado (canonico, multidao, bloco, cruzamento,
// ruido-alto). Isso NÃO é coincidência nem falta de amostra — é uma CONSEQUÊNCIA MATEMÁTICA da
// definição de conflictRate: `Assignment.hadConflict` (associate.ts/assign()) é calculado
// INTEIRAMENTE a partir da matriz de scores por (pista, tag) — margem entre o par escolhido e o
// MELHOR CONCORRENTE na mesma linha e na mesma coluna — e NUNCA olha o NOME da tag nem a verdade.
// Renomear tags por uma bijeção FIXA é uma permutação de COLUNAS da matriz de scores: os valores
// numéricos de cada célula não mudam, só o rótulo da coluna onde eles aparecem. Máximo de uma
// linha (marginPista), máximo de uma coluna (marginTag) e a decisão de "houve conflito" são,
// todos, invariantes a QUALQUER reordenação/renomeação de colunas — não existe permutação capaz
// de mudar o resultado. Conclusão: este desenho de shuffle (só trocar NOMES mantendo os SCORES
// intactos) é estruturalmente INCAPAZ de separar "aritmética do acaso" de "informação real dos
// scores" para conflictRate — o teste dá sempre a MESMA resposta, informativamente vazio para
// essa pergunta específica. A predição (a) do especialista ("no canônico a real ficará
// visivelmente abaixo do shuffle") é FALSEADA, mas por um motivo mais forte do que "o sinal é
// fraco": a métrica escolhida é, por construção, cega a qualquer shuffle de identidade. Um
// baseline que realmente testasse "o quanto do conflito é geometria pura" precisaria destruir a
// CORRESPONDÊNCIA FÍSICA entre a série de RSSI e a trajetória real que a gerou (ex.: substituir o
// RSSI por ruído independente da posição, ou embaralhar o ALINHAMENTO temporal) — não apenas
// renomear quem é dono de qual série. Fica registrado como ACHADO NEGATIVO honesto: a peça 1 do
// pedido roda e mede exatamente o que foi especificado, e o resultado (nulo, mas explicado) É a
// resposta científica válida.
//
// DECISÃO DE DESIGN (documentada, pedida pelo prompt): a taxa de conflito (`conflictRate` em
// identity-metrics.ts) é uma propriedade da MATRIZ DE SCORES do associador — não compara contra
// verdade-terreno (só depende de `Assignment.hadConflict`, calculado dentro de assign() a partir
// da margem top-2 entre candidatos). Por isso NÃO é preciso recalcular `truthTagByTrack` para
// medir conflictRate sob shuffle: `truthTagByTrack` só é usada por computeIdentityMetrics para
// filtrar tracks-fantasma (`trackId in tick.truthTagByTrack`), o que não muda ao permutar os
// RÓTULOS das leituras BLE (os trackIds continuam os mesmos). Reescrever a verdade também seria
// válido, mas desnecessário para esta métrica — mais simples é melhor (KISS). Esta MESMA
// propriedade (conflictRate não olha nomes) é o que torna o experimento matematicamente nulo —
// ver o parágrafo acima.
//
// Responsabilidade única: só construir o cenário embaralhado + expor o atalho de conflictRate
// sob shuffle. Não mede reliability nem outros contadores — reusa replayFusion/identity-metrics
// como estão.
import type { SimAnchor, SimFusionScenario } from "./sim";
import type { FusionConfig } from "./associate";
import { replayFusion } from "./replay-fusion";

// PRNG determinístico — MESMO padrão de sim.ts (LCG de Numerical Recipes). Zero Math.random.
type Rng = () => number;
function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Bijeção FIXA e determinística de `items` (Fisher-Yates sobre o LCG de `seed`). Com 2 itens há
 * só 2 permutações possíveis (identidade ou troca) — uma identidade sorteada não embaralharia
 * nada, então perturbamos o seed deterministicamente e tentamos de novo (ainda 100%
 * determinístico: mesmo seed de entrada → mesmo resultado sempre). Com <2 itens não há o que
 * trocar — devolve cópia intacta.
 */
function fixedPermutation<T>(items: readonly T[], seed: number): T[] {
  if (items.length < 2) return [...items];
  let s = seed >>> 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = lcg(s);
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    if (out.some((v, i) => v !== items[i])) return out;
    s = (s + 0x9e3779b9) >>> 0; // identidade sorteada (comum com poucos itens) → perturba e retenta
  }
  return [...items].reverse(); // fallback determinístico; nunca deveria chegar aqui com ≥2 itens
}

/**
 * Devolve uma CÓPIA do cenário com o MAC de toda leitura BLE (`SimTick.readings[].mac`) trocado
 * por uma bijeção FIXA (sorteada 1× por `seed`, não por tick) — a série de RSSI de cada tag
 * mantém sua forma/ruído intactos, só passa a se chamar OUTRO nome de tag do início ao fim do
 * cenário. NÃO mexe em H/stationPx/tracks/truthTagByTrack (ver docstring do módulo: conflictRate
 * não depende da verdade).
 *
 * Tags-ÂNCORA (`sc.anchors`, quando presentes) ficam DE FORA da permutação: são ferragem fixa
 * cadastrada por MAC literal (excludeTags em frame.ts/replay-fusion.ts) — trocar o MAC de uma
 * âncora por um de pessoa quebraria a exclusão (uma "pessoa" passaria a ser filtrada, ou uma
 * âncora passaria a competir). A pergunta deste baseline é sobre confusão PESSOA↔PESSOA; âncoras
 * não fazem parte dela.
 */
export function shuffledScenario(sc: SimFusionScenario, seed: number): SimFusionScenario {
  const anchorMacs = new Set((sc.anchors ?? []).map((a: SimAnchor) => a.mac));

  const tagSet = new Set<string>();
  for (const tick of sc.ticks) {
    for (const r of tick.readings) {
      if (!anchorMacs.has(r.mac)) tagSet.add(r.mac);
    }
  }
  const tags = [...tagSet].sort(); // ordem determinística (independente de ordem de iteração)
  const shuffled = fixedPermutation(tags, seed);
  const mapping = new Map<string, string>(tags.map((t, i) => [t, shuffled[i]]));

  const ticks = sc.ticks.map((tick) => ({
    ...tick,
    readings: tick.readings.map((r) =>
      anchorMacs.has(r.mac) ? r : { ...r, mac: mapping.get(r.mac) ?? r.mac },
    ),
  }));

  return { ...sc, ticks };
}

/**
 * Taxa de conflito (`IdentityMetrics.conflictRate`) do associador rodando sobre a versão
 * EMBARALHADA do cenário (mesma config/warmup do replay real) — o "conflito sob acaso puro" para
 * comparar contra a taxa medida no cenário original (`replayFusion(sc, cfg).metrics.conflictRate`).
 * MEDIDO: esta taxa é SEMPRE bit-a-bit igual à real, para qualquer seed — ver o achado no
 * cabeçalho do módulo (conflictRate é invariante a renomear tags; a permutação não pode mudá-la).
 */
export function shuffleConflictRate(
  sc: SimFusionScenario,
  cfg?: FusionConfig,
  seed = 1,
  warmupMs?: number,
): number {
  return replayFusion(shuffledScenario(sc, seed), cfg, warmupMs).metrics.conflictRate;
}

/**
 * Média de `shuffleConflictRate` sobre várias permutações (seeds) — não depender de uma
 * permutação só de sorte (pedido do especialista: ≥3 seeds). Puro/determinístico: mesma entrada,
 * mesma média sempre.
 */
export function meanShuffleConflictRate(
  sc: SimFusionScenario,
  seeds: readonly number[],
  cfg?: FusionConfig,
  warmupMs?: number,
): number {
  const rates = seeds.map((seed) => shuffleConflictRate(sc, cfg, seed, warmupMs));
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}
