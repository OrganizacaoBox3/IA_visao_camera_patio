// Ponte DVR — SHIM de loopback do login-plugin do frps (B-2). Dependency-free (node:http).
//
// Por quê: o frps (server manage plugin) chama um endpoint HTTP a cada Login/NewProxy, mas NÃO
// adiciona headers custom à chamada. A trava CP_FRP_PLUGIN_TOKEN do control-plane (contratos §2)
// exige o header `x-frp-plugin-token` — logo alguém precisa injetá-lo. Este shim roda em loopback
// na MESMA VPS do relay: recebe a chamada do frps (127.0.0.1:9001 /frp/login), repassa ao
// control-plane do visão (POST /api/dvr/frp-login) INJETANDO o token, e devolve a resposta
// verbatim. A DECISÃO (accept/reject) é 100% do control-plane (C-be-4) — o shim só é plumbing.
//
// Fail-CLOSED: se o control-plane estiver inacessível, o shim RECUSA (reject no corpo, HTTP 200) —
// túnel sem validação nunca sobe.
//
// Env (na VPS; nada de segredo no git):
//   CP_URL                — base do HUB do visão (ex.: https://cam.box3.software) [default http://127.0.0.1:4100]
//   CP_FRP_PLUGIN_TOKEN   — mesma trava do control-plane; injetada como x-frp-plugin-token (opcional)
//   SHIM_ADDR / SHIM_PORT — bind do shim [default 127.0.0.1:9001]  ·  SHIM_PATH [default /frp/login]
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const CP_URL = process.env.CP_URL || "http://127.0.0.1:4100";
const CP_PATH = "/api/dvr/frp-login";
const PLUGIN_TOKEN = process.env.CP_FRP_PLUGIN_TOKEN || "";
const ADDR = process.env.SHIM_ADDR || "127.0.0.1";
const PORT = Number(process.env.SHIM_PORT || 9001);
const PATH = process.env.SHIM_PATH || "/frp/login";

const REJECT = JSON.stringify({ reject: true, reject_reason: "shim: control-plane inacessível" });

function repassar(corpo) {
  return new Promise((resolve) => {
    const alvo = new URL(CP_PATH, CP_URL);
    const lib = alvo.protocol === "https:" ? https : http;
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(corpo) };
    if (PLUGIN_TOKEN) headers["x-frp-plugin-token"] = PLUGIN_TOKEN;
    const upstream = lib.request(alvo, { method: "POST", headers }, (up) => {
      let body = "";
      up.on("data", (c) => (body += c));
      up.on("end", () => resolve({ status: up.statusCode || 200, body: body || REJECT }));
    });
    upstream.on("error", (e) => {
      console.error("[frp-shim] control-plane inacessível:", e.message);
      resolve({ status: 200, body: REJECT }); // fail-closed
    });
    upstream.end(corpo);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== PATH) {
    res.writeHead(404).end();
    return;
  }
  let corpo = "";
  req.on("data", (c) => {
    corpo += c;
    if (corpo.length > 64_000) req.destroy(); // teto defensivo
  });
  req.on("end", async () => {
    const r = await repassar(corpo || "{}");
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
});

server.listen(PORT, ADDR, () => {
  console.log(`[frp-shim] no ar em http://${ADDR}:${PORT}${PATH} → ${CP_URL}${CP_PATH}` + (PLUGIN_TOKEN ? " (+token)" : ""));
});
