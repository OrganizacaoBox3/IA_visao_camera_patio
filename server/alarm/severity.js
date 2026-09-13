// ─────────────────────────────────────────────────────────────────────────────
// severity.js — QUEM DECIDE O QUE É CRÍTICO.
//
// O PROBLEMA MEDIDO (2026-09-13). A criticidade era decidida por um CARACTERE no texto: o
// `classify()` marca `critico` na presença de "⚠", e TODO emissor do front prefixa suas
// mensagens com "⚠" (`⚠ ${label}: ${msg}` em CameraWorkspace/useTripwires), assim como os
// emissores do hub (presence-alert, occupancy-alert, engine/health, flood). Resultado medido
// sobre os 12 textos REAIS dos emissores:
//
//     critical  10/12 = 83%      ← meta declarada pelo próprio sistema: ≤ 5% (EEMUA 191)
//     high       0/12
//     advisory   2/12            ← e eram "renotificar" e "normalizada", os MENOS importantes
//
// Isto é a definição de sistema de alarme quebrado pela ISA-18.2: quando tudo é crítico, nada
// é — o operador aprende a ignorar o vermelho, e o alarme que importava chega junto com os
// outros nove. Pior: a tela de saúde do relatório MEDE essa taxa e a exibe como "acima do
// alvo", ou seja, o sistema já sabia relatar o próprio defeito; faltava a decisão.
//
// A DECISÃO: a prioridade passa a vir da NATUREZA DO EVENTO — a tabela abaixo — e não da
// grafia da mensagem. O texto volta a ser só apresentação (é o que ele deveria ter sido
// sempre). Ordem de precedência em `severityOf`:
//
//   1. `severidade` EXPLÍCITA no payload  — o emissor sabe mais que qualquer heurística;
//   2. tabela (tipo × evento)             — a regra da casa, revisável num lugar só;
//   3. heurística de TEXTO (legado)       — só p/ emissor antigo que não declara nada.
//
// O CRITÉRIO DE "CRÍTICO" (a régua, escrita para poder ser contestada): crítico é o que exige
// ação AGORA e cuja demora tem custo irreversível — risco a pessoa, ou perda TOTAL de
// vigilância (não estamos vendo nada). Degradação que dá para tratar dentro do turno é
// ATENÇÃO. Contexto, ciclo de vida e boa notícia são INFORMATIVO.
//
// Consequência aceita e declarada: com esta tabela, a taxa de crítico cai de 83% para ~17%
// no mesmo conjunto de textos (dois eventos: área proibida e sem-vídeo). Ainda acima de 5%,
// porque 5% é meta de REGIME (a operação real emite muito mais informativo/atenção do que os
// 12 textos-exemplo) — o que se conserta aqui é a INVERSÃO, não o percentual por decreto.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const NIVEIS = Object.freeze(["advisory", "high", "critical"]);
const RANK = Object.freeze({ advisory: 0, high: 1, critical: 2 });

/** É um nível válido da política? (payload externo não define vocabulário). */
const nivelValido = (v) => typeof v === "string" && NIVEIS.includes(v);

// ── A TABELA ─────────────────────────────────────────────────────────────────
// Chave: `${tipo}` ou `${tipo}:${evento}` (o mais específico vence). `evento` é o campo
// OPCIONAL do payload que diz o QUE aconteteu dentro do tipo (ex.: "sem-video" em saude).
// Cada linha tem o porquê ao lado: regra sem justificativa é regra que ninguém revisa.
const TABELA = Object.freeze({
  // ── CRÍTICO — risco a pessoa, ou perda TOTAL de vigilância ──────────────────
  // Segurança patrimonial/vida: alguém está onde não podia estar. É o caso que justifica
  // acordar gente. Fail-safe: se a classificação errar para cá, o custo é uma mensagem a mais.
  presenca: "critical",
  // Nenhum frame chegando: não é "a IA está lenta", é NÃO ESTAMOS VENDO NADA. Todo indicador
  // daquela câmera no período vira não-medido — e é o operador que precisa saber disso, não o
  // relatório de amanhã.
  "saude:sem-video": "critical",
  // A MESMA condição em N câmeras (colapso sistêmico do health-incidents): perda de vigilância
  // em escala, com causa única. Continua crítico porque o escopo é a frota, não uma câmera.
  "saude:frota": "critical",

  // ── ATENÇÃO — degradação real, tratável dentro do turno ─────────────────────
  // Tem vídeo, mas picado: ainda se mede, com buracos. Merece ação, não interrupção.
  "saude:video-instavel": "high",
  // Vídeo chegando e inferência parada/atrasada: o vídeo na tela engana, mas o histórico
  // registra a lacuna (observedMs) e o relatório sabe declarar. Ação no turno.
  "saude:ia-parada": "high",
  "saude:ia-atrasada": "high",
  // Fadiga/sonolência/celular: risco a pessoa, mas com resposta de SUPERVISÃO (falar com o
  // operador), não de emergência. JUÍZO DE PRODUTO — se o dono quiser crítico, é esta linha.
  fadiga: "high",
  // Área parada / lotação fora do esperado: produtividade e operação. Nunca foi emergência.
  atividade: "high",
  objetos: "high",
  // Rajada: é SINTOMA (o colapso já resumiu N alertas). O alarme-raiz já saiu com a própria
  // gravidade; repetir crítico aqui é contar o mesmo problema duas vezes.
  "atividade:rajada": "high",

  // ── INFORMATIVO — contexto, qualidade de medição e boa notícia ──────────────
  // Qualidade de LEITURA (no-read/taxa) é indicador, não incidente.
  leitura: "advisory",
  // A linha existe e conta, só não na cadência ideal: é aviso de CALIBRAÇÃO, não incidente.
  "saude:linha-sem-cadencia": "advisory",
  // Ciclo de vida do incidente. "Fechar" é boa notícia — boa notícia nunca é crítica; se
  // fosse, o operador receberia vermelho para saber que o problema ACABOU.
  "saude:fechar": "advisory",
});

/**
 * Prioridade pela NATUREZA do evento. Não olha texto: quem olha texto é o fallback legado
 * em priority.js, e só quando esta função devolve `null`.
 * @param {{tipo?:string, evento?:string, severidade?:string}} p payload do alerta
 * @returns {"advisory"|"high"|"critical"|null} null = a tabela não opina (cai no legado)
 */
function severityOf(p) {
  if (!p) return null;
  // 1. O emissor declarou. Ninguém sabe mais sobre o evento que quem o emitiu.
  if (nivelValido(p.severidade)) return p.severidade;
  const tipo = String(p.tipo || "").trim();
  if (!tipo) return null;
  const evento = String(p.evento || "").trim();
  // 2. Tabela: o mais específico (tipo:evento) vence o geral (tipo).
  if (evento && TABELA[`${tipo}:${evento}`]) return TABELA[`${tipo}:${evento}`];
  return TABELA[tipo] ?? null;
}

/** Rebaixa uma prioridade em N degraus (piso: advisory). Usado por quem SUPRIME contexto —
 *  ex.: câmera fora de produção, cujo alarme vira registro, não emergência. */
function rebaixar(priority, degraus = 1) {
  const r = (RANK[priority] ?? 0) - Math.max(0, degraus);
  return NIVEIS[Math.max(0, r)];
}

module.exports = { severityOf, rebaixar, TABELA, NIVEIS, RANK };
