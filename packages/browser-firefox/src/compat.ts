import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { FIREFOX_BROKER_PROTOCOL_VERSION } from "./protocol.js";
import { FIREFOX_COMPANION_PROTOCOL_VERSION } from "./companion.js";

/** Version facts that must agree for a working install. Each axis has its own number on purpose. */
export const FIREFOX_JOURNAL_SCHEMA_VERSION = 2 as const;
export const FIREFOX_MIN_BROWSER_VERSION = 142 as const;

export interface FirefoxCompatibilityFacts {
  /** Native wire protocol the host and companion must both speak. */
  nativeWireProtocol: number;
  companionProtocol: number;
  journalSchema: number;
  minFirefoxMajor: number;
  /** Version of the companion shipped inside this package's runtime directory. */
  bundledCompanionVersion: string;
  packageVersion: string;
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as Record<string, unknown>;
}

export function firefoxCompatibilityFacts(): FirefoxCompatibilityFacts {
  const manifest = readJson("../runtime/companion/manifest.json");
  const pkg = readJson("../package.json");
  return {
    nativeWireProtocol: FIREFOX_BROKER_PROTOCOL_VERSION,
    companionProtocol: FIREFOX_COMPANION_PROTOCOL_VERSION,
    journalSchema: FIREFOX_JOURNAL_SCHEMA_VERSION,
    minFirefoxMajor: FIREFOX_MIN_BROWSER_VERSION,
    bundledCompanionVersion: String(manifest.version ?? "unknown"),
    packageVersion: String(pkg.version ?? "unknown"),
  };
}
