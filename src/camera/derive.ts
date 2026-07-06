// Derivações PURAS da view do CameraWorkspace (sem React/DOM/refs): assinaturas baratas do
// painel, modo predominante (preset) e legenda do overlay. Extraídas do componente (padrão
// rafSteps) p/ teste sem runtime — o JSX/rAF só consome.
import { type ModeKey } from "../config";
import { objClass } from "../objects/catalog";
import type { Zone } from "../zones";
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

// Legenda do overlay: só as cores realmente em uso pelos modos/classes das zonas atuais.
export type LegendItem = { color: string; label: string };
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
  return out;
}
