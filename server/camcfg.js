// Configuração COMPARTILHADA das câmeras entre operadores/turnos:
//  • TRIPWIRES — linhas de contagem POR CÂMERA: { id, a:{x,y}, b:{x,y} } (coords normalizadas 0..1).
//  • ZONES — zonas (ROIs + modo/config) POR CÂMERA: array de Zone (formato de src/zones.ts).
//  • CAMCONFIG — config de câmera POR CÂMERA: objeto CameraCfg (formato de src/cameraConfig.ts).
// Centralizadas no hub para serem partilhadas entre operadores/turnos (não no localStorage).
// Espelha o padrão de recipients.js/settings.js: cache em memória + Postgres (se configurado) ou
// camcfg.json (fallback). LGPD: SÓ geometria/ids/config — nunca imagem, frame ou PII.
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
// Validação de zona POLIGONAL (spec zonas-poligonais): espelho JS de src/zones.ts vive em
// analysis/zones.js (mesmo lugar do pointInPolygon que a consome) — fonte única no hub.
const { sanitizeZonePoints, polygonBBox } = require("./analysis/zones");
// TURNOS (spec-turnos-por-zona F2): a atribuição zona→turnos viaja NESTE store (campo shiftIds),
// e a regra "a grade de uma zona não pode ter overlap" (D4/CA-4) é validada no SAVE — servidor,
// não UI. Só leitura do cadastro (shifts.all()) + o parser puro do relógio.
const shiftsStore = require("./shifts");
const { parseHM, durationMin } = require("./shift-clock");

const FILE = path.join(__dirname, "camcfg.json");
let tripwires = new Map(); // cameraId -> Tripwire[]
let zones = new Map(); // cameraId -> Zone[]
let camConfigs = new Map(); // cameraId -> CameraCfg
let calibrations = new Map(); // cameraId -> Calibration (homografia px↔metros; ver cleanCalibration)
let usingPg = false;

// ── Validação defensiva (só persistimos geometria/ids/nomes/config) ──────────
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isCoord = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
// Enums espelhados de src/zones.ts (ZoneMode) e src/cameraConfig.ts (CapturePreset).
// "exclusao": zona que SUPRIME detecções de pessoa (máscara p/ FP de objeto fixo) — sem o
// modo aqui, cleanZone rebaixaria a zona de exclusão p/ "atividade" ao persistir (calibração).
// "proibida": área que deve ficar VAZIA (spec alerta-por-atividade E1) — o motor do hub produz
// o alarme tipo "presenca" a partir DESTA config (dwell em presencaAlertMs).
const ZONE_MODES = new Set(["atividade", "leitura", "objetos", "fadiga", "exclusao", "proibida"]);
// Modos em que o RÓTULO é a identidade que chega ao operador — e por isso tem de ser ÚNICO por
// câmera (ver validateZoneLabels). "atividade": o label vira a coluna `area` do ativ_buckets (o
// relatório); "proibida": o label vira o campo `zona` do alarme de presença. Nos demais modos
// (leitura/objetos/fadiga/exclusao) NENHUM consumidor lê o rótulo — ele é decoração de UI, e
// exigir unicidade lá só bloquearia saves legítimos sem comprar nada.
const LABEL_UNIQUE_MODES = new Map([
  ["atividade", "atividade"],
  ["proibida", "área proibida"],
]);
// Janela de armamento da zona proibida (E4 / turnos F2): "sempre" (24/7, default seguro) ou
// relativa aos turnos ATRIBUÍDOS à zona (shiftIds). Quem decide é alarm/shift.js (a política);
// aqui só se PERSISTE o enum — espelho de ZONE_ARMINGS em src/zones.ts.
const ARMING_MODES = new Set(["sempre", "dentro-turnos", "fora-turnos"]);
const CAPTURE_PRESETS = new Set(["media", "alta", "maxima"]);
// Transporte de vídeo do tile: "mjpeg" (relé socket.io, default/rollback) ou "webrtc"
// (tile <video-stream> servido pelo go2rtc). Aditivo — câmera sem o campo segue MJPEG.
const TRANSPORTS = new Set(["auto", "mjpeg", "webrtc"]);
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
// Número finito qualquer (metros do mundo / entradas de H podem ser negativos ou grandes).
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v, d) => {
  const n = num(v, d);
  return n < 0 ? 0 : n > 1 ? 1 : n;
};
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function cleanTripwire(w) {
  if (!w || typeof w !== "object" || !w.a || !w.b) return null;
  const id = str(w.id);
  if (!id) return null;
  if (!isCoord(w.a.x) || !isCoord(w.a.y) || !isCoord(w.b.x) || !isCoord(w.b.y)) return null;
  return { id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } };
}
function cleanTripwires(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const w of arr) {
    const c = cleanTripwire(w);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
// ── MIGRAÇÃO rect → POLÍGONO (spec-zona-unificada §7) ────────────────────────────────────────
// A zona É um polígono; o RETÂNGULO é o PRESET de 4 vértices (a leitura de ONVIF/Axis/Frigate —
// nenhum deles tem "tipo retângulo"). Semeia os cantos da bbox JÁ SANEADA na ordem consistente
// TL → TR → BR → BL (horária, y crescendo p/ baixo): ordem consistente ⇒ NUNCA auto-intersecta.
// Roda dentro do cleanZone ⇒ no LOAD **e** no SAVE, e é IDEMPOTENTE (a 2ª passada entra pelo ramo
// de `points`, que devolve os mesmos vértices) — por isso NÃO há script de migração nem downtime.
// Os vértices saem CLAMPADOS 0..1 por sanitizeZonePoints (fonte ÚNICA da validação — não
// duplicamos a regra aqui): retângulo que estourava o frame passa a valer o que já valia na
// prática, a parte DENTRO do frame.
//
// DUAS zonas NÃO são semeadas — e as duas seguem valendo EXATAMENTE como hoje (retângulo/máscara):
//  • com MÁSCARA PINTADA: o retângulo dela é a ENVOLVENTE da área pintada, não a área. A única em
//    produção (cam-50fa5758e7 "Área 1") é uma faixa DIAGONAL serrilhada em 5 pedaços — semear os 4
//    cantos AUMENTARIA a área EM SILÊNCIO. Preserva a mask; quem a redesenha é o operador (o
//    polígono que ela sempre quis ser). É a única migração manual da onda.
//  • DEGENERADA (w ou h = 0, ou colapsada pelo clamp): área zero não é polígono SIMPLES —
//    sanitizeZonePoints a rejeita (undefined) e a zona segue retângulo, como já era.
// Recebe a zona JÁ SANEADA (o `out` do cleanZone), não o input bruto: x/y/w/h já passaram pelo
// clamp01 e `mask` já é string-não-vazia-ou-ausente. Depender do bruto aqui seria uma armadilha
// (um `mask` truthy porém não-string bloquearia o preset SEM a zona ter máscara de verdade).
function rectPreset(saneada) {
  if (saneada.mask) return undefined;
  const { x, y, w, h } = saneada;
  const x1 = x + w;
  const y1 = y + h;
  return sanitizeZonePoints([
    { x, y }, // TL
    { x: x1, y }, // TR
    { x: x1, y: y1 }, // BR
    { x, y: y1 }, // BL
  ]);
}

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });

// ── MODO DA ZONA: LEITURA e ESCRITA são DELIBERADAMENTE diferentes ───────────────────────────
// ESCRITA (strict, saveZones ⇒ PUT): modo fora do enum é ERRO DO CLIENTE → 400 com mensagem.
//   O rebaixamento silencioso p/ "atividade" que existia aqui transformava uma zona PROIBIDA
//   corrompida numa zona de CONTAGEM sem erro, sem log e sem 400 — vigilância sumindo em
//   silêncio, que é a pior falha possível num sistema de alarme (falso-OK).
// LEITURA (lenient, init/boot): NUNCA derruba o hub e NUNCA reinterpreta. O modo desconhecido é
//   preservado VERBATIM + WARN alto. Consequência (a intencional): a zona fica INERTE — os
//   filtros do engine são igualdade exata (`z.modo === "atividade" | "exclusao" | "proibida"`,
//   engine.js:147/154/161), então uma zona de modo que este hub não conhece não conta, não
//   alarma e não exclui. É o comportamento HONESTO: não sabemos o que ela é, então não fingimos.
//   Preservar (em vez de dropar) protege o rollback: um hub antigo lendo config de um hub novo
//   ignora a zona futura sem DESTRUIR o desenho do operador ao regravar o arquivo.
// RESIDUAL DECLARADO: com uma zona assim na config, todo PUT daquela câmera passa a dar 400
//   até que ela seja corrigida/removida (o front faz GET → PUT da lista inteira). É o preço de
//   falhar alto, e a mensagem diz exatamente qual zona e qual modo.
function zoneMode(z, strict) {
  const raw = z.modo;
  if (raw == null || raw === "") return "atividade"; // ausente = default de sempre (retrocompat)
  if (ZONE_MODES.has(raw)) return raw;
  const nome = str(z.label) || str(z.id) || "(sem rótulo)";
  if (strict)
    throw badRequest(
      `zona "${nome}": modo ${JSON.stringify(raw)} é desconhecido — modos válidos: ${[...ZONE_MODES].join(", ")}`,
    );
  console.warn(
    `[camcfg] zona "${nome}" tem modo desconhecido ${JSON.stringify(raw)} — preservado como está; a zona fica INERTE (não conta, não alarma, não exclui) neste hub`,
  );
  return raw;
}

// Zona (src/zones.ts Zone): geometria normalizada + modo + config plana por modo.
// `mask` é opcional (string codificada); só é incluída quando presente (retrocompat).
// `strict` = caminho de ESCRITA (ver zoneMode): LANÇA badRequest em vez de normalizar em silêncio.
function cleanZone(z, strict) {
  if (!z || typeof z !== "object") return null;
  const id = str(z.id);
  if (!id) return null;
  const out = {
    id,
    label: str(z.label) || "Área",
    x: clamp01(z.x, 0),
    y: clamp01(z.y, 0),
    w: clamp01(z.w, 1),
    h: clamp01(z.h, 1),
    modo: zoneMode(z, strict),
    idleAlertMs: Math.max(0, num(z.idleAlertMs, 0)),
    sensitivity: num(z.sensitivity, 5),
    atividade: str(z.atividade),
    ponto: str(z.ponto),
    selectedClasses: strList(z.selectedClasses),
    // proibida (spec alerta-por-atividade E2/E4). INVARIANTE desta allowlist (armadilha A5):
    // campo NOVO de zona TEM que ser adicionado aqui, senão o save o descarta MUDO e o motor
    // do hub nunca vê o dwell configurado. Clamp são: 0..24h; inválido → default 10s.
    presencaAlertMs: Math.min(86_400_000, Math.max(0, num(z.presencaAlertMs, 10_000))),
    arming: ARMING_MODES.has(z.arming) ? z.arming : "sempre",
    // shiftIds (spec-turnos-por-zona F2): turnos atribuídos à zona. MESMA armadilha A5 — sem o
    // campo AQUI o save o descartaria MUDO e o gate de turno (alarm/shift.js) nunca veria a
    // atribuição. Ausente/malformado → [] = zona 24/7 (comportamento atual, CA-5). Ids DANGLING
    // (turno excluído do cadastro) NÃO são podados aqui: camcfg.init() pode rodar antes de
    // shifts.init() — o gate resolve isso em runtime (fail-open).
    shiftIds: [...new Set(strList(z.shiftIds))],
  };
  if (typeof z.mask === "string" && z.mask) out.mask = z.mask;
  // points (zona POLIGONAL, spec zonas-poligonais P2/P4 — armadilha 1: campo NOVO tem que estar
  // NESTA allowlist, senão o save o descarta MUDO): ≥3 e ≤20 vértices {x,y} clampados 0..1,
  // polígono SIMPLES. Malformado → campo OMITIDO (a zona segue valendo como retângulo/máscara),
  // NUNCA []. Com points válidos, a bbox x,y,w,h é RE-DERIVADA deles no save (padrão
  // maskBBoxNorm): o pré-filtro retangular dos call-sites nunca fica velho (armadilha 3).
  // NÃO confundir com calibration.points (homografia) — objetos distintos (armadilha 10).
  //
  // A REGRA (spec-zona-unificada §3): **`points` é a FONTE DA VERDADE; x/y/w/h é CACHE da
  // envolvente — DERIVADO, nunca autorado.** Sem points válidos, o rectPreset semeia os 4 cantos
  // do retângulo (migração) — logo, toda zona SEM MÁSCARA sai daqui COM polígono. Malformado não
  // vira [] nem some: cai no preset, que é o que a zona já era na prática (retângulo).
  const pts = sanitizeZonePoints(z.points) || rectPreset(out);
  if (pts) {
    out.points = pts;
    const bb = polygonBBox(pts);
    out.x = bb.x;
    out.y = bb.y;
    out.w = bb.w;
    out.h = bb.h;
  }
  return out;
}
// `strict` só é passado pelo caminho de ESCRITA (saveZones). O de LEITURA (init) chama sem ele —
// config já persistida com modo desconhecido NÃO pode derrubar o boot (ver zoneMode).
function cleanZones(arr, strict) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const z of arr) {
    const c = cleanZone(z, strict);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
// ── RÓTULO ÚNICO por câmera nos modos que chegam ao operador (bug medido 2026-07-26) ──────────
// Duas zonas homônimas somavam a contagem uma da outra no motor. A causa PRIMÁRIA (agregação por
// label) foi corrigida em analysis/pipeline.js — a contagem é por zone.id. Esta regra é a
// segunda camada, e é sobre AMBIGUIDADE, não sobre aritmética: duas "Doca" na mesma câmera
// produzem duas linhas `area="Doca"` no relatório e dois alarmes `zona="Doca"` indistinguíveis —
// o operador não tem como saber QUAL área agir. E não é canto raro: cleanZone rotula toda zona
// sem nome como "Área", então criar duas zonas e não nomear é o caminho PADRÃO.
// ESCOPO (justificado em LABEL_UNIQUE_MODES): só atividade e proibida, e a unicidade é POR MODO —
// uma zona de atividade "Doca" e uma proibida "Doca" caem em sinks diferentes (ativ_buckets ×
// alarme) e não se confundem entre si. Comparação EXATA sobre o label já trimado pelo cleanZone:
// "doca" e "Doca" são visualmente distintos no relatório; dobrar isso em case-folding seria
// inventar política que ninguém pediu.
// SÓ NA ESCRITA (mesma assimetria do modo): config LEGADA com duplicata continua carregando —
// depois da correção do pipeline ela é ambígua, não errada, e barrar no boot só apagaria zonas.
// ⚠ PENDÊNCIA CROSS-FRENTE (não é deste arquivo): o front batiza zona nova de
// `Área ${lista.length + 1}` (CameraWorkspace.tsx:413) — depois de APAGAR uma zona, o contador
// volta e o nome COLIDE com um existente ⇒ 400 legítimo em cima de um nome que o operador não
// escolheu. O conserto é gerar o PRÓXIMO nome LIVRE lá; aqui a regra fica, e a mensagem diz
// exatamente o que renomear (auto-renomear no save seria mutar em silêncio o nome do operador).
// PURA (recebe a lista já saneada) — devolve a mensagem do 400 ou null.
function validateZoneLabels(list) {
  const seen = new Set();
  for (const z of list) {
    const nomeModo = LABEL_UNIQUE_MODES.get(z.modo);
    if (!nomeModo) continue;
    const key = `${z.modo} ${z.label}`;
    if (seen.has(key))
      return `duas zonas de ${nomeModo} desta câmera se chamam "${z.label}" — o rótulo é como o operador identifica a área no painel, no relatório e no alarme; dê nomes distintos`;
    seen.add(key);
  }
  return null;
}
// ── OVERLAP dos turnos de UMA zona (D4 / CA-4) — a REGRA vive no servidor ────────────────────
// A grade atribuída a uma zona é uma PARTIÇÃO do tempo: dois turnos da MESMA zona não podem se
// sobrepor (senão "dentro do turno" vira ambíguo e o gate de ociosidade perde o denominador).
// Modelo: cada turno vira intervalos em MINUTOS DA SEMANA [início, início+duração) — um por dia
// em que INICIA (D1); o overnight que passa do domingo 24h volta ao começo da semana (a semana é
// circular). Duração ∈ (0, 24h) por construção (shifts.validateShift rejeita 0) ⇒ um turno nunca
// se sobrepõe a si mesmo em dias distintos. Intervalo MEIO-ABERTO: 06–14 e 14–22 na mesma zona
// são LEGAIS (a borda pertence ao turno que INICIA — D4).
const WEEK_MIN = 7 * 24 * 60;
function weekIntervals(s) {
  const ini = parseHM(s && s.inicio);
  const fim = parseHM(s && s.fim);
  if (ini == null || fim == null) return [];
  const dur = durationMin(ini, fim);
  if (!(dur > 0)) return [];
  const out = [];
  for (const d of Array.isArray(s.dias) ? s.dias : []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) continue;
    const start = (d * 24 * 60 + ini) % WEEK_MIN;
    const end = start + dur;
    if (end <= WEEK_MIN) out.push([start, end]);
    else out.push([start, WEEK_MIN], [0, end - WEEK_MIN]); // vira a semana
  }
  return out;
}
const intervalsOverlap = (a, b) => a[0] < b[1] && b[0] < a[1];

// Valida a atribuição zona→turnos de uma LISTA de zonas (já saneada por cleanZones) contra o
// cadastro de turnos. Devolve mensagem de erro (string, p/ o 400) ou null quando está tudo certo.
// Turno DANGLING (id de turno excluído) é IGNORADO aqui — o gate trata em runtime (fail-open);
// turno INATIVO conta para o overlap (reativá-lo não pode criar uma grade ambígua pelas costas).
// PURA (recebe o cadastro por parâmetro) — é o que o teste do CA-4 exercita.
function validateZoneShifts(list, shifts) {
  const byId = new Map((Array.isArray(shifts) ? shifts : []).map((s) => [s.id, s]));
  for (const z of list) {
    const assigned = (z.shiftIds || []).map((id) => byId.get(id)).filter(Boolean);
    for (let i = 0; i < assigned.length; i++) {
      const A = weekIntervals(assigned[i]);
      for (let j = i + 1; j < assigned.length; j++) {
        const B = weekIntervals(assigned[j]);
        for (const a of A)
          for (const b of B)
            if (intervalsOverlap(a, b))
              return `zona "${z.label}": os turnos "${assigned[i].nome}" e "${assigned[j].nome}" se sobrepõem — os turnos de uma mesma zona não podem se sobrepor`;
      }
    }
  }
  return null;
}

// ── MODO DA CÂMERA: a MESMA assimetria do modo de ZONA (zoneMode) ────────────────────────────
// Mesma política porque é o mesmo defeito: rebaixar p/ "atividade" em silêncio apagava
// configuração SEM erro, SEM log e SEM 400. E aqui não é só cosmético — o hub LÊ este campo:
// engine.isFadiga/index.js decidem por `modo === "fadiga"` que a câmera roda no cliente e que o
// hub NÃO detecta pessoa nela. Um modo corrompido virava "atividade" calado e a câmera de fadiga
// passava a ser analisada (e contada no relatório) como pátio — o operador vendo número onde
// não deveria haver nenhum. Falso-OK é pior que erro.
// ESCRITA (strict, saveCamConfig ⇒ PUT): modo fora do enum é ERRO DO CLIENTE → badRequest.
// LEITURA (lenient, init/boot): preserva VERBATIM + WARN alto — nunca derruba o boot, nunca
//   reinterpreta. Consequência (intencional, idêntica à da zona): a câmera fica INERTE nos ramos
//   que comparam por igualdade exata (isFadiga = false) e o front cai no seu próprio default.
//   Preservar (em vez de rebaixar) é o que protege o rollback: hub antigo lendo config de hub
//   novo ignora o modo futuro sem DESTRUIR a escolha do operador ao regravar o arquivo.
// ESCOPO deliberado (só o modo): `capture`/`transport` seguem normalizando em silêncio de
//   propósito — são preferência de apresentação (qualidade do preset, transporte do tile), a
//   degradação é VISÍVEL na hora e não apaga vigilância nenhuma. Endurecê-los seria inventar
//   política que ninguém pediu e transformar payload legado em 400.
// ⚠ PENDÊNCIA CROSS-FRENTE (não é deste arquivo): a rota do camconfig
//   (server/routes/config-routes.js, PUT /api/camconfig/:id) ainda NÃO tem o try/catch que a de
//   zonas tem, então este badRequest sai como 500 "erro interno" em vez de 400 com a mensagem.
//   O PUT já é REJEITADO e NADA é persistido — que é o ponto — só o status/texto ficam devendo;
//   o conserto é as mesmas 6 linhas do bloco de zonas (config-routes.js:47-55) na rota do
//   camconfig. Residual DECLARADO, não descoberto depois.
function camMode(c, strict) {
  const raw = c.modo;
  if (raw == null || raw === "") return "atividade"; // ausente = default de sempre (retrocompat)
  if (ZONE_MODES.has(raw)) return raw;
  if (strict)
    throw badRequest(
      `config da câmera: modo ${JSON.stringify(raw)} é desconhecido — modos válidos: ${[...ZONE_MODES].join(", ")}`,
    );
  console.warn(
    `[camcfg] câmera com modo desconhecido ${JSON.stringify(raw)} — preservado como está; a câmera fica INERTE nos ramos por modo (não roda fadiga) neste hub`,
  );
  return raw;
}

// Config de câmera (src/cameraConfig.ts CameraCfg): modo + ponto de leitura + preset + classes.
// `strict` = caminho de ESCRITA (ver camMode): LANÇA badRequest em vez de normalizar em silêncio.
function cleanCamConfig(c, strict) {
  if (!c || typeof c !== "object") return null;
  return {
    modo: camMode(c, strict),
    pontoLeitura: str(c.pontoLeitura),
    capture: CAPTURE_PRESETS.has(c.capture) ? c.capture : "maxima",
    transport: TRANSPORTS.has(c.transport) ? c.transport : "auto",
    selectedClasses: strList(c.selectedClasses),
    // longRange liga o tiling 2×2 no motor de análise (ADR-009). INVARIANTE desta allowlist:
    // campo NOVO de config TEM que ser adicionado aqui, senão é descartado MUDO no save.
    longRange: c.longRange === true,
  };
}

// Calibração de HOMOGRAFIA por câmera (medir distância no chão em metros; ADR tags-bluetooth §3).
// `points` = correspondências px(imagem, normalizado 0..1) ↔ world(metros); `H` = matriz 3×3
// ROW-MAJOR (9 números) computada no cliente por src/vision/homography.ts. SÓ geometria/números —
// nunca imagem/frame (LGPD). Validação defensiva: ≥4 pontos, px em 0..1, world/H finitos.
function cleanCalibration(c) {
  if (!c || typeof c !== "object") return null;
  if (!Array.isArray(c.points) || c.points.length < 4) return null;
  const points = [];
  for (const p of c.points) {
    if (!p || !p.px || !p.world) return null;
    if (!isCoord(p.px.x) || !isCoord(p.px.y)) return null; // px normalizado 0..1
    if (!fin(p.world.x) || !fin(p.world.y)) return null; // metros (finitos, sinal livre)
    points.push({
      px: { x: p.px.x, y: p.px.y },
      world: { x: p.world.x, y: p.world.y },
    });
  }
  if (!Array.isArray(c.H) || c.H.length !== 9 || !c.H.every(fin)) return null;
  // (Os campos BLE — mac por vértice, station/stations, refTag — migraram com a fusão para o
  //  repo mvp_trilateracao_BLE; ADR-018. A allowlist é aditiva: payload antigo com esses campos
  //  continua válido — eles simplesmente deixam de ser persistidos aqui.)
  return { points, H: c.H.slice(), updatedAt: fin(c.updatedAt) ? c.updatedAt : Date.now() };
}

// ── Persistência ─────────────────────────────────────────────────────────────
function saveFile() {
  try {
    fs.writeFileSync(
      FILE,
      JSON.stringify(
        {
          tripwires: Object.fromEntries(tripwires),
          zones: Object.fromEntries(zones),
          camConfigs: Object.fromEntries(camConfigs),
          calibrations: Object.fromEntries(calibrations),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error("[camcfg] falha ao salvar:", e.message);
  }
}
// Tripwires: substitui as linhas de UMA câmera (upsert; remove a linha se ficou vazia).
async function persistTripwires(cameraId) {
  if (!usingPg) return saveFile();
  const list = tripwires.get(cameraId) || [];
  if (list.length === 0) {
    await db.query("delete from cam_tripwires where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_tripwires (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(list)],
  );
}
// Zonas: substitui as zonas de UMA câmera (upsert; remove a linha se ficou vazia).
async function persistZones(cameraId) {
  if (!usingPg) return saveFile();
  const list = zones.get(cameraId) || [];
  if (list.length === 0) {
    await db.query("delete from cam_zones where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_zones (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(list)],
  );
}
// Config de câmera: upsert do objeto de UMA câmera (remove a linha se ficou nula).
async function persistCamConfig(cameraId) {
  if (!usingPg) return saveFile();
  const cfg = camConfigs.get(cameraId);
  if (!cfg) {
    await db.query("delete from cam_config where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_config (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(cfg)],
  );
}
// Calibração: upsert do objeto de UMA câmera (remove a linha se ficou nula).
async function persistCalibration(cameraId) {
  if (!usingPg) return saveFile();
  const cal = calibrations.get(cameraId);
  if (!cal) {
    await db.query("delete from cam_calibration where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_calibration (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(cal)],
  );
}

async function init() {
  if (db.configured()) {
    try {
      const rt = await db.query("select camera_id, data from cam_tripwires");
      tripwires = new Map();
      for (const row of rt.rows) {
        const list = cleanTripwires(row.data);
        if (list.length) tripwires.set(String(row.camera_id), list);
      }
      const rz = await db.query("select camera_id, data from cam_zones");
      zones = new Map();
      for (const row of rz.rows) {
        const list = cleanZones(row.data);
        if (list.length) zones.set(String(row.camera_id), list);
      }
      const rc = await db.query("select camera_id, data from cam_config");
      camConfigs = new Map();
      for (const row of rc.rows) {
        const cfg = cleanCamConfig(row.data);
        if (cfg) camConfigs.set(String(row.camera_id), cfg);
      }
      const rk = await db.query("select camera_id, data from cam_calibration");
      calibrations = new Map();
      for (const row of rk.rows) {
        const cal = cleanCalibration(row.data);
        if (cal) calibrations.set(String(row.camera_id), cal);
      }
      usingPg = true;
      console.log(
        `[camcfg] tripwires de ${tripwires.size}, zonas de ${zones.size}, config de ${camConfigs.size} e calibração de ${calibrations.size} câmera(s) do Postgres`,
      );
      return;
    } catch (e) {
      console.error("[camcfg] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    tripwires = new Map();
    for (const [cam, arr] of Object.entries((data && data.tripwires) || {})) {
      const list = cleanTripwires(arr);
      if (list.length) tripwires.set(String(cam), list);
    }
    zones = new Map();
    for (const [cam, arr] of Object.entries((data && data.zones) || {})) {
      const list = cleanZones(arr);
      if (list.length) zones.set(String(cam), list);
    }
    camConfigs = new Map();
    for (const [cam, obj] of Object.entries((data && data.camConfigs) || {})) {
      const cfg = cleanCamConfig(obj);
      if (cfg) camConfigs.set(String(cam), cfg);
    }
    calibrations = new Map();
    for (const [cam, obj] of Object.entries((data && data.calibrations) || {})) {
      const cal = cleanCalibration(obj);
      if (cal) calibrations.set(String(cam), cal);
    }
  } catch {
    tripwires = new Map();
    zones = new Map();
    camConfigs = new Map();
    calibrations = new Map();
  }
}

// ── API ──────────────────────────────────────────────────────────────────────
function getTripwires(cameraId) {
  return tripwires.get(str(cameraId)) || [];
}
// Substitui as linhas de uma câmera e persiste; devolve a lista salva.
async function saveTripwires(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanTripwires(input);
  if (list.length === 0) tripwires.delete(id);
  else tripwires.set(id, list);
  await persistTripwires(id);
  return list;
}
function getZones(cameraId) {
  return zones.get(str(cameraId)) || [];
}
// Substitui as zonas de uma câmera e persiste; devolve a lista salva.
// REJEITA (throw com badRequest → 400 na rota) três coisas, nesta ordem: modo FORA do enum
// (cleanZones strict — falhar alto em vez de rebaixar em silêncio), RÓTULO repetido nos modos
// que chegam ao operador (validateZoneLabels) e grade com turnos sobrepostos na mesma zona
// (validateZoneShifts, CA-4). A validação de NEGÓCIO é do servidor; a UI só exibe a mensagem.
// NADA é mutado nem persistido antes de validar — save inválido deixa o estado anterior intacto
// (o teste unitário depende disso: é a única chamada de saveZones que pode rodar sem tocar disco).
async function saveZones(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanZones(input, true);
  const err = validateZoneLabels(list) || validateZoneShifts(list, shiftsStore.all());
  if (err) throw badRequest(err);
  if (list.length === 0) zones.delete(id);
  else zones.set(id, list);
  await persistZones(id);
  return list;
}
// Config de câmera; null quando a câmera nunca teve config salva (o front aplica os defaults).
function getCamConfig(cameraId) {
  return camConfigs.get(str(cameraId)) || null;
}
// Substitui a config de uma câmera e persiste; devolve a config salva (ou null se inválida).
// REJEITA (throw com badRequest) modo FORA do enum — falhar alto em vez de rebaixar em silêncio
// (mesma política do saveZones; ver camMode). NADA é mutado nem persistido antes de validar:
// save inválido deixa o estado anterior intacto (e o teste roda sem tocar disco).
async function saveCamConfig(cameraId, input) {
  const id = str(cameraId);
  if (!id) return null;
  const cfg = cleanCamConfig(input, true);
  if (!cfg) return null;
  camConfigs.set(id, cfg);
  await persistCamConfig(id);
  return cfg;
}
// Calibração de homografia; null quando a câmera nunca foi calibrada (o front trata como ausente).
function getCalibration(cameraId) {
  return calibrations.get(str(cameraId)) || null;
}
// Substitui a calibração de uma câmera e persiste; devolve a calibração salva (ou null se inválida).
async function saveCalibration(cameraId, input) {
  const id = str(cameraId);
  if (!id) return null;
  const cal = cleanCalibration(input);
  if (!cal) return null;
  calibrations.set(id, cal);
  await persistCalibration(id);
  return cal;
}

module.exports = {
  init,
  getTripwires,
  saveTripwires,
  getZones,
  saveZones,
  getCamConfig,
  saveCamConfig,
  getCalibration,
  saveCalibration,
  // Exportado SÓ p/ teste (puro, sem I/O): o round-trip da allowlist (CA-7) valida que salvar
  // e reler uma zona preserva os campos — sem tocar no camcfg.json/Postgres reais.
  cleanZones,
  // Idem, para a calibração. Sem este round-trip, a allowlist descarta campo novo em SILÊNCIO —
  // foi como `stations` (multi-antena) passou meses sendo salvo pela UI e jogado fora pelo hub.
  cleanCalibration,
  // Idem, para a config de câmera: a assimetria leitura/escrita do MODO (camMode) só é
  // verificável chamando a função pura nos dois caminhos — sem disco, sem Postgres.
  cleanCamConfig,
  // Puro (cadastro de turnos por parâmetro): a regra de overlap da grade da zona (CA-4).
  validateZoneShifts,
  // Puro (lista já saneada): a regra de RÓTULO ÚNICO por câmera nos modos atividade/proibida.
  validateZoneLabels,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
