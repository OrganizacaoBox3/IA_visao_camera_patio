// Loader PURO da gravação do coletor BLE — Fase 1 do motor de localização (ADR-012). Converte o JSONL
// gravado pelo server/bt/recorder.js em EvidenceBatch[], a MESMA entrada que o harness de replay consome
// (replay.ts). Puro: recebe as linhas já lidas (I/O é responsabilidade de quem chama) → testável e sem side effect.
// Pula linha malformada sem lançar (honestidade: dado real vem sujo — JSON quebrado, campo faltando).
//
// Dado REAL não tem ground truth: ninguém rotulou a posição verdadeira das tags no instante da captura.
// Logo parseRecording devolve SÓ os batches; o RMSE-vs-truth (computeMetrics/replay) espera dados ROTULADOS,
// que hoje só o simulador produz — coleta rotulada de campo é uma FASE POSTERIOR. Por isso toRecording
// entrega truth vazio (a métrica não é aplicável até haver rótulo).
import type { EvidenceBatch } from "./evidence";
import type { LatLon } from "./entity";
import type { Recording } from "./replay";
import type { TruthPoint } from "./simulate";

// Forma de UMA linha gravada (espelha server/bt/recorder.js). Campos frouxos (unknown): validamos em runtime,
// porque o arquivo pode ter sido escrito por versões diferentes ou editado à mão.
type RecordedLine = {
  ts?: unknown;
  lat?: unknown;
  lon?: unknown;
  acc?: unknown;
  tags?: unknown;
};

type RecordedTag = { mac?: unknown; rssi?: unknown; rotulo?: unknown };

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

// Uma tag gravada → TagSighting, ou null se sem MAC / RSSI não-finito (leitura inútil).
function toSighting(raw: unknown): EvidenceBatch["seen"][number] | null {
  const t = (raw ?? {}) as RecordedTag;
  const tagId = String(t.mac ?? "").trim();
  const rssi = num(t.rssi);
  if (!tagId || !Number.isFinite(rssi)) return null;
  if (t.rotulo == null) return { tagId, rssi };
  return { tagId, rssi, label: String(t.rotulo) };
}

// Uma linha crua → EvidenceBatch, ou null se malformada (JSON inválido / ts,lat,lon não-finitos).
function lineToBatch(raw: string): EvidenceBatch | null {
  let obj: RecordedLine;
  try {
    obj = JSON.parse(raw) as RecordedLine;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const ts = num(obj.ts);
  const lat = num(obj.lat);
  const lon = num(obj.lon);
  if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];
  const seen = tagsRaw
    .map(toSighting)
    .filter((s): s is EvidenceBatch["seen"][number] => s !== null);
  const batch: EvidenceBatch = { ts, collectorPos: { lat, lon }, seen };
  // acc é gravado como número finito OU null (sem GPS) — só vira accuracyM quando é um número de verdade.
  const acc = obj.acc == null ? NaN : num(obj.acc);
  if (Number.isFinite(acc)) batch.accuracyM = acc;
  return batch;
}

/** Converte linhas JSONL gravadas em EvidenceBatch[]. Linhas vazias/malformadas são puladas (sem lançar). */
export function parseRecording(lines: string[]): EvidenceBatch[] {
  const out: EvidenceBatch[] = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const batch = lineToBatch(line);
    if (batch) out.push(batch);
  }
  return out;
}

/**
 * Empacota as linhas como Recording p/ o harness de replay. Dado real não tem ground truth, então
 * `truth` vem vazio: o replay ainda roda o motor sobre os batches; o RMSE só faz sentido com rótulo (fase posterior).
 */
export function toRecording(lines: string[]): Recording {
  return { batches: parseRecording(lines), truth: [] };
}

/**
 * Recording ROTULADO p/ RMSE-vs-truth em DADO REAL de campo, no protocolo mais simples: TAGS ESTÁTICAS em
 * pontos MEDIDOS. `staticTruth` = { MAC → posição-verdade fixa } (o lat/lon do ponto onde a tag foi
 * fincada, medido uma vez). A verdade é a mesma em todo instante (a tag não se move), então cada batch
 * ganha o mesmo mapa de posições. Só as tags em `staticTruth` entram na métrica — leituras de tags não
 * medidas são ignoradas (não há verdade p/ elas). Este é o gancho que transforma a gravação bruta (sem
 * ground truth) numa medida real, sem depender de simulação.
 *
 * Para tag em MOVIMENTO (ex.: o carroção) a verdade varia no tempo → exige uma trilha temporizada
 * (posição-verdade por instante); fica p/ um segundo protocolo. Aqui cobrimos o caso estático, que já
 * responde "o v1/v3 localiza uma tag parada a partir do coletor móvel, em campo?".
 */
export function labeledRecording(lines: string[], staticTruth: Record<string, LatLon>): Recording {
  const batches = parseRecording(lines);
  const positions: Record<string, LatLon> = {};
  for (const [mac, pos] of Object.entries(staticTruth)) positions[mac.toUpperCase()] = pos;
  const truth: TruthPoint[] = batches.map((b) => ({ ts: b.ts, positions }));
  return { batches, truth };
}
