// COMPARAR DIAS OU TURNOS (2026-09-29) — painel do Resumo. Dois recortes (dia × turno), lado a
// lado, com o delta. A conta vive em report/calc/comparar.ts (pura, testada); aqui só a escolha
// dos recortes e o desenho. Respeita o filtro de câmera do topo (recebe o dataset já filtrado).
import { useMemo, useState } from "react";
import { Select, SectionTitle, Table, HelpTip } from "../../ui";
import {
  ALL_SHIFTS,
  metricas,
  comparar,
  avisoDeDuracao,
  rotuloDia,
  type Dataset,
  type FlowDataset,
  type Recorte,
  type LinhaComparacao,
} from "../../report/calc";

const TODOS_DIAS = "todos";

/** [penúltimo, último] dia com algum bucket (atividade ou fluxo); cai em ontem × hoje sem dado. */
function diasComDado(ds: Dataset | null, flow: FlowDataset | null, dias: number): [number, number] {
  const comDado = [
    ...new Set([...(ds?.cells ?? []), ...(flow?.cells ?? [])].map((c) => c.dayIndex)),
  ].sort((x, y) => y - x);
  const ultimo = comDado[0] ?? Math.max(0, dias - 1);
  const penultimo = comDado[1] ?? Math.max(0, ultimo - 1);
  return [penultimo, ultimo];
}

function fmt(v: number | null, unidade: LinhaComparacao["unidade"]): string {
  if (v === null) return "—";
  const n = v.toLocaleString("pt-BR");
  return unidade === "%" ? `${n}%` : unidade === "/h" ? `${n}/h` : unidade === "h" ? `${n}h` : n;
}

/** Tom do delta pelo SIGNIFICADO (alerta subindo é ruim; ocupação subindo não é). */
function tomDelta(l: LinhaComparacao): "bom" | "ruim" | "neutro" {
  if (l.deltaPct === null || l.deltaPct === 0 || l.chave === "horas") return "neutro";
  const subiu = l.deltaPct > 0;
  return l.subirEhRuim ? (subiu ? "ruim" : "bom") : "neutro";
}

export function ComparePanel({
  ds,
  flow,
  shiftItems,
}: {
  ds: Dataset | null;
  flow: FlowDataset | null;
  shiftItems: { value: string; label: string }[];
}) {
  const dias = ds?.days ?? flow?.days ?? 0;
  const startMs = ds?.startMs ?? flow?.startMs ?? 0;
  // Padrão: os DOIS DIAS MAIS RECENTES COM MEDIÇÃO (em geral ontem × hoje — "hoje está melhor?").
  // "Ontem × hoje" fixo abria todo em "—" num site cuja câmera ficou parada nos últimos dias.
  const [padraoA, padraoB] = useMemo(() => diasComDado(ds, flow, dias), [ds, flow, dias]);
  const [a, setA] = useState<Recorte>({ dia: padraoA, turno: ALL_SHIFTS });
  const [b, setB] = useState<Recorte>({ dia: padraoB, turno: ALL_SHIFTS });

  const opcoesDia = useMemo(
    () => [
      { value: TODOS_DIAS, label: "Todos os dias carregados" },
      ...Array.from({ length: dias }, (_, i) => dias - 1 - i).map((i) => ({
        value: String(i),
        label: i === dias - 1 ? `Hoje · ${rotuloDia(startMs, i)}` : rotuloDia(startMs, i),
      })),
    ],
    [dias, startMs],
  );
  const opcoesTurno = [{ value: ALL_SHIFTS, label: "Todos os turnos" }, ...shiftItems];

  const ma = useMemo(() => metricas(ds, flow, a), [ds, flow, a]);
  const mb = useMemo(() => metricas(ds, flow, b), [ds, flow, b]);
  const linhas = comparar(ma, mb);
  const aviso = avisoDeDuracao(ma, mb);

  if (!dias) return null;

  const seletor = (r: Recorte, set: (r: Recorte) => void, nome: string) => (
    <div className="cmp-recorte">
      <b>{nome}</b>
      <Select
        value={r.dia === "todos" ? TODOS_DIAS : String(r.dia)}
        onChange={(v) => set({ ...r, dia: v === TODOS_DIAS ? "todos" : Number(v) })}
        ariaLabel={`Dia do recorte ${nome}`}
        options={opcoesDia}
      />
      <Select
        value={r.turno}
        onChange={(v) => set({ ...r, turno: v })}
        ariaLabel={`Turno do recorte ${nome}`}
        options={opcoesTurno}
      />
    </div>
  );

  return (
    <section className="panel cmp-panel" aria-label="Comparar dias ou turnos">
      <div className="cmp-head">
        <SectionTitle flush>Comparar dias ou turnos</SectionTitle>
        <HelpTip label="Como ler a comparação">
          Escolha dois recortes — um dia e um turno cada — e veja atividade e fluxo lado a lado. Δ é
          a variação de B em relação a A. Quando os dois lados foram medidos por tempos diferentes
          (ex.: um turno contra um dia inteiro), compare os valores por hora e a ocupação, não os
          totais. "—" é recorte sem medição: não é zero.
        </HelpTip>
      </div>
      <div className="cmp-recortes">
        {seletor(a, setA, "A")}
        <span className="cmp-vs" aria-hidden>
          ×
        </span>
        {seletor(b, setB, "B")}
      </div>
      {aviso && <p className="cmp-aviso">{aviso}</p>}
      {(ma.fluxoSemCarimbo || mb.fluxoSemCarimbo) && (
        <p className="cmp-aviso">
          O fluxo das linhas ainda não é separado por turno cadastrado — para comparar fluxo entre
          turnos, use "Todos os turnos" ou os turnos por horário (legado).
        </p>
      )}
      <Table
        ariaLabel="Comparação entre os recortes A e B"
        columns={[
          { label: "Indicador", className: "w-full" },
          { label: "A", className: "whitespace-nowrap text-right" },
          { label: "B", className: "whitespace-nowrap text-right" },
          { label: "Δ (B vs A)", className: "whitespace-nowrap text-right" },
        ]}
      >
        <tbody>
          {linhas.map((l) => (
            <tr key={l.chave}>
              <td>{l.rotulo}</td>
              <td className="text-right">{fmt(l.a, l.unidade)}</td>
              <td className="text-right">{fmt(l.b, l.unidade)}</td>
              <td className="text-right cmp-delta" data-tom={tomDelta(l)}>
                {l.deltaPct === null ? "—" : `${l.deltaPct > 0 ? "+" : ""}${l.deltaPct}%`}
              </td>
            </tr>
          ))}
          <tr>
            <td>Área mais ativa</td>
            <td className="text-right">{ma.areaMaisAtiva ?? "—"}</td>
            <td className="text-right">{mb.areaMaisAtiva ?? "—"}</td>
            <td />
          </tr>
          {(ma.temFluxo || mb.temFluxo) && (
            <tr>
              <td>Hora de pico do fluxo</td>
              <td className="text-right">{ma.horaPico === null ? "—" : `${ma.horaPico}h`}</td>
              <td className="text-right">{mb.horaPico === null ? "—" : `${mb.horaPico}h`}</td>
              <td />
            </tr>
          )}
        </tbody>
      </Table>
    </section>
  );
}
