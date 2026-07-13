// POR QUE NÃO IDENTIFICOU — o seam entre o funil de vetos do associador (associate.ts:
// `diagnoseFunnel()`, que existia SEM NENHUM consumidor de UI: bug B8 do laudo de 2026-07-13) e a
// aba "Por quê" do drawer da câmera (camera/tabs/PorQueTab.tsx).
//
// A TESE: o produto não é só ACERTAR — é DIZER POR QUE NÃO SABE. Um sistema que cala sem explicar
// treina o operador a não confiar nele; um que diz "não sei, e é porque você está PARADO" é honesto
// e ACIONÁVEL (o operador anda; o gestor reposiciona a câmera). O laudo mediu, na gravação real de
// campo (n=129 episódios do corpus ouro): 41,9% do silêncio é pessoa parada [IC 33,7–50,5%], 31,0%
// é RSSI constante, 21,7% é evidência insuficiente — 94,6% do silêncio é PREVISTO pela física.
// Nada disso aparecia na tela.
//
// RESPONSABILIDADE ÚNICA: o TIMING/estado do diagnóstico (montar o frame, empurrar no associador,
// ler o funil a 1 Hz). A matemática dos vetos mora em associate.ts (pura/testada) e NÃO é
// recalculada aqui — fonte única. Este hook roda um associador PRÓPRIO, alimentado com os MESMOS
// insumos do vivo (useTagFusion) e com a MESMA config default: o funil que ele lê é o funil que o
// associador do vivo estaria vendo. É SÓ-LEITURA e só liga quando a aba está aberta (`enabled`) —
// custo zero quando ninguém está perguntando.
//
// REGRA 8 (deduplique ANTES de qualquer estatística): a UI NÃO pode mostrar `rssiSamples` como
// "leituras" — 81,2% do que o hub recebe é CÓPIA do valor anterior (sample-and-hold do app, bug B1),
// então o número cru MENTE por ~4× para cima. Contamos aqui as leituras DISTINTAS na janela
// (transições de valor) e mostramos as DUAS: "16 recebidas · 4 distintas". É CONTAGEM, não modelo.
import { useEffect, useMemo, useState } from "react";
import { TagTrackAssociator, type FunnelVerdict, type PairFunnel } from "./associate";
import { buildFusionFrame, type RawReading } from "./frame";
import type { FloorCalibration } from "./useFloorTags";
import type { HubAnalysis } from "../types/analysis";

/** Janela do associador (espelha o DEFAULTS.windowMs de associate.ts, que não é exportado) — usada
 *  só p/ podar o histórico de leituras deste hook. O valor EFETIVO exibido na UI vem sempre do
 *  próprio funil (`PairFunnel.thresholds.windowMs`), nunca desta constante. */
const WINDOW_MS = 8000;
const TICK_MS = 500; // mesma cadência da fusão viva (useTagFusion)
const EMIT_MS = 1000; // o painel respira a 1 Hz — diagnóstico é indicador, não vídeo

/** Uma pessoa em cena e o quão longe a MELHOR tag candidata chegou na cadeia de vetos. */
export type PersonFunnel = {
  trackId: number;
  /** O par que chegou MAIS LONGE no funil (empate → maior score). null = nenhuma tag no ar. */
  best: PairFunnel | null;
  /** Tags avaliadas para esta pessoa nesta janela. */
  candidates: number;
  /** Leituras da tag do `best` na janela: as RECEBIDAS (com cópias) e as DISTINTAS (Regra 8). */
  rawReadings: number;
  distinctReadings: number;
};

/** Tag-ÂNCORA (cadastrada na calibração desta câmera) que está sendo OUVIDA agora — bug B5: ela é
 *  excluída da fusão de propósito (âncora é infraestrutura fixa, jamais está numa pessoa) e por isso
 *  NUNCA associa NESTA câmera. Hoje isso acontece em silêncio; a aba diz. */
export type HeardAnchor = { mac: string; label: string };

export type FunnelDiagnosis = {
  /** false = o diagnóstico não está rodando (aba fechada / sem leituras BLE ligadas). */
  running: boolean;
  /** Pistas do MOTOR DO HUB. null = o motor do hub não está entregando tracks p/ esta câmera —
   *  a fusão NÃO RODA (bug B7 do laudo: com `analysisEngine="local"`, `labelFor` fica vazio p/
   *  sempre). É o 1º elo da cadeia e o único que nem chega ao funil. */
  hubTracks: number | null;
  /** Tags (não-âncora) ouvidas na última varredura — o elo RÁDIO. */
  tagsHeard: number;
  anchors: HeardAnchor[];
  people: PersonFunnel[];
  /** true enquanto a janela ainda não encheu desde que a aba abriu (evita ler "poucas amostras"
   *  como veredito quando é só o buffer enchendo). */
  warmingUp: boolean;
  /** Janela efetiva do funil (ms) — do próprio funil quando há par; senão o default. */
  windowMs: number;
};

export const EMPTY_DIAGNOSIS: FunnelDiagnosis = {
  running: false,
  hubTracks: null,
  tagsHeard: 0,
  anchors: [],
  people: [],
  warmingUp: false,
  windowMs: WINDOW_MS,
};

/** Ordem EXATA da cadeia de vetos (a de `diagnoseFunnel`): quanto MAIOR, mais longe o par chegou. */
const VERDICT_RANK: Record<FunnelVerdict, number> = {
  "distSamples<minSamples": 0,
  "rssiSamples<minSamples": 1,
  "aligned<minSamples": 2,
  constantSeries: 3,
  lowMovement: 4,
  belowMinConfidence: 5,
  lostTieBreak: 6,
  belowMinMargin: 7,
  SPOKE: 8,
};

/** O par que chegou MAIS LONGE na cadeia (empate no elo → maior score). PURA. */
export function pickBest(pairs: readonly PairFunnel[]): PairFunnel | null {
  let best: PairFunnel | null = null;
  for (const p of pairs) {
    if (best === null) {
      best = p;
      continue;
    }
    const a = VERDICT_RANK[p.verdict],
      b = VERDICT_RANK[best.verdict];
    if (a > b || (a === b && p.score > best.score)) best = p;
  }
  return best;
}

/** REGRA 8 — leituras DISTINTAS: transições de valor numa série que repete a última leitura entre
 *  atualizações reais (sample-and-hold). Cópia consecutiva carrega informação ZERO. É CONTAGEM. */
export function distinctReadings(values: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (i === 0 || values[i] !== values[i - 1]) n++;
  return n;
}

type Params = {
  calibration: FloorCalibration;
  getHubAnalysis?: () => HubAnalysis | null;
  getReadings?: () => RawReading[];
  /** Liga o diagnóstico (a aba "Por quê" está aberta). Desligado → EMPTY_DIAGNOSIS, custo zero. */
  enabled: boolean;
};

export function useFunnelDiagnosis({
  calibration,
  getHubAnalysis,
  getReadings,
  enabled,
}: Params): FunnelDiagnosis {
  const [diag, setDiag] = useState<FunnelDiagnosis>(EMPTY_DIAGNOSIS);

  // MESMA regra do useCameraTagLabels (âncora cadastrada nunca é candidata): MACs em MAIÚSCULAS.
  // Recomputado aqui (e não importado de lá) porque aquele hook não expõe o conjunto — e é ele que
  // torna o silêncio da âncora VISÍVEL: sem esta lista, o B5 continua mudo.
  const excludeTags = useMemo(() => {
    const macs = calibration.points
      .map((p) => p.mac)
      .filter((mac): mac is string => typeof mac === "string" && mac.length > 0)
      .map((mac) => mac.toUpperCase());
    return macs.length ? new Set(macs) : undefined;
  }, [calibration.points]);

  const H = calibration.H;
  const stationPx = calibration.station ?? undefined;

  useEffect(() => {
    if (!enabled || !getHubAnalysis || !getReadings) {
      setDiag(EMPTY_DIAGNOSIS);
      return;
    }
    const assoc = new TagTrackAssociator();
    // Histórico local SÓ p/ a contagem distinta (Regra 8): [ts, RSSI por tag] na janela.
    const hist: Array<{ ts: number; byTag: Map<string, number> }> = [];
    const startedAt = performance.now();
    let sinceEmit = 0;

    const id = window.setInterval(() => {
      const hd = getHubAnalysis();
      const readings = getReadings() ?? [];
      const now = performance.now();

      // Sem tracks do hub a fusão NEM RODA (B7) — reporta o elo zero e não inventa funil.
      if (hd) assoc.push(buildFusionFrame(hd.tracks, readings, H, now, stationPx, excludeTags));

      const byTag = new Map<string, number>();
      const heardAnchors = new Map<string, string>();
      for (const r of readings) {
        const mac = r.mac.toUpperCase();
        if (excludeTags?.has(mac)) {
          heardAnchors.set(mac, r.rotulo || mac);
          continue;
        }
        byTag.set(r.rotulo || r.mac, r.rssi); // MESMA chave do FusionFrame (frame.ts)
      }
      hist.push({ ts: now, byTag });
      while (hist.length > 0 && hist[0].ts < now - WINDOW_MS) hist.shift();

      sinceEmit += TICK_MS;
      if (sinceEmit < EMIT_MS) return;
      sinceEmit = 0;

      const pairs = hd ? assoc.diagnoseFunnel(now) : [];
      const byTrack = new Map<number, PairFunnel[]>();
      for (const p of pairs) {
        const arr = byTrack.get(p.trackId);
        if (arr) arr.push(p);
        else byTrack.set(p.trackId, [p]);
      }
      const people: PersonFunnel[] = [];
      for (const trackId of [...byTrack.keys()].sort((a, b) => a - b)) {
        const rows = byTrack.get(trackId) ?? [];
        const best = pickBest(rows);
        const series: number[] = [];
        if (best)
          for (const h of hist) {
            const v = h.byTag.get(best.tag);
            if (v !== undefined) series.push(v);
          }
        people.push({
          trackId,
          best,
          candidates: rows.length,
          rawReadings: series.length,
          distinctReadings: distinctReadings(series),
        });
      }
      // Pista SEM nenhum par (nenhuma tag no ar): o funil devolve [] — mas a PESSOA está em cena e
      // precisa aparecer com o elo "rádio" vermelho. Reconstitui a partir dos tracks do hub.
      if (hd && pairs.length === 0)
        for (const t of hd.tracks)
          people.push({
            trackId: t.id,
            best: null,
            candidates: 0,
            rawReadings: 0,
            distinctReadings: 0,
          });

      setDiag({
        running: true,
        hubTracks: hd ? hd.tracks.length : null,
        tagsHeard: byTag.size,
        anchors: [...heardAnchors].map(([mac, label]) => ({ mac, label })),
        people,
        warmingUp: now - startedAt < WINDOW_MS,
        windowMs: pairs[0]?.thresholds.windowMs ?? WINDOW_MS,
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled, getHubAnalysis, getReadings, H, stationPx, excludeTags]);

  return diag;
}
