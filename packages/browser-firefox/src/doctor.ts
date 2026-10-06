import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sendFirefoxBrokerRequest } from "./client.js";
import { FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID } from "./companion.js";
import { firefoxCompatibilityFacts, type FirefoxCompatibilityFacts } from "./compat.js";
import { buildFirefoxNativeHostInstallPlan, DEFAULT_FIREFOX_NATIVE_HOST_NAME } from "./install.js";
import { listLiveFirefoxSessions } from "./session.js";

export type DoctorSeverity = "ok" | "warn" | "fail" | "info";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  message: string;
  /** Concrete next step, when there is one. */
  fix?: string;
}

export interface DoctorSession {
  sessionId: string;
  hostPid: number;
  hostAliveByHeartbeat: boolean;
  profileIdPrefix: string | null;
  hostProtocol: number;
  companionProtocol: number | null;
  extensionVersion: string | null;
  journalSchema: number | null;
  heartbeatAgeMs: number;
  /** Observed through a status handshake; absent when the handshake failed. */
  observed?: {
    firefoxVersion: string | null;
    companionVersion: string | null;
    protocolCompatible: boolean;
    authorizationState: string;
    scopeCount: number;
    expiresAt: number | null;
    controlState: string;
    features: Record<string, boolean>;
  };
  handshakeError?: string;
}

export interface DoctorReport {
  ok: boolean;
  facts: FirefoxCompatibilityFacts;
  findings: DoctorFinding[];
  sessions: DoctorSession[];
}

export interface DoctorOptions {
  homeDir?: string;
  sessionsDir?: string;
  nodeVersion?: string;
  firefoxAppPath?: string;
  /** Skip the live handshake (used by offline checks). */
  handshake?: boolean;
  now?: number;
}

function sha256File(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function parseMajor(version: string | undefined | null): number | null {
  const match = /^(\d+)/.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

function installedFirefoxVersion(appPath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Read-only evidence that our add-on is installed and signed in a profile, without listing other add-ons. */
function installedCompanionEntries(homeDir: string): Array<{ profile: string; version: string | null; active: boolean | null; signedState: number | null }> {
  const root = path.join(homeDir, "Library", "Application Support", "Firefox", "Profiles");
  const out: Array<{ profile: string; version: string | null; active: boolean | null; signedState: number | null }> = [];
  let profiles: string[] = [];
  try { profiles = fs.readdirSync(root); } catch { return out; }
  for (const profile of profiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, profile, "extensions.json"), "utf8")) as { addons?: Array<Record<string, unknown>> };
      const entry = parsed.addons?.find((addon) => addon.id === FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID);
      if (entry) {
        out.push({
          profile: profile.replace(/^[^.]+\./, "").slice(0, 24),
          version: typeof entry.version === "string" ? entry.version : null,
          active: typeof entry.active === "boolean" ? entry.active : null,
          signedState: typeof entry.signedState === "number" ? entry.signedState : null,
        });
      }
    } catch { /* profile without readable extensions.json */ }
  }
  return out;
}

/**
 * Non-mutating health report. Every claim is tied to evidence it could actually observe: an installed file,
 * a profile's add-on registry, or a live handshake. Anything not observable is reported as such.
 */
export async function runFirefoxDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const homeDir = options.homeDir ?? os.homedir();
  const facts = firefoxCompatibilityFacts();
  const findings: DoctorFinding[] = [];
  const add = (finding: DoctorFinding): void => { findings.push(finding); };
  const now = options.now ?? Date.now();

  if (process.platform !== "darwin" && !options.homeDir) {
    add({ id: "platform", severity: "warn", message: `The technical preview targets macOS; this is ${process.platform}.` });
  }
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = parseMajor(nodeVersion) ?? 0;
  if (nodeMajor < 22 || nodeMajor >= 25) add({ id: "node", severity: "fail", message: `Node ${nodeVersion} is outside the supported range >=22.19.0 <25.`, fix: "Install a supported Node and re-run setup so the host launcher points at it." });
  else add({ id: "node", severity: "ok", message: `Node ${nodeVersion}` });

  // Firefox application
  const appPath = options.firefoxAppPath ?? "/Applications/Firefox.app";
  const appVersion = installedFirefoxVersion(appPath);
  if (!appVersion) add({ id: "firefox-app", severity: "info", message: `No Firefox.app found at ${appPath} (a different install location is fine).` });
  else if ((parseMajor(appVersion) ?? 0) < facts.minFirefoxMajor) add({ id: "firefox-app", severity: "fail", message: `Firefox ${appVersion} is older than the required ${facts.minFirefoxMajor}.`, fix: "Update Firefox." });
  else add({ id: "firefox-app", severity: "ok", message: `Firefox ${appVersion} installed at ${appPath}` });

  // Native host manifest + launcher
  const plan = buildFirefoxNativeHostInstallPlan({ extensionId: FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID, homeDir });
  let manifestOk = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(plan.manifestPath, "utf8")) as { name?: string; path?: string; allowed_extensions?: string[] };
    if (manifest.name !== DEFAULT_FIREFOX_NATIVE_HOST_NAME) add({ id: "host-manifest", severity: "fail", message: "Native host manifest has an unexpected name.", fix: "Run `zamery-browser-firefox setup`." });
    else if (!manifest.allowed_extensions?.includes(FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID)) add({ id: "host-manifest", severity: "fail", message: "Native host manifest does not allow the production companion extension id.", fix: "Run `zamery-browser-firefox setup --force` (a backup of the old manifest is kept)." });
    else if (manifest.path !== plan.launcherPath) add({ id: "host-manifest", severity: "warn", message: `Manifest points at a different launcher: ${manifest.path}` });
    else { manifestOk = true; add({ id: "host-manifest", severity: "ok", message: `Native host manifest: ${plan.manifestPath}` }); }
  } catch {
    add({ id: "host-manifest", severity: "fail", message: "Native host manifest is missing or unreadable.", fix: "Run `zamery-browser-firefox setup`." });
  }

  if (manifestOk) {
    let launcher = "";
    try { launcher = fs.readFileSync(plan.launcherPath, "utf8"); } catch { /* reported below */ }
    const mode = (() => { try { return fs.statSync(plan.launcherPath).mode; } catch { return 0; } })();
    const nodeMatch = /exec '([^']+)' '([^']+)'/.exec(launcher);
    if (!launcher) add({ id: "host-launcher", severity: "fail", message: "Host launcher script is missing.", fix: "Run `zamery-browser-firefox setup --force`." });
    else if (!(mode & 0o100)) add({ id: "host-launcher", severity: "fail", message: "Host launcher is not executable.", fix: "Run `zamery-browser-firefox setup --force`." });
    else if (!nodeMatch) add({ id: "host-launcher", severity: "warn", message: "Host launcher has an unrecognized format." });
    else {
      const [, nodePath, hostPath] = nodeMatch;
      // Firefox launched from the Dock has a minimal PATH, so the launcher must carry an absolute Node path.
      if (!fs.existsSync(nodePath!)) add({ id: "host-launcher", severity: "fail", message: `Launcher Node path no longer exists: ${nodePath}`, fix: "Run `zamery-browser-firefox setup --force` with the Node you want to use." });
      else add({ id: "host-launcher", severity: "ok", message: `Launcher uses absolute Node ${nodePath}` });
      const installedHash = sha256File(hostPath!);
      const bundledHash = sha256File(plan.sourceHostPath);
      if (!installedHash) add({ id: "host-copy", severity: "fail", message: "Installed host script is missing.", fix: "Run `zamery-browser-firefox setup --force`." });
      else if (bundledHash && installedHash !== bundledHash) add({ id: "host-copy", severity: "warn", message: "Installed host script differs from the one in this package (an older or newer install).", fix: "Run `zamery-browser-firefox setup --force`, then restart Firefox." });
      else add({ id: "host-copy", severity: "ok", message: "Installed host script matches this package." });
    }
  }

  const stateDir = path.join(homeDir, "Library", "Application Support", "Zamery", "browser-firefox", "state");
  if (fs.existsSync(path.join(stateDir, "mutation-journal.json"))) {
    add({ id: "legacy-journal", severity: "warn", message: "A legacy plaintext mutation journal exists. It is migrated to safe tombstones and deleted the next time the current host starts.", fix: "Restart Firefox (or reload the companion) with the current host installed." });
  }

  // Installed companion (profile add-on registry)
  const installed = installedCompanionEntries(homeDir);
  if (installed.length === 0) add({ id: "companion-installed", severity: "info", message: "No Firefox profile registry entry for the companion was found (not installed, or a non-default profile location). A live session below is stronger evidence." });
  for (const entry of installed) {
    const detail = `profile ${entry.profile}: companion ${entry.version ?? "?"}, ${entry.active === false ? "disabled" : "enabled"}${entry.signedState === 2 ? ", signed" : entry.signedState === null ? "" : `, signedState=${entry.signedState}`}`;
    add({ id: "companion-installed", severity: entry.active === false ? "warn" : "ok", message: detail, ...(entry.active === false ? { fix: "Enable the Zamery Browser Companion in about:addons." } : {}) });
  }

  // Live sessions + handshake
  const sessions: DoctorSession[] = [];
  const live = listLiveFirefoxSessions({
    now,
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
  });
  if (live.length === 0) {
    add({ id: "live-session", severity: "warn", message: "No live Firefox native-host session. Firefox is closed, the companion is not installed/enabled, or the host cannot start.", fix: "Start Firefox with the companion enabled; check ~/Library/Application Support/Zamery/browser-firefox/native-host-stderr.log." });
  }
  if (live.length > 1) add({ id: "live-session", severity: "warn", message: `${live.length} live sessions (several Firefox profiles). Consumers must choose one explicitly; none is guessed.` });
  for (const session of live) {
    const entry: DoctorSession = {
      sessionId: session.session_id,
      hostPid: session.host_pid,
      hostAliveByHeartbeat: true,
      profileIdPrefix: session.profile_id ? session.profile_id.slice(0, 8) : null,
      hostProtocol: session.protocol_version,
      companionProtocol: (session as { companion_protocol_version?: number | null }).companion_protocol_version ?? null,
      extensionVersion: session.extension_version,
      journalSchema: (session as { journal_schema?: number | null }).journal_schema ?? null,
      heartbeatAgeMs: now - Number(session.last_heartbeat_at || 0),
    };
    if (entry.companionProtocol !== null && entry.companionProtocol !== facts.companionProtocol) {
      add({ id: "protocol", severity: "fail", message: `Companion speaks protocol ${entry.companionProtocol}, this package expects ${facts.companionProtocol}. All access is blocked.`, fix: `Install a companion built for protocol ${facts.companionProtocol} (this package bundles ${facts.bundledCompanionVersion}).` });
    }
    if (options.handshake !== false) {
      try {
        const response = await sendFirefoxBrokerRequest(session, "status", { probe: true, client_label: "doctor" }, { audienceId: `doctor-${process.pid}-${Math.floor(now / 1000)}`, timeoutMs: 5_000 });
        if (response.ok) {
          const result = response.result as {
            companion_extension_version?: string;
            browser_info?: { version?: string };
            features?: Record<string, unknown>;
            authorization?: { state?: string; protocol_compatible?: boolean; scope_count?: number; expires_at?: number | null; control?: { state?: string } };
          };
          const features: Record<string, boolean> = {};
          for (const [key, value] of Object.entries(result.features ?? {})) if (typeof value === "boolean") features[key] = value;
          entry.observed = {
            firefoxVersion: result.browser_info?.version ?? null,
            companionVersion: result.companion_extension_version ?? null,
            protocolCompatible: result.authorization?.protocol_compatible !== false,
            authorizationState: result.authorization?.state ?? "unknown",
            scopeCount: result.authorization?.scope_count ?? 0,
            expiresAt: result.authorization?.expires_at ?? null,
            controlState: result.authorization?.control?.state ?? "unknown",
            features,
          };
          if (!entry.observed.protocolCompatible) add({ id: "protocol", severity: "fail", message: "The companion reports a protocol mismatch with the host; access is blocked.", fix: "Update the companion and host to a compatible pair." });
          else add({ id: "handshake", severity: "ok", message: `Live handshake OK: Firefox ${entry.observed.firefoxVersion ?? "?"}, companion ${entry.observed.companionVersion ?? "?"}, access ${entry.observed.authorizationState}${entry.observed.scopeCount ? ` (${entry.observed.scopeCount} tab(s))` : ""}.` });
          if (entry.observed.firefoxVersion && (parseMajor(entry.observed.firefoxVersion) ?? 999) < facts.minFirefoxMajor) add({ id: "firefox-live", severity: "fail", message: `Running Firefox ${entry.observed.firefoxVersion} is older than ${facts.minFirefoxMajor}.` });
          if (entry.observed.features.tab_groups_api === false) add({ id: "tab-groups", severity: "info", message: "This Firefox build does not expose the tab groups API; group tools will report unsupported." });
        } else {
          entry.handshakeError = response.error?.code ?? "UNKNOWN";
          add({ id: "handshake", severity: response.error?.code === "BROWSER_PROTOCOL_MISMATCH" ? "fail" : "warn", message: `Live handshake failed: ${entry.handshakeError}.` });
        }
      } catch (error) {
        entry.handshakeError = (error as Error).message;
        add({ id: "handshake", severity: "warn", message: `Live handshake failed: ${entry.handshakeError}` });
      }
    }
    sessions.push(entry);
  }

  return { ok: !findings.some((finding) => finding.severity === "fail"), facts, findings, sessions };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<DoctorSeverity, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  const lines = [
    `Zamery Browser Firefox doctor — package ${report.facts.packageVersion}, native wire ${report.facts.nativeWireProtocol}, companion protocol ${report.facts.companionProtocol}, bundled companion ${report.facts.bundledCompanionVersion}`,
    "",
  ];
  for (const finding of report.findings) {
    lines.push(`${icon[finding.severity]} ${finding.message}`);
    if (finding.fix) lines.push(`    fix: ${finding.fix}`);
  }
  lines.push("", report.ok ? "No blocking problems found." : "Blocking problems found.");
  return `${lines.join("\n")}\n`;
}
