// ─────────────────────────────────────────────────────────────────────────────
// frame-freeze.js — CÂMERA CONECTADA MAS COM A IMAGEM PARADA (2026-09-29).
//
// O caso que nenhum sinal de saúde pegava: o frame CHEGA (então não é "sem-video"), chega
// no ritmo certo (não é "video-instavel"), a IA roda em cima dele (não é "ia-parada") — e é
// SEMPRE O MESMO frame. DVR que trava e segue mandando a última imagem, encoder da câmera
// pendurado, câmera tampada/virada para a parede no escuro total. Na tela, parece uma cena
// vazia e tranquila; na verdade não estamos vendo nada. É o falso-OK mais caro do sistema:
// paga ingest + decode + inferência, e o número que sai é zero com cara de "ninguém passou".
//
// COMO: comparação de BYTES do JPEG com o anterior (Buffer.equals = memcmp, sub-ms). Sensor
// de câmera real tem RUÍDO — dois frames de uma cena parada de verdade NÃO saem byte a byte
// iguais. Bytes idênticos por minutos seguidos só acontecem quando a imagem não é mais de
// um sensor vivo. Não é heurística de "pouco movimento" (isso é o gate de movimento, e cena
// parada à noite é NORMAL) — é igualdade EXATA.
//
// RESIDUAL DECLARADO: codecs com GOP "inteligente" (H.264+/H.265+) podem repetir o quadro
// decodificado por alguns segundos numa cena estática — por isso o limiar é de MINUTOS
// (FRAME_FROZEN_MS, default 3 min), não de frames. Câmera no escuro TOTAL pode gerar JPEG
// idêntico (tudo preto comprime igual); o motivo na tela diz "congelada OU tampada/escura"
// — as duas são câmera que não vê nada, e as duas merecem alguém olhar.
//
// CUSTO: 1 referência de Buffer por câmera (o relé já segura o último frame) + 1 memcmp por
// frame. Mesmo caminho quente de health.observeFrame — O(1), sem alocação.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const FROZEN_MS = Math.max(30_000, Number(process.env.FRAME_FROZEN_MS) || 180_000);
// Frame mais velho que isto = a câmera parou de mandar (é "sem-video", não "congelada").
const FRESCO_MS = 15_000;

/** @typedef {{prev: Buffer, since: number, lastAt: number, iguais: number}} Entrada */

function asBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof ArrayBuffer) return Buffer.from(buf);
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}

function createFreezeTracker({ frozenMs = FROZEN_MS, frescoMs = FRESCO_MS } = {}) {
  /** @type {Map<string, Entrada>} */
  const cams = new Map();

  /** Registra a chegada de um frame. `since` = último instante em que a imagem MUDOU. */
  function observe(cameraId, rawBuf, now = Date.now()) {
    if (cameraId == null) return;
    const buf = asBuffer(rawBuf);
    if (!buf || !buf.length) return;
    const id = String(cameraId);
    const c = cams.get(id);
    if (!c) {
      cams.set(id, { prev: buf, since: now, lastAt: now, iguais: 0 });
      return;
    }
    if (c.prev.length === buf.length && c.prev.equals(buf)) {
      c.iguais += 1;
    } else {
      c.prev = buf;
      c.since = now;
      c.iguais = 0;
    }
    c.lastAt = now;
  }

  /**
   * Veredito da câmera. `congelada` só com frame FRESCO chegando (senão é sem-video) E
   * idêntico há ≥ frozenMs. `paradoMs` = há quanto tempo a imagem não muda (0 = mudou agora).
   * @returns {{congelada:boolean, paradoMs:number, iguais:number, fresco:boolean} | null}
   */
  function statusOf(cameraId, now = Date.now()) {
    const c = cams.get(String(cameraId));
    if (!c) return null;
    const fresco = now - c.lastAt <= frescoMs;
    const paradoMs = c.iguais > 0 ? Math.max(0, c.lastAt - c.since) : 0;
    return {
      congelada: fresco && c.iguais > 0 && paradoMs >= frozenMs,
      paradoMs,
      iguais: c.iguais,
      fresco,
    };
  }

  /** Esquece câmeras sem frame há muito (removidas do cadastro) — não segura Buffer à toa. */
  function prune(now = Date.now(), maxIdadeMs = 10 * 60_000) {
    for (const [id, c] of cams) if (now - c.lastAt > maxIdadeMs) cams.delete(id);
  }

  return { observe, statusOf, prune, size: () => cams.size };
}

// Instância do processo: o relé (index.js) e o pull do go2rtc (go2rtc-source.js) observam
// no MESMO tracker — uma câmera, um veredito, independente de por onde o frame chegou e de
// o motor de análise estar ligado (câmera congelada é falha de VÍDEO, não da IA).
const shared = createFreezeTracker();

module.exports = { createFreezeTracker, shared, FROZEN_MS, FRESCO_MS };
