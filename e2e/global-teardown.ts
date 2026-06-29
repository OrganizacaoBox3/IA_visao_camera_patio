import { readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIDFILE = join(tmpdir(), "visao-e2e-hub.pid");

export default async function globalTeardown() {
  if (!existsSync(PIDFILE)) return;
  const pid = Number(readFileSync(PIDFILE, "utf8"));
  try {
    process.kill(pid);
  } catch {
    /* já morreu */
  }
  try {
    rmSync(PIDFILE);
  } catch {
    /* noop */
  }
}
