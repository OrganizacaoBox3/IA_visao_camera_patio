// Testes do módulo de EVIDÊNCIA ABSOLUTA (distance.ts). O que estes testes travam:
//  1. Regra 8 (dedupeConsecutive é CONTAGEM: cópia não é medição);
//  2. o ponto do módulo inteiro — a evidência absoluta FALA COM MOVIMENTO ZERO (é onde a
//     correlação é matematicamente indefinida e o produto vive);
//  3. o σ sai do DADO (LOO nas âncoras), não do gosto — e o LOO é honesto (o modelo não vê a tag
//     que julga);
//  4. Regra 9 — o piso de resolução existe e é declarável.
import { describe, it, expect } from "vitest";
import {
  absoluteEvidence,
  absoluteScore,
  dedupeConsecutive,
  estimateTagDistM,
  looResiduals,
  median,
  resolutionFloorM,
  sigmaDecadesFromResiduals,
} from "./distance";
import { fitPathLoss, type AnchorObs, type PathLossModel } from "./floor-plot";
import type { Vec2 } from "../vision/homography";

const STATION: Vec2 = { x: 0, y: 0 };
/** RSSI que o modelo (rssi0, n) produziria a d metros — o gerador inverso de distFromRssi. */
const rssiAt = (rssi0: number, n: number, d: number) => rssi0 - 10 * n * Math.log10(d);
const anchorAt = (mac: string, d: number, rssi: number): AnchorObs => ({
  mac,
  world: { x: d, y: 0 },
  rssi,
});

describe("Regra 8 — dedupeConsecutive é CONTAGEM, não modelo", () => {
  it("colapsa a repetição CONSECUTIVA (o sample-and-hold do app: 81% do que chega é cópia)", () => {
    expect(dedupeConsecutive([-60, -60, -60, -65, -65, -70])).toEqual([-60, -65, -70]);
  });

  it("valor que VOLTA depois de mudar conta de novo — são medições distintas de verdade", () => {
    expect(dedupeConsecutive([-60, -65, -60])).toEqual([-60, -65, -60]);
  });

  it("descarta não-finitos e sobrevive à série vazia", () => {
    expect(dedupeConsecutive([NaN, -60, -60, Infinity])).toEqual([-60]);
    expect(dedupeConsecutive([])).toEqual([]);
  });

  it("o nº de DISTINTAS é o teto de evidência: 16 POSTs de 3 medições valem 3, não 16", () => {
    const posts = [-60, -60, -60, -60, -60, -65, -65, -65, -65, -65, -70, -70, -70, -70, -70, -70];
    expect(posts.length).toBe(16);
    expect(dedupeConsecutive(posts).length).toBe(3); // o que o motor de hoje acredita ter: 16
  });
});

describe("estimateTagDistM — mediana das DISTINTAS invertida pelo modelo", () => {
  const model: PathLossModel = { rssi0: -45, n: 2.2, source: "anchors", samples: 4 };

  it("recupera a distância exata quando o RSSI vem do próprio modelo", () => {
    const est = estimateTagDistM(model, [rssiAt(-45, 2.2, 3)]);
    expect(est!.distM).toBeCloseTo(3, 6);
    expect(est!.nDistinct).toBe(1);
  });

  it("MEDIANA, não média: o outlier de obstrução (−93 dBm no meio de −66) não arrasta a distância", () => {
    // O −93 no meio de −66 é REAL (medido na gravação de campo: obstrução momentânea).
    const clean = estimateTagDistM(model, [-66, -67, -66, -66])!; // dedupe → [-66,-67,-66]
    const withOutlier = estimateTagDistM(model, [-66, -67, -66, -93, -66])!; // 5 distintas
    expect(withOutlier.distM).toBeCloseTo(clean.distM, 6); // a mediana NÃO se move

    // A MÉDIA se moveria — e muito: 9,0 m → 16,2 m (×1,8) por causa de UM único outlier.
    const mean = (-66 - 67 - 66 - 93 - 66) / 5; // = −71,6 dBm
    const dPelaMedia = Math.pow(10, (model.rssi0 - mean) / (10 * model.n));
    expect(dPelaMedia).toBeGreaterThan(clean.distM * 1.75); // é POR ISSO que é mediana
  });

  it("conta DISTINTAS, não POSTs (Regra 8)", () => {
    expect(estimateTagDistM(model, [-60, -60, -60, -60])!.nDistinct).toBe(1);
  });

  it("série vazia → null (sem leitura não há evidência; inventar 100 m seria fabricar medição)", () => {
    expect(estimateTagDistM(model, [])).toBeNull();
    expect(estimateTagDistM(model, [NaN])).toBeNull();
  });
});

describe("absoluteScore — verossimilhança em DÉCADAS (o erro do RSSI é multiplicativo)", () => {
  it("gap zero → score 1; o score cai com o gap", () => {
    expect(absoluteScore(2, 2, 0.25)).toBeCloseTo(1, 6);
    expect(absoluteScore(2, 4, 0.25)).toBeLessThan(1);
    expect(absoluteScore(2, 8, 0.25)).toBeLessThan(absoluteScore(2, 4, 0.25));
  });

  it("SIMÉTRICO no fator (o oposto de um limiar em metros, que aperta longe e afrouxa perto)", () => {
    // 1 m vs 2 m (fator 2) tem o MESMO score que 10 m vs 20 m (fator 2).
    expect(absoluteScore(1, 2, 0.25)).toBeCloseTo(absoluteScore(10, 20, 0.25), 10);
    // Já em metros absolutos, |1−2| = 1 e |10−20| = 10 — réguas diferentes para o mesmo erro físico.
  });

  it("σ ≤ 0 ou entrada inválida → 0 (sem régua medida, a evidência não fala)", () => {
    expect(absoluteScore(2, 2, 0)).toBe(0);
    expect(absoluteScore(2, 2, -1)).toBe(0);
    expect(absoluteScore(NaN, 2, 0.25)).toBe(0);
  });
});

describe("absoluteEvidence — O PONTO: fala com MOVIMENTO ZERO", () => {
  const model: PathLossModel = { rssi0: -45, n: 2.2, source: "anchors", samples: 4 };

  it("pessoa PARADA (distância constante) e RSSI constante: a correlação seria INDEFINIDA — aqui há evidência", () => {
    // Série de distância constante: variância 0 ⇒ o pearson do associador devolve null e o
    // movementVetoed corta. A distância absoluta não olha a série: olha o VALOR.
    const dParada = 3.0;
    const ev = absoluteEvidence(dParada, [rssiAt(-45, 2.2, 3), rssiAt(-45, 2.2, 3)], model, 0.25);
    expect(ev).not.toBeNull();
    expect(ev!.gapDecades).toBeCloseTo(0, 6);
    expect(ev!.score).toBeCloseTo(1, 6);
    expect(ev!.nDistinct).toBe(1); // uma medição distinta basta — é uma DISTÂNCIA, não uma tendência
  });

  it("tag do vizinho (a 8 m) contra a pessoa a 3 m: gap grande, score cai — mas cai POUCO", () => {
    const ev = absoluteEvidence(3, [rssiAt(-45, 2.2, 8)], model, 0.25)!;
    expect(ev.dTagM).toBeCloseTo(8, 5);
    expect(ev.gapDecades).toBeCloseTo(Math.log10(8 / 3), 5);
    // z = 0,426/0,25 = 1,70 ⇒ score = 0,23. HONESTIDADE: um erro de 2,7× em distância derruba o
    // score só até 0,23 — a evidência absoluta é MOLE por construção quando σ é grande. Este número
    // NÃO é um detalhe do teste: é a razão pela qual o torneio de campo mediu 23,7% de precisão
    // (σ real = 0,268 década). Um σ pequeno é o que tornaria este score afiado; o campo não o deu.
    expect(ev.score).toBeCloseTo(0.234, 2);
    expect(ev.score).toBeLessThan(absoluteEvidence(3, [rssiAt(-45, 2.2, 3)], model, 0.25)!.score);
  });

  it("sem distância MÉTRICA (proxy de caixa / câmera sem H) → null, nunca um score fabricado", () => {
    expect(absoluteEvidence(null, [-60], model, 0.25)).toBeNull();
  });

  it("minDistinct é o gate da Regra 8: 5 cópias não viram 5 medições", () => {
    expect(absoluteEvidence(3, [-60, -60, -60, -60, -60], model, 0.25, { minDistinct: 2 })).toBeNull();
    expect(absoluteEvidence(3, [-60, -61], model, 0.25, { minDistinct: 2 })).not.toBeNull();
  });
});

describe("looResiduals — o juiz NÃO-CIRCULAR (o modelo nunca vê a tag que julga)", () => {
  it("dado sintético do próprio modelo: resíduo ≈ 0 (o LOO recupera a física quando ela existe)", () => {
    // Âncoras espalhadas o bastante em log10(d) → o fit recupera rssi0 E n (regime "anchors").
    const obs = [1, 2, 4, 8].map((d, i) => anchorAt(`A${i}`, d, rssiAt(-45, 2.2, d)));
    const res = looResiduals(obs, STATION);
    expect(res).toHaveLength(4);
    for (const r of res) expect(r.errM).toBeLessThan(0.05);
    const sigma = sigmaDecadesFromResiduals(res)!;
    expect(sigma).toBeLessThan(0.01);
  });

  it("CIRCULARIDADE PROVADA AUSENTE: viés só na âncora testada aparece no resíduo DELA", () => {
    const obs = [1, 2, 4, 8].map((d, i) => anchorAt(`A${i}`, d, rssiAt(-45, 2.2, d)));
    obs[2] = { ...obs[2], rssi: obs[2].rssi - 12 }; // 12 dB a menos SÓ nela (obstrução localizada)
    const res = looResiduals(obs, STATION);
    const suja = res.find((r) => r.mac === "A2")!;
    const limpa = res.find((r) => r.mac === "A0")!;
    expect(suja.errDecades).toBeGreaterThan(limpa.errDecades * 3); // o LOO a DENUNCIA
    // (é o data-snooping da geodésia: o observável que destoa do ajuste feito com TODOS os outros.
    //  Se o fit incluísse a própria âncora, o mínimo quadrado absorveria o viés e o erro sumiria —
    //  mediríamos a qualidade do ajuste, não a do rádio.)
  });

  it("menos de 3 âncoras → [] (sem 2 sobrando para o fit, não há leave-one-out)", () => {
    expect(looResiduals([anchorAt("A", 1, -45), anchorAt("B", 2, -51)], STATION)).toEqual([]);
  });

  it("o fit LOO nunca inclui a âncora julgada (invariante estrutural)", () => {
    const obs = [1, 2, 4].map((d, i) => anchorAt(`A${i}`, d, rssiAt(-45, 2.2, d)));
    // Corrompe UMA âncora com valor absurdo: se ela entrasse no próprio fit, o rssi0 iria junto e
    // o resíduo dela seria pequeno. Com LOO, o resíduo dela explode — é o que o assert cobra.
    const corrompida = [...obs];
    corrompida[0] = { ...obs[0], rssi: -20 };
    const res = looResiduals(corrompida, STATION);
    expect(res.find((r) => r.mac === "A0")!.errDecades).toBeGreaterThan(0.3);
  });
});

describe("Regra 9 — resolutionFloorM: o PONTO CEGO, declarado em metros", () => {
  it("σ medido em campo (0,268 década) a 1,4 m ⇒ piso ≈ 1,2 m: NÃO resolve duas mesas a 0,5 m", () => {
    const floor = resolutionFloorM(0.268, 1.41)!;
    expect(floor).toBeGreaterThan(1.1);
    expect(floor).toBeLessThan(1.3);
    expect(floor).toBeGreaterThan(0.49); // a separação RADIAL mediana medida no campo
  });

  it("o piso ESCALA com a distância — longe da estação o rádio é ainda mais cego", () => {
    expect(resolutionFloorM(0.25, 10)!).toBeGreaterThan(resolutionFloorM(0.25, 1)!);
  });

  it("σ inválido → null (sem σ medido não se declara ponto cego nenhum)", () => {
    expect(resolutionFloorM(0, 2)).toBeNull();
    expect(resolutionFloorM(0.25, 0)).toBeNull();
  });
});

describe("median — utilitário (série vazia é null, não 0)", () => {
  it("ímpar, par e vazia", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("o regime do fit é DECLARADO (âncoras coladas não identificam o expoente)", () => {
  it("as 4 âncoras REAIS do campo (retângulo 2,5 × 1,2 m) caem em anchors-offset — n é chute", () => {
    // Geometria real do camcfg (cam-8a95ac6090): span de log10(d) ≈ 0,11 década << 0,4.
    const obs: AnchorObs[] = [
      { mac: "A", world: { x: 0, y: 0 }, rssi: -69 },
      { mac: "B", world: { x: 2.5, y: 0 }, rssi: -67 },
      { mac: "C", world: { x: 2.5, y: 1.2 }, rssi: -71 },
      { mac: "D", world: { x: 0, y: 1.2 }, rssi: -70 },
    ];
    const model = fitPathLoss(obs, { x: 1.25, y: 0.6 }); // estação no meio
    expect(model.source).toBe("anchors-offset"); // só o OFFSET é calibrável — o expoente NÃO
    expect(model.n).toBe(2.2); // o default, declarado
  });
});
