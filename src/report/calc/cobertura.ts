// ─────────────────────────────────────────────────────────────────────────────
// COBERTURA DA ANÁLISE — quanto do período foi REALMENTE analisado.
//
// O PROBLEMA QUE ISTO RESOLVE. O relatório sabia dizer "0 alertas", "0 travessias", "nenhuma
// parada" — e essas quatro palavras significam duas coisas OPOSTAS que a tela não separava:
//   (a) "observei a hora inteira e não aconteceu nada"  → operação tranquila;
//   (b) "a câmera estava cega / a IA não rodou"         → não faço ideia do que aconteceu.
// Exibir (b) com a cara de (a) é falso-OK: o gestor fecha o relatório achando que o pátio
// estava calmo justamente no período em que ninguém estava olhando. É a mesma classe de erro
// que a auditoria A6 já tinha pego na ociosidade, agora resolvida com o número que faltava.
//
// A MEDIDA. O hub já mede `observedMs` por hora×câmera — tempo que a análise REALMENTE
// observou, com teto por rodada (buraco maior que o teto é ausência de medição, não
// observação; ver server/analysis/pipeline.js). Este módulo só divide pelo tempo que DEVERIA
// ter sido observado. Nada aqui é estimado: é uma razão entre dois tempos medidos.
//
// O DENOMINADOR (a parte que se contesta, então está escrita). Para cada câmera:
//   início = max(início da janela, primeira hora em que aquela câmera aparece no histórico)
//   fim    = min(fim da janela, agora)
// e todas as horas nesse intervalo entram no denominador — INCLUSIVE as que não produziram
// bucket nenhum. É o caso que mais importa: câmera que morreu às 14h e nunca mais voltou
// simplesmente SOME dos dados, e um denominador feito só com as horas existentes daria 100%
// de cobertura para uma câmera cega. Por isso o denominador vem da linha do tempo, não do dado.
//
// O que NÃO entra no denominador, de propósito:
//   • horas anteriores à primeira aparição da câmera (ela não existia — não é "não medimos");
//   • horas futuras (fim é limitado por `agora`);
//   • câmeras DESATIVADAS (`camerasForaDeOperacao`) — não era para medir, então não conta
//     como buraco. Teste e manutenção CONTAM: era para medir e não mediu.
//
// RESIDUAL DECLARADO: a cobertura é do PERÍODO, sem recorte de turno. Uma hora que não gerou
// bucket não tem carimbo de turno — não há como saber se ela cairia dentro do filtro. Preferir
// um número do período inteiro a um número de turno com denominador inventado é a mesma regra
// de sempre. A UI diz isso em texto, não em nota de rodapé.
// ─────────────────────────────────────────────────────────────────────────────

import type { Dataset } from "./atividade";
import { periodDays, type Period } from "./common";

const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

export type Cobertura = {
  /** % do tempo esperado que a análise realmente observou. `null` = sem como medir. */
  pct: number | null;
  /** ms observados e ms esperados — o numerador e o denominador, sempre visíveis. */
  observadoMs: number;
  esperadoMs: number;
  /** horas×câmera que não produziram NENHUM dado (o buraco que não aparece na tabela). */
  horasSemDado: number;
  /** horas×câmera no denominador (o total contra o qual `horasSemDado` se lê). */
  horasEsperadas: number;
  /** câmeras consideradas (as desativadas ficam de fora). */
  cameras: number;
  /** Por que não deu para medir — `null` quando `pct` existe. */
  motivo: MotivoCobertura | null;
};

export type MotivoCobertura = "sem-dado" | "sem-medicao-de-tempo";

export const MOTIVO_COBERTURA_TEXTO: Record<MotivoCobertura, string> = {
  "sem-dado": "Nenhum dado de análise no período — não há o que cobrir.",
  "sem-medicao-de-tempo":
    "O hub que gravou este período não registrava tempo observado; a cobertura não pode ser calculada para trás.",
};

/** Piso a partir do qual o período é considerado bem coberto. Abaixo disso, todo ZERO do
 *  relatório passa a ser exibido como "não medido" em vez de afirmação. 80% é escolha de
 *  produto (não constante da natureza): abaixo de 4/5 do tempo observado, a ausência de
 *  ocorrência deixa de ser evidência de que nada aconteceu. */
export const COBERTURA_OK_PCT = 80;

const chaveSlot = (cameraId: string, hourStart: number) => `${cameraId}|${hourStart}`;

/** Início da janela do período (epoch-ms), na mesma geometria de `windows()`. */
function janelaInicioMs(ds: Dataset, period: Period): number {
  return ds.startMs + Math.max(0, ds.days - periodDays[period]) * DIA_MS;
}

/**
 * Cobertura da análise no período.
 * @param ds dataset INTEIRO (o denominador precisa das horas que não geraram célula)
 * @param period recorte de período (o de turno não se aplica — ver o cabeçalho)
 * @param camerasForaDeOperacao ids de câmera DESATIVADAS (não era para medir → fora do
 *        denominador). Vazio quando o chamador não sabe: o resultado é conservador (conta tudo).
 * @param agora relógio injetado (teste)
 */
export function cobertura(
  ds: Dataset,
  period: Period,
  camerasForaDeOperacao: ReadonlySet<string> = new Set(),
  agora: number = Date.now(),
): Cobertura {
  const vazio: Cobertura = {
    pct: null,
    observadoMs: 0,
    esperadoMs: 0,
    horasSemDado: 0,
    horasEsperadas: 0,
    cameras: 0,
    motivo: "sem-dado",
  };
  if (!ds.cells.length) return vazio;

  const inicio = janelaInicioMs(ds, period);
  const fim = Math.min(agora, ds.startMs + ds.days * DIA_MS);
  if (fim <= inicio) return vazio;

  // 1) Observado por slot (câmera × hora). O hub replica o MESMO observedMs em cada zona da
  //    câmera naquela hora (pipeline.flushWindows), então somar zonas multiplicaria o tempo
  //    observado pelo número de zonas — daí MAX, não soma.
  const observadoPorSlot = new Map<string, number>();
  const primeiraHoraDaCamera = new Map<string, number>();
  let algumObservedMs = false;
  for (const c of ds.cells) {
    const cameraId = c.cameraId;
    const hourStart = c.hourStart;
    if (!cameraId || typeof hourStart !== "number") continue; // bucket de hub antigo
    const anterior = primeiraHoraDaCamera.get(cameraId);
    if (anterior === undefined || hourStart < anterior)
      primeiraHoraDaCamera.set(cameraId, hourStart);
    if (hourStart < inicio || hourStart >= fim) continue; // fora da janela do período
    if (typeof c.observedMs === "number") {
      algumObservedMs = true;
      const k = chaveSlot(cameraId, hourStart);
      observadoPorSlot.set(k, Math.max(observadoPorSlot.get(k) ?? 0, c.observedMs));
    } else {
      observadoPorSlot.set(chaveSlot(cameraId, hourStart), observadoPorSlot.get(chaveSlot(cameraId, hourStart)) ?? 0);
    }
  }
  if (!primeiraHoraDaCamera.size) return vazio;
  // Hub ANTIGO: os buckets existem mas nenhum traz `observedMs`. Calcular daria 0%, que se
  // leria como "ninguém analisou nada" — uma acusação sobre um período que só não foi medido
  // com este instrumento. Cala e diz por quê.
  if (!algumObservedMs)
    return { ...vazio, cameras: primeiraHoraDaCamera.size, motivo: "sem-medicao-de-tempo" };

  // 2) Denominador: a LINHA DO TEMPO de cada câmera, não as horas que sobreviveram no dado.
  let observadoMs = 0;
  let esperadoMs = 0;
  let horasSemDado = 0;
  let horasEsperadas = 0;
  let cameras = 0;
  for (const [cameraId, primeira] of primeiraHoraDaCamera) {
    if (camerasForaDeOperacao.has(cameraId)) continue; // desativada: não era p/ medir
    cameras += 1;
    const de = Math.max(inicio, Math.floor(primeira / HORA_MS) * HORA_MS);
    for (let h = de; h < fim; h += HORA_MS) {
      // A última hora é PARCIAL (ainda está correndo): esperar 60min dela acusaria de buraco
      // um tempo que simplesmente ainda não passou.
      const esperado = Math.min(HORA_MS, fim - h);
      if (esperado <= 0) continue;
      const obs = observadoPorSlot.get(chaveSlot(cameraId, h));
      horasEsperadas += 1;
      esperadoMs += esperado;
      if (obs === undefined) {
        horasSemDado += 1; // hora que não gerou bucket nenhum — o buraco invisível na tabela
        continue;
      }
      observadoMs += Math.min(obs, esperado); // não se observa mais do que a hora dura
    }
  }
  if (!esperadoMs || !cameras) return { ...vazio, cameras };
  return {
    pct: Math.round((observadoMs / esperadoMs) * 100),
    observadoMs,
    esperadoMs,
    horasSemDado,
    horasEsperadas,
    cameras,
    motivo: null,
  };
}

/** O período está bem coberto o bastante para um ZERO ser afirmação? */
export function coberturaConfiavel(c: Cobertura): boolean {
  return c.pct !== null && c.pct >= COBERTURA_OK_PCT;
}

/**
 * O texto que acompanha um ZERO no relatório. É aqui que "0 ocorrências" deixa de ser uma
 * afirmação sozinha: ou ela vem com a cobertura que a sustenta, ou vem com o aviso de que o
 * período não foi observado o bastante para afirmar coisa alguma.
 */
export function textoDeZero(c: Cobertura): string {
  if (c.pct === null) return "sem medição de cobertura no período — não é possível afirmar ausência";
  if (coberturaConfiavel(c)) return `${c.pct}% do período analisado`;
  return `atenção: só ${c.pct}% do período foi analisado — ausência não é evidência aqui`;
}

/** Horas em ms → texto curto ("2h 30min"), para a tela e o CSV falarem igual. */
export function duracaoHumana(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}min`;
}
