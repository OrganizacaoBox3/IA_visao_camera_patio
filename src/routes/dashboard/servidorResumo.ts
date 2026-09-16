// A DECISÃO do indicador de servidor, separada da renderização (mesma divisão de
// transport.ts/useVideoTransport.ts e idle.ts/useIdleVideo.ts). Aqui mora o que tem
// consequência: qual nível a pílula assume e quais números ela pode afirmar.
//
// A regra que este módulo existe para garantir: **nada aqui inventa normalidade**. Consulta
// falhada e motor desligado NÃO podem cair no caminho "ok" com número velho na tela; e câmera
// parada por falta de turno tem de puxar o nível para `warn`, porque economia e cegueira
// derrubam CPU exatamente igual — quem olha o cabeçalho não pode confundir as duas.

import type { AnalysisStatus } from "../../api";

/**
 * Limiar de "afogando", aplicado à SOMA hub + pool (100% = um núcleo).
 * 255% ≈ 64% da máquina de produção (4 vCPU = 400%). Escolhido abaixo da saturação medida —
 * a máquina começou a formar fila de CPU por volta de 340% — para o aviso chegar ANTES de a
 * análise atrasar, não junto com o atraso.
 */
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

  // CPU = HUB + POOL, e a soma não é capricho:
  //   · o `worker.cpuPct` só é recalculado QUANDO UM WORKER RESPONDE (worker-host:sampleCpu).
  //     Com o gate de turno ligado e 4 câmeras a 0,2 fps, as respostas ficam raras e o número
  //     CONGELA — foi assim que o indicador exibiu "0% cpu" num servidor que estava trabalhando.
  //   · e o pool cobre só a inferência. Medido em produção: 2,5 vCPU com 4 câmeras analisando,
  //     porque receber e manter 15 streams custa independente de análise. O hub é essa parte.
  // `hub.cpuPct` vem do process.cpuUsage() em janela própria de 5s, então atualiza mesmo com o
  // motor ocioso — é o que impede o congelamento.
  // RESSALVA que o tooltip declara: o go2rtc roda em processo SEPARADO e não entra nesta soma.
  const cpuHub = status.hub?.cpuPct ?? null;
  const cpuPool = status.worker?.cpuPct ?? null;
  // Só é `null` quando NENHUM dos dois foi medido; um lado ausente não zera o outro.
  const cpu =
    cpuHub === null && cpuPool === null
      ? null
      : Math.round(((cpuHub ?? 0) + (cpuPool ?? 0)) * 10) / 10;
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
