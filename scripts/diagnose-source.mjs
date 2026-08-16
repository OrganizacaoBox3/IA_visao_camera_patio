// Diagnóstico de FONTE de vídeo — responde "chega em dia?", não "conecta?".
//
// Uso: node scripts/diagnose-source.mjs <rtsp://…|http(s)://…|arquivo> [segundos]
//      node scripts/diagnose-source.mjs <fonte> 12 --work-ms 64 --queue
//
// POR QUE ISTO EXISTE SEPARADO do `validate-streams.mjs`: aquele responde se a URL ABRE e qual
// a resolução. Quando a imagem "atrasa" no campo, essa resposta não separa câmera de rede de
// motor — e o atraso é o sintoma nº 1 que chega como "o modelo está ruim".
//
// O FENÔMENO QUE ESTE SCRIPT MEDE (portado de `inspecao_biscoito/fonte.py` do repo irmão
// `mvp_maos`, onde foi medido): **o buffer mente.** Se a fonte entrega mais quadros por segundo
// do que o consumidor processa, a fila cresce e o ATRASO CRESCE SEM LIMITE — lá, medido, o
// atraso subiu **+5,3 s em 12 s**; com descarte do quadro velho, ficou em 15–20 ms estáveis.
// O veredito sai sobre uma cena que já passou, e nada no sistema denuncia isso.
//
// COMO ELE MEDE: um consumidor SIMULADO gasta `--work-ms` por quadro (default 64 ms — o custo
// medido do D-FINE-S nesta casa, ver `docs/analises/comparativo-mvp-maos-2026-08-16.md` §2) e
// registra a IDADE do quadro que pegou (agora − instante em que aquele quadro chegou). Dois
// regimes, e a comparação entre eles é o ponto:
//   • default  = ÚLTIMO-VENCE (o que o motor faz): quadro intermediário morre, idade fica baixa.
//   • --queue  = enfileira tudo (o que o ffmpeg faz sozinho): se a fonte for mais rápida que o
//                consumidor, a idade CRESCE ao longo da janela. É o defeito, reproduzido.
//
// Saída relevante: idade mediana/p90 e a comparação 1ª metade × 2ª metade da janela.
// **Idade que cresce é fila** — e fila não se conserta lendo mais rápido, se conserta descartando.
//
// Códigos de saída: 0 = ok · 1 = fila detectada (idade crescendo) · 2 = erro de uso/fonte ·
//                   3 = ffmpeg ausente.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Reusa o resolvedor de binário e a REDAÇÃO de credencial do dono desses assuntos (server/rtsp.js
// — FFMPEG_PATH > PATH > locais comuns). Duplicar aqui seria uma segunda verdade sobre onde o
// ffmpeg mora, e a redação é controle de SEGURANÇA: a URL pode carregar usuário/senha.
const rtsp = require(resolve(AQUI, "..", "server", "rtsp.js"));
const FFMPEG = rtsp.ffmpegBin();
const redact = rtsp.redact;

// ── Argumentos (PURO — nada de process.exit fora do main; o módulo precisa ser IMPORTÁVEL
//    para que `vereditoFila`/`percentil`, que decidem o código de saída, tenham teste) ──
export function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const posicionais = argv.filter((a) => !a.startsWith("--"));
  const idxWork = argv.indexOf("--work-ms");
  return {
    fonte: posicionais[0],
    segundos: Number(posicionais[1]) > 0 ? Number(posicionais[1]) : 8,
    workMs: idxWork >= 0 && Number(argv[idxWork + 1]) >= 0 ? Number(argv[idxWork + 1]) : 64,
    enfileira: flags.has("--queue"),
  };
}

// ── ffmpeg: versão decide o NOME da opção de timeout ─────────────────────────
// Até o ffmpeg 5 era `-stimeout`; do 6 em diante é `-timeout`, e o antigo foi REMOVIDO. Passar
// os dois na linha de comando faz o ffmpeg abortar por opção desconhecida (diferente do OpenCV,
// que ignora). Então detecta-se a versão — é a mesma disciplina do guard de `-extension_picky`
// que já existe em `server/rtsp.js`. Sem timeout nenhum, fonte morta trava a abertura por 30 s.
function versaoFfmpeg() {
  try {
    const { execFileSync } = require("node:child_process");
    const saida = execFileSync(FFMPEG, ["-version"], { encoding: "utf8", timeout: 5000 });
    const m = saida.match(/ffmpeg version n?(\d+)\./i);
    return m ? Number(m[1]) : 0;
  } catch {
    return -1; // binário ausente/não executável
  }
}

const TIMEOUT_US = 5_000_000; // 5 s sem resposta: reconectar é melhor que esperar

/** Args do ffmpeg (PURO — contrato de teste, mesmo padrão do `inputArgs` de server/rtsp.js). */
export function montarArgs(fonte, major) {
  const ehRtsp = /^rtsps?:/i.test(fonte);
  return [
    "-nostats",
    "-loglevel",
    "error",
    // Baixa latência na entrada — mesmas flags do relé de produção (server/rtsp.js): sem estas o
    // demuxer segura 0,5–1,5 s ANTES do primeiro quadro sair, e essa idade é invisível a jusante.
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "500000",
    "-analyzeduration",
    "0",
    ...(ehRtsp
      ? [
          // TCP: por UDP o stream chega com bloco corrompido sob perda de pacote, e imagem
          // corrompida vira medição corrompida sem avisar ninguém.
          "-rtsp_transport",
          "tcp",
          major >= 6 ? "-timeout" : "-stimeout",
          String(TIMEOUT_US),
        ]
      : []),
    "-i",
    fonte,
    "-an",
    "-f",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];
}

// ── Estatística (pura — testável, e é o que o relatório consome) ─────────────
export function percentil(valores, p) {
  if (!valores.length) return 0;
  const v = [...valores].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

/**
 * Veredito de FILA: compara a idade média da 1ª metade das amostras com a da 2ª metade.
 * Fila é um fenômeno CUMULATIVO — ela não aparece na mediana (que a 1ª metade segura), aparece
 * na TENDÊNCIA. Por isso o critério é crescimento, não valor absoluto.
 */
export function vereditoFila(idades, { crescimentoMinMs = 250, fatorMin = 2 } = {}) {
  if (idades.length < 8) return { fila: false, motivo: "amostras insuficientes" };
  const meio = Math.floor(idades.length / 2);
  const media = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const inicio = media(idades.slice(0, meio));
  const fim = media(idades.slice(meio));
  const delta = fim - inicio;
  const fila = delta >= crescimentoMinMs && fim >= inicio * fatorMin;
  return { fila, inicio, fim, delta, motivo: fila ? "idade crescendo ao longo da janela" : "estável" };
}

// ── Extração de quadros do MJPEG (SOI ffd8 … EOI ffd9) ───────────────────────
function extrairQuadros(buf, aoQuadro) {
  let restante = buf;
  for (;;) {
    const ini = restante.indexOf("\xff\xd8", 0, "binary");
    if (ini < 0) return restante.length > 4 << 20 ? Buffer.alloc(0) : restante; // lixo: não cresce sem teto
    const fim = restante.indexOf("\xff\xd9", ini + 2, "binary");
    if (fim < 0) return restante.subarray(ini);
    aoQuadro(restante.subarray(ini, fim + 2));
    restante = restante.subarray(fim + 2);
  }
}

// ── Execução ─────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("diagnose-source.mjs")) {
  const { fonte: FONTE, segundos: SEGUNDOS, workMs: WORK_MS, enfileira: ENFILEIRA } = parseArgs(
    process.argv.slice(2),
  );
  if (!FONTE) {
    console.error("uso: node scripts/diagnose-source.mjs <rtsp://…|http(s)://…|arquivo> [segundos]");
    console.error("     [--work-ms N]  custo simulado por quadro (default 64 = D-FINE-S medido)");
    console.error("     [--queue]      enfileira em vez de descartar (reproduz o defeito)");
    process.exit(2);
  }
  const MAJOR = versaoFfmpeg();
  if (MAJOR < 0) {
    console.error(`ffmpeg não encontrado (tentado: ${FFMPEG}).`);
    console.error("  macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg");
    console.error("  ou defina FFMPEG_PATH=<caminho do ffmpeg>");
    process.exit(3);
  }

  console.log(`fonte: ${redact(FONTE)}`);
  console.log(
    `regime: ${ENFILEIRA ? "ENFILEIRA (reproduz o defeito)" : "último-vence (o que o motor faz)"}` +
      ` · consumidor simulado: ${WORK_MS} ms/quadro · janela: ${SEGUNDOS}s`,
  );

  const proc = spawn(FFMPEG, montarArgs(FONTE, MAJOR), { stdio: ["ignore", "pipe", "pipe"] });
  let erroFfmpeg = "";
  proc.stderr.on("data", (d) => {
    erroFfmpeg = redact(String(d)).trim().split("\n").pop() || erroFfmpeg;
  });
  proc.on("error", (e) => {
    console.error(`falha ao executar o ffmpeg: ${e.message}`);
    process.exit(3);
  });

  const t0 = Date.now();
  let sobra = Buffer.alloc(0);
  let lidos = 0;
  let descartados = 0;
  let primeiroEm = null;
  const chegadas = [];
  let ultimo = null; // { buf, t } — último-vence
  const fila = []; // { buf, t } — modo --queue

  proc.stdout.on("data", (chunk) => {
    sobra = extrairQuadros(Buffer.concat([sobra, chunk]), (quadro) => {
      const agora = Date.now();
      lidos++;
      if (primeiroEm === null) primeiroEm = agora - t0;
      chegadas.push(agora);
      if (ENFILEIRA) {
        fila.push({ buf: quadro, t: agora });
      } else {
        if (ultimo) descartados++;
        ultimo = { buf: quadro, t: agora };
      }
    });
  });

  const idades = [];
  let processados = 0;
  let parar = false;

  // Consumidor: gasta WORK_MS e então pega o quadro disponível, registrando a idade dele.
  // `await` de timer em vez de busy-loop — o objetivo é medir a fila, não competir com o ffmpeg.
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (!parar) {
      await espera(WORK_MS);
      const item = ENFILEIRA ? fila.shift() : ((x) => ((ultimo = null), x))(ultimo);
      if (!item) continue;
      processados++;
      idades.push(Date.now() - item.t);
    }
  })();

  setTimeout(() => {
    parar = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* já morreu */
    }
    relatar();
  }, SEGUNDOS * 1000);

  function relatar() {
    const dt = (Date.now() - t0) / 1000;
    console.log("");
    if (!lidos) {
      console.error(`NENHUM QUADRO em ${dt.toFixed(1)}s.`);
      if (erroFfmpeg) console.error(`  ffmpeg: ${erroFfmpeg}`);
      console.error("  Confira usuário/senha na URL, a porta (554 é o padrão) e se o perfil de");
      console.error("  stream está HABILITADO na câmera (na SEC110 o RTSP não vem ligado).");
      process.exit(2);
    }
    const intervalos = chegadas.slice(1).map((t, i) => t - chegadas[i]);
    const medIv = percentil(intervalos, 50);
    console.log(`  primeiro quadro em ${(primeiroEm / 1000).toFixed(2)}s`);
    console.log(
      `  intervalo entre quadros: mediana ${medIv} ms (p90 ${percentil(intervalos, 90)} ms)` +
        (medIv > 0 ? ` = ${(1000 / medIv).toFixed(1)} fps efetivos` : ""),
    );
    console.log(
      `  idade do quadro entregue: mediana ${percentil(idades, 50)} ms ` +
        `(p90 ${percentil(idades, 90)} ms)   <-- se CRESCER, há fila`,
    );
    const v = vereditoFila(idades);
    if (v.inicio !== undefined) {
      console.log(
        `  tendência: 1ª metade ${v.inicio.toFixed(0)} ms → 2ª metade ${v.fim.toFixed(0)} ms ` +
          `(${v.delta >= 0 ? "+" : ""}${v.delta.toFixed(0)} ms)`,
      );
    }
    console.log(
      `  ${lidos} lidos (${(lidos / dt).toFixed(1)}/s) | ${processados} processados ` +
        `(${(processados / dt).toFixed(1)}/s) | ${descartados} descartados por antiguidade`,
    );
    console.log("");
    if (v.fila) {
      console.log(`FILA DETECTADA — ${v.motivo}.`);
      console.log("  A fonte entrega mais rápido do que o consumidor processa e o atraso acumula.");
      console.log("  Não se conserta lendo mais rápido: conserta-se DESCARTANDO o quadro velho");
      console.log("  (é o que o motor faz — rode sem --queue para ver a diferença).");
      process.exit(1);
    }
    console.log(`Sem fila (${v.motivo}).`);
    process.exit(0);
  }
}
