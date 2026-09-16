import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_FIREFOX_SESSION_MAX_AGE_MS,
  FIREFOX_BROKER_PROTOCOL_VERSION,
  type FirefoxSessionReceipt,
} from "./protocol.js";

export function firefoxRuntimeRoot(uid = typeof process.getuid === "function" ? process.getuid() : "user"): string {
  const tempRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(tempRoot, `zamery-browser-firefox-${uid}`);
}

export function firefoxSessionsDir(uid = typeof process.getuid === "function" ? process.getuid() : "user"): string {
  return path.join(firefoxRuntimeRoot(uid), "sessions");
}

export function listLiveFirefoxSessions(options: {
  now?: number;
  maxAgeMs?: number;
  sessionsDir?: string;
} = {}): FirefoxSessionReceipt[] {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_FIREFOX_SESSION_MAX_AGE_MS;
  const dir = options.sessionsDir ?? firefoxSessionsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as FirefoxSessionReceipt;
      } catch {
        return null;
      }
    })
    .filter((value): value is FirefoxSessionReceipt => Boolean(value))
    .filter((session) => session.protocol_version === FIREFOX_BROKER_PROTOCOL_VERSION)
    .filter((session) => now - Number(session.last_heartbeat_at || 0) < maxAgeMs)
    .sort((a, b) => Number(b.last_heartbeat_at || 0) - Number(a.last_heartbeat_at || 0));
}

export class FirefoxSessionSelectionError extends Error {
  readonly code: "BROWSER_INSTANCE_AMBIGUOUS" | "BROWSER_INSTANCE_NOT_FOUND";

  constructor(
    code: "BROWSER_INSTANCE_AMBIGUOUS" | "BROWSER_INSTANCE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "FirefoxSessionSelectionError";
    this.code = code;
  }
}

export function selectFirefoxSession(
  sessions: readonly FirefoxSessionReceipt[],
  requestedSessionId?: string,
): FirefoxSessionReceipt {
  if (requestedSessionId) {
    const selected = sessions.find((session) => session.session_id === requestedSessionId);
    if (!selected) {
      throw new FirefoxSessionSelectionError(
        "BROWSER_INSTANCE_NOT_FOUND",
        `Firefox broker session not found: ${requestedSessionId}`,
      );
    }
    return selected;
  }

  if (sessions.length === 1) return sessions[0]!;
  if (sessions.length === 0) {
    throw new FirefoxSessionSelectionError(
      "BROWSER_INSTANCE_NOT_FOUND",
      "no live Firefox broker session is available",
    );
  }

  throw new FirefoxSessionSelectionError(
    "BROWSER_INSTANCE_AMBIGUOUS",
    `multiple live Firefox broker sessions are available: ${sessions.map((session) => session.session_id).join(",")}`,
  );
}
