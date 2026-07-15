// PLANTA BLE — posição X,Y de cada tag por MULTILATERAÇÃO das antenas do chão — núcleo PURO
// (sem DOM/React), testável. Base de uma tela "Planta baixa 2D" que mostra as tags SEM câmera:
// só as antenas BLE, a caixa do galpão (retângulo em metros) e um ponto por tag.
//
// HONESTIDADE (LOAD-BEARING — não apagar, não suavizar): trilateração por RSSI foi REFUTADA neste
// projeto (ver useFloorTags.ts:8-11 — piso de 1,20 m contra separação de 0,49 m; a interseção herda
// o erro de DUAS medições → um ponto que NÃO existe, Regra 11). O RSSI dá DISTÂNCIA grosseira
// (±dB → ±30-50% em metros), não posição. Portanto o ponto X,Y que este núcleo devolve é
// ESTIMATIVA DE DEMO, explicitamente rotulada — NÃO é medição. A tela que o consome deve dizer isso
// na cara ("estimativa", não coordenada de verdade). Não prometemos precisão a ninguém.
//
// O que fazemos para a estimativa não MENTIR mais do que o inevitável (mitigações, não milagres):
//  (a) GRAMPO ao chão (set-membership): a pos final é clampada ao retângulo [0,w]×[0,h] — a tag
//      pode estar mal posicionada DENTRO do prédio, mas nunca do lado de fora dele;
//  (b) SELO DE CONFIANÇA por nº de antenas (`fix`): ok (≥3, multilateração), weak (2, interseção de
//      2 círculos — chute geométrico), none (<2, sem X,Y — só a antena mais forte como texto);
//  (c) SUAVIZAÇÃO temporal fica no HOOK (EMA do RSSI, fora deste núcleo — aqui é 1 quadro, puro).
// Fallback textual sempre honesto: `nearest` = a antena de MAIOR rssi (a mais próxima) + a distância
// estimada por ela — isso é DISTÂNCIA de 1 antena, o único número que o RSSI compra sem inventar.
//
// Responsabilidade única: geometria da estimativa (RSSI→distância→ponto grampeado). Desenho e
// suavização vivem à parte. Espelha o estilo defensivo de deriveTopdownView (guardas isFiniteNum/
// isVec/Array.isArray, dedup determinístico por (mac,fonte), rótulos por sufixo do MAC).

import type { Vec2 } from "../vision/homography";
import { distFromRssi, type PathLossModel } from "./floor-plot";
import { bboxOf, type TopdownBbox } from "./topdown"; // reusa o bbox de mundo (mesma família)

/** Antena BLE no chão em METROS (pos) + estado vivo (só antena viva mede) + rótulo amigável. */
export type FloorplanStation = { id: string; label: string; pos: Vec2; live: boolean };
/** Leitura crua (estação, tag, rssi). rotulo = nome da pessoa quando a tag foi batizada. */
export type FloorplanReading = { stationId: string; mac: string; rssi: number; rotulo?: string | null };
/** Qualidade do fix: ok = ≥3 antenas vivas ouviram; weak = 2; none = <2 (sem X,Y confiável). */
export type FloorplanFix = "ok" | "weak" | "none";
export type FloorplanTag = {
  mac: string;
  /** rotulo (nome da pessoa) || sufixo de 4 hex do MAC. */
  label: string;
  /** X,Y estimado, GRAMPEADO ao retângulo [0,w]×[0,h]; null quando fix==="none" (sem posição). */
  pos: Vec2 | null;
  fix: FloorplanFix;
  /** nº de antenas VIVAS que ouviram a tag (o que define o `fix`). */
  nStations: number;
  /** Antena de MAIOR rssi (a mais próxima) + distância estimada por ela — fallback textual honesto. */
  nearest: { stationId: string; distM: number } | null;
};
export type FloorplanView = {
  widthM: number;
  heightM: number;
  /** Só as antenas com posição válida (as passadas), na ordem recebida — inclui as mortas (marcador). */
  stations: FloorplanStation[];
  tags: FloorplanTag[];
};

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === "object" && isFiniteNum((v as Vec2).x) && isFiniteNum((v as Vec2).y);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Chave de fonte: casa `reading.stationId` com `station.id` (mesmo critério de topdown: MAIÚSCULAS). */
const srcKey = (id: string | undefined | null): string => (typeof id === "string" ? id.toUpperCase() : "");
const macKey = (mac: string): string => mac.toUpperCase();
/** Sufixo curto p/ rótulo: 4 últimos hex do MAC (sem separadores), maiúsculo. */
const macSuffix = (mac: string): string =>
  mac.replace(/[^0-9a-zA-Z]/g, "").slice(-4).toUpperCase();

// Modelo default DECLARADO (o mesmo do floor-plot, mas com os campos que a assinatura exige) —
// usado quando o chamador não passa um path-loss calibrado. O raio vira chute de modelo, não medição.
const DEFAULT_MODEL: PathLossModel = { rssi0: -45, n: 2.2, source: "default", samples: 0 };
// AᵀA quase singular (antenas colineares/coincidentes) → o sistema não RESOLVE X e Y; devolvemos null
// em vez de um ponto NaN/explodido. Mesmo espírito do W_EPS/1e-12 do horizonte projetivo.
const DET_EPS = 1e-9;

/**
 * MULTILATERAÇÃO PURA por mínimos quadrados LINEARIZADOS: antenas com posição+distância → ponto X,Y.
 *
 * Linearização clássica (subtrai a antena-referência p0, a 1ª, para cancelar o termo quadrático |x|²):
 *   para cada antena i>0:  2·(p_i − p_0)·x = (|p_i|² − |p_0|²) − (d_i² − d_0²).
 * Monta A (linhas [2·(xi−x0), 2·(yi−y0)]) e b, resolve por equações normais 2×2 x = (AᵀA)⁻¹ Aᵀb.
 * `residualM` = RMS de (‖x − p_i‖ − d_i) sobre TODAS as antenas (0 no caso exato/sem ruído).
 *
 * Retorna null quando:
 *  - <2 observações (nada a resolver);
 *  - |det(AᵀA)| < 1e-9 → sistema degenerado. Cai aqui, por construção, o caso N==2 (1 linha só →
 *    AᵀA de posto 1 → det≈0) E o caso de antenas COLINEARES (a direção perpendicular à reta das
 *    antenas fica sem informação — det≈0). A separação do N==2 (interseção de 2 círculos) e a
 *    escolha de fallback ficam em deriveFloorplanView.
 */
export function multilaterate(
  obs: { pos: Vec2; distM: number }[],
): { pos: Vec2; residualM: number } | null {
  if (!Array.isArray(obs)) return null;
  const pts = obs.filter((o) => o && isVec(o.pos) && isFiniteNum(o.distM));
  if (pts.length < 2) return null;

  const p0 = pts[0].pos;
  const d0 = pts[0].distM;
  const p0sq = p0.x * p0.x + p0.y * p0.y;

  // Equações normais AᵀA·x = Aᵀb acumuladas (A é (N−1)×2, então guardamos só os 3+2 escalares).
  let s00 = 0; // Σ ax²
  let s01 = 0; // Σ ax·ay
  let s11 = 0; // Σ ay²
  let t0 = 0; // Σ ax·b
  let t1 = 0; // Σ ay·b
  for (let i = 1; i < pts.length; i++) {
    const pi = pts[i].pos;
    const di = pts[i].distM;
    const ax = 2 * (pi.x - p0.x);
    const ay = 2 * (pi.y - p0.y);
    const bi = pi.x * pi.x + pi.y * pi.y - p0sq - (di * di - d0 * d0);
    s00 += ax * ax;
    s01 += ax * ay;
    s11 += ay * ay;
    t0 += ax * bi;
    t1 += ay * bi;
  }

  const det = s00 * s11 - s01 * s01;
  if (Math.abs(det) < DET_EPS) return null; // colinear/coincidente/N==2 → não resolve → null honesto
  const x = (s11 * t0 - s01 * t1) / det;
  const y = (-s01 * t0 + s00 * t1) / det;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  // Resíduo RMS sobre TODAS as antenas (inclusive a referência): mede quanto o ponto "brigou" com
  // as distâncias — 0 no caso exato, cresce com ruído/inconsistência (útil de olho, não surfaçado).
  let acc = 0;
  for (const o of pts) {
    const r = Math.hypot(x - o.pos.x, y - o.pos.y) - o.distM;
    acc += r * r;
  }
  const residualM = Math.sqrt(acc / pts.length);
  return { pos: { x, y }, residualM };
}

/**
 * Interseção geométrica de DOIS círculos (antena p0/raio d0, antena p1/raio d1) → um ponto X,Y.
 * É o fix "weak": com 2 antenas não há solução única de multilateração, então caímos na geometria.
 *  - centros coincidentes (dCenter≈0) → devolve p0 (sem eixo definível);
 *  - círculos que SE CRUZAM → há 2 interseções; escolhe a que cai DENTRO do retângulo [0,w]×[0,h];
 *    se ambas fora ou ambas dentro, a de MENOR |y| (desempate determinístico); nunca aleatório;
 *  - círculos que NÃO se cruzam (longe demais / um dentro do outro) → ponto na LINHA entre as antenas,
 *    dividido na proporção das distâncias (fração d0/(d0+d1) a partir de p0: raio maior a p0 ⇒ mais
 *    perto de p1). É um chute honesto "em algum lugar entre as duas", sem inventar interseção que
 *    não existe. Os w/h entram só para a escolha entre as 2 raízes — o grampo final é do chamador.
 */
function twoCircle(p0: Vec2, d0: number, p1: Vec2, d1: number, w: number, h: number): Vec2 {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dCenter = Math.hypot(dx, dy);
  if (dCenter < 1e-9) return { x: p0.x, y: p0.y }; // antenas coincidentes → sem eixo
  // 'a' = projeção, sobre o eixo dos centros, do pé da corda comum medido a partir de p0.
  const a = (d0 * d0 - d1 * d1 + dCenter * dCenter) / (2 * dCenter);
  const h2 = d0 * d0 - a * a;
  if (h2 < 0) {
    // Sem interseção: ponto na linha, na proporção das distâncias (fração a partir de p0).
    const denom = d0 + d1;
    const f = denom > 1e-9 ? d0 / denom : 0.5;
    return { x: p0.x + f * dx, y: p0.y + f * dy };
  }
  const ux = dx / dCenter;
  const uy = dy / dCenter;
  // Pé da corda no eixo dos centros, e o offset perpendicular (as 2 raízes = pé ± offset⊥).
  const mx = p0.x + a * ux;
  const my = p0.y + a * uy;
  const off = Math.sqrt(h2);
  const s1 = { x: mx - off * uy, y: my + off * ux };
  const s2 = { x: mx + off * uy, y: my - off * ux };
  const inside = (p: Vec2): boolean => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
  const in1 = inside(s1);
  const in2 = inside(s2);
  if (in1 && !in2) return s1;
  if (in2 && !in1) return s2;
  // Ambas dentro ou ambas fora → desempate determinístico pela menor |y|.
  return Math.abs(s1.y) <= Math.abs(s2.y) ? s1 : s2;
}

/**
 * Deriva a Planta BLE — PURA. Robusta a lixo (guardas isFiniteNum/isVec/Array.isArray, espelhando
 * deriveTopdownView). Só antenas VIVAS medem; dedup por (mac, antena viva) fica o MAIOR rssi.
 * Para cada tag ouvida por ≥1 antena viva: distância por antena via distFromRssi (modelo default
 * DECLARADO se `model` ausente), depois:
 *   ≥3 antenas → multilaterate (fix "ok"); se degenerar (colinear), degrada p/ interseção das 2 mais
 *                fortes (mantém pos não-null — o selo "ok" já avisa que é estimativa, o grampo protege);
 *   ==2 antenas → twoCircle das 2 (fix "weak");
 *   ==1 antena  → sem X,Y (fix "none", pos null) — só `nearest` como texto;
 *   0 antenas vivas → a tag NÃO aparece (nada honesto a mostrar).
 * A pos final é sempre GRAMPEADA a [0,widthM]×[0,heightM]. Tags ordenadas por MAC (determinístico);
 * stations na ordem recebida (as passadas com posição válida).
 */
export function deriveFloorplanView(args: {
  widthM: number;
  heightM: number;
  stations: FloorplanStation[];
  readings: FloorplanReading[];
  model?: PathLossModel;
}): FloorplanView {
  const widthM = isFiniteNum(args?.widthM) && args.widthM > 0 ? args.widthM : 0;
  const heightM = isFiniteNum(args?.heightM) && args.heightM > 0 ? args.heightM : 0;
  const stationsIn = Array.isArray(args?.stations) ? args.stations : [];
  const readingsIn = Array.isArray(args?.readings) ? args.readings : [];
  const model = args?.model ?? DEFAULT_MODEL;

  // ── Antenas: só as com posição válida entram na vista (na ordem recebida). Vivas medem; mortas
  //    ficam como marcador. Índice por srcKey só das VIVAS (o único que casa com as leituras). ──
  const stations: FloorplanStation[] = [];
  const liveByKey = new Map<string, { id: string; label: string; pos: Vec2 }>();
  for (const st of stationsIn) {
    if (!st || !isVec(st.pos)) continue;
    const label = (st.label ?? "").trim() || st.id || "Estação";
    stations.push({ id: st.id, label, pos: st.pos, live: !!st.live });
    if (st.live) liveByKey.set(srcKey(st.id), { id: st.id, label, pos: st.pos });
  }

  // ── Agrupa leituras por MAC; por (mac, antena viva) fica o MAIOR rssi (dedup determinístico). ──
  const byMac = new Map<string, { mac: string; rotulo: string | null; heard: Map<string, number> }>();
  for (const r of readingsIn) {
    if (!r || typeof r.mac !== "string" || !r.mac || !isFiniteNum(r.rssi)) continue;
    const key = srcKey(r.stationId);
    if (!liveByKey.has(key)) continue; // antena inexistente ou MORTA → não mede
    const mk = macKey(r.mac);
    let e = byMac.get(mk);
    if (!e) {
      e = { mac: r.mac, rotulo: r.rotulo ?? null, heard: new Map() };
      byMac.set(mk, e);
    }
    const prev = e.heard.get(key);
    if (prev === undefined || r.rssi > prev) e.heard.set(key, r.rssi);
    if (r.rotulo) e.rotulo = r.rotulo;
  }

  // ── Uma FloorplanTag por MAC ouvido por ≥1 antena viva. ──
  const tags: FloorplanTag[] = [];
  for (const e of byMac.values()) {
    // Antenas vivas que ouviram, com rssi e distância estimada — ordenadas pela MAIS FORTE primeiro
    // (referência da multilateração = antena mais próxima ⇒ melhor condicionamento; e nearest = [0]).
    const heard = [...e.heard.entries()]
      .map(([key, rssi]) => {
        const stn = liveByKey.get(key)!;
        return { id: stn.id, pos: stn.pos, rssi, distM: distFromRssi(model, rssi) };
      })
      .sort((a, b) => b.rssi - a.rssi || a.id.localeCompare(b.id));

    const nStations = heard.length;
    if (nStations === 0) continue; // tag só ouvida por antena morta → não aparece

    const nearest = { stationId: heard[0].id, distM: heard[0].distM };
    let pos: Vec2 | null = null;
    let fix: FloorplanFix;
    if (nStations >= 3) {
      fix = "ok";
      const ml = multilaterate(heard.map((o) => ({ pos: o.pos, distM: o.distM })));
      // Degenerado (colinear) → não deixa a tag sem posição: interseção das 2 mais fortes.
      pos = ml
        ? ml.pos
        : twoCircle(heard[0].pos, heard[0].distM, heard[1].pos, heard[1].distM, widthM, heightM);
    } else if (nStations === 2) {
      fix = "weak";
      pos = twoCircle(heard[0].pos, heard[0].distM, heard[1].pos, heard[1].distM, widthM, heightM);
    } else {
      fix = "none"; // 1 antena → distância, não posição (pos permanece null)
    }

    // GRAMPO ao chão (set-membership): a tag nunca sai do prédio, por pior que a estimativa seja.
    if (pos) pos = { x: clamp(pos.x, 0, widthM), y: clamp(pos.y, 0, heightM) };

    tags.push({ mac: e.mac, label: e.rotulo || macSuffix(e.mac), pos, fix, nStations, nearest });
  }
  tags.sort((a, b) => macKey(a.mac).localeCompare(macKey(b.mac)));

  return { widthM, heightM, stations, tags };
}

// Reexporta o tipo de bbox de mundo (mesma família topdown) — quem enquadra a planta no canvas
// reusa bboxOf/worldToCanvas de topdown.ts; aqui só damos passagem ao tipo para conveniência.
export { bboxOf };
export type { TopdownBbox };
