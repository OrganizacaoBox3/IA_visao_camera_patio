// Gravador OPT-IN da SESSÃO DE FUSÃO INDOOR (câmera + BLE) — matéria-prima do harness de replay do
// motor de localização (ADR-012). O recorder.js grava só relatórios COM lat/lon (modelo AirTag/GPS);
// indoor NÃO tem GPS — este grava o par bruto que o motor consome: tracks do `analysis-tracks`
// (caixas normalizadas) + leituras BLE do ingest, cada um com seu relógio (ts do hub).
//
// FORMATO (JSONL append-only, 1 evento/linha — contrato fixo com o loader de replay):
//   {"t":"cal","ts":<ms>,"cameraId":"<id>","H":[9 números]|null,"station":{"x":0..1,"y":0..1}|null}
//   {"t":"trk","ts":<ms>,"cameraId":"<id>","tracks":[{"id":<num>,"bbox":[x,y,w,h]}]}  // bbox 0..1
//   {"t":"ble","ts":<ms>,"stationId":"<id>","sourceKind":"ble-rssi","readings":[{"mac":"<MAC>","rssi":<int>}]}
//     — `sourceKind` (ADITIVO, ADR-013 item 3): tipo da FONTE da medição, no vocabulário universal
//     de evidência (evidence.ts, arquivado na tag research-fusion-arc-2026-07-12) — sensores futuros (AoA/UWB/mmWave) gravam o seu pela
//     MESMA porta. O `stationId` É o `sourceId` do domínio BLE: o nome fica por retrocompat de
//     contrato (loader/ingest antigos o conhecem assim), a generalização fica registrada aqui — o
//     loader (`src/fusion/session-loader.ts`) o preserva como `sourceId` de cada reading quando a
//     linha traz `sourceKind`. Gravações antigas (sem o campo) seguem lidas idênticas.
//   {"t":"meta","ts":<ms>,"gitRev":"<hash curto>"|null,"fusionConfig":{...knobs de associate.ts}}
//     — versão do algoritmo/knobs (pedido do especialista científico, 2026-07-10): escrita UMA vez,
//     na primeira linha gravada do PROCESSO (não por câmera/sessão — ver `ensureMeta()`). "Replay de
//     gravação antiga com semântica nova é lixo silencioso" — sem isso não dá pra saber que default
//     de `minMargin`/`optimal`/etc. gerou aquela decisão. `gitRev` é o `git rev-parse --short HEAD`
//     do hub no instante da gravação (null se `git` indisponível, ex.: pacote de release sem .git —
//     não é fatal). `fusionConfig` é um ESPELHO MANUAL dos `DEFAULTS` de `src/fusion/associate.ts`
//     (ver `CLIENT_FUSION_CONFIG_MIRROR` abaixo) — mesma convenção de espelho manual já usada em
//     `eval/` para `precision.js` (CLAUDE.md §6: "toda mudança de knob... passa por eles"). Por quê
//     um espelho e não import direto: o associador roda no CLIENTE (browser, `useTagFusion.ts`), e o
//     hub (`server/`) é CommonJS puro — não há ponte de runtime entre o TS do cliente e o JS do
//     servidor sem build. `gitRev` é a fonte de verdade DEFINITIVA se este espelho ficar desatualizado
//     (baixe `git show <gitRev>:src/fusion/associate.ts` e confira); manter isso sincronizado é
//     responsabilidade de quem mexer nos DEFAULTS de associate.ts (mesmo espírito do precision.js).
//
// GAP CONHECIDO (a) — decisões do associador POR TICK (trackId/tag/confidence/margin/hadConflict,
// incluindo candidatos REJEITADOS) NÃO são gravadas aqui. Investigado: `TagTrackAssociator.assign()`
// roda em `src/fusion/useTagFusion.ts`, no CLIENTE (browser) — o hub (dono deste arquivo) NUNCA
// executa o associador e não tem visibilidade sobre suas decisões. Gravar isso exigiria um canal
// NOVO cliente→servidor (endpoint HTTP ou emissão socket) que hoje não existe. Decisão HONESTA:
// não inventar essa rota sem necessidade clara validada em campo — fica como GAP documentado e
// escopado para fase futura (backlog: `docs/analises/tags-bluetooth/PENDENCIAS.md`, item 3). A
// DEFINIÇÃO do que seria minerado dessas decisões (o "episódio-candidato a pseudo-label") já está
// tipada em `src/fusion/session-loader.ts` (`PseudoLabelCandidate`/`findPseudoLabelCandidates`),
// pronta para o dia em que a gravação for viabilizada.
//
// GAP CONHECIDO (c) — OFFSET DE RELÓGIO hub↔TC22: investigado em `server/routes/bt-station.js` e no
// código-fonte real do coletor (`tc22-scanner/src/com/grendene/btscan/MainActivity.java:405`, contrato
// documentado ali: `{stationId, readings:[{mac,name,rssi}]}`) — o TC22 NÃO manda timestamp próprio no
// payload; todo `ts` gravado (inclusive aqui) é `Date.now()` do HUB na chegada (já flagueado em
// `docs/cientifica/status-implementacao.md`, item "ts de captura na borda"). Sem um `deviceTs` no
// payload não há o que comparar — {hubTs, deviceTs} exigiria dado que o dispositivo não envia. NÃO
// implementado (documentar > inventar protocolo NTP): se o TC22 um dia ganhar timestamp próprio
// (ex.: `body.ts`/`body.deviceTs`), a linha `{"t":"clock","ts":<hubTs>,"deviceTs":<deviceTs>}`,
// gravada periodicamente (ex.: 1×/min), é o formato natural a adicionar aqui — o loader já tolera
// tipos de linha desconhecidos (contrato aditivo), então isso pode ser ligado sem migração.
//
// LGPD (ADR-002): SÓ metadados (caixas/MAC/RSSI/matriz H) — JAMAIS frame/imagem. Whitelist de campos:
// mesmo que track/leitura traga mais coisa, nada além do contrato acima vai pro disco. Minimização
// DELIBERADA: a leitura BLE grava só {mac, rssi} — o `rotulo` (nome dado pelo usuário, PII potencial)
// fica FORA; o mapeamento mac→rotulo vive em bt-tags p/ anotação humana pós-coleta.
//
// I/O: appendFileSync no caminho quente é ACEITO para este escopo (opt-in, teste de campo de minutos,
// linhas pequenas) — simplicidade > throughput aqui. Se virar uso recorrente/24-7, trocar por
// fs.createWriteStream({ flags: "a" }).
//
// OFF por default: só grava com FUSION_RECORD truthy (opt-in explícito — quem liga sabe que está
// coletando). Fail-safe: JAMAIS lança no caminho quente (pipeline de análise / ingest BLE) — erro de
// disco loga UMA vez e segue mudo. Só node:fs/node:path + camcfg (padrão da casa: sem dependência nova).
//
// CADÊNCIA (documentada, sem throttle — KISS, o loader resample): `analysis-tracks` emite ~1-20 Hz por
// câmera (FPS/FPS_LINE/FPS_FOCUS do engine). Num teste de campo de minutos isso dá um JSONL de alguns
// MB — ok. NÃO deixe FUSION_RECORD ligado 24/7 sem rotação.
//
// OPERAÇÃO: a linha "cal" é escrita na PRIMEIRA rodada de tracks gravada da câmera (H/station null se
// não calibrada) e RE-EMITIDA sempre que o `updatedAt` da calibração no camcfg mudar — calibrar ou
// recalibrar durante a sessão entra no JSONL (o loader aplica "último cal vence").
//
// SEGURANÇA DO DADO (invariante da casa, CLAUDE.md §3 — nasceu de um incidente real, 2026-07-10: um
// `rm -f` num arquivo sob escrita ativa apagou ~7h de gravação irrecuperável, gitignored):
//  1. SEGMENTAÇÃO POR HORA: cada hora vira um arquivo `fusion-session-YYYY-MM-DD_HH.jsonl` novo — a
//     perda MÁXIMA de um acidente cai de "a sessão inteira" para "a hora corrente". Cada segmento é
//     AUTOSSUFICIENTE (meta/cal re-emitidos no início de cada um — ver `rollSegmentIfNeeded()`), então
//     o loader consegue ler um segmento sozinho sem depender dos anteriores.
//  2. BACKUP PERIÓDICO: a cada `BACKUP_EVERY_APPENDS` linhas, o segmento corrente é copiado para
//     `<nome>.bak.jsonl` ao lado (mesma pasta, também gitignored) — se o arquivo ativo for apagado por
//     engano, a cópia mais recente (no máximo `BACKUP_EVERY_APPENDS` linhas atrás) sobrevive. NÃO é
//     backup fora do alcance de quem tem acesso à pasta (mitigação parcial, documentada como tal — não
//     substitui um backup externo de verdade se o incidente for mais sério que "comando errado").
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const camcfg = require("../camcfg");

const DIR = __dirname; // co-locado com os outros artefatos de runtime do domínio BT. Gitignored.

// Chave de hora local (sem `:`, inválido em nome de arquivo no Windows): "YYYY-MM-DD_HH".
function hourKey(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}`;
}

function segmentPath(key) {
  return path.join(DIR, `fusion-session-${key}.jsonl`);
}

// Estado do segmento ATIVO — recalculado a cada escrita (barato: 1 `new Date()` + comparação de
// string). Trocar de segmento reseta `metaWritten`/`calStamp`: cada arquivo nasce autossuficiente.
let activeKey = null;
let activeFile = null;
let appendsInSegment = 0;

const BACKUP_EVERY_APPENDS = 200; // ordem de grandeza: minutos de gravação a ~1-20Hz, não segundos

// Raiz do repo (server/bt/ → ../..) — onde o `git rev-parse` deve rodar.
const REPO_ROOT = path.join(__dirname, "..", "..");

// ESPELHO MANUAL dos `DEFAULTS` de `src/fusion/associate.ts` (ver header) — o FusionConfig efetivo
// hoje, porque `useTagFusion.ts` sempre instancia `new TagTrackAssociator()` sem overrides (conferido
// em 2026-07-10: nenhum lugar do cliente passa config). Se um dia existir override em produção, este
// espelho para de ser a verdade e passa a ser só o "default de fábrica" — o `gitRev` gravado ao lado
// continua reconstituindo os DEFAULTS exatos daquela revisão via `git show`.
const CLIENT_FUSION_CONFIG_MIRROR = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  minMovement: 0.15, // 0,25→0,15 em 2026-07-11 (evidência de campo + torneio — ver associate.ts DEFAULTS)
  minMargin: 0.1,
  optimal: false,
  maxDistRatio: 0,
  distWeight: 0,
};

// `git rev-parse --short HEAD` obtido 1x por processo (lazy) e cacheado. `undefined` = ainda não
// tentou; `null` = tentou e falhou (sem `.git`/`git` ausente, ex.: pacote de release — não é fatal).
let gitRevCache;
function getGitRev() {
  if (gitRevCache !== undefined) return gitRevCache;
  try {
    gitRevCache = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    gitRevCache = null; // sem .git / git ausente — segue sem versão, nunca lança
  }
  return gitRevCache;
}

// Opt-in: liga só quando FUSION_RECORD é truthy (1/true/yes/on). Lido a CADA chamada — sem estado de
// boot, dá pra ligar/desligar sem reiniciar caso a env mude no processo.
function enabled() {
  const v = String(process.env.FUSION_RECORD || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Última calibração gravada por câmera NO SEGMENTO ATIVO: cameraId → `updatedAt` do camcfg (null =
// "gravada como não-calibrada"). Se o updatedAt corrente divergir, a linha "cal" é re-emitida. Limpo
// a cada rollover de hora (ver `rollSegmentIfNeeded`) — cada segmento reconstrói seu próprio "cal".
let calStamp = new Map();
// Fail-safe "loga 1x": o pipeline chama a ~10-20 Hz — um disco cheio não pode virar spam de log.
// Global (não por segmento) — disco com defeito não se conserta trocando de hora.
let warned = false;

// Troca de segmento por hora (ver header §SEGURANÇA DO DADO). Idempotente: só age quando a chave de
// hora muda. Reseta o estado "escrito neste segmento" (meta/cal) — cada arquivo nasce autossuficiente.
function rollSegmentIfNeeded() {
  const key = hourKey(new Date());
  if (key === activeKey) return;
  activeKey = key;
  activeFile = segmentPath(key);
  appendsInSegment = 0;
  calStamp = new Map();
  metaWritten = false;
}

// Backup periódico (mitigação, não crítico): copia o segmento ativo pra `<nome>.bak.jsonl` ao lado.
// Falha de backup NUNCA usa `fail()`/loga-e-para — é best-effort silencioso (o path principal de
// gravação não pode ficar refém de um backup que falhou).
function backupSegment() {
  try {
    fs.copyFileSync(activeFile, activeFile.replace(/\.jsonl$/, ".bak.jsonl"));
  } catch {
    // silencioso de propósito — ver comentário acima
  }
}

function append(line) {
  fs.appendFileSync(activeFile, JSON.stringify(line) + "\n");
  appendsInSegment++;
  if (appendsInSegment % BACKUP_EVERY_APPENDS === 0) backupSegment();
}

function fail(e) {
  if (warned) return;
  warned = true;
  console.error("[fusion-recorder] falha ao gravar (ignorado; não loga de novo):", String((e && e.message) || e));
}

// Escreve a linha "meta" (versão do algoritmo/knobs — ver header) UMA vez por SEGMENTO, antes da
// PRIMEIRA linha de qualquer outro tipo naquele arquivo. `metaWritten` é marcado ANTES do append
// (não depois, ao contrário do `calStamp`): computar `gitRev` chama um subprocesso — não vale a pena
// repetir a cada tick só porque o disco falhou uma vez; se a escrita falhar, `fail()` já loga e o
// resto do pipeline segue mudo, como o resto deste arquivo.
let metaWritten = false;
function ensureMeta() {
  if (metaWritten) return;
  metaWritten = true;
  append({ t: "meta", ts: Date.now(), gitRev: getGitRev(), fusionConfig: CLIENT_FUSION_CONFIG_MIRROR });
}

/**
 * Grava UMA rodada de tracks de uma câmera (chamado no ponto de emissão do `analysis-tracks`).
 * Whitelist: só {id, bbox} de cada track (bbox normalizado 0..1, como veio do tracker).
 * Escreve antes a linha "cal" na primeira gravação da câmera E sempre que a calibração mudar
 * (comparação por `updatedAt` do camcfg — o loader aplica "último cal vence").
 * No-op quando desabilitado. Nunca lança (fail-safe — caminho quente do pipeline).
 */
function recordTracks(cameraId, ts, tracks) {
  if (!enabled()) return;
  try {
    rollSegmentIfNeeded();
    ensureMeta();
    const id = String(cameraId || "");
    const when = Number(ts) || Date.now();
    const cal = camcfg.getCalibration(id); // null quando a câmera nunca foi calibrada
    const stamp = cal ? Number(cal.updatedAt) || 0 : null; // null distingue "sem calibração" de updatedAt=0
    if (!calStamp.has(id) || calStamp.get(id) !== stamp) {
      const H = cal && Array.isArray(cal.H) && cal.H.length === 9 ? cal.H.map(Number) : null;
      const station = cal && cal.station ? { x: Number(cal.station.x), y: Number(cal.station.y) } : null;
      append({ t: "cal", ts: when, cameraId: id, H, station });
      calStamp.set(id, stamp); // só marca após escrever — falha transitória tenta de novo na próxima rodada
    }
    const clean = (Array.isArray(tracks) ? tracks : []).map((t) => ({
      id: Number(t && t.id),
      bbox: Array.isArray(t && t.bbox) ? t.bbox.slice(0, 4).map(Number) : [],
    }));
    append({ t: "trk", ts: when, cameraId: id, tracks: clean });
  } catch (e) {
    fail(e);
  }
}

/**
 * Grava UM batch de leituras BLE de uma estação (chamado no ingest /api/bt/reading — SEMPRE,
 * com ou sem lat/lon). Whitelist MINIMIZADA (LGPD): só {mac, rssi} — sem `rotulo` (ver header).
 * No-op quando desabilitado. Nunca lança (fail-safe — caminho quente do ingest).
 */
function recordReadings(stationId, ts, readings) {
  if (!enabled()) return;
  try {
    rollSegmentIfNeeded();
    ensureMeta();
    const clean = (Array.isArray(readings) ? readings : []).map((r) => ({
      mac: String((r && r.mac) || ""),
      rssi: Number(r && r.rssi),
    }));
    // sourceKind: vocabulário universal de evidência (ADR-013 / evidence.ts, arquivado na tag research-fusion-arc-2026-07-12) — ver header.
    append({
      t: "ble",
      ts: Number(ts) || Date.now(),
      stationId: String(stationId || ""),
      sourceKind: "ble-rssi",
      readings: clean,
    });
  } catch (e) {
    fail(e);
  }
}

// `getActiveFile`: caminho do segmento CORRENTE (null antes da 1ª escrita — não há segmento ainda).
// Substitui o antigo export `FILE` (constante única): agora o arquivo muda a cada hora (ver
// §SEGURANÇA DO DADO no header) — não há mais "o" arquivo, só o segmento ativo no momento.
module.exports = { enabled, recordTracks, recordReadings, getActiveFile: () => activeFile, DIR };
