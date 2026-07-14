// Teste do forwarder do control-plane (control-plane-forwarder.js).
// O módulo lê os envs no LOAD → cada cenário seta/limpa process.env e RE-REQUER o módulo com
// cache limpo (load()), provando o "env ausente → INERTE" e o POST correto quando ligado.
// fetch é global (Node 18+) e é mockado por caso. Fail-soft: fetch rejeita → NÃO relança.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MODULE_PATH = "./control-plane-forwarder.js";

// Recarrega o módulo do zero com o env atual (os envs são lidos no topo do arquivo).
function load() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

const ENV_KEYS = ["CP_URL", "SITE_ID", "SITE_KEY", "CP_HEARTBEAT_MS", "CP_TIMEOUT_MS"];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Um ev no shape de events.record (só metadados — LGPD-safe).
const EV = {
  id: "a1",
  ts: 1_700_000_000_000,
  cameraId: "cam-1",
  cameraLabel: "Doca 1",
  zona: "doca",
  tipo: "atividade",
  priority: "high",
  text: "Zona parada há 20min",
  state: "new",
};

describe("control-plane-forwarder — inerte sem env", () => {
  it("enabled()=false e forwardAlarm NÃO faz fetch quando falta qualquer env", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cp = load();
    expect(cp.enabled()).toBe(false);
    await cp.forwardAlarm(EV);
    await cp.heartbeat();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("inerte se faltar SÓ o SITE_KEY (os três são obrigatórios)", async () => {
    process.env.CP_URL = "https://plane.exemplo";
    process.env.SITE_ID = "site-1";
    // SITE_KEY ausente de propósito
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cp = load();
    expect(cp.enabled()).toBe(false);
    await cp.forwardAlarm(EV);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("startHeartbeat() inerte não agenda timer nem faz fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cp = load();
    const handle = cp.startHeartbeat();
    expect(handle).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("control-plane-forwarder — ligado (env completo)", () => {
  function enable() {
    process.env.CP_URL = "https://plane.exemplo/"; // barra final é normalizada
    process.env.SITE_ID = "site-1";
    process.env.SITE_KEY = "chave-crua-123";
  }

  it("forwardAlarm monta o POST certo: url, headers x-site-id/x-site-key e body LGPD-safe", async () => {
    enable();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchSpy);
    const cp = load();

    await cp.forwardAlarm(EV);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://plane.exemplo/api/ingest/alarm"); // sem barra dupla
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-site-id"]).toBe("site-1");
    expect(opts.headers["x-site-key"]).toBe("chave-crua-123");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual(EV);
  });

  it("heartbeat faz POST em /api/site/heartbeat com a MESMA auth", async () => {
    enable();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const cp = load();

    await cp.heartbeat();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://plane.exemplo/api/site/heartbeat");
    expect(opts.headers["x-site-id"]).toBe("site-1");
    expect(opts.headers["x-site-key"]).toBe("chave-crua-123");
  });

  it("fail-soft: fetch rejeita → forwardAlarm NÃO relança (o hub sobrevive)", async () => {
    enable();
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cp = load();

    await expect(cp.forwardAlarm(EV)).resolves.toBeUndefined();
    await expect(cp.heartbeat()).resolves.toBeUndefined();
  });

  it("fail-soft: HTTP não-2xx é logado mas NÃO relança", async () => {
    enable();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchSpy);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cp = load();

    await expect(cp.forwardAlarm(EV)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it("LGPD: o payload carrega SÓ os campos de metadados — nunca frame nem texto cru extra", async () => {
    enable();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchSpy);
    const cp = load();

    // ev "contaminado" com campos proibidos — devem ser filtrados pela whitelist.
    const dirty = {
      ...EV,
      frame: "data:image/jpeg;base64,AAAA", // frame NUNCA pode sair
      rawAndon: "texto cru interno do webhook", // texto cru do Andon
      buf: Buffer.from([1, 2, 3]),
      ackBy: "fulano",
    };
    await cp.forwardAlarm(dirty);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual(EV);
    expect(body).not.toHaveProperty("frame");
    expect(body).not.toHaveProperty("rawAndon");
    expect(body).not.toHaveProperty("buf");
    expect(body).not.toHaveProperty("ackBy");
    expect(Object.keys(body).sort()).toEqual(
      ["cameraId", "cameraLabel", "id", "priority", "state", "text", "tipo", "ts", "zona"].sort(),
    );
  });
});
