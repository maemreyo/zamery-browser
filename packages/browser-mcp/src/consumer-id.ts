import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONSUMER_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function defaultStateDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Zamery", "browser-mcp");
}

/**
 * The enrolled consumer id is this MCP installation's stable audience. A Firefox grant is bound to it, so a
 * restart of the MCP child (or of Codex) keeps working under the same grant, and two different installations
 * never share one. It is a routing key for the same OS user, not a credential: it authenticates nothing.
 */
export function loadOrCreateConsumerId(options: { stateDir?: string; override?: string } = {}): string {
  const override = options.override?.trim();
  if (override) {
    if (!CONSUMER_ID_PATTERN.test(override)) throw new Error("ZAMERY_BROWSER_MCP_CONSUMER_ID must match [A-Za-z0-9._:-]{8,128}");
    return override;
  }
  const dir = options.stateDir ?? defaultStateDir();
  const file = path.join(dir, "consumer-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (CONSUMER_ID_PATTERN.test(existing)) return existing;
  } catch {
    // fall through and create
  }
  const created = `mcp-${randomUUID()}`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${created}\n`, { mode: 0o600 });
  } catch {
    // An unwritable state dir only costs grant continuity across restarts; the id still works for this run.
  }
  return created;
}
