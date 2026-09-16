// A DECISÃO do indicador de servidor, separada da renderização (mesma divisão de
// transport.ts/useVideoTransport.ts e idle.ts/useIdleVideo.ts). Aqui mora o que tem
// consequência: qual nível a pílula assume e quais números ela pode afirmar.
//
// A regra que este módulo existe para garantir: **nada aqui inventa normalidade**. Consulta
// falhada e motor desligado NÃO podem cair no caminho "ok" com número velho na tela; e câmera
// parada por falta de turno tem de puxar o nível para `warn`, porque economia e cegueira
// derrubam CPU exatamente igual — quem olha o cabeçalho não pode confundir as duas.

import type { AnalysisStatus } from "../../api";

/** Pool afogando: 255% ≈ 85% dos 3 workers do hub em produção. Acima disso a fila cresce e a
 *  análise atrasa, então é estado que pede ação humana — não é pico normal. */
export const CPU_AFOGANDO_PCT = 255;

export type ServidorResumo = {
  nivel: "ok" | "warn" | "down" | "unknown";
  /** CPU do pool em % (100% = um núcleo inteiro). `null` = não medido nesta janela. */
  cpu: number | null;
  /** Inferência p50 em ms — o custo de UMA análise. `null` = sem amostra na janela. */
  inferMs: number | null;
  analisando: number;
  /** Câmeras CADASTRADAS que não vigiam nada por falta de turno. 0 quando o gate está desligado. */
  paradas: number;
  /** Quando preenchido, substitui os números: é o estado que domina a leitura. */
  manchete: string | null;
};

export function servidorResumo(
  status: AnalysisStatus | null,
  erro: boolean,
): ServidorResumo | null {
  const vazio = { cpu: null, inferMs: null, analisando: 0, paradas: 0 };
  // Consulta falhou: "não sei" é vermelho, nunca silêncio nem número anterior.
  if (erro) return { ...vazio, nivel: "unknown", manchete: "servidor: sem resposta" };
  if (!status) return null; // primeira carga — não renderiza nada em vez de chutar zero
  // Motor parado domina: qualquer número de CPU ao lado disso seria distração.
  if (!status.enabled) return { ...vazio, nivel: "down", manchete: "análise DESLIGADA" };

  const cpu = status.worker?.cpuPct ?? null;
  const inferMs = status.worker?.custo?.inferMs?.p50 ?? null;
  const sg = status.shiftGate;
  // Gate desligado não tem câmera parada por turno — e o número de "analisando" passa a ser
  // quem de fato produziu inferência na janela (fps > 0), que é o que a palavra significa ali.
  const paradas = sg?.on ? sg.semTurno : 0;
  const analisando = sg?.on
    ? sg.ativas
    : Object.values(status.perCamera).filter((c) => c.fps > 0).length;

  const nivel = paradas > 0 || (cpu !== null && cpu > CPU_AFOGANDO_PCT) ? "warn" : "ok";
  return { nivel, cpu, inferMs, analisando, paradas, manchete: null };
}
