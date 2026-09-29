// COMPARAR ATIVIDADE/FLUXO ENTRE DIAS OU TURNOS (2026-09-29) — agregações puras.
//
// O relatório já comparava "este período × o anterior de mesmo tamanho". O que faltava era a
// pergunta que o gestor faz de verdade: "a segunda desta semana foi pior que a da passada?",
// "a Manhã rende mais que a Tarde?". Um RECORTE é (dia, turno) — dia = um dia do histórico
// ou "todos" (o histórico carregado inteiro); turno = um turno ou "Todos".
//
// HONESTIDADE DO DENOMINADOR: um turno de 8h contra um dia de 24h, somados, "prova" qualquer
// coisa. Por isso cada recorte carrega as HORAS COM ANÁLISE e o fluxo ganha uma linha "por hora
// analisada"; e `avisoDeDuracao` avisa quando os dois lados foram medidos em durações muito
// diferentes. Sem medição de um lado, o delta é `null` — nunca um 0% inventado.
import type { Cell, Dataset } from "./atividade";
import type { FlowCell, FlowDataset } from "./flow";
import {
  ALL_SHIFTS,
  LEGACY_SHIFTS,
  deltaPct,
  inShift,
  shiftStateOf,
  type ShiftFilter,
  type ShiftStamp,
} from "./common";

export type Recorte = { dia: number | "todos"; turno: ShiftFilter };
export const RECORTE_PADRAO: Recorte = { dia: "todos", turno: ALL_SHIFTS };

type Bucket = ShiftStamp & { dayIndex: number; hour: number };
export function noRecorte(c: Bucket, r: Recorte): boolean {
  return (r.dia === "todos" || c.dayIndex === r.dia) && inShift(c, r.turno);
}

export type MetricasRecorte = {
  /** Horas (dia×hora) com ao menos um bucket de ATIVIDADE — o denominador honesto do recorte. */
  horasAnalisadas: number;
  /** Ocupação média ponderada por amostras; `null` = nada medido (não é 0%). */
  ocupacaoPct: number | null;
  alertas: number;
  /** Área de maior ocupação no recorte; `null` sem atividade. */
  areaMaisAtiva: string | null;
  entradas: number;
  saidas: number;
  travessias: number;
  /** Travessias por hora analisada; `null` sem hora analisada (não divide por zero). */
  travessiasPorHora: number | null;
  horaPico: number | null;
  temAtividade: boolean;
  temFluxo: boolean;
  /** O recorte pede um turno CADASTRADO, mas os buckets de fluxo do dia não têm carimbo de
   *  turno (pendência do hub — flow.ts §8). Aí o filtro nunca casa e o fluxo daria ZERO com
   *  cara de medição: marcamos para a comparação mostrar "—", não 0. */
  fluxoSemCarimbo: boolean;
};

function ocupacao(cells: Cell[]): number | null {
  if (!cells.length) return null;
  const comAmostra = cells.filter((c) => typeof c.samples === "number" && c.samples > 0);
  if (comAmostra.length === cells.length) {
    const tot = comAmostra.reduce((a, c) => a + (c.samples ?? 0), 0);
    const ativ = comAmostra.reduce((a, c) => a + (c.activeSamples ?? 0), 0);
    return tot ? Math.round((ativ / tot) * 100) : null;
  }
  // Hub antigo sem amostras: média simples (declarado — é o que o resto do relatório faz).
  return Math.round(cells.reduce((a, c) => a + (c.activePct ?? 0), 0) / cells.length);
}

export function metricas(
  ds: Dataset | null,
  flow: FlowDataset | null,
  r: Recorte,
): MetricasRecorte {
  const cells = (ds?.cells ?? []).filter((c) => noRecorte(c, r));
  const fcells: FlowCell[] = (flow?.cells ?? []).filter((c) => noRecorte(c, r));
  const fDoDia = (flow?.cells ?? []).filter((c) => r.dia === "todos" || c.dayIndex === r.dia);
  const turnoCadastrado = r.turno !== ALL_SHIFTS && !LEGACY_SHIFTS.includes(r.turno);
  const fluxoSemCarimbo =
    turnoCadastrado && fDoDia.length > 0 && fDoDia.every((c) => shiftStateOf(c) === "sem-carimbo");

  const horas = new Set(cells.map((c) => `${c.dayIndex}|${c.hour}`));
  const porArea = new Map<string, Cell[]>();
  for (const c of cells) porArea.set(c.area, [...(porArea.get(c.area) ?? []), c]);
  let areaMaisAtiva: string | null = null;
  let melhor = -1;
  for (const [area, cs] of porArea) {
    const o = ocupacao(cs) ?? -1;
    if (o > melhor) {
      melhor = o;
      areaMaisAtiva = area;
    }
  }

  let entradas = 0;
  let saidas = 0;
  const porHora = new Array(24).fill(0) as number[];
  for (const c of fcells) {
    entradas += c.in;
    saidas += c.out;
    porHora[c.hour] += c.in + c.out;
  }
  const travessias = entradas + saidas;
  const maxHora = Math.max(...porHora);
  return {
    horasAnalisadas: horas.size,
    ocupacaoPct: ocupacao(cells),
    alertas: cells.reduce((a, c) => a + c.alerts, 0),
    areaMaisAtiva,
    entradas,
    saidas,
    travessias,
    travessiasPorHora: horas.size ? Math.round((travessias / horas.size) * 10) / 10 : null,
    horaPico: maxHora > 0 ? porHora.indexOf(maxHora) : null,
    temAtividade: cells.length > 0,
    temFluxo: fcells.length > 0,
    fluxoSemCarimbo,
  };
}

export type LinhaComparacao = {
  chave: string;
  rotulo: string;
  a: number | null;
  b: number | null;
  /** (B − A) / A em %, arredondado; `null` se algum lado não tem medida ou A = 0. */
  deltaPct: number | null;
  unidade: "%" | "" | "/h" | "h";
  /** true = SUBIR é ruim (alertas) — a tela pinta o delta pelo significado, não pelo sinal. */
  subirEhRuim?: boolean;
};

export function comparar(a: MetricasRecorte, b: MetricasRecorte): LinhaComparacao[] {
  const d = (x: number | null, y: number | null) =>
    x === null || y === null ? null : deltaPct(y, x);
  const linhas: LinhaComparacao[] = [
    {
      chave: "horas",
      rotulo: "Horas com análise",
      a: a.horasAnalisadas,
      b: b.horasAnalisadas,
      deltaPct: d(a.horasAnalisadas, b.horasAnalisadas),
      unidade: "h",
    },
  ];
  if (a.temAtividade || b.temAtividade) {
    const oa = a.temAtividade ? a.ocupacaoPct : null;
    const ob = b.temAtividade ? b.ocupacaoPct : null;
    linhas.push(
      {
        chave: "ocupacao",
        rotulo: "Ocupação média",
        a: oa,
        b: ob,
        deltaPct: d(oa, ob),
        unidade: "%",
      },
      {
        chave: "alertas",
        rotulo: "Alertas",
        a: a.temAtividade ? a.alertas : null,
        b: b.temAtividade ? b.alertas : null,
        deltaPct: d(a.temAtividade ? a.alertas : null, b.temAtividade ? b.alertas : null),
        unidade: "",
        subirEhRuim: true,
      },
    );
  }
  if (a.temFluxo || b.temFluxo || a.fluxoSemCarimbo || b.fluxoSemCarimbo) {
    // Sem cruzamento num recorte COM análise, 0 é medida (ninguém cruzou). Sem hora analisada,
    // OU com turno cadastrado sobre fluxo ainda sem carimbo de turno, é `null` (não medimos).
    const medeA = a.horasAnalisadas > 0 && !a.fluxoSemCarimbo;
    const medeB = b.horasAnalisadas > 0 && !b.fluxoSemCarimbo;
    const lado = (mede: boolean, v: number | null) => (mede ? v : null);
    const linha = (
      chave: string,
      rotulo: string,
      get: (m: MetricasRecorte) => number | null,
      unidade: LinhaComparacao["unidade"],
    ): LinhaComparacao => {
      const va = lado(medeA, get(a));
      const vb = lado(medeB, get(b));
      return { chave, rotulo, a: va, b: vb, deltaPct: d(va, vb), unidade };
    };
    linhas.push(
      linha("entradas", "Entradas", (m) => m.entradas, ""),
      linha("saidas", "Saídas", (m) => m.saidas, ""),
      linha("travessias", "Travessias (total)", (m) => m.travessias, ""),
      linha("porHora", "Travessias por hora analisada", (m) => m.travessiasPorHora, "/h"),
    );
  }
  return linhas;
}

/** Aviso quando os recortes foram medidos em durações muito diferentes (> 25%): comparar
 *  TOTAIS aí engana — o texto aponta a linha "por hora", que é a comparável. */
export function avisoDeDuracao(a: MetricasRecorte, b: MetricasRecorte): string | null {
  const [x, y] = [a.horasAnalisadas, b.horasAnalisadas];
  if (!x || !y) return null;
  if (Math.abs(x - y) / Math.max(x, y) <= 0.25) return null;
  return `A teve ${x}h com análise e B teve ${y}h — compare os valores por hora e a ocupação, não os totais.`;
}

/** Rótulo de um dia do histórico ("seg 22/09"). Meio-dia local: startMs é limite UTC, e
 *  rotular a meia-noite trocaria o dia na borda do fuso. */
export function rotuloDia(startMs: number, dayIndex: number): string {
  const d = new Date(startMs + dayIndex * 86_400_000 + 12 * 3_600_000);
  const sem = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][d.getDay()];
  return `${sem} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
