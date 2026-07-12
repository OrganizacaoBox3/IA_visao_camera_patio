// A MEDIÇÃO que decide a feature de UI de planta baixa. Roda a bancada de `floor-plan-gain.ts` e
// trava, como teste, os achados que a decisão usa — inclusive (sobretudo) os NEGATIVOS: achado
// negativo tem o mesmo peso (CLAUDE.md §2.5).
//
// A MÉTRICA QUE IMPORTA é `exclusionRate` (`via: "exclusao"`): a identidade que as RESTRIÇÕES
// entranharam. O `via: "pin"` não conta — a conservação já o dava, sem planta nenhuma.
//
// Para ver as tabelas: `npx vitest run src/fusion/floor-plan-gain.test.ts --reporter=verbose`

import { describe, it, expect } from "vitest";
import { runGain, buildPlan, type GainParams } from "./floor-plan-gain";
import { analyzeFloorPlan } from "./floor-plan";

const P = (over: Partial<GainParams>): GainParams => ({
  seed: 20260712,
  runs: 1500,
  operators: 4,
  coverage: 0.7,
  pPin: 0,
  pHole: 0,
  closure: false,
  topology: "nenhuma",
  ...over,
});

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

describe("GANHO DA PLANTA BAIXA — identidade sem rádio de posição, só geometria", () => {
  it("TABELA 1 — fechamento × obstáculos × cobertura (4 operadores, anônimos constantes, cap. 1–2)", () => {
    const rows: Record<string, string>[] = [];
    for (const cov of [1.0, 0.9, 0.7]) {
      for (const cell of [
        { nome: "hoje (nada)", closure: false, topology: "nenhuma" as const },
        { nome: "topol. ABSTRATA", closure: false, topology: "abstrata" as const },
        { nome: "OBSTÁCULOS (planta)", closure: false, topology: "planta-com-obstaculo" as const },
        { nome: "FECHAMENTO", closure: true, topology: "nenhuma" as const },
        { nome: "FECHAM.+OBSTÁCULOS", closure: true, topology: "planta-com-obstaculo" as const },
      ]) {
        const s = runGain(P({ coverage: cov, closure: cell.closure, topology: cell.topology }));
        rows.push({
          cob: pct(cov),
          cenario: cell.nome,
          "DECIDIDA p/ exclusão": pct(s.exclusionRate),
          precisao: s.decided > 0 ? pct(s.precision) : "—",
          "fora (ok)": `${pct(s.fora / s.operators)} (${s.fora > 0 ? pct(s.foraCorrect / s.fora) : "—"})`,
          "zonas possíveis (amb.)": s.ambiguityMean.toFixed(2),
          inviavel: String(s.infeasibleRuns),
        });
      }
    }
    console.table(rows);
    expect(rows.length).toBe(15);
  }, 60_000);

  it("ACHADO CENTRAL (negativo) — FECHAMENTO+OBSTÁCULOS não entranha quase NADA: a exclusividade é PERMUTACIONALMENTE SIMÉTRICA", () => {
    // Fechar o "fora" tira uma opção de TODOS os operadores IGUALMENTE. Com N operadores
    // intercambiáveis sobre M zonas ocupadas, toda permutação continua viável ⇒ entailment VAZIO.
    // Só um sinal ASSIMÉTRICO por operador (pino, locality de receptor, continuidade) quebra a
    // simetria. A planta NÃO é um sinal assimétrico — ela é uma restrição global.
    const hoje = runGain(P({ coverage: 0.7 }));
    const tudo = runGain(P({ coverage: 0.7, closure: true, topology: "planta-com-obstaculo" }));
    expect(hoje.exclusionRate).toBeLessThan(0.01);
    expect(tudo.exclusionRate).toBeLessThan(0.05); // <5 p.p. — o ganho NÃO existe neste regime
  }, 30_000);

  it("TABELA 2 — o REGIME em que o fechamento paga: ocupação SATURADA (poucos postos, poucos anônimos)", () => {
    const rows: Record<string, string>[] = [];
    for (const cfg of [
      { nome: "6 postos, anônimos 35% (o CD descrito)", rows: 2, cols: 3, pAnonZone: 0.35, operators: 4 },
      { nome: "6 postos, SEM anônimos", rows: 2, cols: 3, pAnonZone: 0, operators: 4 },
      { nome: "3 postos, anônimos 35%", rows: 1, cols: 3, pAnonZone: 0.35, operators: 3 },
      { nome: "3 postos, SEM anônimos", rows: 1, cols: 3, pAnonZone: 0, operators: 3 },
      { nome: "2 postos, SEM anônimos", rows: 1, cols: 2, pAnonZone: 0, operators: 2 },
    ]) {
      const a = runGain(P({ ...cfg, closure: false }));
      const b = runGain(P({ ...cfg, closure: true }));
      const c = runGain(P({ ...cfg, closure: true, pPin: 0.34 }));
      rows.push({
        regime: cfg.nome,
        hoje: pct(a.exclusionRate),
        "c/ FECHAMENTO": pct(b.exclusionRate),
        "c/ FECHAM. + 1 pino em 3": pct(c.exclusionRate),
        "amb. (zonas)": b.ambiguityMean.toFixed(2),
      });
    }
    console.table(rows);
    expect(rows.length).toBe(5);
  }, 60_000);

  it("TABELA 3 — CONTINUIDADE: os obstáculos só pagam se o buraco de identidade for CURTO", () => {
    const rows: Record<string, string>[] = [];
    for (const gap of [
      { nome: "0–5 s (track morreu agora)", gapMinMs: 500, gapMaxMs: 5_000 },
      { nome: "5–15 s", gapMinMs: 5_000, gapMaxMs: 15_000 },
      { nome: "5–40 s (o default)", gapMinMs: 5_000, gapMaxMs: 40_000 },
      { nome: "1–5 min (o horizonte da Onda 2)", gapMinMs: 60_000, gapMaxMs: 300_000 },
    ]) {
      const semGeo = runGain(P({ ...gap, closure: true, topology: "planta-sem-obstaculo" }));
      const comGeo = runGain(P({ ...gap, closure: true, topology: "planta-com-obstaculo" }));
      rows.push({
        "buraco de identidade": gap.nome,
        "planta SEM obstáculo": pct(semGeo.exclusionRate),
        "planta COM obstáculo": pct(comGeo.exclusionRate),
        "ganho dos obstáculos (p.p.)": (100 * (comGeo.exclusionRate - semGeo.exclusionRate)).toFixed(1),
        "amb. (zonas)": comGeo.ambiguityMean.toFixed(2),
      });
    }
    console.table(rows);
    expect(rows.length).toBe(4);
  }, 60_000);

  it("GEOMETRIA — o rack NÃO cria zero estrutural (dá para contornar); cria DESVIO", () => {
    const a = analyzeFloorPlan(buildPlan(0.7, true, true));
    expect(a.unreachablePairs).toEqual([]); // num CD aberto, quase nunca há transição IMPOSSÍVEL
    expect(a.detouredPairs.length).toBeGreaterThan(0); // o que existe é "contorne o rack"
    const pior = a.detouredPairs.reduce((m, d) => (d[2] > m[2] ? d : m));
    console.log(
      `planta 2×3 c/ rack: cobertura=${(100 * a.coverage).toFixed(0)}% · desvios=${a.detouredPairs.length} · ` +
        `pior=${pior[0]}→${pior[1]} ${pior[2].toFixed(1)} m (reta ${pior[3].toFixed(1)} m)`,
    );
    expect(pior[2]).toBeGreaterThan(2 * pior[3]);
  });

  it("TABELA 4 (RISCO) — fechamento ERRADO: onde ele decide, ele MENTE com cara de certeza", () => {
    // O fechamento errado tem DOIS destinos possíveis, e a diferença entre eles é tudo:
    //   - FALHA SEGURA: a conta não fecha (o operador do buraco não é contado por câmera nenhuma) ⇒
    //     `inviavel`. Nenhum rótulo é emitido. É o que acontece quando NÃO há folga de ocupação.
    //   - MENTIRA: um ANÔNIMO abre uma vaga na zona, e a exclusividade empurra para lá o operador que
    //     está no buraco ⇒ `decidida via exclusao`, ERRADA. A folga do anônimo é o veículo do erro.
    // Ou seja: o anônimo — que já destrói o ganho — é também o que transforma a falha segura em mentira.
    const rows: Record<string, string>[] = [];
    for (const anon of [0, 0.35]) {
      for (const pPin of [0.34, 0.67, 1.0]) {
        const cfg = { rows: 1, cols: 3, operators: 3, pAnonZone: anon, pPin, closure: true };
        const s = runGain(P({ ...cfg, pHole: 0.1 }));
        rows.push({
          anonimos: pct(anon),
          pinos: pct(pPin),
          "o que a planta comprou": `${s.decidedByExclusion} (${pct(s.exclusionRate)})`,
          "🔑 PRECISÃO do que ela comprou": s.decidedByExclusion > 0 ? pct(s.exclusionPrecision) : "—",
          "ERRADOS c/ cara de certeza": String(s.exclusionWrong),
          "precisão GLOBAL (maquiada p/ pinos)": s.decided > 0 ? pct(s.precision) : "—",
          "falha SEGURA (inviável)": `${s.infeasibleRuns}/${s.runs}`,
        });
      }
    }
    console.table(rows);

    const perigo = { rows: 1, cols: 3, operators: 3, pAnonZone: 0.35, pPin: 1.0, closure: true } as const;
    const s = runGain(P({ ...perigo, pHole: 0.1 }));
    expect(s.exclusionWrong).toBeGreaterThan(0); // a premissa falsa CONTAMINA — é o preço da flag
    // A PRECISÃO GLOBAL fica ~99% e ESCONDE o estrago (os pinos, que são verdadeiros, a inflam).
    // A precisão DO QUE O FECHAMENTO COMPROU despenca — é ela que tem de ser reportada.
    expect(s.precision).toBeGreaterThan(0.98);
    expect(s.exclusionPrecision).toBeLessThan(0.5);
    // Com a premissa VERDADEIRA (pHole 0), entailment não erra: precisão 100% por construção lógica.
    const verdadeiro = runGain(P({ ...perigo, pPin: 0.34, pHole: 0 }));
    expect(verdadeiro.decidedByExclusion).toBeGreaterThan(0);
    expect(verdadeiro.exclusionPrecision).toBe(1);
    // ...e SEM o fechamento, a mesma verdade-terreno NUNCA produz rótulo errado. Este é o motivo de a
    // flag nascer desligada: o erro do sistema honesto é "não sei"; o do fechado é "sei, e é falso".
    const seguro = runGain(P({ ...perigo, closure: false, pHole: 0.1 }));
    expect(seguro.decidedWrong).toBe(0);
  }, 30_000);
});
