import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Sobe um hub ISOLADO p/ o E2E: copia os arquivos do server p/ um tempdir (users.json/wa-auth
// ficam só ali — não toca o estado de dev), sem Postgres (→ bootstrap admin/admin@box3),
// na porta 4100 e com CAMERA_TOKEN fixo. NODE_PATH aponta p/ o node_modules do projeto.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIDFILE = join(tmpdir(), "visao-e2e-hub.pid");

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok || r.status === 400) return true; } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export default async function globalSetup() {
  const tmp = mkdtempSync(join(tmpdir(), "visao-e2e-"));
  const srcServer = join(ROOT, "server");
  for (const f of readdirSync(srcServer)) if (f.endsWith(".js") || f.endsWith(".sql")) copyFileSync(join(srcServer, f), join(tmp, f));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "4100", HOST: "127.0.0.1",
    CAMERA_TOKEN: "e2e-cam", AUTH_SECRET: "e2e-secret",
    SUPERADMIN_USER: "admin", SUPERADMIN_PASSWORD: "admin@box3",
    NODE_PATH: join(ROOT, "node_modules"),
  };
  for (const k of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "DATABASE_URL", "WHATSAPP_ENABLED"]) delete env[k];

  const hub: ChildProcess = spawn(process.execPath, [join(tmp, "index.js")], { cwd: tmp, env, stdio: "inherit" });
  writeFileSync(PIDFILE, String(hub.pid));

  const ok = await waitFor("http://127.0.0.1:4100/socket.io/?EIO=4&transport=polling", 30_000);
  if (!ok) { try { hub.kill(); } catch { /* noop */ } throw new Error("[e2e] hub não respondeu na 4100"); }
  console.log(`[e2e] hub pronto na 4100 (pid ${hub.pid}) · dir ${tmp}`);
}
