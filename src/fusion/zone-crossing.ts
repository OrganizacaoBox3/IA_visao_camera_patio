// Cruzamento de FRONTEIRA de ZONA — lógica PURA, base da CONSERVAÇÃO de identidade por zona
// (ADR-014, camada 3: zonas=places, operadores=tokens, cruzamentos=transições). A hipótese H2 diz
// que a identidade sobrevive à permanência pela conservação da zona, NÃO pelo tracker quadro-a-quadro:
// se X entrou na zona, ninguém mais entrou/saiu, e um track novo nasce dentro → é X. Isso NÃO exige o
// track sobreviver — exige a FRONTEIRA ser detectável de forma confiável. Este módulo é o detector de
// fronteira; medir sua confiabilidade sobre a gravação real (zone-crossing.test.ts) é o que decide H2.
//
// Responsabilidade única: dado o PÉ de um track ao longo do tempo e o polígono de uma zona, dizer
// QUANDO ele cruzou a fronteira (com anti-flicker) e QUAIS são os casos-limite da conservação
// (nascer/morrer dentro). Não projeta câmera, não associa tag, não conta pessoas globalmente.
//
// REUSO (sem duplicar geometria): `pointInPolygon`/`Polygon` de floor-polygon.ts — o MESMO primitivo
// do recorte anel∩navegável. A fronteira da zona é a borda do polígono; "dentro" é o mesmo teste.
//
// ANTI-FLICKER — escolha e valor (o pé do bbox oscilando sobre a linha não pode gerar 10 cruzamentos):
//   Debounce por N TICKS CONSECUTIVOS (Schmitt-trigger por contagem), default N=2. Uma transição só é
//   CONFIRMADA depois que o pé fica N ticks seguidos do lado novo; um pico de 1 tick sobre a linha
//   nunca confirma. ESCOLHA deliberada sobre a alternativa "margem de distância à borda": a margem
//   exigiria distância ponto→aresta (geometria NOVA, duplicando cálculo de segmento) — o debounce por
//   contagem reusa `pointInPolygon` puro, custo zero de geometria nova (doutrina: uma responsabilidade
//   por unidade, sem duplicar primitivo). VALOR N=2: a 500 ms/tick (o TICK_MS do resample de produção)
//   um cruzamento real permanece do lado novo por muitos ticks; 2 ticks (1 s) filtram o jitter de pé
//   (pxJitter ~cm) sem perder cruzamentos genuínos. TRADEOFF DECLARADO, NÃO ESCONDIDO: uma
//   entrada/saída de 1 único tick (excursão relâmpago) é SUPRIMIDA — é o preço do anti-flicker; a
//   medição de campo conta essas excursões à parte (cruzamentos potencialmente PERDIDOS).
//
// CASOS-LIMITE DA CONSERVAÇÃO (é AQUI que a conservação precisa de cuidado — documentado, não escondido):
//   - "nasceu-dentro": o 1º tick do track já está dentro. NÃO é "entrou" — o tracker criou um ID
//     dentro da zona sem passar pela fronteira (pessoa presente na chegada da observação, ou re-detecção
//     de quem já estava). RISCO DE DUPLA-CONTAGEM: a fronteira não viu essa entrada.
//   - "morreu-dentro": o track some com o estado confirmado DENTRO, sem "saiu". A pessoa não cruzou a
//     fronteira para fora — o tracker apenas a perdeu. RISCO DE VAZAMENTO: a conservação tem de
//     SEGURAR essa identidade (é exatamente o "carregar ID através da morte de track por BALANÇO" do
//     ADR). Decrementar a ocupação aqui seria "confiar no tracker", o que a H2 rejeita.

import { pointInPolygon, type Polygon } from "./floor-polygon";
import type { Vec2 } from "../vision/homography";

/** Zona = contêiner topológico (place da rede de Petri): id + polígono de MUNDO (metros) ou de
 *  IMAGEM (0..1) — `pointInPolygon` é geometria pura, agnóstica ao espaço; o chamador é quem decide
 *  em qual coordenada o `foot` e o `poly` vivem (mundo se há homografia, imagem se não há). */
export type Zone = { id: string; poly: Polygon };

/** Classificação de uma transição de pertinência entre dois instantes (estados JÁ resolvidos). */
export type CrossingClass = "entrou" | "saiu" | "dentro" | "fora";

/**
 * Classifica a transição de UM par (antes, agora) de pertinência à zona. Primitivo mínimo — a base
 * conceitual; `trackZoneEvents` aplica-o sobre estados CONFIRMADOS (pós-histerese), não sobre o cru.
 */
export function classifyCrossing(prevInside: boolean, nowInside: boolean): CrossingClass {
  if (prevInside === nowInside) return nowInside ? "dentro" : "fora";
  return nowInside ? "entrou" : "saiu";
}

/** Tipo de evento de fronteira. "entrou"/"saiu" cruzam a fronteira; "nasceu-dentro"/"morreu-dentro"
 *  são os casos-limite (ver cabeçalho) — o track apareceu/sumiu DENTRO sem cruzar. */
export type ZoneEventKind = "entrou" | "saiu" | "nasceu-dentro" | "morreu-dentro";

/** Um evento de fronteira de UM track sobre UMA zona. `bounces` = flips crus da borda ABSORVIDOS pela
 *  histerese na aproximação deste cruzamento (0 = cruzamento LIMPO, uma transição só; >0 = a borda
 *  oscilou antes de estabilizar). Só faz sentido em "entrou"/"saiu" (nasceu/morreu = 0). */
export type ZoneEvent = {
  zoneId: string;
  kind: ZoneEventKind;
  ts: number;
  /** Índice do tick (na série ORDENADA por ts) em que o evento foi confirmado/observado. */
  tickIndex: number;
  bounces: number;
};

/** Uma amostra do PÉ de um track (bottom-center do bbox projetado ao espaço da zona) num instante. */
export type ZoneSample = { ts: number; foot: Vec2 };

export type TrackZoneOpts = {
  /** Ticks consecutivos do lado novo para CONFIRMAR o cruzamento (anti-flicker). Default 2; <1 vira 1
   *  (sem histerese — cada flip cru vira evento). */
  confirmTicks?: number;
};

const DEFAULT_CONFIRM_TICKS = 2;

/**
 * Sequência de eventos de fronteira de UM track sobre UMA zona, com histerese anti-flicker (ver
 * cabeçalho). A série é ordenada por ts (cópia — não muta a entrada). Pé fora do polígono (ou
 * polígono inválido <3 pts) → `pointInPolygon` devolve `false` (retorno seguro do primitivo).
 *
 * Emite, na ordem temporal:
 *   - "nasceu-dentro" no 1º tick, se o track já começa DENTRO (distinto de "entrou");
 *   - "entrou"/"saiu" a cada cruzamento CONFIRMADO (N ticks do lado novo), com `bounces` = flips
 *     absorvidos (0 = limpo);
 *   - "morreu-dentro" no último tick, se o estado confirmado terminar DENTRO (o track some sem "saiu").
 *
 * A confirmação tem latência de N−1 ticks (o evento é datado no tick em que a evidência FECHA, não no
 * 1º tick do lado novo) — consequência aceita do anti-flicker, documentada.
 */
export function trackZoneEvents(
  track: readonly ZoneSample[],
  zone: Zone,
  opts?: TrackZoneOpts,
): ZoneEvent[] {
  if (!Array.isArray(track) || track.length === 0) return [];
  const N = Math.max(1, Math.floor(opts?.confirmTicks ?? DEFAULT_CONFIRM_TICKS));
  const s = [...track].sort((a, b) => a.ts - b.ts);
  const raw = s.map((p) => pointInPolygon(p.foot, zone.poly));

  const events: ZoneEvent[] = [];
  let confirmed = raw[0];
  if (confirmed)
    events.push({ zoneId: zone.id, kind: "nasceu-dentro", ts: s[0].ts, tickIndex: 0, bounces: 0 });

  let run = 0; // ticks crus consecutivos do lado OPOSTO ao confirmado
  let bounces = 0; // flips crus da borda desde a última mudança confirmada (messiness deste cruzamento)
  for (let i = 1; i < s.length; i++) {
    if (raw[i] !== raw[i - 1]) bounces++;
    if (raw[i] !== confirmed) {
      run++;
      if (run >= N) {
        // O flip que INICIOU esta corrida oposta é o cruzamento "real" → subtrai 1 de bounces para
        // isolar os flips ABSORVIDOS (o dithering); bounces==1 (só o flip real) ⇒ limpo (0 absorvidos).
        const kind = classifyCrossing(confirmed, raw[i]) as "entrou" | "saiu";
        events.push({ zoneId: zone.id, kind, ts: s[i].ts, tickIndex: i, bounces: Math.max(0, bounces - 1) });
        confirmed = raw[i];
        run = 0;
        bounces = 0;
      }
    } else {
      run = 0; // voltou ao lado confirmado antes de fechar N — a corrida oposta se dissolve
    }
  }

  if (confirmed)
    events.push({
      zoneId: zone.id,
      kind: "morreu-dentro",
      ts: s[s.length - 1].ts,
      tickIndex: s.length - 1,
      bounces: 0,
    });
  return events;
}

/** Um ponto da linha do tempo de ocupação: o instante e a ocupação (balanço de fronteira) resultante. */
export type OccupancyPoint = { ts: number; occ: number };

/** Ocupação de uma zona ao longo do tempo + os anomalias que o balanço puro de fronteira NÃO vê. */
export type ZoneOccupancy = {
  /** Ocupação após cada evento que a altera, em ordem de ts (a base da conservação). */
  timeline: OccupancyPoint[];
  /** Tokens que apareceram DENTRO sem cruzar a fronteira (risco de dupla-contagem). */
  bornInside: number;
  /** Tokens cujo track morreu DENTRO sem "saiu" (risco de vazamento — a conservação tem de segurar). */
  diedInside: number;
  minOcc: number;
  maxOcc: number;
  /** Ocupação final: !=0 é a "dívida" de conservação (entradas+nascidos−saídas não zeraram). */
  endOcc: number;
};

/**
 * Dobra eventos de fronteira em ocupação ao longo do tempo — a BASE DA CONSERVAÇÃO. Convenção:
 *   - "entrou": +1 · "saiu": −1 (o balanço de fronteira, a quantidade conservada);
 *   - "nasceu-dentro": +1 (o token ESTÁ presente — apareceu dentro), mas contado à parte em `bornInside`;
 *   - "morreu-dentro": 0 (a pessoa NÃO cruzou a fronteira para fora; decrementar seria confiar no
 *     tracker, o que a H2 rejeita) — contado à parte em `diedInside`.
 * `bornInside`/`diedInside` quantificam quanto do movimento de ocupação veio de churn de track
 * DENTRO da zona (não de cruzamentos reais): uma zona perfeitamente conservativa tem os dois = 0 e
 * `endOcc` = 0. Espera-se eventos de UMA zona (o chamador filtra por zoneId se necessário); a dobra é
 * sobre TODOS os eventos passados, em ordem de ts.
 */
export function zoneOccupancy(events: readonly ZoneEvent[]): ZoneOccupancy {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const timeline: OccupancyPoint[] = [];
  let occ = 0;
  let minOcc = 0;
  let maxOcc = 0;
  let bornInside = 0;
  let diedInside = 0;
  for (const e of sorted) {
    let delta = 0;
    if (e.kind === "entrou") delta = 1;
    else if (e.kind === "saiu") delta = -1;
    else if (e.kind === "nasceu-dentro") {
      delta = 1;
      bornInside++;
    } else {
      diedInside++; // "morreu-dentro" — não move o balanço de fronteira
    }
    if (delta !== 0) {
      occ += delta;
      if (occ < minOcc) minOcc = occ;
      if (occ > maxOcc) maxOcc = occ;
      timeline.push({ ts: e.ts, occ });
    }
  }
  return { timeline, bornInside, diedInside, minOcc, maxOcc, endOcc: occ };
}
