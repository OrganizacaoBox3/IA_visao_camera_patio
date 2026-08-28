// ONDE O ESTADO DE RUNTIME VIVE. Ponto único de verdade.
//
// Default: o próprio diretório server/ — byte-idêntico ao deploy systemd de hoje (o release
// é copiado POR CIMA e os .json de estado ficam de fora do rsync; ver deploy-homolog.yml).
// Sem VISAO_STATE_DIR no ambiente, este módulo não muda NADA do comportamento atual.
//
// VISAO_STATE_DIR redireciona o estado quando o disco do CÓDIGO é efêmero e o estado precisa
// sobreviver ao redeploy — container/Fly, onde o rootfs da machine é descartado e o volume é
// montado em outro caminho.
//
// POR QUE UM MÓDULO, E NÃO SYMLINK NO ENTRYPOINT (a solução "óbvia", medida e descartada):
// data-hist.json (pgstore.js) e alarm-shelves.json (alarm/persist.js) gravam com tmp+rename,
// e rename(2) NÃO segue symlink — ele SUBSTITUI o link por um arquivo real. O estado desses
// dois voltaria para o disco efêmero na primeira gravação e morreria calado no deploy seguinte:
// a aplicação sobe, atende, responde "salvo", e perde o dado. Falso-OK, que é pior que erro.
// Redirecionar o DIRETÓRIO resolve os dois casos (o .tmp nasce ao lado do alvo, no volume) e
// mantém a atomicidade real, que é o motivo de existir do tmp+rename.
//
// FALHA CEDO E EM VOZ ALTA: diretório de estado inexistente ou sem permissão de escrita derruba
// o boot. Estado que não pode ser gravado NÃO pode virar "gravou" silencioso.
const fs = require("node:fs");
const path = require("node:path");

// server/ — o mesmo __dirname que cada store usava antes de existir este módulo.
const DEFAULT_STATE_DIR = __dirname;

const configured = String(process.env.VISAO_STATE_DIR || "").trim();
const stateDir = configured ? path.resolve(configured) : DEFAULT_STATE_DIR;

// Só validamos o caminho CONFIGURADO: o default é o diretório do próprio código, que existe por
// construção — checá-lo criaria um modo novo de falhar no boot de quem não pediu nada.
if (stateDir !== DEFAULT_STATE_DIR) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.accessSync(stateDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(
      `VISAO_STATE_DIR=${stateDir} não é gravável (${e.code || e.message}). ` +
        `O estado do hub (cadastro de câmeras, usuários, zonas, DVRs, sessão do WhatsApp) mora aí: ` +
        `subir sem ele é perder o dado no próximo deploy sem aviso. Verifique se o volume está montado.`,
      { cause: e },
    );
  }
}

/**
 * Caminho de um arquivo/diretório de ESTADO (nunca de código).
 * @param {...string} parts trecho(s) relativos ao diretório de estado.
 * @returns {string} caminho absoluto.
 */
function statePath(...parts) {
  return path.join(stateDir, ...parts);
}

module.exports = { statePath, stateDir, DEFAULT_STATE_DIR };
