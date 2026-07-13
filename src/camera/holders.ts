// Ciclo de vida dos PROCESSADORES por zona (Holder). União DISCRIMINADA: o compilador estreita
// `proc` pelo `modo` no laço quente do rAF — um pareamento errado modo↔processador vira erro de
// tipo. "exclusao" e "proibida" NÃO instanciam processador (o laço pula antes de holderFor) →
// fora da união. PROIBIDA: o PRODUTOR do alarme é o MOTOR DO HUB (24/7 — spec alerta-por-
// atividade F2, diretriz "lógica no back"); um espelho cliente é fase futura.
import { AtividadeProcessor } from "../processors/atividade";
import { LeituraProcessor } from "../processors/leitura";
import { ObjetosProcessor } from "../processors/objetos";
import { FadigaProcessor } from "../processors/fadiga";
import { loadFadigaThresholds } from "../fadiga/calibration";
import type { Zone } from "../zones";

export type Holder =
  | { modo: "atividade"; proc: AtividadeProcessor }
  | { modo: "leitura"; proc: LeituraProcessor }
  | { modo: "objetos"; proc: ObjetosProcessor }
  | { modo: "fadiga"; proc: FadigaProcessor };

// Perfil "Longo alcance": só atividade/objetos consomem; idempotente nos dois.
function applyLongRange(h: Holder, longRange: boolean): void {
  if (h.modo === "atividade") h.proc.setLongRange(longRange);
  else if (h.modo === "objetos") h.proc.setLongRange(longRange);
}

function makeHolder(modo: Holder["modo"]): Holder {
  switch (modo) {
    case "leitura":
      return { modo, proc: new LeituraProcessor() };
    case "objetos":
      return { modo, proc: new ObjetosProcessor() };
    case "fadiga": {
      const proc = new FadigaProcessor();
      proc.setThresholds(loadFadigaThresholds()); // calibração global persistida
      return { modo, proc };
    }
    case "atividade":
      return { modo, proc: new AtividadeProcessor(performance.now()) };
  }
}

/**
 * Obtém (ou cria) o processador da zona, mantendo o perfil "longo alcance" em dia. Troca de modo
 * descarta o processador antigo (dispose) e o crop de fadiga associado. Zonas "exclusao" e
 * "proibida" nunca chegam aqui em regime (o laço pula antes); o mapeamento p/ atividade preserva
 * o fallback histórico do `else`. PROIBIDA não tem processador cliente NESTA ONDA por decisão de
 * produto: o produtor do alerta de presença é o MOTOR DO HUB (cobre 24/7 sem espectador) —
 * LIMITAÇÃO CONHECIDA: câmera sem hub não alerta zona proibida por ora (fallback cliente
 * espelhado é fase futura, spec alerta-por-atividade F1×F2).
 */
export function holderFor(
  holders: Map<string, Holder>,
  crops: Map<string, HTMLCanvasElement>,
  z: Zone,
  longRange: boolean,
): Holder {
  const cur = holders.get(z.id);
  if (cur && cur.modo === z.modo) {
    applyLongRange(cur, longRange); // toggle em runtime chega ao processador vivo
    return cur;
  }
  cur?.proc.dispose();
  if (cur?.modo === "fadiga") crops.delete(z.id);
  const h = makeHolder(z.modo === "exclusao" || z.modo === "proibida" ? "atividade" : z.modo);
  holders.set(z.id, h);
  applyLongRange(h, longRange); // recém-criado herda o perfil atual da câmera
  return h;
}
