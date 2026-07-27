// TRADUÇÃO estado-do-motor → o que isso significa para o número que o operador está lendo.
// PURA e testável fora do React (engineHealth.test.ts) — é aqui que mora o valor da feature; o
// SaudeMotorPanel só desenha o que esta função decide.
//
// O PROBLEMA QUE ISTO RESOLVE. O motor mede muita coisa (/api/analysis/status) e, até esta onda,
// NADA no front consumia. Na tela, um motor DESLIGADO, um worker morrendo em loop, o gate cegando
// a câmera e um Postgres caído se pareciam todos com "0 pessoas · tudo normal". Isso é FALSO-OK —
// a classe que a doutrina da casa põe acima de erro (CLAUDE.md §2.5/§3).
//
// AS TRÊS REGRAS QUE DECIDEM ESTE ARQUIVO:
//
// 1. TRADUZIR, NÃO DESPEJAR. Todo achado tem DUAS frases: `what` (o que está acontecendo) e
//    `soWhat` (o que isso faz com o dado dele). Número cru — fps, cpu%, p50/p95, respawns — não é
//    manchete: vive no nível de DETALHE do painel. "skipMoving1m: 41" não é informação para o
//    operador; "o gate pulou 41 de 60 rodadas com gente andando" é.
// 2. ESTADO DESCONHECIDO ≠ ESTADO BOM. Endpoint falhando devolve `level: "unknown"` e NENHUMA
//    frase de normalidade — o mesmo desenho honesto do AlarmHealthStrip (que escreve "—" em vez
//    de 0). O teste tem ASSERT NEGATIVO em cima disso: se um dia a falha voltar a renderizar
//    "Motor rodando", o gate quebra.
// 3. A JANELA É DE 60 SEGUNDOS, E O TEXTO DIZ ISSO. Os sensores `*1m` do hub são janela rolante de
//    UM MINUTO. Escrever "na última hora" seria inflar a evidência por 60× num texto que o gestor
//    lê como medição (CLAUDE.md §6, regra 9: o número que sai é o do INSTRUMENTO — declare a
//    escala dele). Todo texto daqui carimba "no último minuto".
//
// GOING-GRAY: `findings` só existe para ANORMALIDADE (+ 2 casos `info` que explicam um zero
// estrutural — câmera em modo Operador e auto-máscara). Motor saudável ⇒ lista VAZIA e uma
// manchete neutra. Verde permanente é ruído.
import type { AnalysisCamera, AnalysisStatus, ConnectedCamera } from "../../api";

export type FindingLevel = "down" | "warn" | "info";
/** "unknown" existe para nunca colapsar "não consultei" em "está bom". */
export type HealthLevel = "unknown" | "down" | "warn" | "ok";

export type Finding = {
  /** Chave ESTÁVEL (teste/aria/key do React) — o texto pode mudar, o id não. */
  id: string;
  level: FindingLevel;
  /** Rótulo da câmera quando o achado é local (já resolvido; nunca um id cru se houver nome). */
  camera?: string;
  /** O que está acontecendo. */
  what: string;
  /** O que isso significa para o DADO do operador. */
  soWhat: string;
};

export type EngineHealth = {
  level: HealthLevel;
  headline: string;
  meaning: string;
  findings: Finding[];
  /** Câmeras com inferência concluída no último minuto. */
  analyzing: number;
  /** Câmeras que o motor DEVERIA estar analisando (exclui as de modo Operador). */
  expected: number;
  /** false = a lista de câmeras da central não veio; o cruzamento "online mas invisível" não rodou. */
  crossChecked: boolean;
};

export type EngineHealthInput = {
  /** Payload do /api/analysis/status; `null` quando a consulta falhou ou ainda não voltou. */
  status: AnalysisStatus | null;
  /** Mensagem de erro da consulta (ApiError.message) — presença dela força `unknown`. */
  error: string | null;
  /** Câmeras da central (/api/cameras/connected). `null` = não sei quais deveriam existir. */
  cameras: ConnectedCamera[] | null;
};

// ── Limiares (declarados, não escondidos) ────────────────────────────────────────────────────
// O gate PULA rodadas de propósito quando a cena está parada — isso é ECONOMIA, não cegueira. Só
// vira achado o pulo COM gente NÃO estacionária em quadro (`skipMoving1m`), e mesmo assim medido
// como PROPORÇÃO das rodadas da janela: com FPS=1 (default) são ~60 rodadas/min, com foco ~360 —
// "5 pulos" significa coisas opostas nos dois casos. O piso ABSOLUTO existe para não disparar em
// janela minúscula (2 rodadas, 1 cega = 50% e não quer dizer nada).
export const GATE_BLIND_MIN = 3; // pulos cegos mínimos p/ o achado existir
export const GATE_BLIND_RATIO = 0.2; // ≥1 rodada cega em cada 5

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Total de rodadas avaliadas na janela de 60s (a soma de reasons1m é o total, por construção). */
export function roundsIn(cam: AnalysisCamera): number | null {
  if (!cam.gate || !cam.gate.reasons1m) return null;
  let total = 0;
  for (const n of Object.values(cam.gate.reasons1m)) total += n || 0;
  return total;
}

/** Ordem de leitura: o que quebra o dado primeiro; dentro do nível, ordem de descoberta. */
const LEVEL_RANK: Record<FindingLevel, number> = { down: 0, warn: 1, info: 2 };
function sortFindings(list: Finding[]): Finding[] {
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => LEVEL_RANK[a.f.level] - LEVEL_RANK[b.f.level] || a.i - b.i)
    .map((x) => x.f);
}

function unknown(detail: string): EngineHealth {
  return {
    level: "unknown",
    headline: "Não foi possível consultar a saúde do motor",
    // Sem frase de normalidade em lugar nenhum deste retorno — ver regra 2 no cabeçalho.
    meaning:
      "Estado desconhecido não é estado bom: não dá para afirmar que as contagens estão sendo " +
      "gravadas neste momento. Trate os números desta tela como NÃO CONFIRMADOS até a consulta voltar.",
    findings: [
      {
        id: "unreachable",
        level: "down",
        what: detail,
        soWhat:
          "Enquanto o hub não responder, o motor pode estar rodando normalmente OU parado — daqui não dá para distinguir.",
      },
    ],
    analyzing: 0,
    expected: 0,
    crossChecked: false,
  };
}

/**
 * Decide a saúde do motor a partir do snapshot. PURA: mesma entrada, mesma saída.
 * Nenhuma decisão aqui depende de relógio — os sensores do hub já vêm como janela de 60s.
 */
export function buildEngineHealth(input: EngineHealthInput): EngineHealth {
  const { status, error, cameras } = input;
  if (error) return unknown(error);
  if (!status) return unknown("A saúde do motor ainda não foi consultada.");

  const crossChecked = Array.isArray(cameras);
  const labelOf = (id: string) => cameras?.find((c) => c.id === id)?.label || id;

  // ── Motor DESLIGADO: nada mais importa; um único achado, sem ruído ao redor ──
  if (!status.enabled) {
    return {
      level: "down",
      headline: "Motor de análise DESLIGADO",
      meaning:
        "Nenhuma contagem de pessoas está sendo gravada agora. O histórico já gravado continua " +
        "válido; o período que inclui este momento está incompleto.",
      findings: [
        {
          id: "engine-off",
          level: "down",
          what: "O motor não está rodando no hub.",
          soWhat:
            "Enquanto durar, nenhum indicador de pessoas, ocupação ou fluxo é produzido — as câmeras " +
            "continuam mostrando vídeo, e é exatamente por isso que a tela parece normal.",
        },
      ],
      analyzing: 0,
      expected: 0,
      crossChecked,
    };
  }

  const findings: Finding[] = [];

  // ── Pool de inferência ──────────────────────────────────────────────────────
  const w = status.worker;
  let noWorker = false;
  if (w) {
    if (w.readyCount <= 0) {
      noWorker = true;
      findings.push({
        id: "no-worker",
        level: "down",
        what: "O motor está ligado, mas nenhum processo de análise está pronto.",
        soWhat:
          "Nada está sendo analisado neste instante — nenhuma contagem é gravada, ainda que o vídeo siga normal.",
      });
    } else if (w.readyCount < w.size) {
      findings.push({
        id: "worker-partial",
        level: "warn",
        what: `Só ${w.readyCount} de ${w.size} processos de análise estão prontos.`,
        soWhat:
          "O motor analisa mais devagar do que deveria: com fila, rodadas são descartadas e a contagem sai por baixo.",
      });
    }
    if (w.respawns > 0) {
      findings.push({
        id: "worker-respawn",
        level: "warn",
        what: `O processo de análise reiniciou ${w.respawns} ${plural(w.respawns, "vez", "vezes")} desde que o hub subiu.`,
        soWhat:
          "Cada reinício deixa alguns segundos sem nenhuma contagem — se o número sobe sozinho, há buracos no histórico.",
      });
    }
  }

  // ── Tamanho do modelo: rebaixar é decisão do autoscale e MUDA o que se enxerga ──
  const as = status.autoscale;
  if (as && as.tier === "n") {
    findings.push(
      as.mode === "pin"
        ? {
            id: "model-pinned-light",
            level: "info",
            what: "O modelo está fixado no mais leve (N) por configuração.",
            soWhat:
              "É uma escolha, não uma falha — mas pessoa distante (fundo de corredor, doca ao longe) é detectada com menos frequência.",
          }
        : {
            id: "model-downgraded",
            level: "warn",
            what: "O motor rebaixou o modelo para o mais leve (N) sob carga.",
            soWhat:
              "Menos alcance em pessoa distante: a contagem no fundo de corredores e docas tende a sair MENOR que a real enquanto durar.",
          },
    );
  }

  // ── Por câmera ──────────────────────────────────────────────────────────────
  const ids = Object.keys(status.perCamera);
  let analyzing = 0;
  let expected = 0;
  for (const id of ids.sort()) {
    const cam = status.perCamera[id];
    const name = labelOf(id);
    if (cam.fadiga) {
      // Zero ESTRUTURAL, não falha: modo Operador roda no navegador (ADR-009). Dizer isso evita
      // que alguém leia "0 pessoas" desta câmera como pátio vazio.
      findings.push({
        id: `cam-fadiga:${id}`,
        level: "info",
        camera: name,
        what: "Câmera em modo Operador (fadiga) — a análise dela roda no navegador, não no hub.",
        soWhat:
          "Ela não produz contagem de pessoas por desenho: o zero desta câmera não significa área vazia.",
      });
      continue;
    }
    expected += 1;
    const rounds = roundsIn(cam);
    if (cam.fps <= 0) {
      if (rounds === 0) {
        findings.push({
          id: `cam-no-frames:${id}`,
          level: "down",
          camera: name,
          what: "Nenhum frame chegou ao motor no último minuto.",
          soWhat:
            "Nada está sendo contado nesta câmera. A imagem pode continuar aparecendo na central e ainda assim o motor não recebê-la.",
        });
      } else {
        findings.push({
          id: `cam-idle:${id}`,
          level: "down",
          camera: name,
          what: "Chegaram frames, mas nenhuma análise foi concluída no último minuto.",
          soWhat:
            "A contagem desta câmera está parada — o número que você lê para ela é o último de antes disso, não o de agora.",
        });
      }
    } else {
      analyzing += 1;
    }

    // Gate cegando: o pulo COM gente andando (o resto é economia deliberada).
    const blind = cam.gate?.skipMoving1m ?? 0;
    if (rounds && blind >= GATE_BLIND_MIN && blind / rounds >= GATE_BLIND_RATIO) {
      findings.push({
        id: `cam-gate-blind:${id}`,
        level: "warn",
        camera: name,
        what: `O filtro de movimento pulou ${blind} de ${rounds} rodadas com gente andando em quadro (último minuto).`,
        soWhat: `A detecção pode estar atrasando nesta câmera: em ${pct(blind / rounds)} das rodadas houve movimento sem análise, e pessoas de passagem podem não entrar na contagem.`,
      });
    }

    // Auto-máscara SUBTRAI detecções — quem esconde, mostra que escondeu.
    const masked = cam.automasked1m ?? 0;
    if (masked > 0 && cam.autoMask?.mode === "hide") {
      findings.push({
        id: `cam-automask:${id}`,
        level: "info",
        camera: name,
        what: `A auto-máscara escondeu ${masked} ${plural(masked, "detecção", "detecções")} no último minuto.`,
        soWhat:
          "São pontos fixos que o motor aprendeu como objeto parado (não pessoa). Se houver gente parada sempre no mesmo lugar, ela pode estar sendo descontada junto.",
      });
    }
  }

  // ── Cruzamento com a central: vídeo na tela e NADA sendo contado é o falso-OK clássico ──
  // Só faz sentido com o pool vivo — sem worker, o achado global acima já explica tudo.
  if (cameras && !noWorker) {
    for (const c of cameras) {
      if (!c.online || status.perCamera[c.id]) continue;
      expected += 1;
      findings.push({
        id: `cam-unseen:${c.id}`,
        level: "down",
        camera: c.label || c.id,
        what: "A câmera aparece online na central, mas o motor não tem registro nenhum dela.",
        soWhat:
          "Nada está sendo contado nesta câmera. Se ela acabou de conectar, isto se resolve em segundos; se persistir, o motor não está recebendo a imagem.",
      });
    }
  }

  if (!ids.length && !findings.some((f) => f.level === "down")) {
    findings.push({
      id: "no-cameras",
      level: "down",
      what: "O motor está ligado, mas nenhuma câmera chegou até ele.",
      soWhat: "Nenhum indicador de pessoas está sendo produzido em lugar nenhum.",
    });
  }

  const downs = findings.filter((f) => f.level === "down").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const level: HealthLevel = downs > 0 ? "down" : warns > 0 ? "warn" : "ok";

  let headline: string;
  let meaning: string;
  if (level === "down") {
    if (noWorker) {
      headline = "Motor ligado, mas sem nenhum processo de análise pronto";
      meaning = "Nenhuma contagem está sendo gravada neste momento.";
    } else if (!ids.length) {
      headline = "Motor ligado, mas sem nenhuma câmera";
      meaning = "Nenhuma contagem está sendo gravada neste momento.";
    } else {
      headline = `${downs} de ${expected} ${plural(expected, "câmera", "câmeras")} sem análise agora`;
      meaning =
        "O que essas câmeras deveriam contar não está sendo gravado — para elas, o número desta tela não é o de agora.";
    }
  } else if (level === "warn") {
    headline = `Motor rodando com ${warns} ${plural(warns, "ressalva", "ressalvas")}`;
    meaning =
      "As contagens estão sendo gravadas, mas há algo que pode distorcer o número — veja abaixo antes de decidir.";
  } else if (expected === 0) {
    // Site 100% em modo Operador: legítimo, mas "0 de 0 câmeras sendo analisadas" é texto sem
    // sentido — e um 0 sem explicação é onde o falso-OK nasce.
    headline = "Motor rodando — nenhuma câmera é analisada pelo hub";
    meaning =
      "Todas as câmeras estão em modo Operador (a análise roda no navegador): o hub não produz " +
      "contagem de pessoas para nenhuma delas.";
  } else {
    // Going-gray: a manchete boa é NEUTRA e ESCOPADA — afirma o que foi medido, não "tudo certo".
    headline = `Motor rodando — ${analyzing} de ${expected} ${plural(expected, "câmera", "câmeras")} sendo ${plural(expected, "analisada", "analisadas")}`;
    meaning = "Nenhuma anormalidade nos sensores do motor no último minuto.";
  }

  return {
    level,
    headline,
    meaning,
    findings: sortFindings(findings),
    analyzing,
    expected,
    crossChecked,
  };
}
