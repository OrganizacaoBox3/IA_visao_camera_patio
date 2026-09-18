// ─────────────────────────────────────────────────────────────────────────────
// camera-bg.js — IMAGEM DE REFERÊNCIA por câmera (ADR-021).
//
// O QUE É, e principalmente o que NÃO É. Isto guarda UM arquivo de imagem por câmera, ENVIADO
// POR UM HUMANO (superadmin), para servir de fundo ao desenho de zonas que o cliente vê. Não
// existe, e não pode passar a existir, nenhum caminho que capture isto do feed: o ADR-002
// continua valendo inteiro para o pipeline — frame é efêmero em memória, no relé e no motor.
//
// A diferença que o ADR-021 decide: frame do pipeline é dado pessoal por construção (contínuo,
// automático, ninguém olhou antes de salvar). Arquivo escolhido por um admin avisado na tela é
// material de referência do local, como uma planta baixa. Se alguém subir uma foto com gente
// dentro, a responsabilidade é de quem subiu — o sistema avisa e não tem como impedir, do mesmo
// jeito que não impede escrever um CPF no rótulo de uma zona.
//
// Mora no diretório de ESTADO (o volume), fora do código e no .gitignore — como todo estado de
// runtime. Uma por câmera: o upload SUBSTITUI, nunca acumula.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { statePath } = require("./state-dir");

const DIR = statePath("camera-bg");

/** Teto de tamanho. 2 MB cobre com folga uma foto de galpão ou uma planta; acima disso é
 *  alguém subindo o original da câmera sem redimensionar, e o cliente pagaria no carregamento. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Tipos aceitos → extensão. Allowlist, nunca denylist: formato fora desta lista não entra,
 *  e a extensão sai DAQUI (nunca do nome do arquivo enviado, que é entrada do usuário). */
const TIPOS = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

/** Assinatura dos bytes ("magic number") por extensão. O `content-type` é declarado por quem
 *  envia e pode mentir; os primeiros bytes, não. Sem isto, um .exe renomeado passaria pelo
 *  tipo e ficaria servido pelo nosso domínio. */
const ASSINATURAS = {
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) =>
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  // WEBP = "RIFF" .... "WEBP"
  webp: (b) =>
    b.length > 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP",
};

/** Id de câmera seguro para virar NOME DE ARQUIVO. `cameraId` vem da URL: sem esta checagem,
 *  um "../../users" viraria escrita fora do diretório de estado (path traversal). */
const ID_OK = /^[\w-]{1,64}$/;

const arquivoDe = (cameraId, ext) => path.join(DIR, `${cameraId}.${ext}`);

/** Extensões possíveis, para achar/apagar a imagem sem saber o formato que foi salvo. */
const EXTS = Object.values(TIPOS);

/**
 * Valida um upload ANTES de tocar o disco. PURA (não escreve, não lê) — é o que permite
 * testá-la sem sistema de arquivos.
 * @returns {{ok:true, ext:string} | {ok:false, erro:string}}
 */
function validar(cameraId, contentType, bytes) {
  if (!ID_OK.test(String(cameraId || ""))) return { ok: false, erro: "câmera inválida" };
  const tipo = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = TIPOS[tipo];
  if (!ext) return { ok: false, erro: "formato não aceito (use JPEG, PNG ou WebP)" };
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, erro: "arquivo vazio" };
  if (bytes.length > MAX_BYTES)
    return { ok: false, erro: `imagem acima de ${Math.round(MAX_BYTES / 1024 / 1024)} MB` };
  // O tipo DECLARADO tem de bater com os BYTES — ver ASSINATURAS.
  if (!ASSINATURAS[ext](bytes))
    return { ok: false, erro: "o conteúdo do arquivo não confere com o formato declarado" };
  return { ok: true, ext };
}

/** Grava (substituindo a anterior, em qualquer formato). Devolve o metadado do que ficou. */
function salvar(cameraId, contentType, bytes) {
  const v = validar(cameraId, contentType, bytes);
  if (!v.ok) return { error: v.erro };
  fs.mkdirSync(DIR, { recursive: true });
  remover(cameraId); // uma por câmera: trocar de formato não pode deixar a antiga para trás
  fs.writeFileSync(arquivoDe(cameraId, v.ext), bytes);
  return { ok: true, ...info(cameraId) };
}

/** Caminho + metadados da imagem da câmera, ou `null` quando não há. */
function info(cameraId) {
  if (!ID_OK.test(String(cameraId || ""))) return null;
  for (const ext of EXTS) {
    const p = arquivoDe(cameraId, ext);
    try {
      const st = fs.statSync(p);
      // `enviadoEm` vai para a tela: fundo envelhece em silêncio (um layout que mudou deixa a
      // imagem mentindo sobre o lugar, e nada avisa) — a data é o que permite desconfiar.
      return { cameraId, ext, bytes: st.size, enviadoEm: st.mtimeMs, caminho: p };
    } catch {
      /* próximo formato */
    }
  }
  return null;
}

/** Bytes da imagem (ou `null`). Quem chama responde o `content-type` a partir de `info().ext`. */
function ler(cameraId) {
  const i = info(cameraId);
  if (!i) return null;
  try {
    return fs.readFileSync(i.caminho);
  } catch {
    return null;
  }
}

/** Apaga a imagem da câmera (qualquer formato). Idempotente. */
function remover(cameraId) {
  if (!ID_OK.test(String(cameraId || ""))) return { error: "câmera inválida" };
  let apagou = false;
  for (const ext of EXTS) {
    try {
      fs.unlinkSync(arquivoDe(cameraId, ext));
      apagou = true;
    } catch {
      /* não existia */
    }
  }
  return { ok: true, apagou };
}

/** `content-type` a devolver para uma extensão salva. */
function tipoDe(ext) {
  return Object.keys(TIPOS).find((t) => TIPOS[t] === ext) || "application/octet-stream";
}

module.exports = { validar, salvar, info, ler, remover, tipoDe, MAX_BYTES, TIPOS, DIR };
