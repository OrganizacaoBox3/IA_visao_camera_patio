// ESPELHO DE FRONT de `server/camera-state.js` — o estado operacional da câmera.
// Par espelhado: mudou lá, muda aqui, no MESMO PR (mesma obrigação de bytetrack/counting).
// O back continua sendo o dono da decisão (quem notifica, quem analisa); aqui mora só o
// vocabulário que a tela precisa exibir.
//
// POR QUE QUATRO ESTADOS E NÃO UM LIGA/DESLIGA: com `enabled` booleano, a câmera que o técnico
// desparafusou para limpar a lente é indistinguível da câmera de produção que caiu — as duas
// ficam sem vídeo e as duas acordam alguém. O estado é o que separa "falhou" de "está em
// manutenção", e é ele que o gate de alarme (server/alarm/camera-gate.js) consulta.

export type CameraEstado = "producao" | "teste" | "manutencao" | "desativada";

export const CAMERA_ESTADOS: CameraEstado[] = ["producao", "teste", "manutencao", "desativada"];

export const CAMERA_ESTADO_LABEL: Record<CameraEstado, string> = {
  producao: "Produção",
  teste: "Teste",
  manutencao: "Manutenção",
  desativada: "Desativada",
};

/** A CONSEQUÊNCIA de cada estado, em uma frase. A tela mostra isto ao lado do seletor: um
 *  nome de estado sozinho ("Teste") não diz a ninguém que aquela câmera parou de notificar. */
export const CAMERA_ESTADO_NOTA: Record<CameraEstado, string> = {
  producao: "No ar e vigiando — é a única que dispara notificação.",
  teste: "Em avaliação: continua medindo e gravando histórico, mas não notifica ninguém.",
  manutencao: "Intervenção programada: mede o que conseguir e não notifica ninguém.",
  desativada: "Fora de operação: não analisa, não alarma e não conta como período sem medição.",
};

/** Tom do selo. Going-gray: produção é o NORMAL (neutro, sem cor); os demais são desvio
 *  declarado — âmbar, não vermelho, porque estado fora de produção é uma escolha do time,
 *  não uma falha do sistema. */
export const CAMERA_ESTADO_TONE: Record<CameraEstado, "neutral" | "warn"> = {
  producao: "neutral",
  teste: "warn",
  manutencao: "warn",
  desativada: "warn",
};

/** Migração do `enabled` legado, igual à do back (`estadoDe`): registro antigo em disco só tem
 *  o booleano. Fail-open para "producao" — na dúvida, a câmera está valendo. */
export function cameraEstadoDe(c: { estado?: string; enabled?: boolean } | null | undefined): CameraEstado {
  if (!c) return "producao";
  if (typeof c.estado === "string" && (CAMERA_ESTADOS as string[]).includes(c.estado))
    return c.estado as CameraEstado;
  return c.enabled === false ? "desativada" : "producao";
}

/** A câmera deveria estar vendo alguma coisa agora? (usado pelo relatório p/ o denominador
 *  de cobertura: a desativada não entra em "não medido" — não era para medir). */
export function cameraDeveriaEstarVendo(c: { estado?: string; enabled?: boolean }): boolean {
  return cameraEstadoDe(c) !== "desativada";
}
