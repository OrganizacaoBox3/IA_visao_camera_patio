// Gates do relay RTMP→HTTP-FLV (server/rtmp-ingest.js). O cliente de teste implementa o
// dialeto RTMP que o DVR/ffmpeg falam (handshake simples, chunking fmt0/fmt3, AMF0), publica
// tags de mídia e valida o FLV servido por HTTP — o caminho INTEIRO, por sockets reais.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import http from "node:http";
import { startRtmpIngest, amfDecode, amfEncode, flvTag } from "./rtmp-ingest";

const RTMP_PORT = 19351;
const HTTP_PORT = 19352;

// ── Cliente RTMP mínimo de teste ─────────────────────────────────────────────────────────────
function chunkMessage(csid, type, timeMS, payload, wrChunkSize = 4096) {
  const parts = [];
  const hdr = Buffer.alloc(12);
  hdr[0] = csid & 0x3f; // fmt 0
  hdr.writeUIntBE(timeMS & 0xffffff, 1, 3);
  hdr.writeUIntBE(payload.length, 4, 3);
  hdr[7] = type;
  hdr.writeUInt32LE(1, 8);
  parts.push(hdr);
  for (let i = 0; i < payload.length; i += wrChunkSize) {
    if (i > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)]));
    parts.push(payload.slice(i, i + wrChunkSize));
  }
  return Buffer.concat(parts);
}

function connectPublish({ app, publishKey = "", port = RTMP_PORT }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(1536)])); // C0 + C1
    });
    let buf = Buffer.alloc(0);
    let stage = "hs";
    const send = (payload) => sock.write(chunkMessage(3, 20, 0, payload));
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "hs" && buf.length >= 1 + 1536 + 1536) {
        buf = Buffer.alloc(0);
        stage = "cmd";
        sock.write(Buffer.alloc(1536)); // C2 (eco simplificado — o relay não valida conteúdo)
        // O cliente de teste usa chunk size de escrita 4096 — anuncia via Set Chunk Size
        const scs = Buffer.alloc(4);
        scs.writeUInt32BE(4096);
        sock.write(chunkMessage(2, 1, 0, scs));
        send(amfEncode("connect", 1, { app, tcUrl: `rtmp://127.0.0.1:${port}/${app}` }));
        send(amfEncode("releaseStream", 2, null, publishKey));
        send(amfEncode("FCPublish", 3, null, publishKey));
        send(amfEncode("createStream", 4, null));
        send(amfEncode("publish", 5, null, publishKey, "live"));
      } else if (stage === "cmd" && buf.toString("latin1").includes("NetStream.Publish.Start")) {
        stage = "pub";
        resolve({
          sock,
          // publica uma tag de mídia (type 8/9/18) com timestamp em ms
          tag: (type, timeMS, payload) => sock.write(chunkMessage(type === 9 ? 6 : type === 8 ? 4 : 5, type, timeMS, payload)),
          close: () => sock.destroy(),
        });
      }
    });
    sock.on("close", () => stage !== "pub" && reject(new Error("conexão fechada antes do Publish.Start")));
    setTimeout(() => stage !== "pub" && reject(new Error("timeout esperando Publish.Start")), 3000).unref();
  });
}

function fetchFlv(name, ms = 400) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: HTTP_PORT, path: `/${name}.flv` }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      const done = () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
      res.on("end", done);
      setTimeout(() => {
        req.destroy();
        done();
      }, ms).unref();
    });
    req.on("error", reject);
  });
}

// Varre as tags de um corpo FLV → [{type, timeMS, payload}]
function parseFlv(body) {
  expect(body.slice(0, 3).toString()).toBe("FLV");
  const tags = [];
  let o = 9 + 4; // header + prevTagSize0
  while (o + 11 <= body.length) {
    const type = body[o];
    const size = body.readUIntBE(o + 1, 3);
    const timeMS = body.readUIntBE(o + 4, 3) | (body[o + 7] << 24);
    if (o + 11 + size + 4 > body.length) break;
    tags.push({ type, timeMS, payload: body.slice(o + 11, o + 11 + size) });
    o += 11 + size + 4;
  }
  return tags;
}

const AVC_SEQ_HEADER = Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00, 0x01, 0x64, 0x00, 0x1f]); // keyframe+AVC, packetType 0
const AVC_NALU = Buffer.from([0x27, 0x01, 0x00, 0x00, 0x00, 0xaa, 0xbb]); // interframe, packetType 1
const METADATA = Buffer.concat([amfEncode("@setDataFrame", "onMetaData"), amfEncode({ width: 704 })]);

let ingest;
beforeAll(() => {
  ingest = startRtmpIngest({ rtmpPort: RTMP_PORT, httpPort: HTTP_PORT, log: () => {} });
});
afterAll(() => ingest.close());

describe("rtmp-ingest", () => {
  it("AMF0 ida-e-volta (o subconjunto do handshake de publish)", () => {
    const items = amfDecode(amfEncode("connect", 1, { app: "dydentro_cam05", tcUrl: "rtmp://x/y" }, null));
    expect(items[0]).toBe("connect");
    expect(items[1]).toBe(1);
    expect(items[2]).toEqual({ app: "dydentro_cam05", tcUrl: "rtmp://x/y" });
    expect(items[3]).toBeNull();
  });

  it("publish aceito emite evento com o nome do canal (app do connect, como o MHDX envia)", async () => {
    const seen = [];
    ingest.relay.on("publish", (n) => seen.push(n));
    const pub = await connectPublish({ app: "dydentro_cam05" });
    expect(seen).toContain("dydentro_cam05");
    pub.close();
  });

  it("FLV servido reapresenta metadata (sem @setDataFrame) + sequence header antes das tags vivas", async () => {
    const pub = await connectPublish({ app: "cam_hdr" });
    pub.tag(18, 0, METADATA);
    pub.tag(9, 0, AVC_SEQ_HEADER);
    pub.tag(9, 40, AVC_NALU);
    await new Promise((r) => setTimeout(r, 100));

    // Consumidor chega DEPOIS — precisa receber o cache primeiro (o joelho que quebrava o go2rtc)
    const flvPromise = fetchFlv("cam_hdr");
    await new Promise((r) => setTimeout(r, 50));
    pub.tag(9, 80, AVC_NALU);
    const { status, body } = await flvPromise;
    expect(status).toBe(200);
    const tags = parseFlv(body);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    expect(tags[0].type).toBe(18);
    expect(tags[0].payload[0]).toBe(0x02); // começa direto na string "onMetaData"
    expect(tags[0].payload.includes("onMetaData")).toBe(true);
    expect(tags[0].payload.includes("@setDataFrame")).toBe(false);
    expect(tags[1].type).toBe(9);
    expect(tags[1].payload.equals(AVC_SEQ_HEADER)).toBe(true);
    const live = tags.find((t) => t.timeMS === 80);
    expect(live).toBeTruthy();
    expect(live.payload.equals(AVC_NALU)).toBe(true);
    pub.close();
  });

  it("mensagem maior que o chunk size atravessa inteira (continuação fmt3)", async () => {
    const pub = await connectPublish({ app: "cam_big" });
    const big = Buffer.alloc(10_000, 0xab);
    big[0] = 0x27;
    big[1] = 0x01;
    const flvPromise = fetchFlv("cam_big");
    await new Promise((r) => setTimeout(r, 50));
    pub.tag(9, 40, big);
    const { body } = await flvPromise;
    const tags = parseFlv(body);
    const t = tags.find((x) => x.type === 9 && x.payload.length === 10_000);
    expect(t).toBeTruthy();
    expect(t.payload.equals(big)).toBe(true);
    pub.close();
  });

  it("canal sem publisher → 404 (o ffmpeg do go2rtc falha rápido e re-tenta)", async () => {
    const { status } = await fetchFlv("nao_existe", 100);
    expect(status).toBe(404);
  });

  it("nome fora do contrato derruba a conexão sem criar sessão", async () => {
    await expect(connectPublish({ app: "a/b" })).rejects.toThrow();
    expect(ingest.relay.activeChannels()).not.toContain("a");
    await expect(connectPublish({ app: "x".repeat(33) })).rejects.toThrow();
  });

  it("app vazio usa a stream key do publish (variante de firmware)", async () => {
    const pub = await connectPublish({ app: "", publishKey: "cam_key" });
    expect(ingest.relay.activeChannels()).toContain("cam_key");
    pub.close();
  });

  it("mesmo app, stream keys diferentes → canais distintos (NVR multi-canal com app forçado, ex. Intelbras/Dahua)", async () => {
    const pub1 = await connectPublish({ app: "live", publishKey: "ch1" });
    const pub2 = await connectPublish({ app: "live", publishKey: "ch2" });
    await new Promise((r) => setTimeout(r, 50));
    // a 2ª câmera NÃO derruba a 1ª: ambas seguem ativas, sob nomes distintos
    expect(ingest.relay.activeChannels()).toContain("live");
    expect(ingest.relay.activeChannels()).toContain("live-ch2");

    const flv1 = fetchFlv("live");
    const flv2 = fetchFlv("live-ch2");
    await new Promise((r) => setTimeout(r, 50));
    pub1.tag(9, 10, AVC_NALU);
    pub2.tag(9, 20, AVC_NALU);
    const [body1, body2] = await Promise.all([flv1, flv2]);
    expect(parseFlv(body1.body).some((t) => t.type === 9 && t.timeMS === 10)).toBe(true);
    expect(parseFlv(body2.body).some((t) => t.type === 9 && t.timeMS === 20)).toBe(true);
    pub1.close();
    pub2.close();
  });

  it("mesmo app e mesma stream key → reconexão do mesmo canal, substitui normalmente (sem sufixo)", async () => {
    const pub1 = await connectPublish({ app: "live2", publishKey: "ch3" });
    const pub2 = await connectPublish({ app: "live2", publishKey: "ch3" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ingest.relay.activeChannels().filter((n) => n === "live2")).toHaveLength(1);
    expect(ingest.relay.activeChannels()).not.toContain("live2-ch3");
    pub1.close();
    pub2.close();
  });

  it("republish substitui a sessão antiga (reconexão do DVR não fica presa a socket morto)", async () => {
    const pub1 = await connectPublish({ app: "cam_re" });
    const pub2 = await connectPublish({ app: "cam_re" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ingest.relay.activeChannels().filter((n) => n === "cam_re")).toHaveLength(1);
    // a sessão viva é a segunda: publicar por ela alimenta consumidores
    const flvPromise = fetchFlv("cam_re");
    await new Promise((r) => setTimeout(r, 50));
    pub2.tag(9, 10, AVC_NALU);
    const { body } = await flvPromise;
    expect(parseFlv(body).some((t) => t.type === 9)).toBe(true);
    pub1.close();
    pub2.close();
  });

  it("fim do publish encerra os consumidores e libera o canal", async () => {
    const pub = await connectPublish({ app: "cam_end" });
    const flvPromise = fetchFlv("cam_end", 1500);
    await new Promise((r) => setTimeout(r, 50));
    pub.close();
    const { body } = await flvPromise; // res.end() chegou antes do timeout de 1500ms
    expect(body.slice(0, 3).toString()).toBe("FLV");
    expect(ingest.relay.activeChannels()).not.toContain("cam_end");
  });

  it("flvTag monta timestamp estendido (bit 24+) no byte certo", () => {
    const t = flvTag(9, 0x01234567, Buffer.from([0xaa]));
    expect(t.readUIntBE(4, 3)).toBe(0x234567);
    expect(t[7]).toBe(0x01);
  });
});
