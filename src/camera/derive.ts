// Derivações PURAS da view do CameraWorkspace (sem React/DOM/refs): assinaturas baratas do
// painel, modo predominante (preset), resumo da zona restrita e legenda do overlay. Extraídas do
// componente (padrão rafSteps) p/ teste sem runtime — o JSX/rAF só consome.
import { type ModeKey } from "../config";
import { fmtLimit } from "../format";
import { objClass } from "../objects/catalog";
import { DEFAULT_PRESENCA_ALERT_MS, type Zone } from "../zones";
import type { ZoneResult } from "./draw";

// Assinatura BARATA do snapshot do painel: serializa por zona SÓ o que o JSX exibe, na
// granularidade exibida — o tick de UI só chama setPanel quando algo VISÍVEL mudou (zero
// re-render sem mudança). Campos não exibidos (dets/scene/occupied) ficam de fora de propósito:
// alimentam o overlay do canvas via resultsRef, não o JSX.
export function panelSig(results: Map<string, ZoneResult>): string {
  let sig = "";
  for (const [id, r] of results) {
    if (r.modo === "atividade") {
      const v = r.view;
      sig += `${id}|a|${v.state}|${Math.round(v.motion * 100)}|${Math.floor(v.idleMs / 1000)}|${v.people}|${v.flowLevel}|${v.flow.map((s) => Math.round(s * 100)).join(",")};`;
    } else if (r.modo === "leitura") {
      sig += `${id}|l|${r.lastCode ?? ""}|${r.ratePct}|${r.perMin}|${r.noReads}|${r.passes};`;
    } else if (r.modo === "objetos") {
      let c = "";
      for (const k in r.counts) c += `${k}:${r.counts[k]},`;
      sig += `${id}|o|${r.total}|${c};`;
    } else {
      sig += `${id}|f|${r.risk}|${r.ear == null ? "" : r.ear.toFixed(2)}|${r.phone ? 1 : 0}|${r.faceState};`;
    }
  }
  return sig;
}

// Idem p/ os contadores de tripwire do painel "linhas" ({ [wireId]: {in,out} }).
export function twSig(counts: Record<string, { in: number; out: number }>): string {
  let sig = "";
  for (const id in counts) sig += `${id}:${counts[id].in}:${counts[id].out};`;
  return sig;
}

// MODO-COMO-PRESET: overlays/confiança são globais da sessão; o preset ativo segue o modo
// PREDOMINANTE entre as zonas (empate → ordem abaixo).
const PRESET_ORDER: ModeKey[] = ["atividade", "leitura", "objetos", "fadiga"];
export function dominantMode(zs: Zone[]): ModeKey {
  if (!zs.length) return "atividade";
  const counts: Record<string, number> = {};
  for (const z of zs) counts[z.modo] = (counts[z.modo] ?? 0) + 1;
  return PRESET_ORDER.reduce(
    (best, m) => ((counts[m] ?? 0) > (counts[best] ?? 0) ? m : best),
    PRESET_ORDER[0],
  );
}

// ── RESUMO DA ZONA RESTRITA (modo "proibida") ────────────────────────────────────────────────
// A zona que ALARMA era a única sem uma linha em texto no drawer: o dwell e a janela de
// armamento só existiam DENTRO do diálogo de configuração — quem olhava a lista não sabia se a
// área estava armada 24/7 nem a partir de quantos segundos ela dispara.
// FAIL-OPEN declarado: "dentro/fora dos turnos" SEM turno atribuído segue 24/7 (o servidor nunca
// cala um alarme por config incompleta — ver zones.ts/ConfigZonaDialog); o texto diz isso em vez
// de prometer uma janela que não existe.
export function armingSummary(z: Pick<Zone, "arming" | "shiftIds">): string {
  const a = z.arming ?? "sempre";
  if (a === "sempre") return "armada 24/7";
  if (!z.shiftIds?.length) return "armada 24/7 (sem turno atribuído)";
  return a === "dentro-turnos" ? "armada só nos turnos" : "armada só fora dos turnos";
}

/** Uma linha: quando esta área restrita alarma. Ex.: "Alarma se alguém ficar mais de 30s · armada 24/7". */
export function restritaSummary(z: Pick<Zone, "arming" | "shiftIds" | "presencaAlertMs">): string {
  const dwell = fmtLimit(z.presencaAlertMs ?? DEFAULT_PRESENCA_ALERT_MS);
  return `Alarma se alguém ficar mais de ${dwell} · ${armingSummary(z)}`;
}

// Legenda do overlay: só as cores realmente em uso pelos modos/classes das zonas atuais.
// `variant` é o canal NÃO-CROMÁTICO do overlay — sem ele a legenda só sabe falar de COR e metade
// da linguagem do desenho (hachura da zona restrita, contorno tracejado, marcação esmaecida) fica
// sem verbete. Ausente = preenchimento sólido (comportamento de sempre).
export type LegendVariant = "hatch" | "dashed" | "dim";
export type LegendItem = { color: string; label: string; variant?: LegendVariant };
export function legendFor(zones: Zone[]): LegendItem[] {
  const out: LegendItem[] = [];
  const modes = new Set(zones.map((z) => z.modo));
  if (modes.has("atividade")) {
    out.push(
      { color: "var(--state-neutral)", label: "Ativa" },
      { color: "var(--state-warn)", label: "Lenta/Ociosa" },
      { color: "var(--state-critical)", label: "Alerta" },
      { color: "var(--state-info)", label: "Pessoa" },
    );
  }
  if (modes.has("leitura")) out.push({ color: "var(--state-info)", label: "Faixa de leitura" });
  if (modes.has("objetos")) {
    const keys = new Set(
      zones.filter((z) => z.modo === "objetos").flatMap((z) => z.selectedClasses),
    );
    for (const k of keys) {
      const o = objClass(k);
      if (o) out.push({ color: o.color, label: o.label });
    }
  }
  if (modes.has("fadiga"))
    out.push(
      { color: "var(--state-neutral)", label: "OK" },
      { color: "var(--state-warn)", label: "Alerta" },
      { color: "var(--state-critical)", label: "Duplo" },
    );
  if (modes.has("exclusao"))
    out.push({ color: "var(--state-neutral)", label: "Exclusão (ignorada)" });
  // ZONA RESTRITA (proibida): o overlay a desenha em DOIS estados e a legenda ignorava os dois.
  // Quieta = hachura + contorno tracejado NEUTRO + badge ARMADA (going-gray: estar armada é
  // operação normal); violada = --state-critical com fill saturado + badge VIOLADA. Ver draw.ts.
  if (modes.has("proibida"))
    out.push(
      { color: "var(--state-neutral)", label: "Área restrita · ARMADA", variant: "hatch" },
      { color: "var(--state-critical)", label: "Área restrita · VIOLADA" },
    );
  // ── MARCAÇÃO DA PESSOA: os DOIS canais de incerteza, nomeados ─────────────────────────────
  // Antes, "caixa a 45%" era ambíguo: podia ser score abaixo do slider de confiança (ação:
  // calibrar o slider) OU coasting (ação: investigar câmera/CPU/rede). O desenho passou a separar
  // os canais — TRACEJADO = sem observação nova, OPACIDADE = confiança — e a legenda os declara.
  // Entram sempre que a legenda existe: drawTracks é independente do modo das zonas (a marcação
  // de pessoa aparece em qualquer câmera com o motor ligado).
  if (zones.length)
    out.push(
      {
        color: "var(--state-info)",
        label: "Pessoa tracejada · sem leitura nova",
        variant: "dashed",
      },
      { color: "var(--state-info)", label: "Pessoa apagada · abaixo da confiança", variant: "dim" },
    );
  return out;
}
