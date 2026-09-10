// ─────────────────────────────────────────────────────────────────────────────
// EFICIÊNCIA — a decomposição honesta do rendimento de um posto. Agregação PURA.
//
// POR QUE ESTE MÓDULO EXISTE: pediram "uma taxa de eficiência no relatório". O sistema NÃO
// identifica pessoas (invariante do projeto: a caixa nunca exibe número, o id do tracker é
// interno e muda a cada re-associação; a fusão que daria nome migrou de repo — ADR-018).
// Então não existe "eficiência do funcionário X" a medir aqui, e fabricar esse número seria
// mentir. O que EXISTE é o rendimento de um POSTO num TURNO — e, se o posto tem dono conhecido
// naquele turno, a leitura é do gestor, não do sistema. Este módulo entrega o rendimento do
// posto com o denominador explícito, e cala quando não tem denominador.
//
// A DECOMPOSIÇÃO (é o ponto — um número só esconde a causa):
//
//     produtividade BRUTA  =  volume ÷ horas de TURNO
//     produtividade EFETIVA =  volume ÷ horas COM PRESENÇA
//     aproveitamento        =  horas com presença ÷ horas de turno
//
//     ⇒  bruta = efetiva × aproveitamento
//
// Essa identidade separa as DUAS causas de um resultado ruim, que exigem ações opostas:
//   • aproveitamento baixo  → o posto ficou VAZIO (escala, absenteísmo, remanejamento);
//   • efetiva baixa         → tinha gente e saiu pouco (método, treinamento, gargalo, defeito).
// Um indicador único somaria as duas e mandaria o gestor agir no lugar errado.
//
// A TAXA (%) só existe contra uma META informada — é ela que transforma "18 caixas/hora" em
// "82% do esperado". Sem meta o módulo devolve as produtividades e diz `semMeta`: número
// absoluto ainda serve para comparar turnos/dias entre si.
//
// LIMITES QUE O NÚMERO CARREGA (quem exibe precisa declarar):
//   • PAUSAS já saem do denominador (shiftRuler as exclui) — pausa não é ociosidade;
//   • a presença vem da análise por câmera na cadência real do motor: é amostragem, não relógio
//     de ponto. Com a frota saturada a amostra é grossa (o `activePct` é ponderado por TEMPO
//     desde 2026-09-04, então é imparcial — mas imprecisa);
//   • sem carimbo de turno (`ruler.stamped=false`) não há denominador de turno e tudo cala.
// ─────────────────────────────────────────────────────────────────────────────

/** Por que um número não existe. O consumidor troca o valor por esta razão — nunca por "0". */
export type MotivoAusencia =
  | "sem-turno" // o hub não carimbou turno no recorte (ou recorte vazio) → sem denominador
  | "sem-presenca" // turno medido, mas sem medição de ocupação → não dá p/ isolar a efetiva
  | "sem-volume" // não há indicador de volume no recorte (operação sem leitura de código)
  | "sem-meta"; // tudo medido, mas ninguém informou a meta → a TAXA não existe

export type EficienciaEntrada = {
  /** horas-bucket DENTRO do turno, pausas já excluídas (shiftRuler.hoursInShift). */
  horasTurno: number;
  /** % do tempo de turno com presença detectada (shiftRuler.occupancyPct). null = não medido. */
  ocupacaoPct: number | null;
  /** volume produzido no recorte — hoje: caixas lidas (readingKpis.boxes). null = sem o modo. */
  volume: number | null;
  /** meta de volume por hora TRABALHADA (informada pelo gestor). Ausente/≤0 → sem taxa. */
  metaPorHora?: number | null;
  /** rótulo da unidade de volume, só p/ o texto de quem exibe ("caixas"). */
  unidade?: string;
};

export type Eficiencia = {
  horasTurno: number;
  /** horas em que havia alguém no posto (turno × ocupação). null = ocupação não medida. */
  horasComPresenca: number | null;
  /** % do turno com presença — o "quanto o posto esteve guarnecido". */
  aproveitamentoPct: number | null;
  /** volume ÷ horas de turno — o rendimento do POSTO (inclui tempo vazio). */
  produtividadeBruta: number | null;
  /** volume ÷ horas com presença — o rendimento de QUEM ESTAVA LÁ. Base da taxa. */
  produtividadeEfetiva: number | null;
  /** produtividade EFETIVA ÷ meta, em %. É a "taxa de eficiência" pedida. */
  taxaPct: number | null;
  /** razão da ausência do número mais específico que faltou (null = tudo disponível). */
  motivo: MotivoAusencia | null;
  unidade: string;
};

const arredonda1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Calcula a decomposição de eficiência de um recorte já filtrado (período/turno/área).
 * PURA: recebe números, devolve números. Nada de fetch, relógio ou estado.
 */
export function eficiencia(e: EficienciaEntrada): Eficiencia {
  const unidade = e.unidade || "itens";
  const horasTurno = Number.isFinite(e.horasTurno) ? Math.max(0, e.horasTurno) : 0;
  const vazio: Eficiencia = {
    horasTurno,
    horasComPresenca: null,
    aproveitamentoPct: null,
    produtividadeBruta: null,
    produtividadeEfetiva: null,
    taxaPct: null,
    motivo: "sem-turno",
    unidade,
  };
  // Sem horas de turno não há denominador nenhum: nem bruta, nem efetiva, nem taxa.
  if (horasTurno <= 0) return vazio;

  const volume = typeof e.volume === "number" && Number.isFinite(e.volume) ? e.volume : null;
  const ocupacaoPct =
    typeof e.ocupacaoPct === "number" && Number.isFinite(e.ocupacaoPct)
      ? Math.max(0, Math.min(100, e.ocupacaoPct))
      : null;
  const horasComPresenca = ocupacaoPct === null ? null : arredonda1((horasTurno * ocupacaoPct) / 100);

  const produtividadeBruta = volume === null ? null : arredonda1(volume / horasTurno);
  // Presença ZERO com volume > 0 é contradição de medição (a câmera não viu quem produziu):
  // dividir por zero inventaria um infinito. Cala a efetiva e diz por quê.
  const produtividadeEfetiva =
    volume === null || horasComPresenca === null || horasComPresenca <= 0
      ? null
      : arredonda1(volume / horasComPresenca);

  const meta =
    typeof e.metaPorHora === "number" && Number.isFinite(e.metaPorHora) && e.metaPorHora > 0
      ? e.metaPorHora
      : null;
  const taxaPct =
    produtividadeEfetiva === null || meta === null
      ? null
      : Math.round((produtividadeEfetiva / meta) * 100);

  // O motivo aponta o elo que faltou, do mais estrutural ao mais superficial.
  let motivo: MotivoAusencia | null = null;
  if (volume === null) motivo = "sem-volume";
  else if (horasComPresenca === null || horasComPresenca <= 0) motivo = "sem-presenca";
  else if (meta === null) motivo = "sem-meta";

  return {
    horasTurno,
    horasComPresenca,
    aproveitamentoPct: ocupacaoPct === null ? null : Math.round(ocupacaoPct),
    produtividadeBruta,
    produtividadeEfetiva,
    taxaPct,
    motivo,
    unidade,
  };
}

/** Texto curto do porquê de um número não existir — fonte única (tela, PDF e CSV). */
export const MOTIVO_TEXTO: Record<MotivoAusencia, string> = {
  "sem-turno":
    "Sem turno carimbado no recorte — não há jornada para servir de denominador; nenhuma taxa é exibida.",
  "sem-presenca":
    "Presença não medida no recorte — dá para mostrar o rendimento do posto, não o de quem estava nele.",
  "sem-volume":
    "Sem indicador de volume no recorte (leitura de código) — a eficiência precisa de algo produzido para contar.",
  "sem-meta":
    "Meta não informada — os valores por hora aparecem, mas não há percentual a afirmar sem o esperado.",
};
