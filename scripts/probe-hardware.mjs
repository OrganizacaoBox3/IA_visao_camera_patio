#!/usr/bin/env node
// Probe de capacidade do HARDWARE do hub — roda no SERVIDOR REAL do cliente e devolve os
// dados que decidem as alavancas de perf abertas (parecer de stack jul/2026):
//   • Nº de cores → recomenda ANALYSIS_WORKERS (o pool auto usa min(cores/2, câmeras)).
//   • AVX-512 VNNI presente? → decide se INT8 vale a pena (2-3× SÓ com VNNI; sem, costuma ficar +lento).
//   • GPU NVIDIA presente? → decide se vale um spike CUDA-EP (COM teste de paridade — DML/WebGPU já
//     reprovados por darem saída errada/crash nesta família D-FINE; nunca adotar EP às cegas).
// NÃO altera nada, NÃO baixa nada — só lê /proc/cpuinfo, os.*, e tenta `nvidia-smi -L`. Uso:
//   node scripts/probe-hardware.mjs   (ou: npm run probe)
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const line = () => console.log("─".repeat(64));

function cpuFlags() {
  // /proc/cpuinfo (Linux, o alvo de produção). Em outros SOs, degrada sem quebrar.
  try {
    const info = fs.readFileSync("/proc/cpuinfo", "utf8");
    const m = info.match(/^flags\s*:\s*(.+)$/m);
    return m ? new Set(m[1].split(/\s+/)) : null;
  } catch {
    return null;
  }
}
function physicalCores() {
  try {
    const info = fs.readFileSync("/proc/cpuinfo", "utf8");
    const ids = new Set();
    let cur = {};
    for (const ln of info.split("\n")) {
      if (ln.startsWith("physical id")) cur.pkg = ln.split(":")[1].trim();
      else if (ln.startsWith("core id")) cur.core = ln.split(":")[1].trim();
      else if (ln.trim() === "") {
        if (cur.pkg != null && cur.core != null) ids.add(`${cur.pkg}:${cur.core}`);
        cur = {};
      }
    }
    return ids.size || null;
  } catch {
    return null;
  }
}
function gpuNvidia() {
  try {
    const out = execSync("nvidia-smi -L", { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 })
      .toString()
      .trim();
    return out ? out.split("\n") : [];
  } catch {
    return null; // nvidia-smi ausente = sem GPU NVIDIA utilizável
  }
}
function ortVersion() {
  try {
    return req("onnxruntime-node/package.json").version;
  } catch {
    return "n/d";
  }
}

const cpus = os.cpus();
const logical = cpus.length;
const phys = physicalCores();
const model = cpus[0]?.model?.trim() || "desconhecido";
const flags = cpuFlags();
const totalGB = (os.totalmem() / 1024 ** 3).toFixed(1);
const gpu = gpuNvidia();

const hasAvx2 = flags?.has("avx2") ?? null;
const hasAvx512 = flags ? [...flags].some((f) => f.startsWith("avx512")) : null;
const hasVnni = flags ? flags.has("avx512_vnni") || flags.has("avx_vnni") : null;

line();
console.log(B("  PROBE DE HARDWARE DO HUB — visao_computacional_mvp"));
line();
console.log(`  SO/arch      : ${os.type()} ${os.release()} · ${os.arch()}`);
console.log(`  CPU          : ${model}`);
console.log(`  Cores        : ${logical} lógicos${phys ? ` · ${phys} físicos` : ""}`);
console.log(`  RAM total    : ${totalGB} GB`);
console.log(`  Node / ORT   : ${process.version} / onnxruntime-node ${ortVersion()}`);
console.log(
  `  Flags CPU    : AVX2=${fmt(hasAvx2)}  AVX-512=${fmt(hasAvx512)}  VNNI=${fmt(hasVnni)}` +
    (flags ? "" : "  (só lê em Linux; ignore fora de produção)"),
);
console.log(`  GPU NVIDIA   : ${gpu ? gpu.join("; ") : "nenhuma (nvidia-smi ausente)"}`);
line();
console.log(B("  RECOMENDAÇÕES (parecer de stack)"));
line();

// 1) Pool de workers
const rec = Math.max(1, Math.floor(logical / 2));
console.log(`  • ANALYSIS_WORKERS: o pool auto usa min(cores/2, câmeras) → ~${B(rec)} aqui`);
console.log(`      (deixe SEM setar p/ auto; só fixe se quiser reservar cores p/ outra carga)`);

// 2) INT8
console.log(`  • INT8 (quantização do D-FINE):`);
if (hasVnni === true)
  console.log(
    `      ${B("VALE MEDIR")} — há AVX-512 VNNI: INT8 QDQ costuma dar 2-3× throughput.\n` +
      `      Gere o .onnx int8 e rode 'npm run eval' (acurácia pode cair) + compare inferMs.`,
  );
else if (hasVnni === false)
  console.log(
    `      ${B("PROVAVELMENTE NÃO")} — sem VNNI, INT8 QDQ tende a ficar MAIS LENTO (medido: 7× no dev).\n` +
      `      Fique no FP32; o pool de workers já é a alavanca de throughput.`,
  );
else console.log(`      indeterminado (rode este probe NO servidor Linux p/ ler as flags).`);

// 3) GPU
console.log(`  • GPU / execution provider:`);
if (gpu && gpu.length)
  console.log(
    `      há GPU NVIDIA → vale um SPIKE CUDA-EP, mas ${B("COM teste de paridade de detecção")}\n` +
      `      (DML/WebGPU já deram saída errada/crash nesta família D-FINE — nunca adotar às cegas).`,
  );
else console.log(`      sem GPU NVIDIA → assunto GPU encerrado; CPU-EP é a escolha certa.`);
line();
console.log(`  Próximo: com estes números dá pra decidir INT8 e GPU. Rode 'npm run eval' p/ acurácia/inferMs.`);
line();

function fmt(v) {
  return v === true ? "sim" : v === false ? "não" : "?";
}
