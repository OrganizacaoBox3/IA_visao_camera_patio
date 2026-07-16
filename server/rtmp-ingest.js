// RELAY de ingest RTMP → HTTP-FLV local. Substitui o listener RTMP do go2rtc, cujo probe
// (pkg/flv/producer.go) exige sequence header formal em ≤5s e só aceita "hvc1" no caminho
// enhanced-RTMP — o push do DVR Intelbras MHDX chegava com bytes mas nunca ganhava tracks
// (spec: docs/analises/rtmp-ingest/spec-relay-ingest.md). Este relay NÃO interpreta codec:
// aceita o publish, repassa as tags FLV verbatim por HTTP local (127.0.0.1), e quem faz o
// parse é o ffmpeg (fonte "ffmpeg:…#video=copy" do canal no go2rtc) — o mesmo parser que
// comprovadamente decodifica esse DVR. Zero dependências: node:net + node:http.
//
// SEGURANÇA/LIMITES (a :1935 é pública gated por firewall; o publish RTMP não tem auth):
//  · nome de canal validado por regex estrita (o mesmo contrato do rtmp-auto-enroll);
//  · mensagem RTMP ≤ MAX_MSG (keyframe 4K cabe; scanner não infla memória);
//  · sessões simultâneas ≤ MAX_SESSIONS; timeout de socket derruba publisher mudo;
//  · HTTP-FLV amarrado a 127.0.0.1; consumidor lento (buffer alto) é derrubado;
//  · LGPD (ADR-002): tudo efêmero em memória — cache = metadata + sequence headers (KBs).

const net = require("node:net");
const http = require("node:http");
const { EventEmitter } = require("node:events");

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const MAX_MSG = 8 * 1024 * 1024; // 8 MB por mensagem RTMP (keyframe grande cabe com folga)
const MAX_SESSIONS = 64;
const SOCKET_TIMEOUT_MS = 60_000; // publisher sem NENHUM byte por 60s = morto
const CONSUMER_HIGH_WATER = 16 * 1024 * 1024; // consumidor HTTP atrasado além disto cai

// ── AMF0 (só o que o handshake de publish usa) ───────────────────────────────────────────────
// Leitura: number(0x00), boolean(0x01), string(0x02), object(0x03), null(0x05), undefined(0x06),
// ECMA array(0x08), fim de objeto(0x09), long string(0x0C). Suficiente para connect/publish de
// DVRs/OBS/ffmpeg. Qualquer tipo desconhecido aborta a leitura (devolve o que já decodificou).
function amfDecode(buf) {
  const items = [];
  let o = 0;
  const str16 = () => {
    const n = buf.readUInt16BE(o);
    o += 2;
    const s = buf.toString("utf8", o, o + n);
    o += n;
    return s;
  };
  const one = () => {
    const t = buf[o++];
    switch (t) {
      case 0x00: {
        const v = buf.readDoubleBE(o);
        o += 8;
        return v;
      }
      case 0x01:
        return buf[o++] !== 0;
      case 0x02:
        return str16();
      case 0x03:
      case 0x08: {
        if (t === 0x08) o += 4; // ECMA array: count u32 (ignorado; termina em 0x000009 como objeto)
        const obj = {};
        for (;;) {
          if (o + 3 <= buf.length && buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 0x09) {
            o += 3;
            return obj;
          }
          const k = str16();
          const v = one();
          if (v === STOP) return obj;
          obj[k] = v;
        }
      }
      case 0x05:
      case 0x06:
        return null;
      case 0x0c: {
        const n = buf.readUInt32BE(o);
        o += 4;
        const s = buf.toString("utf8", o, o + n);
        o += n;
        return s;
      }
      default:
        return STOP; // tipo não suportado — para a leitura sem lançar
    }
  };
  const STOP = Symbol("amf-stop");
  try {
    while (o < buf.length) {
      const v = one();
      if (v === STOP) break;
      items.push(v);
    }
  } catch {
    /* payload truncado/malformado — usa o que deu */
  }
  return items;
}

// Escrita: só number/string/null/objeto raso — o suficiente para _result/onStatus.
function amfEncode(...items) {
  const parts = [];
  const pushStr16 = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    parts.push(len, b);
  };
  for (const v of items) {
    if (typeof v === "number") {
      const b = Buffer.alloc(9);
      b[0] = 0x00;
      b.writeDoubleBE(v, 1);
      parts.push(b);
    } else if (typeof v === "string") {
      parts.push(Buffer.from([0x02]));
      pushStr16(v);
    } else if (v === null || v === undefined) {
      parts.push(Buffer.from([0x05]));
    } else if (typeof v === "object") {
      parts.push(Buffer.from([0x03]));
      for (const [k, val] of Object.entries(v)) {
        pushStr16(k);
        if (typeof val === "number") {
          const b = Buffer.alloc(9);
          b[0] = 0x00;
          b.writeDoubleBE(val, 1);
          parts.push(b);
        } else {
          parts.push(Buffer.from([0x02]));
          pushStr16(String(val));
        }
      }
      parts.push(Buffer.from([0x00, 0x00, 0x09]));
    }
  }
  return Buffer.concat(parts);
}

// ── Montagem de tag FLV ──────────────────────────────────────────────────────────────────────
const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 0, 0, 0, 0, 9]); // "FLV" v1 flags=0 (ffmpeg descobre pelas tags)

function flvTag(tagType, timeMS, payload) {
  const b = Buffer.alloc(11 + payload.length + 4);
  b[0] = tagType;
  b.writeUIntBE(payload.length, 1, 3);
  b.writeUIntBE(timeMS & 0xffffff, 4, 3);
  b[7] = (timeMS >>> 24) & 0xff;
  // stream id (3 bytes) = 0
  payload.copy(b, 11);
  b.writeUInt32BE(11 + payload.length, 11 + payload.length); // previous tag size
  return b;
}

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_DATA = 18;

// É sequence header? (o que precisa ser reapresentado a consumidor que chega no meio)
function isVideoSeqHeader(p) {
  if (p.length < 2) return false;
  if (p[0] & 0x80) return (p[0] & 0x0f) === 0; // enhanced RTMP: PacketTypeSequenceStart
  const codecId = p[0] & 0x0f;
  return (codecId === 7 || codecId === 12) && p[1] === 0; // AVC/HEVC legacy header
}
function isAudioSeqHeader(p) {
  return p.length >= 2 && p[0] >> 4 === 10 && p[1] === 0; // AAC sequence header
}

// Publishers mandam "@setDataFrame","onMetaData",{...}; a tag FLV correta começa em "onMetaData".
const SET_DATA_FRAME = Buffer.from([0x02, 0x00, 0x0d]); // string AMF0 "@setDataFrame" (prefixo)
function stripSetDataFrame(p) {
  if (p.length > 16 && p.slice(0, 3).equals(SET_DATA_FRAME) && p.slice(3, 16).toString() === "@setDataFrame") {
    return p.slice(16);
  }
  return p;
}

// ── Sessão RTMP (um publisher) ───────────────────────────────────────────────────────────────
// Parser incremental por socket: handshake C0/C1/C2 → mensagens em chunks (fmt 0-3, extended
// timestamp, SetChunkSize do cliente) → comandos AMF respondidos → tags de mídia repassadas.
// Referência de comportamento: pkg/rtmp do go2rtc (o MHDX conversa com esse dialeto — chega ao
// publish e envia mídia; só o probe de codec falhava) + node-media-server para os timestamps.
class RtmpSession {
  constructor(socket, relay) {
    this.socket = socket;
    this.relay = relay;
    this.buf = Buffer.alloc(0);
    this.stage = "c0c1"; // c0c1 → c2 → messages
    this.rdChunkSize = 128;
    this.wrChunkSize = 4096;
    this.chunks = new Map(); // csid → {ts, delta, size, type, extTs, remaining, parts}
    this.app = "";
    this.name = null; // definido no publish (sessão registrada no relay)
    this.alive = true;

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => this.destroy("timeout"));
    socket.on("data", (d) => this.onData(d));
    socket.on("error", () => this.destroy("socket error"));
    socket.on("close", () => this.destroy("close"));
  }

  destroy(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.socket.destroy();
    if (this.name) this.relay._endSession(this.name, this, reason);
  }

  onData(d) {
    if (!this.alive) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    try {
      this.drain();
    } catch (e) {
      this.relay.log(`[rtmp-ingest] sessão derrubada (${e.message})`);
      this.destroy("parse error");
    }
  }

  drain() {
    for (;;) {
      if (this.stage === "c0c1") {
        if (this.buf.length < 1 + 1536) return;
        if (this.buf[0] !== 3) throw new Error("handshake: versão != 3");
        const c1 = this.buf.slice(1, 1537);
        this.buf = this.buf.slice(1537);
        // S0 + S1 (ts + zero + random) + S2 (eco do C1) — handshake simples, igual ao go2rtc
        const s1 = Buffer.alloc(1536);
        s1.writeUInt32BE(Date.now() >>> 0 & 0x7fffffff, 0);
        this.socket.write(Buffer.concat([Buffer.from([3]), s1, c1]));
        this.stage = "c2";
      } else if (this.stage === "c2") {
        if (this.buf.length < 1536) return;
        this.buf = this.buf.slice(1536);
        this.stage = "messages";
        this.writeMessage(2, 1, 0, (() => {
          const b = Buffer.alloc(4);
          b.writeUInt32BE(this.wrChunkSize);
          return b;
        })()); // Set Chunk Size nosso
      } else if (!this.readChunk()) {
        return;
      }
    }
  }

  // Lê UM chunk do buffer; false = precisa de mais bytes. Mensagem completa → handleMessage.
  // INVARIANTE (comprado com bug): nada de estado é mutado nem byte consumido antes de o chunk
  // INTEIRO (header + payload) estar no buffer — o header de um keyframe chega às vezes num
  // segmento TCP sozinho, e um parse parcial re-entrante viraria desalinhamento permanente.
  readChunk() {
    const buf = this.buf;
    if (buf.length < 1) return false;
    let o = 0;
    const fmt = buf[0] >> 6;
    let csid = buf[0] & 0x3f;
    o = 1;
    if (csid === 0) {
      if (buf.length < 2) return false;
      csid = 64 + buf[1];
      o = 2;
    } else if (csid === 1) {
      if (buf.length < 3) return false;
      csid = 64 + buf[1] + buf[2] * 256;
      o = 3;
    }

    let st = this.chunks.get(csid);
    if (!st) {
      st = { ts: 0, delta: 0, size: 0, type: 0, extTs: false, remaining: 0, parts: [] };
      this.chunks.set(csid, st);
    }

    const midMessage = st.remaining > 0;
    // 1ª passada: só LÊ (em locais), sem tocar em st nem em this.buf
    let size = st.size;
    let type = st.type;
    let ts = st.ts;
    let delta = st.delta;
    let extTs = st.extTs;
    if (!midMessage) {
      const hdrLen = fmt === 0 ? 11 : fmt === 1 ? 7 : fmt === 2 ? 3 : 0;
      if (buf.length < o + hdrLen) return false;
      let rawTime = 0;
      if (fmt <= 2) rawTime = buf.readUIntBE(o, 3);
      if (fmt <= 1) {
        size = buf.readUIntBE(o + 3, 3);
        type = buf[o + 6];
      }
      o += hdrLen;
      extTs = fmt <= 2 && rawTime === 0xffffff;
      if (extTs) {
        if (buf.length < o + 4) return false;
        rawTime = buf.readUInt32BE(o);
        o += 4;
      }
      if (fmt === 0) {
        ts = rawTime;
        delta = 0;
      } else if (fmt === 1 || fmt === 2) {
        delta = rawTime;
        ts += rawTime;
      } else {
        ts += delta; // fmt 3 como início de mensagem: repete o delta anterior
      }
      if (size > MAX_MSG) throw new Error(`mensagem RTMP acima do teto (${size} bytes)`);
    } else if (extTs) {
      // Continuação (fmt 3) de mensagem grande: alguns encoders repetem o extended timestamp
      if (buf.length < o + 4) return false;
      o += 4;
    }

    const remaining = midMessage ? st.remaining : size;
    const chunkLen = Math.min(remaining, this.rdChunkSize);
    if (buf.length - o < chunkLen) return false;

    // 2ª passada: chunk inteiro disponível — COMITA estado e consome
    st.size = size;
    st.type = type;
    st.ts = ts;
    st.delta = delta;
    st.extTs = extTs;
    if (!midMessage) st.parts = [];
    st.parts.push(buf.slice(o, o + chunkLen));
    st.remaining = remaining - chunkLen;
    this.buf = buf.slice(o + chunkLen);

    if (st.remaining === 0) {
      const payload = st.parts.length === 1 ? st.parts[0] : Buffer.concat(st.parts);
      st.parts = [];
      this.handleMessage(st.type, st.ts, payload);
    }
    return true;
  }

  handleMessage(type, timeMS, payload) {
    switch (type) {
      case 1: // Set Chunk Size do cliente
        if (payload.length >= 4) {
          const n = payload.readUInt32BE(0) & 0x7fffffff;
          if (n > 0 && n <= MAX_MSG) this.rdChunkSize = n;
        }
        return;
      case 20: // comando AMF0
        return this.handleCommand(amfDecode(payload));
      case 8:
      case 9:
      case 18: {
        if (!this.name) return; // mídia antes do publish — ignora
        const p = type === TAG_DATA ? stripSetDataFrame(payload) : payload;
        if (p.length === 0) return;
        this.relay._media(this.name, type, timeMS, p);
        return;
      }
      default:
        return; // ack/window/user control/AMF3 — irrelevantes para ingest (o MHDX publica sem acks)
    }
  }

  handleCommand(items) {
    const [cmd, tID] = items;
    if (typeof cmd !== "string") return;
    switch (cmd) {
      case "connect": {
        if (items[2] && typeof items[2] === "object") this.app = String(items[2].app || "");
        this.writeCommand(
          amfEncode("_result", typeof tID === "number" ? tID : 1, { fmsVer: "FMS/3,0,1,123" }, { code: "NetConnection.Connect.Success" }),
        );
        return;
      }
      case "releaseStream": {
        if (!this.app && typeof items[3] === "string") this.app = items[3];
        this.writeCommand(amfEncode("_result", typeof tID === "number" ? tID : 0, null));
        return;
      }
      case "FCPublish":
        return; // sem resposta (igual go2rtc)
      case "createStream": {
        this.writeCommand(amfEncode("_result", typeof tID === "number" ? tID : 0, null, 1));
        return;
      }
      case "publish": {
        // Nome do canal: app do connect (semântica do go2rtc, comprovada com o MHDX);
        // fallback: stream key do publish. Barra/esquisitice cai na validação estrita.
        const key = typeof items[3] === "string" ? items[3] : "";
        const name = (this.app || key).replace(/^\/+|\/+$/g, "");
        if (!NAME_RE.test(name)) {
          this.relay.log(`[rtmp-ingest] publish recusado: nome fora do contrato (${JSON.stringify(name).slice(0, 48)})`);
          this.destroy("nome inválido");
          return;
        }
        if (!this.relay._startSession(name, this)) {
          this.destroy("sem vaga");
          return;
        }
        this.name = name;
        this.writeCommand(amfEncode("onStatus", 0, null, { code: "NetStream.Publish.Start" }));
        return;
      }
      default:
        return; // comandos desconhecidos são ignorados em silêncio
    }
  }

  writeCommand(payload) {
    this.writeMessage(3, 20, 0, payload);
  }

  writeMessage(csid, type, timeMS, payload) {
    if (!this.alive) return;
    const parts = [];
    const hdr = Buffer.alloc(12);
    hdr[0] = csid & 0x3f;
    hdr.writeUIntBE(timeMS & 0xffffff, 1, 3);
    hdr.writeUIntBE(payload.length, 4, 3);
    hdr[7] = type;
    hdr.writeUInt32LE(1, 8); // message stream id = 1 (little endian)
    parts.push(hdr);
    for (let i = 0; i < payload.length; i += this.wrChunkSize) {
      if (i > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)]));
      parts.push(payload.slice(i, i + this.wrChunkSize));
    }
    this.socket.write(Buffer.concat(parts));
  }
}

// ── Relay (sessões + consumidores HTTP-FLV) ──────────────────────────────────────────────────
class RtmpRelay extends EventEmitter {
  constructor({ log = console.log } = {}) {
    super();
    this.log = log;
    this.sessions = new Map(); // name → {session, metadata, videoSeq, audioSeq, consumers:Set}
  }

  _startSession(name, session) {
    if (this.sessions.size >= MAX_SESSIONS && !this.sessions.has(name)) {
      this.log(`[rtmp-ingest] CAP de ${MAX_SESSIONS} sessões atingido — publish em "${name}" recusado`);
      return false;
    }
    const old = this.sessions.get(name);
    if (old) {
      // Republish substitui a sessão (DVR re-conectando após queda não fica preso a socket morto)
      this.log(`[rtmp-ingest] publish repetido em "${name}" — substituindo a sessão anterior`);
      const consumers = old.consumers; // consumidores migram para a sessão nova
      old.consumers = new Set();
      old.session.name = null; // impede o destroy antigo de derrubar a entrada nova
      old.session.destroy("substituída");
      this.sessions.set(name, { session, metadata: null, videoSeq: [], audioSeq: null, consumers });
    } else {
      this.sessions.set(name, { session, metadata: null, videoSeq: [], audioSeq: null, consumers: new Set() });
    }
    this.log(`[rtmp-ingest] publish aceito no canal "${name}" (${this.sessions.size} sessão(ões) ativa(s))`);
    this.emit("publish", name);
    return true;
  }

  _endSession(name, session, reason) {
    const s = this.sessions.get(name);
    if (!s || s.session !== session) return;
    this.sessions.delete(name);
    this.log(`[rtmp-ingest] publish encerrado no canal "${name}" (${reason})`);
    for (const res of s.consumers) res.end();
    s.consumers.clear();
  }

  _media(name, tagType, timeMS, payload) {
    const s = this.sessions.get(name);
    if (!s) return;

    // Cache do que um consumidor tardio precisa ver primeiro (tudo pequeno, KBs)
    if (tagType === TAG_DATA) {
      if (payload.includes("onMetaData")) s.metadata = payload;
    } else if (tagType === TAG_VIDEO && isVideoSeqHeader(payload)) {
      s.videoSeq = [payload]; // o mais recente vence (troca de resolução re-publica o header)
    } else if (tagType === TAG_AUDIO && isAudioSeqHeader(payload)) {
      s.audioSeq = payload;
    }

    if (s.consumers.size === 0) return;
    const tag = flvTag(tagType, timeMS, payload);
    for (const res of s.consumers) {
      if (res.socket && res.socket.writableLength > CONSUMER_HIGH_WATER) {
        this.log(`[rtmp-ingest] consumidor lento no canal "${name}" — derrubado`);
        s.consumers.delete(res);
        res.destroy();
        continue;
      }
      res.write(tag);
    }
  }

  // GET /<name>.flv — FLV header + cache (metadata/seq headers) + tags ao vivo.
  handleHttp(req, res) {
    const m = /^\/([A-Za-z0-9_-]{1,32})\.flv$/.exec(String(req.url).split("?")[0]);
    if (!m || req.method !== "GET") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("canal não encontrado");
      return;
    }
    const s = this.sessions.get(m[1]);
    if (!s) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("sem publisher ativo");
      return;
    }
    res.writeHead(200, { "content-type": "video/x-flv", connection: "close" });
    res.write(FLV_HEADER);
    res.write(Buffer.from([0, 0, 0, 0])); // previous tag size 0
    if (s.metadata) res.write(flvTag(TAG_DATA, 0, s.metadata));
    for (const v of s.videoSeq) res.write(flvTag(TAG_VIDEO, 0, v));
    if (s.audioSeq) res.write(flvTag(TAG_AUDIO, 0, s.audioSeq));
    s.consumers.add(res);
    req.on("close", () => s.consumers.delete(res));
  }

  activeChannels() {
    return [...this.sessions.keys()];
  }
}

/**
 * Sobe o relay: listener RTMP público (firewall por IP é a defesa — runbook) + HTTP-FLV local.
 * @param {object} opts
 * @param {number} [opts.rtmpPort=1935]
 * @param {number} [opts.httpPort=8935]  — SEMPRE amarrado a 127.0.0.1
 * @param {(msg: string) => void} [opts.log]
 * @returns {{relay: RtmpRelay, close: () => void}}
 */
function startRtmpIngest({ rtmpPort = 1935, httpPort = 8935, log = console.log } = {}) {
  const relay = new RtmpRelay({ log });

  const tcp = net.createServer((socket) => {
    socket.setNoDelay(true);
    new RtmpSession(socket, relay);
  });
  tcp.on("error", (e) => log(`[rtmp-ingest] listener RTMP falhou: ${e.message}`));
  tcp.listen(rtmpPort, () => log(`[rtmp-ingest] RTMP escutando em :${rtmpPort} (publish → HTTP-FLV local :${httpPort})`));

  const web = http.createServer((req, res) => relay.handleHttp(req, res));
  web.on("error", (e) => log(`[rtmp-ingest] HTTP-FLV falhou: ${e.message}`));
  web.listen(httpPort, "127.0.0.1");

  return {
    relay,
    close: () => {
      tcp.close();
      web.close();
      for (const name of relay.activeChannels()) {
        const s = relay.sessions.get(name);
        if (s) s.session.destroy("shutdown");
      }
    },
  };
}

module.exports = { startRtmpIngest, RtmpRelay, amfDecode, amfEncode, flvTag, NAME_RE };
