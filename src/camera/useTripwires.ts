// ── Tripwires (linhas de contagem com direção) — fonte: BACKEND (compartilhado por câmera) ──
// Extraído do CameraWorkspace.tsx (R2.1) SEM mudança de comportamento. Encapsula o estado e o
// ciclo de vida das linhas de contagem: load/migração do backend, sync ao vivo (ADR-006),
// editor (traçar/inverter/remover/zerar) e a fiação do `Counter` da lib pura counting.ts.
//
// NÃO reimplementa contagem — só move a FIAÇÃO. O `counterRef` é criado sob demanda no rAF do
// componente (que tem o frame/tracks); este hook o re-seta/zera e reflete os contadores no painel.
// O componente continua DONO do JSX, do rAF (cria/atualiza o counter, desenha o overlay) e dos
// handlers de ponteiro (que leem `twDrawRef`/`tripwireMode` e chamam `commitTripwire`).
//
// Antes as linhas viviam em localStorage (`vp-tripwires-<id>`); AGORA carregam/persistem via
// api.ts (getTripwires/saveTripwires), compartilhadas entre operadores/turnos. Coords 0..1.
// O localStorage permanece SÓ como origem de uma MIGRAÇÃO única best-effort (ver effect de load).
import { useEffect, useRef, useState, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { getTripwires, saveTripwires, ApiError, type Tripwire } from "../api";
import { type Counter, type TripwireCounts } from "../vision/counting";
import { loadFlowToday } from "../report/store";
import { getContentRect } from "./draw";

const tripwireKey = (cameraId: string) => `vp-tripwires-${cameraId}`;
let twSeq = 0;
function newTripwireId(cameraId: string) {
  return `${cameraId}-tw${Date.now().toString(36)}${++twSeq}`;
}
// Lê linhas LEGADAS do localStorage (somente p/ migração única; validação defensiva do shape).
function loadLegacyTripwires(cameraId: string): Tripwire[] {
  let raw: unknown;
  try {
    const s = localStorage.getItem(tripwireKey(cameraId));
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) return [];
  const out: Tripwire[] = [];
  for (const w of raw as Partial<Tripwire>[]) {
    if (!w || typeof w.id !== "string" || !w.a || !w.b) continue;
    if (
      typeof w.a.x !== "number" ||
      typeof w.a.y !== "number" ||
      typeof w.b.x !== "number" ||
      typeof w.b.y !== "number"
    )
      continue;
    out.push({ id: w.id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } });
  }
  return out;
}
// Remove a chave legada após migração bem-sucedida (best-effort; falha silenciosa).
function clearLegacyTripwires(cameraId: string) {
  try {
    localStorage.removeItem(tripwireKey(cameraId));
  } catch {
    /* no-op */
  }
}

type Args = {
  cameraId: string;
  label: string;
  canConfigure: boolean;
  // SYNC AO VIVO (ADR-006): contador de revisão por câmera (opcional/retrocompatível).
  tripwiresRev?: number;
  getFrame: () => FrameSource | null;
  viewportRef: RefObject<HTMLDivElement | null>;
  onAlertRef: RefObject<((msg: string) => void) | undefined>;
  // Ao entrar no editor de linha, encerra os outros modos de edição (zona/pintura) no componente.
  onEnterEditMode: () => void;
};

export function useTripwires({
  cameraId,
  label,
  canConfigure,
  tripwiresRev,
  getFrame,
  viewportRef,
  onAlertRef,
  onEnterEditMode,
}: Args) {
  // Tripwires + ocupação (Onda C item 13): counter da lib pura counting.ts (criado sob demanda no rAF do componente).
  const counterRef = useRef<Counter | null>(null);
  const tripwiresRef = useRef<Tripwire[]>([]); // lido no rAF (desenho + setTripwires)
  const twCountsRef = useRef<Record<string, TripwireCounts>>({}); // snapshot p/ o HUD no canvas (sem alocar por frame)
  const twDrawRef = useRef<{
    active: boolean;
    sx: number;
    sy: number;
    cx: number;
    cy: number;
  } | null>(null); // linha em traçado (viewport px)
  const tripwireModeRef = useRef(false); // espelha tripwireMode p/ checagem fresca dentro do re-sync assíncrono
  const liveSyncCamRef = useRef<string | null>(null); // câmera já "armada" p/ re-sync (pula a 1ª execução por câmera — o load inicial já buscou)

  const [tripwires, setTripwires] = useState<Tripwire[]>([]);
  const [tripwireMode, setTripwireMode] = useState(false); // editor de linha ativo (gated por canConfigure)
  const [twCounts, setTwCounts] = useState<Record<string, TripwireCounts>>({}); // contadores in/out p/ o painel lateral

  // (1.2) ACUMULADO DO DIA por linha, vindo do servidor (agregação dos eventos `flow` que o
  // rAF grava via recordFlow a cada cruzamento). Exibido como "hoje" = base + sessão corrente
  // (HUD no canvas via flowBaseRef; painel via flowBase). Carregado 1× ao abrir/trocar a câmera.
  // "↺ Zerar contagem" zera SÓ a sessão (counter.reset) — o histórico do servidor permanece.
  const flowBaseRef = useRef<Record<string, TripwireCounts>>({}); // lido no rAF (HUD, sem alocar)
  const [flowBase, setFlowBase] = useState<Record<string, TripwireCounts>>({});
  useEffect(() => {
    let cancelled = false;
    flowBaseRef.current = {};
    setFlowBase({});
    loadFlowToday(cameraId)
      .then((acc) => {
        if (cancelled) return;
        flowBaseRef.current = acc;
        setFlowBase(acc);
      })
      .catch((e) => {
        // hub antigo sem o kind "flow" / API fora: degrada p/ SÓ a sessão (comportamento
        // anterior), sem crash — a contagem local segue funcionando normalmente.
        console.warn("[tripwires] acumulado do dia indisponível — exibindo só a sessão", e);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  // Tripwires: carrega do BACKEND ao abrir/trocar a câmera (compartilhado; leitura p/ todos).
  // Robustez: se o load falhar, degrada p/ lista vazia (contagem/heatmap seguem). Migração única
  // best-effort: se o backend vier vazio E houver legado em localStorage E o usuário puder configurar
  // (PUT exige engenharia), sobe o legado uma vez e limpa a chave local. Sem canConfigure, só usa o
  // backend (nada se perde: o legado permanece no localStorage até alguém com permissão migrar).
  useEffect(() => {
    let cancelled = false;
    setTripwireMode(false);
    (async () => {
      let list: Tripwire[];
      try {
        list = await getTripwires(cameraId);
      } catch (e) {
        console.error("[tripwires] load falhou — degradando p/ lista vazia", e);
        list = [];
      }
      if (cancelled) return;
      if (list.length === 0 && canConfigure) {
        const legacy = loadLegacyTripwires(cameraId);
        if (legacy.length) {
          try {
            const saved = await saveTripwires(cameraId, legacy);
            if (cancelled) return;
            list = saved;
            clearLegacyTripwires(cameraId);
          } catch (e) {
            if (cancelled) return;
            console.error(
              "[tripwires] migração best-effort falhou — usando legado nesta sessão",
              e,
            );
            list = legacy;
          }
        }
      }
      if (!cancelled) setTripwires(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraId, canConfigure]);
  useEffect(() => {
    tripwireModeRef.current = tripwireMode;
  }, [tripwireMode]);
  // SYNC AO VIVO last-write-wins (ADR-006): re-busca os tripwires quando a central sinaliza
  // (prop `tripwiresRev` incrementada após `camcfg-updated {kind:"tripwires", cameraId}`).
  // Retrocompatível: se a prop NÃO vier (undefined), sai cedo e nada muda — segue carregando
  // só ao abrir/trocar a câmera (effect acima). Sem dependências novas.
  useEffect(() => {
    if (tripwiresRev === undefined) return; // central não passou a prop → comportamento atual preservado
    // Pula a PRIMEIRA execução para cada câmera: o effect de load acima já buscou (e pode estar
    // migrando o legado). Evita double-fetch e a corrida de sobrescrever a migração. Só reage a
    // INCREMENTOS reais de tripwiresRev depois que a câmera está montada/carregada.
    if (liveSyncCamRef.current !== cameraId) {
      liveSyncCamRef.current = cameraId;
      return;
    }
    // NÃO sobrescrever edição local em curso: se o editor de linha está ativo (tripwireMode) ou há
    // uma linha sendo traçada (twDrawRef), PULA o re-fetch para não descartar trabalho não salvo
    // (ADR-006: "re-fetch é pulado durante edição local"). A central segue incrementando; o próximo
    // sinal após concluir/cancelar a edição traz o estado mais recente.
    if (tripwireModeRef.current || twDrawRef.current?.active) return;
    let cancelled = false;
    (async () => {
      let list: Tripwire[];
      try {
        list = await getTripwires(cameraId);
      } catch (e) {
        console.error("[tripwires] re-sync ao vivo falhou — mantendo lista atual", e);
        return;
      } // erro gracioso: não quebra a tela
      if (cancelled) return; // guard de corrida (troca rápida de câmera)
      if (tripwireModeRef.current || twDrawRef.current?.active) return; // usuário entrou em edição durante o fetch → não sobrescreve
      setTripwires(list); // o counter re-seta + painel via effect [tripwires]
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraId, tripwiresRev]);
  // Re-set da geometria no counter quando as linhas mudam (preserva contadores por id) + reflete no painel.
  useEffect(() => {
    tripwiresRef.current = tripwires;
    if (counterRef.current) {
      counterRef.current.setTripwires(tripwires);
      twCountsRef.current = counterRef.current.counts();
    }
    setTwCounts(counterRef.current ? counterRef.current.counts() : {});
  }, [tripwires]);

  // ── editor de tripwires (linhas de contagem) — distinto do editor de zonas ──
  function commitTripwire() {
    const d = twDrawRef.current;
    twDrawRef.current = null;
    if (!d) return;
    if (Math.hypot(d.cx - d.sx, d.cy - d.sy) < 20) return; // linha muito curta → ignora (evita clique acidental)
    const f = getFrame(),
      viewport = viewportRef.current;
    if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const cl = (v: number) => Math.max(0, Math.min(1, v));
    const a = { x: cl((d.sx - cr.x) / cr.w), y: cl((d.sy - cr.y) / cr.h) };
    const b = { x: cl((d.cx - cr.x) / cr.w), y: cl((d.cy - cr.y) / cr.h) };
    const w: Tripwire = { id: newTripwireId(cameraId), a, b };
    const prev = tripwires;
    persistTw([...prev, w], prev);
  }
  // Persiste no BACKEND de forma OTIMISTA: aplica `next` já, e em erro faz rollback p/ `prev` +
  // toast (via onAlert). O PUT exige perfil de engenharia no backend; estas ações já estão gated
  // por canConfigure no front, então um 403 só aparece em borda (ex.: perfil revogado) — tratado.
  function persistTw(next: Tripwire[], prev: Tripwire[]) {
    setTripwires(next); // otimista (o counter re-seta via effect; preserva contadores por id)
    saveTripwires(cameraId, next).catch((e) => {
      setTripwires(prev); // rollback
      const msg =
        e instanceof ApiError ? e.message : "Não foi possível salvar as linhas de contagem.";
      onAlertRef.current?.(`⚠ ${label}: ${msg}`);
    });
  }
  // Inverte a direção (troca a↔b → Entrada↔Saída). O counter preserva contadores por id ao re-setar.
  function invertTripwire(id: string) {
    const prev = tripwires;
    persistTw(
      prev.map((w) => (w.id === id ? { id: w.id, a: w.b, b: w.a } : w)),
      prev,
    );
  }
  function removeTripwire(id: string) {
    const prev = tripwires;
    persistTw(
      prev.filter((w) => w.id !== id),
      prev,
    );
  }
  // Zera os contadores da SESSÃO (geometria mantida); reflete no HUD e no painel.
  // O acumulado do dia (flowBase, servidor) NÃO é apagado — "zerar" é um marco local.
  function resetCounts() {
    counterRef.current?.reset();
    twCountsRef.current = counterRef.current ? counterRef.current.counts() : {};
    setTwCounts(counterRef.current ? counterRef.current.counts() : {});
  }
  // Modo de edição de linha (mutuamente exclusivo com zona/pintura — coordenado pelo componente).
  function toggleTripwireMode() {
    setTripwireMode((v) => {
      const nv = !v;
      if (nv) onEnterEditMode();
      return nv;
    });
  }

  return {
    // estado p/ o JSX
    tripwires,
    tripwireMode,
    twCounts,
    flowBase, // (1.2) acumulado do dia (servidor) — painel soma à sessão
    setTripwireMode,
    setTwCounts,
    // refs lidos/criados pelo rAF + desenho do componente
    counterRef,
    tripwiresRef,
    twCountsRef,
    twDrawRef,
    flowBaseRef, // (1.2) idem p/ o HUD no canvas (lido no rAF)
    // handlers do editor
    commitTripwire,
    invertTripwire,
    removeTripwire,
    resetCounts,
    toggleTripwireMode,
  };
}
