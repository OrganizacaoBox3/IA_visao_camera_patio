// ─────────────────────────────────────────────────────────────────────────────
// automask-store.js — DECISÃO DO OPERADOR sobre uma célula da auto-máscara (automask.js).
//
// O QUE É: a auto-máscara já aprende sozinha "isto está parado há 10min, provável objeto
// fixo (manequim/foto/TV/boneco)" — ver automask.js. O que faltava é o operador poder
// CORRIGIR essa inferência com um clique, nos dois sentidos:
//   "É falso positivo" → confirma objeto fixo AGORA (não espera as janelas de confirmação
//                         estatística) e a supressão fica PINADA — nunca mais some sozinha.
//   "Está correto"     → confirma pessoa REAL (ex.: guarda que fica parado num posto) e a
//                         célula fica IMUNE à supressão automática, mesmo que a estatística
//                         volte a qualificar (o operador viu com os PRÓPRIOS olhos; o
//                         heurístico de imobilidade não pode overrulá-lo).
//
// Mora no diretório de ESTADO (o volume), fora do código e no .gitignore — como camcfg.json.
// Chave: cameraId → cell (índice do grid AM_COLS×AM_ROWS de automask.js) → decisão.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { statePath } = require("./state-dir");

const FILE = statePath("automask-decisions.json");
const DECISOES = new Set(["correto", "falsoPositivo"]);

function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // ausente/corrompido → sem decisões (automask.js volta ao comportamento puramente estatístico)
  }
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Escrita ATÔMICA (tmp+rename): decisão do operador não pode ficar meio-escrita.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Decisões desta câmera: `{ [cell]: { decision, em } }`. `{}` quando não há nenhuma. */
function decisionsFor(cameraId) {
  const all = loadAll();
  return (cameraId && all[String(cameraId)]) || {};
}

/**
 * Grava a decisão do operador para UMA célula. Valida ANTES de tocar o disco (mesmo padrão
 * de camera-bg.js) — célula fora do grid ou decisão fora do enum não pode virar override
 * silencioso que ninguém consegue explicar depois.
 * @returns {{ok:true}|{error:string}}
 */
function setDecision(cameraId, cell, decision) {
  if (!cameraId || typeof cameraId !== "string") return { error: "câmera inválida" };
  // `typeof` ANTES do `Number()`: null/[]/{} coagem para 0/NaN e um `null` de corpo malformado
  // não pode virar silenciosamente "célula 0" — é erro do cliente, não uma célula válida.
  if (typeof cell !== "number" && typeof cell !== "string") return { error: "célula inválida" };
  const c = Number(cell);
  if (!Number.isInteger(c) || c < 0) return { error: "célula inválida" };
  if (!DECISOES.has(decision)) return { error: "decisão inválida (use 'correto' ou 'falsoPositivo')" };
  const all = loadAll();
  const porCamera = all[cameraId] || (all[cameraId] = {});
  porCamera[String(c)] = { decision, em: Date.now() };
  saveAll(all);
  return { ok: true };
}

/** Desfaz a decisão (a célula volta a depender só da estatística de automask.js). */
function clearDecision(cameraId, cell) {
  const all = loadAll();
  const porCamera = all[cameraId];
  if (porCamera) {
    delete porCamera[String(cell)];
    saveAll(all);
  }
  return { ok: true };
}

module.exports = { decisionsFor, setDecision, clearDecision, FILE };
