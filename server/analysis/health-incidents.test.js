// Testes do CICLO DE VIDA DE INCIDENTE de saúde (health-incidents.js).
//
// O QUE ESTES TESTES TRAVAM: health.js já detectava câmera offline / IA parada / IA atrasada,
// mas o veredito morria no /api/analysis/status — ninguém era notificado. Ao ligar a notificação
// aparecem TRÊS armadilhas clássicas de sistema de alarme, e cada bloco abaixo trava uma:
//   • enxurrada: a condição é reavaliada o tempo todo ⇒ uma câmera offline por 3h viraria uma
//     mensagem por avaliação;
//   • pisca: uma lacuna de frame vira alarme e some;
//   • flapping: fechar cedo demais reabre na avaliação seguinte, em loop.
// E a armadilha específica DESTA operação, medida em produção: 16 de 17 câmeras em "ia-atrasada"
// ao mesmo tempo — porque a causa é UMA (pool saturado). Notificar por câmera aí é o ruído que
// esconde o sinal.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHealthIncidents } = require("./health-incidents");

const T0 = 1_000_000;
const seg = (n) => n * 1000;
const min = (n) => n * 60_000;
// Config curta e explícita nos testes (o default de produção é longo por bom motivo).
const CFG = { confirmMs: seg(120), renotifyMs: min(30), resolveMs: seg(180), sistemicoMin: 3 };
const doente = (estado, motivo = "") => ({ estado, motivo });
const ok = () => ({ estado: "ok" });
const tipos = (r) => r.acoes.map((a) => `${a.tipo}:${a.escopo}`);

describe("abrir — só depois de a condição se SUSTENTAR", () => {
  it("um pisca NÃO vira incidente", () => {
    const inc = createHealthIncidents(CFG);
    expect(inc.observe({ cam1: doente("sem-video") }, T0).acoes).toEqual([]);
    // resolveu antes de confirmar → nada foi notificado, e nada fica pendurado
    expect(inc.observe({ cam1: ok() }, T0 + seg(30)).acoes).toEqual([]);
    expect(inc.observe({ cam1: doente("sem-video") }, T0 + seg(60)).acoes).toEqual([]);
    expect(inc.abertos(T0 + seg(60))).toEqual([]);
  });

  it("sustentada além de confirmMs abre UM incidente, com desde no INÍCIO da condição", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video", "nenhum frame há 30s") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(60));
    const r = inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    expect(r.acoes).toHaveLength(1);
    expect(r.acoes[0]).toMatchObject({ tipo: "abrir", escopo: "camera", cameraId: "cam1", estado: "sem-video" });
    expect(r.acoes[0].desde).toBe(T0); // o incidente conta desde a 1ª evidência, não desde a confirmação
    expect(r.abertos).toHaveLength(1);
  });

  it("uma vez aberto, as avaliações seguintes NÃO geram nova ação (é 1 incidente, não N alarmes)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121)); // abre
    for (let t = 150; t < 1700; t += 30)
      expect(inc.observe({ cam1: doente("sem-video") }, T0 + seg(t)).acoes).toEqual([]);
  });
});

describe("renotificar — lembra sem criar incidente novo", () => {
  it("renotifica a cada renotifyMs, mantendo o MESMO incidenteId", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("ia-parada") }, T0);
    const abriu = inc.observe({ cam1: doente("ia-parada") }, T0 + seg(121)).acoes[0];
    const r1 = inc.observe({ cam1: doente("ia-parada") }, T0 + seg(121) + min(30));
    expect(tipos(r1)).toEqual(["renotificar:camera"]);
    expect(r1.acoes[0].incidenteId).toBe(abriu.incidenteId);
    expect(r1.acoes[0].duracaoMs).toBeGreaterThan(min(30));
    // e não repete antes da hora
    expect(inc.observe({ cam1: doente("ia-parada") }, T0 + seg(121) + min(31)).acoes).toEqual([]);
    const r2 = inc.observe({ cam1: doente("ia-parada") }, T0 + seg(121) + min(60));
    expect(tipos(r2)).toEqual(["renotificar:camera"]);
    expect(r2.acoes[0].incidenteId).toBe(abriu.incidenteId);
  });
});

describe("fechar — com histerese (anti-flapping)", () => {
  it("uma avaliação saudável NÃO fecha; o incidente segue aberto", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    expect(inc.observe({ cam1: ok() }, T0 + seg(130)).acoes).toEqual([]);
    expect(inc.abertos(T0 + seg(130))).toHaveLength(1);
  });

  it("voltar a falhar dentro da histerese NÃO reabre nem fecha (segue o MESMO incidente)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    const abriu = inc.observe({ cam1: doente("sem-video") }, T0 + seg(121)).acoes[0];
    inc.observe({ cam1: ok() }, T0 + seg(130));
    expect(inc.observe({ cam1: doente("sem-video") }, T0 + seg(200)).acoes).toEqual([]);
    const [aberto] = inc.abertos(T0 + seg(200));
    expect(aberto.incidenteId).toBe(abriu.incidenteId);
  });

  it("OK contínuo por resolveMs fecha UMA vez, com a duração total", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    inc.observe({ cam1: ok() }, T0 + seg(200));
    const r = inc.observe({ cam1: ok() }, T0 + seg(381));
    expect(tipos(r)).toEqual(["fechar:camera"]);
    expect(r.acoes[0].duracaoMs).toBe(seg(381));
    expect(inc.abertos(T0 + seg(381))).toEqual([]);
    // e não fecha duas vezes
    expect(inc.observe({ cam1: ok() }, T0 + seg(400)).acoes).toEqual([]);
  });
});

describe("agravar — a mesma câmera piorando é o MESMO incidente", () => {
  it("piorar notifica UMA vez e preserva o incidenteId", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("ia-atrasada") }, T0);
    const abriu = inc.observe({ cam1: doente("ia-atrasada") }, T0 + seg(121)).acoes[0];
    const r = inc.observe({ cam1: doente("sem-video") }, T0 + seg(150));
    expect(tipos(r)).toEqual(["agravar:camera"]);
    expect(r.acoes[0].incidenteId).toBe(abriu.incidenteId);
    expect(r.acoes[0].estado).toBe("sem-video");
    // e não repete o agravamento na avaliação seguinte
    expect(inc.observe({ cam1: doente("sem-video") }, T0 + seg(180)).acoes).toEqual([]);
  });

  it("MELHORAR não notifica (oscilação vira ruído)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    expect(inc.observe({ cam1: doente("ia-atrasada") }, T0 + seg(150)).acoes).toEqual([]);
  });

  it("oscilar entre dois estados não gera uma ação por oscilação", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("ia-atrasada") }, T0);
    inc.observe({ cam1: doente("ia-atrasada") }, T0 + seg(121)); // abre
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(150)); // agrava (1)
    let acoes = 0;
    for (let t = 180; t < 900; t += 30)
      acoes += inc.observe(
        { cam1: doente(t % 60 === 0 ? "ia-atrasada" : "sem-video") },
        T0 + seg(t),
      ).acoes.length;
    expect(acoes).toBe(0); // já esteve no pior estado — nada de novo a dizer
  });
});

describe("incidente SISTÊMICO — a mesma condição em N câmeras é UMA causa", () => {
  const frota = (n, estado) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`cam${i}`, doente(estado)]));

  it("abaixo do limiar, cada câmera notifica sozinha", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe(frota(2, "ia-atrasada"), T0);
    const r = inc.observe(frota(2, "ia-atrasada"), T0 + seg(121));
    expect(tipos(r).sort()).toEqual(["abrir:camera", "abrir:camera"]);
  });

  it("o caso REAL (16 câmeras atrasadas) vira UMA notificação de frota, não 16", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe(frota(16, "ia-atrasada"), T0);
    const r = inc.observe(frota(16, "ia-atrasada"), T0 + seg(121));
    expect(tipos(r)).toEqual(["abrir:frota"]);
    expect(r.acoes[0].cameras).toHaveLength(16);
    // mas os 16 incidentes por câmera CONTINUAM existindo (a UI mostra tudo)
    expect(r.abertos.filter((i) => i.escopo === "camera")).toHaveLength(16);
    expect(r.abertos.filter((i) => i.escopo === "frota")).toHaveLength(1);
  });

  it("o sistêmico renotifica UMA vez, não uma por câmera", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe(frota(16, "ia-atrasada"), T0);
    inc.observe(frota(16, "ia-atrasada"), T0 + seg(121));
    const r = inc.observe(frota(16, "ia-atrasada"), T0 + seg(121) + min(30));
    expect(tipos(r)).toEqual(["renotificar:frota"]);
  });

  it("estados DIFERENTES não se somam no mesmo sistêmico", () => {
    const inc = createHealthIncidents(CFG);
    const misto = { ...frota(3, "ia-atrasada"), x1: doente("sem-video"), x2: doente("sem-video") };
    inc.observe(misto, T0);
    const r = inc.observe(misto, T0 + seg(121));
    // 3 atrasadas colapsam; as 2 sem-vídeo (abaixo do limiar) notificam por câmera
    expect(tipos(r).sort()).toEqual(["abrir:camera", "abrir:camera", "abrir:frota"]);
    expect(r.acoes.find((a) => a.escopo === "frota").estado).toBe("ia-atrasada");
  });

  it("quando a causa comum passa, o sistêmico FECHA e as remanescentes voltam a falar por si", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe(frota(4, "ia-atrasada"), T0);
    inc.observe(frota(4, "ia-atrasada"), T0 + seg(121)); // abre frota
    // 2 saram (precisam de resolveMs contínuo p/ fechar); sobram 2 → abaixo do limiar
    const parcial = { cam0: doente("ia-atrasada"), cam1: doente("ia-atrasada"), cam2: ok(), cam3: ok() };
    inc.observe(parcial, T0 + seg(150));
    const r = inc.observe(parcial, T0 + seg(340));
    expect(tipos(r)).toContain("fechar:frota");
    expect(tipos(r).filter((t) => t === "fechar:camera")).toHaveLength(2);
  });
});

describe("robustez", () => {
  it("câmera que SAI do monitoramento fecha o incidente (não fica pendurada)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    const r = inc.observe({}, T0 + seg(150));
    expect(tipos(r)).toEqual(["fechar:camera"]);
    expect(inc.abertos(T0 + seg(150))).toEqual([]);
  });

  it("veredito ausente/vazio não lança e não inventa incidente", () => {
    const inc = createHealthIncidents(CFG);
    expect(inc.observe(undefined, T0).acoes).toEqual([]);
    expect(inc.observe({}, T0).acoes).toEqual([]);
    expect(inc.observe({ cam1: null }, T0).acoes).toEqual([]);
  });

  it("o rótulo legível chega na ação (o texto do WhatsApp precisa dele)", () => {
    const inc = createHealthIncidents(CFG);
    const rotulo = (id) => (id === "cam1" ? "Doca 3" : id);
    inc.observe({ cam1: doente("sem-video") }, T0, rotulo);
    const r = inc.observe({ cam1: doente("sem-video") }, T0 + seg(121), rotulo);
    expect(r.acoes[0].rotulo).toBe("Doca 3");
  });

  it("estado desconhecido é tratado como saudável (não inventa incidente por typo)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: { estado: "estado-que-nao-existe" } }, T0);
    expect(inc.observe({ cam1: { estado: "estado-que-nao-existe" } }, T0 + seg(300)).acoes).toEqual([]);
  });

  it("reset limpa tudo (usado no shutdown/reinício do motor)", () => {
    const inc = createHealthIncidents(CFG);
    inc.observe({ cam1: doente("sem-video") }, T0);
    inc.observe({ cam1: doente("sem-video") }, T0 + seg(121));
    inc.reset();
    expect(inc.abertos(T0 + seg(200))).toEqual([]);
  });
});

// ── O TEXTO QUE O OPERADOR LÊ ────────────────────────────────────────────────────────────────
// Mensagem de alarme sem NÚMERO é opinião: quem recebe às 3h precisa saber o que quebrou, onde,
// há quanto tempo, e se é uma câmera ou a frota. Estes testes travam isso como contrato, e
// travam também o marcador "⚠" — é ele que a taxonomia (alarm/classify) lê como CRÍTICO e o que
// leva o alarme a "critical" na priorização; perder o marcador rebaixaria o alarme em silêncio.
describe("textoDoIncidente — o que chega no WhatsApp", () => {
  const engine = require("./engine");
  const { textoDoIncidente } = engine;

  it("abrir por câmera: marcador crítico + rótulo legível + o número que sustenta", () => {
    const t = textoDoIncidente({
      tipo: "abrir",
      escopo: "camera",
      rotulo: "Doca 3",
      estado: "sem-video",
      motivo: "nenhum frame há 45s",
    });
    expect(t).toContain("⚠");
    expect(t).toContain("Doca 3");
    expect(t).toContain("sem vídeo");
    expect(t).toContain("nenhum frame há 45s");
  });

  it("renotificar diz HÁ QUANTO TEMPO (senão o operador não sabe se é novo)", () => {
    const t = textoDoIncidente({
      tipo: "renotificar",
      escopo: "camera",
      rotulo: "Doca 3",
      estado: "ia-parada",
      duracaoMs: 2 * 60 * 60_000,
    });
    expect(t).toMatch(/AINDA/);
    expect(t).toContain("2.0h");
  });

  it("fechar avisa a normalização com a duração total (fecha o ciclo p/ quem foi acordado)", () => {
    const t = textoDoIncidente({
      tipo: "fechar",
      escopo: "camera",
      rotulo: "Doca 3",
      estado: "sem-video",
      duracaoMs: 5 * 60_000,
    });
    expect(t).toContain("normalizada");
    expect(t).toContain("5min");
    expect(t).not.toContain("⚠"); // recuperação NÃO é crítico
  });

  it("agravar deixa claro que PIOROU (é o mesmo incidente, não um novo)", () => {
    const t = textoDoIncidente({
      tipo: "agravar",
      escopo: "camera",
      rotulo: "Doca 3",
      estado: "sem-video",
    });
    expect(t).toContain("PIOROU");
    expect(t).toContain("⚠");
  });

  it("frota: diz QUANTAS câmeras e aponta causa ÚNICA (é o anti-enxurrada em texto)", () => {
    const t = textoDoIncidente({
      tipo: "abrir",
      escopo: "frota",
      estado: "ia-atrasada",
      cameras: new Array(16).fill("x"),
    });
    expect(t).toContain("16 câmeras");
    expect(t).toContain("análise atrasada");
    expect(t).toMatch(/causa prov[áa]vel [ÚU]NICA/);
  });

  it("sem rótulo cai no id da câmera (nunca sai mensagem sem alvo)", () => {
    const t = textoDoIncidente({ tipo: "abrir", escopo: "camera", cameraId: "cam-abc", estado: "ia-parada" });
    expect(t).toContain("cam-abc");
  });

  it("duração é legível em s/min/h (não despeja milissegundos no operador)", () => {
    const f = (ms) =>
      textoDoIncidente({ tipo: "fechar", escopo: "camera", rotulo: "c", estado: "sem-video", duracaoMs: ms });
    expect(f(45_000)).toContain("45s");
    expect(f(10 * 60_000)).toContain("10min");
    expect(f(3 * 60 * 60_000)).toContain("3.0h");
  });
});
