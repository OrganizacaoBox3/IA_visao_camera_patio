// ─────────────────────────────────────────────────────────────────────────────
// autoscale.js — DECISÃO PURA de dimensionamento do modelo (Onda 5 do
// mapa-config-simplificacao.md — "auto-dimensionamento S↔N/M por hardware").
//
// NORTE do produto: MELHOR qualidade que o hardware SUSTENTA, com ZERO decisão do
// usuário. Hoje `ANALYSIS_MODEL=n|s|m` era escolha manual; aqui ela vira AUTOMÁTICA:
//   • PICK DE STARTUP — o melhor tier que o orçamento (cores × câmeras) comporta.
//   • VÁLVULA DE RUNTIME — desce um tier (downgrade-only) quando o worker está
//     comprovadamente AFOGADO (cadência muito abaixo do alvo E CPU sustentada alta),
//     com histerese FORTE (N janelas consecutivas) + cooldown pós-troca (anti-flap).
//     Sobe só CONSERVADOR (folga sustentada por MUITO mais tempo + orçamento comporta).
//
// Este módulo é PURO/DETERMINÍSTICO e testável (autoscale.test.js): recebe métricas +
// o estado de histerese, devolve o próximo tier + o porquê. O EFEITO COLATERAL (recarregar
// o .onnx via model.js + respawn do worker) fica no engine — e model.setActiveTier() é
// ATÔMICO (reverte se o download falhar), então o motor NUNCA fica sem modelo (SEGURANÇA:
// um sistema de vigilância não pode ficar cego — nunca descemos abaixo do PISO N).
//
// SOBRE O "MINI-BENCHMARK" (por que NÃO fazemos no boot): medir 1 inferência por tier
// exigiria baixar os TRÊS modelos (~130 MB) só p/ calibrar — viola "barato" e atrasa o
// boot. Em vez disso o pick de startup é um orçamento GROSSO (cores × câmeras) e a válvula
// de runtime corrige com a cadência/CPU REAIS medidas pelo worker (inferMs/cpuPct). É o
// caminho honesto/KISS: começa no melhor plausível, degrada só sob pressão medida.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Tiers em ordem CRESCENTE de qualidade/custo. N (nano) é o PISO — nunca descemos
// abaixo dele (o motor precisa sempre de UM modelo válido).
const TIERS = ["n", "s", "m"];

// Câmeras que UM core sustenta @1fps por tier (medido — model.js: ~17 no N, ~7 no S,
// ~4 no M; M ~2× o custo do S, S ~2,4× o do N). Usado só p/ ORÇAMENTO GROSSO (pick de
// startup + teto de upgrade). A verdade de runtime é a cadência/CPU medidas.
const CAP_PER_CORE = { n: 17, s: 7, m: 4 };

const DEFAULTS = {
  evalMs: 30_000, // tamanho da janela de avaliação (o engine chama 1×/janela)
  downWindows: 3, // janelas consecutivas AFOGADAS → desce um tier (≈90s @30s/janela)
  upWindows: 20, // janelas consecutivas FOLGADAS → sobe um tier (≈10min — conservador)
  cooldownMs: 120_000, // silêncio pós-troca (não reavalia p/ trocar) — anti-oscilação
  downFpsRatio: 0.6, // cadência alcançada < 60% do alvo = está atrás
  downCpuPct: 150, // worker usando ≥1,5 core (2 intra-threads perto do teto) = afogado
  upFpsRatio: 0.95, // batendo ~100% do alvo
  upCpuPct: 60, // worker usando <60% de UM core = muita folga (só então cogita subir)
  startupHeadroom: 1.2, // no boot exige orçamento FOLGADO p/ escolher um tier (ainda sem medição)
};

function tierIndex(t) {
  return TIERS.indexOf(t);
}
function clampTier(i) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, i))];
}

/**
 * Maior tier cujo ORÇAMENTO (cores × cap/core) comporta as câmeras, com `headroom` de
 * folga exigida. Best-first; cai p/ o PISO "n" se nada couber (nunca devolve sem tier).
 */
function budgetTier({ cores, cameras }, headroom = 1) {
  const cam = Math.max(1, cameras || 0);
  const c = Math.max(1, cores || 1);
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i];
    if (cam * headroom <= c * CAP_PER_CORE[t]) return t;
  }
  return "n";
}

/**
 * PICK DE STARTUP: o melhor tier sustentável pelo hardware no boot. Conservador
 * (startupHeadroom) porque ainda NÃO há medição real — o runtime confirma/corrige.
 * Sem câmeras conhecidas ainda, `cameras` baixo → tende ao melhor (M/S).
 */
function pickStartupTier({ cores, cameras }, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return budgetTier({ cores, cameras }, c.startupHeadroom);
}

/** Estado inicial da histerese (o engine guarda e repassa a cada janela). */
function initState(tier) {
  return { tier, choked: 0, idle: 0, lastSwitchAt: 0 };
}

/**
 * DECISÃO PURA de runtime. Dado o estado (contadores de histerese) e uma amostra
 * agregada da janela, devolve { state, action, from, to, reason }.
 *   action ∈ "hold" | "downgrade" | "upgrade".
 * O engine é a AUTORIDADE do tier ativo (sample.tier); esta função só recomenda o passo.
 * SEGURANÇA: só transita entre TIERS válidos e nunca abaixo do PISO N.
 *
 * @param {{tier,choked,idle,lastSwitchAt}} state
 * @param {{now,tier,cpuPct,achievedFps,targetFps,cameras,cores}} sample
 * @param {object} [cfg]  overrides de DEFAULTS (usado nos testes)
 */
function decideRuntime(state, sample, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const tier = sample.tier || state.tier;
  const s = {
    tier,
    choked: state.choked || 0,
    idle: state.idle || 0,
    lastSwitchAt: state.lastSwitchAt || 0,
  };
  const hold = (reason) => ({ state: s, action: "hold", from: tier, to: tier, reason });

  // Cooldown pós-troca: zera contadores e segura (impede N↔S em cascata).
  if (sample.now - s.lastSwitchAt < c.cooldownMs) {
    s.choked = 0;
    s.idle = 0;
    return hold("cooldown");
  }

  // Sem carga p/ julgar (nenhuma câmera / alvo zero) → não mexe.
  if (!sample.cameras || !(sample.targetFps > 0)) {
    s.choked = 0;
    s.idle = 0;
    return hold("sem-carga");
  }

  const fpsRatio = sample.achievedFps / sample.targetFps;
  const idx = tierIndex(tier);
  const chokedNow = fpsRatio <= c.downFpsRatio && sample.cpuPct >= c.downCpuPct;
  const idleNow = fpsRatio >= c.upFpsRatio && sample.cpuPct <= c.upCpuPct;

  // ── DOWNGRADE: afogado (atrás na cadência E CPU alta) por downWindows consecutivas.
  // Só desce se há p/ onde (idx>0) — no PISO N não há downgrade (nunca cego).
  if (chokedNow && idx > 0) {
    s.choked += 1;
    s.idle = 0;
    if (s.choked >= c.downWindows) {
      const to = clampTier(idx - 1);
      return {
        state: { tier: to, choked: 0, idle: 0, lastSwitchAt: sample.now },
        action: "downgrade",
        from: tier,
        to,
        reason: `afogado ${s.choked}× (fps ${fpsRatio.toFixed(2)}≤${c.downFpsRatio} · cpu ${sample.cpuPct}%≥${c.downCpuPct}%)`,
      };
    }
    return hold(`afogando ${s.choked}/${c.downWindows}`);
  }

  // ── UPGRADE (conservador): folga sustentada por upWindows E o orçamento comporta o
  // tier maior (sem headroom extra — já há medição real de folga a sustentar).
  if (idleNow && idx < TIERS.length - 1) {
    const budget = budgetTier({ cores: sample.cores, cameras: sample.cameras }, 1);
    if (tierIndex(budget) > idx) {
      s.idle += 1;
      s.choked = 0;
      if (s.idle >= c.upWindows) {
        const to = clampTier(idx + 1);
        return {
          state: { tier: to, choked: 0, idle: 0, lastSwitchAt: sample.now },
          action: "upgrade",
          from: tier,
          to,
          reason: `folga sustentada ${s.idle}× (fps ${fpsRatio.toFixed(2)}≥${c.upFpsRatio} · cpu ${sample.cpuPct}%≤${c.upCpuPct}%)`,
        };
      }
      return hold(`folga ${s.idle}/${c.upWindows}`);
    }
    // Folga, mas o orçamento já está no teto p/ subir → estável.
    s.idle = 0;
    s.choked = 0;
    return hold("folga (orçamento no teto)");
  }

  // Zona neutra: um blip não conta — RELAXA os contadores (histerese forte por consecutivas).
  s.choked = 0;
  s.idle = 0;
  return hold("estável");
}

module.exports = {
  TIERS,
  CAP_PER_CORE,
  DEFAULTS,
  budgetTier,
  pickStartupTier,
  initState,
  decideRuntime,
};
