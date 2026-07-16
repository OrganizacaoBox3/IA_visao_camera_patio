// AUTO-CADASTRO de canais de ingest RTMP. Quando um publisher (DVR/câmera) empurra vídeo para um
// canal que não existe, o go2rtc recusa e loga `stream not found: <canal>`. Este módulo observa
// essas linhas e cadastra a câmera sozinho — o yaml regenera, o canal nasce e o próximo retry do
// publisher (DVRs insistem a cada ~5 s) é aceito. Mesmo padrão da auto-descoberta de estações BLE
// do hub irmão: a plataforma se adapta ao que CHEGA, em vez de exigir que o instalador acerte o
// nome de primeira. Incidente que motivou (2026-07-16): a "dança de nomes" DVR×painel — o DVR
// publicava dydentro_cam05/07/08, depois cam01/02/live, e cada renomeação manual chegava atrasada.
//
// SEGURANÇA/LIMITES (o publish RTMP do go2rtc NÃO tem auth; a defesa de rede é o firewall da
// porta 1935 restrito por IP de origem — runbook docs/analises/rtmp-ingest/):
//  · nome validado por regex ESTRITA (nada de path/esquisitice vinda de log);
//  · dedup contra canais já cadastrados (o chamador decide como checar);
//  · throttle por canal (o retry de ~5 s do DVR não martela o store);
//  · CAP global por processo (um scanner na porta não infla o painel);
//  · knob RTMP_AUTO_ENROLL=0 desliga (default LIGADO — a 1935 já é gated por firewall).
// Responsabilidade única: parsear e decidir. Cadastrar de fato é injeção do chamador (index.js).

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Captura o nome INTEIRO até a aspa/espaço (o go2rtc loga `error="stream not found: NAME"`).
// A validação estrita fica no NAME_RE — capturar "curto demais" aqui criaria canal errado a
// partir de um path malicioso (ex.: "a/b" virando canal "a" — pego por teste).
const LINE_RE = /stream not found: ([^\s"]+)/;

/**
 * @param {object} deps
 * @param {boolean} deps.enabled  — knob (RTMP_AUTO_ENROLL !== "0" no chamador).
 * @param {(name: string) => boolean} deps.hasChannel — canal já cadastrado?
 * @param {(name: string) => void} deps.register — cadastra a câmera (efeito, injetado).
 * @param {number} [deps.max=32] — teto de auto-cadastros por processo.
 * @param {number} [deps.throttleMs=60000] — intervalo mínimo entre tentativas do MESMO canal.
 * @param {(msg: string) => void} [deps.log]
 */
function createAutoEnroll({ enabled, hasChannel, register, max = 32, throttleMs = 60_000, log = console.log }) {
  const lastTry = new Map(); // canal -> ts da última decisão (dedup do retry do publisher)
  let enrolled = 0;
  let capWarned = false;

  function onLogLine(line, now = Date.now()) {
    if (!enabled) return;
    const m = LINE_RE.exec(String(line));
    if (!m) return;
    const name = m[1];
    if (!NAME_RE.test(name)) return; // nome fora do contrato ([\w-]{1,32}) — ignora em silêncio
    const last = lastTry.get(name);
    if (last !== undefined && now - last < throttleMs) return;
    lastTry.set(name, now);
    if (hasChannel(name)) return; // já cadastrado — o "not found" era corrida de regeneração
    if (enrolled >= max) {
      if (!capWarned) {
        capWarned = true;
        log(`[rtmp-auto] CAP de ${max} auto-cadastros atingido — canais novos passam a ser ignorados (reinicie o hub ou suba o cap se for legítimo)`);
      }
      return;
    }
    enrolled++;
    log(`[rtmp-auto] publisher bateu no canal desconhecido "${name}" — auto-cadastrando (${enrolled}/${max})`);
    register(name);
  }

  return { onLogLine };
}

module.exports = { createAutoEnroll };
