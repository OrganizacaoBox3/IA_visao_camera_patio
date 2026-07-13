// Base compartilhada dos cálculos do Relatório: TURNO (chave/carimbo/rótulo), janelas de período
// e formatadores puros usados por todas as dimensões (atividade/leitura/objetos/fadiga/fluxo).
// Funções PURAS e determinísticas — nenhum efeito colateral.
//
// ── TURNO: quem decide é o SERVIDOR (spec-turnos-por-zona §3) ────────────────────────────────
// A fonte da verdade é o CADASTRO (`GET /api/shifts`) e a resolução é do hub (server/shift-clock.js:
// overnight/borda/pausa/SITE_TZ num lugar só). **O front NUNCA resolve turno** — ele LÊ o carimbo
// que veio na linha do histórico. Este módulo mantinha um `shiftOf(hour)` hardcoded (06/14/22,
// "Manhã/Tarde/Noite") que era CÓPIA MANUAL do hardcode do hub: essa segunda fonte MORREU aqui.
// O que sobra dela é `legacyShiftOf`, usado **só como retrocompat de leitura** (CA-8).
//
// Estados possíveis de uma linha (bucket ou evento) — ver `shiftStateOf`:
//   `shiftId: "<id>"` → carimbada e DENTRO de um turno cadastrado (chave = o id).
//   `shiftId: null`   → carimbada e FORA de turno (D7: não pertence a turno nenhum).
//   sem `shiftId`     → hub/dado ANTIGO: cai no rótulo legado gravado (`shift`) e, na falta dele,
//                       na derivação legada pela hora (o único lugar onde 06/14/22 ainda vive).

export type Period = "hoje" | "7d" | "30d";

/** Chave de turno. Era união fechada ("Manhã"|"Tarde"|"Noite") — virou `string` quando o cadastro
 *  passou a ser a fonte (armadilha 2/9 da spec): hoje é o `id` de um turno cadastrado OU, em dado
 *  antigo, o rótulo legado gravado na própria linha. */
export type Shift = string;

/** Valor-sentinela do filtro "sem recorte de turno" (preservado do filtro atual). */
export const ALL_SHIFTS = "Todos";
/** O que o filtro de turno do relatório carrega: uma chave de turno ou "Todos". */
export type ShiftFilter = Shift | typeof ALL_SHIFTS;

// ── Legado (retrocompat de LEITURA — CA-8) ───────────────────────────────────────────────────
// Dado gravado ANTES do cadastro de turnos tem estas strings na coluna `shift` (ou nada — e aí
// a hora do bucket é tudo que existe). Nada NOVO é classificado por aqui.

export const LEGACY_SHIFTS: Shift[] = ["Manhã", "Tarde", "Noite"];

/** Turno legado de uma hora (06/14/22). NÃO é fonte de verdade: só decodifica dado antigo. */
export function legacyShiftOf(hour: number): Shift {
  if (hour >= 6 && hour < 14) return "Manhã";
  if (hour >= 14 && hour < 22) return "Tarde";
  return "Noite";
}

// ── Carimbo de turno (CONTRATO com o hub — ADITIVO) ──────────────────────────────────────────

/** Campos que o hub carimba na linha do histórico (bucket/evento). Todos OPCIONAIS: hub antigo
 *  omite e o relatório cai no legado sem quebrar (CA-5/CA-8). */
export type ShiftStamp = {
  /** id do turno cadastrado; `null` = resolvido e FORA de turno; ausente = sem carimbo. */
  shiftId?: string | null;
  /** rótulo exibível do turno (nome cadastrado quando resolvido; legado no dado antigo). */
  shift?: Shift;
  /** o instante caiu numa PAUSA do turno (D3) — vazio esperado, fora do denominador. */
  inPause?: boolean;
};

/** Linha do histórico do ponto de vista do turno: o carimbo + a âncora temporal do fallback. */
export type ShiftRow = ShiftStamp & { hour?: number; ts?: number };

export type ShiftState = "dentro" | "fora" | "sem-carimbo";

/** Estado da linha. "sem-carimbo" ≠ "fora": hub antigo não é ausência de turno — é ausência de
 *  INFORMAÇÃO (e por isso nunca entra no denominador da régua de turno). */
export function shiftStateOf(r: ShiftStamp): ShiftState {
  if (typeof r.shiftId === "string" && r.shiftId !== "") return "dentro";
  if (r.shiftId === null) return "fora";
  return "sem-carimbo";
}

/** Chave de turno da linha p/ FILTRO/agrupamento: o carimbo do servidor quando existe; senão o
 *  rótulo legado gravado; senão a derivação legada pela hora. `null` = fora de turno (D7) ou
 *  linha sem âncora temporal. */
export function shiftKeyOf(r: ShiftRow): Shift | null {
  const state = shiftStateOf(r);
  if (state === "dentro") return r.shiftId as string;
  if (state === "fora") return null;
  if (typeof r.shift === "string" && r.shift !== "") return r.shift;
  const hour =
    typeof r.hour === "number"
      ? r.hour
      : typeof r.ts === "number"
        ? new Date(r.ts).getHours()
        : null;
  return hour === null ? null : legacyShiftOf(hour);
}

/** A linha pertence ao turno filtrado (ou o filtro é "Todos")? Usado por TODAS as dimensões. */
export function inShift(r: ShiftRow, filter: ShiftFilter): boolean {
  return filter === ALL_SHIFTS || shiftKeyOf(r) === filter;
}

// ── Rótulos e opções do filtro (populado do CADASTRO, com o legado do dado) ───────────────────

/** Subconjunto estrutural do turno cadastrado (api.ts `Shift`) que o relatório precisa. */
export type ShiftDef = { id: string; nome: string; ativo?: boolean };

/** Rótulo exibível de uma chave de turno: o NOME do cadastro; em dado antigo, a própria string. */
export function shiftLabelOf(key: ShiftFilter | null, shifts: ShiftDef[]): string {
  if (key === ALL_SHIFTS) return "todos";
  if (key === null) return "fora de turno";
  return shifts.find((s) => s.id === key)?.nome ?? key;
}

/** Turnos LEGADOS efetivamente presentes no dado carregado (linhas SEM carimbo). Só eles viram
 *  opção de filtro — um site novo, todo carimbado, não carrega as 3 strings mortas (CA-8). */
export function legacyShiftsIn(rows: ShiftRow[]): Shift[] {
  const seen = new Set<Shift>();
  for (const r of rows) {
    if (shiftStateOf(r) !== "sem-carimbo") continue;
    const key = shiftKeyOf(r);
    if (key) seen.add(key);
  }
  const canonical = LEGACY_SHIFTS.filter((s) => seen.has(s));
  const extras = [...seen].filter((s) => !LEGACY_SHIFTS.includes(s)).sort();
  return [...canonical, ...extras];
}

/** Opções do <Select> de turno: turnos ATIVOS do cadastro + os legados que aparecem no dado.
 *  O "Todos" é prependido pela página (é a sentinela do filtro, não um turno). */
export function shiftOptions(
  shifts: ShiftDef[],
  legacy: Shift[],
): { value: string; label: string }[] {
  const cadastrados = shifts
    .filter((s) => s.ativo !== false)
    .map((s) => ({ value: s.id, label: s.nome }));
  // sufixo "(legado)" só quando há cadastro — sem cadastro, "Manhã" é simplesmente o turno.
  const legados = legacy.map((s) => ({
    value: s,
    label: cadastrados.length ? `${s} (legado)` : s,
  }));
  return [...cadastrados, ...legados];
}

// ── Janela de período e formatadores ─────────────────────────────────────────────────────────

/** Nº de dias por período (interno; base das janelas current/previous). */
export const periodDays: Record<Period, number> = { hoje: 1, "7d": 7, "30d": 30 };

export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60),
    m = min % 60;
  return h <= 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}
