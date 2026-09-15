// Ociosidade do PAINEL — a decisão pura ("este painel está abandonado?"), separada da cola de
// DOM (useIdleClose.ts) porque é ela que tem consequência e portanto precisa de teste.
//
// POR QUE EXISTE: medição em produção (14/09/2026, Fly/gru) — com alguém no painel o load
// average da máquina foi a 15,63; sem ninguém, 8,04. Quase o DOBRO de carga, numa máquina de
// 4 vCPU que já roda saturada. E o painel ficou aberto 17% das horas de uma semana, com 16 Mbps
// contínuos por 11 horas seguidas num único dia — aba esquecida, não operador trabalhando.
// A plataforma dispara alerta por WhatsApp: ninguém precisa olhar imagem em regime. Vídeo é
// ferramenta de SETUP (desenhar zona, conferir enquadramento), não vigia de plantão.
//
// O CUSTO NÃO É SÓ BANDA: o vídeo do painel disputa CPU com a análise que gera o alerta. Painel
// esquecido aberto atrasa a detecção que o sistema existe para fazer.
//
// `visível` entra na conta porque a aba em segundo plano já solta o stream no <video-stream>
// (CameraTile: el.background = false) — aqui o caso novo é o OPOSTO: aba visível num segundo
// monitor o expediente inteiro, sem ninguém interagindo. Visibilidade sozinha não pega isso.

/** 5 min: longo para não cortar quem está desenhando uma zona (atividade contínua de mouse
 *  reinicia o relógio); curto para que uma tela esquecida não atravesse a madrugada. */
export const IDLE_MS = 5 * 60_000;

/**
 * O painel deve soltar o vídeo agora?
 *
 * `ultimaAtividadeMs` = instante do último gesto real do usuário (mouse/tecla/toque/scroll).
 * Aba oculta solta na hora: não há ninguém vendo, e esperar o timeout só queima recurso.
 * Relógio não-monotônico (sleep do notebook, ajuste de NTP) pode devolver um delta negativo —
 * tratamos como atividade recente, nunca como "abandonado há muito tempo": errar para o lado de
 * manter o vídeo é visível ao usuário; errar para o lado de cortar seria um corte fantasma.
 */
export function deveSoltarVideo(
  agoraMs: number,
  ultimaAtividadeMs: number,
  visivel: boolean,
  timeoutMs: number = IDLE_MS,
): boolean {
  if (!visivel) return true;
  const delta = agoraMs - ultimaAtividadeMs;
  if (!Number.isFinite(delta) || delta < 0) return false;
  return delta >= timeoutMs;
}
