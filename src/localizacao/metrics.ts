// MÉTRICAS comparáveis (dev.md §4): comparam a série de estimativas do motor contra o ground truth.
// Fase 0 entrega as duas mais baratas e universais — RMSE de posição e cobertura. As demais (IDF1,
// tempo de recuperação pós-oclusão, calibração de incerteza) entram quando o cenário tiver múltiplas
// entidades/oclusão/covariância (fora de escopo agora, ADR-012).
import type { LocatedEntity } from "./entity";
import type { TruthPoint } from "./simulate";
import { distM } from "./simulate";

export type Metrics = {
  /** RMSE (m) da posição estimada × real, sobre as amostras (tag,instante) COM estimativa. */
  positionRmseM: number;
  /** Fração de (tag,instante) para os quais o motor tinha uma posição. */
  coverage: number;
  /** Nº de amostras (tag,instante) efetivamente comparadas. */
  samples: number;
};

/**
 * `estimates[i]` = a saída do motor (LocatedEntity[]) APÓS o batch i. Compara cada tag do ground truth
 * do instante i com a estimativa de mesma id; acumula erro² (para o RMSE) e cobertura.
 */
export function computeMetrics(estimates: LocatedEntity[][], truth: TruthPoint[]): Metrics {
  let sqSum = 0;
  let n = 0;
  let covHit = 0;
  let covTot = 0;

  for (let i = 0; i < truth.length; i++) {
    const est = estimates[i] ?? [];
    const byId = new Map(est.map((e) => [e.id.toUpperCase(), e]));
    const positions = truth[i].positions;
    for (const id of Object.keys(positions)) {
      covTot++;
      const e = byId.get(id.toUpperCase());
      if (e && e.position) {
        covHit++;
        const d = distM(e.position, positions[id]);
        sqSum += d * d;
        n++;
      }
    }
  }

  return {
    positionRmseM: n ? Math.sqrt(sqSum / n) : Infinity,
    coverage: covTot ? covHit / covTot : 0,
    samples: n,
  };
}
